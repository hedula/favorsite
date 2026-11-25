import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { buildSanitizedAiBatch } from '@/core/ai-schema';
import { orchestrateOrganizePlan } from '@/core/ai-orchestrator';
import {
  restoreBackupToFolder,
  sanitizeBackupPayload,
  validateAndPreviewBackup,
} from '@/core/backup';
import {
  buildProjections,
  getWritableFolders,
  resolveMoveIndex,
  StaleMoveAnchorError,
} from '@/core/bookmark-engine';
import {
  classifyUrlForLinkCheck,
  planHostPermissionRequest,
  runBatchLinkCheck,
} from '@/core/link-checker';
import { generateRuleBasedPlan, validatePlanDraft } from '@/core/planner';
import {
  PromptApiInputTooLargeError,
  PromptApiSessionPool,
  requestChromePromptApiPlan,
  type LanguageModelGlobal,
  type LanguageModelSession,
} from '@/core/prompt-api';
import { summarizeSnapshot, validateStudioMessage } from '@/core/protocol';
import { createDefaultSettings, FavorsiteStore } from '@/core/store';
import type { BookmarkProjection, PlanScope, Snapshot } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

/** Regression suite for the P2 findings of the 2026-11-25 audit. */

function bm(nodeId: string, url: string): BookmarkProjection {
  return {
    profileKey: 'p',
    nodeId,
    parentId: '1',
    index: 0,
    title: nodeId,
    url,
    domain: new URL(url).hostname,
    isFolder: false,
    isSystemFolder: false,
    writable: true,
    canAddChild: false,
    path: nodeId,
    childCount: 0,
  };
}

describe('P2 link-check eligibility closes private-host and sensitive-URL gaps', () => {
  it.each([
    'http://127.0.0.1.nip.io/',
    'http://10-0-0-1.sslip.io/',
    'http://app.192.168.1.20.nip.io/',
    'http://localtest.me/',
    'http://api.lvh.me/',
    'http://198.18.0.1/',
    'http://224.0.0.1/',
    'http://255.255.255.255/',
    'http://192.0.2.10/',
    'http://203.0.113.5/',
  ])('skips private/reserved host %s', (url) => {
    const c = classifyUrlForLinkCheck(url);
    expect(c.eligible).toBe(false);
    expect(c.skipStatus).toBe('skipped_private');
  });

  it.each([
    'https://example.com/callback?code=abc&state=xyz',
    'https://example.com/auth/confirm?token_hash=abc',
    'https://bucket.s3.amazonaws.com/f?X-Amz-Signature=abc&X-Amz-Credential=x',
    'https://example.com/cb#access_token=abc',
    'https://example.com/list/unsubscribe/123',
    'https://example.com/account/confirm',
    'https://example.com/users/activate/abc',
    'https://example.com/invite/abc',
    'https://example.com/?client_secret=s',
  ])('skips sensitive / one-time URL %s', (url) => {
    const c = classifyUrlForLinkCheck(url);
    expect(c.eligible).toBe(false);
    expect(c.skipStatus).toBe('skipped_sensitive');
  });

  it.each([
    'https://example.com/docs/configuration',
    'https://example.com/?page=2&q=key',
    'https://example.com/api/keys-overview',
    'https://8.8.8.8/',
    'https://www.example.co.uk/blog/confirmation-bias-explained',
  ])('still checks ordinary public URL %s', (url) => {
    expect(classifyUrlForLinkCheck(url).eligible).toBe(true);
  });
});

describe('P2 offline device is never reported as mass dead links', () => {
  const sites = [
    bm('a', 'https://a.example.com/'),
    bm('b', 'https://b.example.org/'),
    bm('c', 'https://c.example.net/'),
  ];

  it('does not fetch at all and records timeouts when navigator reports offline', async () => {
    let calls = 0;
    const res = await runBatchLinkCheck({
      bookmarks: sites,
      isOriginAuthorized: async () => true,
      fetchImpl: (async () => {
        calls++;
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
      isOnline: () => false,
    });
    expect(calls).toBe(0);
    expect(res.offlineSuspected).toBe(true);
    expect(res.unreachableCount).toBe(0);
    expect(Object.values(res.results).every((r) => r.status === 'timeout')).toBe(true);
  });

  it('treats "every one of >=3 different sites unreachable" as a local network failure', async () => {
    const res = await runBatchLinkCheck({
      bookmarks: sites,
      isOriginAuthorized: async () => true,
      fetchImpl: (async () => {
        throw new TypeError('Failed to fetch');
      }) as typeof fetch,
      isOnline: () => true,
    });
    expect(res.offlineSuspected).toBe(true);
    expect(res.unreachableCount).toBe(0);
  });

  it('keeps genuine unreachable results when other sites answer', async () => {
    const res = await runBatchLinkCheck({
      bookmarks: sites,
      isOriginAuthorized: async () => true,
      fetchImpl: (async (u: RequestInfo | URL) => {
        if (String(u).includes('a.example.com')) throw new TypeError('Failed to fetch');
        return new Response(null, { status: 200 });
      }) as typeof fetch,
      isOnline: () => true,
    });
    expect(res.offlineSuspected).toBe(false);
    expect(res.results.a.status).toBe('dead_unreachable');
    expect(res.unreachableCount).toBe(1);
  });
});

describe('P2 all-sites permission never outlives the check that needed it', () => {
  it('requests individual origins up to 15 and keeps them', () => {
    const origins = Array.from({ length: 15 }, (_, i) => `https://s${i}.example.com/*`);
    expect(planHostPermissionRequest(origins)).toEqual({
      requestOrigins: origins,
      revokeAfterCheck: [],
    });
  });

  it('uses scheme wildcards beyond 15 origins and marks them for revocation', () => {
    const origins = [
      ...Array.from({ length: 15 }, (_, i) => `https://s${i}.example.com/*`),
      'http://legacy.example.com/*',
    ];
    const plan = planHostPermissionRequest(origins);
    expect(plan.requestOrigins).toEqual(['https://*/*', 'http://*/*']);
    expect(plan.revokeAfterCheck).toEqual(plan.requestOrigins);
  });
});

async function aiScopeSetup() {
  const mock = new MockChromeBookmarks();
  const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
  const inScopeSub = await mock.create({ parentId: inbox.id, title: 'Sub' });
  const outside = await mock.create({ parentId: '2', title: 'Outside' });
  const b1 = await mock.create({ parentId: inbox.id, title: 'One', url: 'https://one.example/' });
  const b2 = await mock.create({ parentId: inbox.id, title: 'Two', url: 'https://two.example/' });
  const flattened = buildProjections(await mock.getTree(), 'p');
  const scope: PlanScope = { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] };
  return { mock, inbox, inScopeSub, outside, b1, b2, flattened, scope };
}

describe('P2 model-proposed changes outside the scope or renames need explicit review', () => {
  it('flags moves and new folders outside the scope, keeps in-scope moves enabled', async () => {
    const { inScopeSub, outside, b1, b2, flattened, scope } = await aiScopeSetup();
    const res = validatePlanDraft({
      draftOps: [
        { type: 'moveBookmark', nodeId: b1.id, toParentId: outside.id, reason: 'r' },
        { type: 'moveBookmark', nodeId: b2.id, toParentId: inScopeSub.id, reason: 'r' },
        { type: 'createFolder', tempFolderId: 'n1', parentId: outside.id, title: 'New', reason: 'r' },
      ],
      flattened,
      scope,
      metadataByNodeId: new Map(),
    });
    const toOutside = res.operations.find((o) => o.type === 'moveBookmark' && o.nodeId === b1.id)!;
    const toInside = res.operations.find((o) => o.type === 'moveBookmark' && o.nodeId === b2.id)!;
    const folder = res.operations.find((o) => o.type === 'createFolder')!;
    expect(toOutside.enabled).toBe(false);
    expect(toOutside.reviewReason).toContain('不在本次整理範圍內');
    expect(toInside.enabled).toBe(true);
    expect(folder.enabled).toBe(false);
    expect(res.warnings.some((w) => w.includes('整理範圍外'))).toBe(true);
  });

  it('marks moves into an out-of-scope NEW folder for review too', async () => {
    const { outside, b1, flattened, scope } = await aiScopeSetup();
    const res = validatePlanDraft({
      draftOps: [
        { type: 'createFolder', tempFolderId: 'n1', parentId: outside.id, title: 'New', reason: 'r' },
        { type: 'moveBookmark', nodeId: b1.id, toTempFolderId: 'n1', reason: 'r' },
      ],
      flattened,
      scope,
      metadataByNodeId: new Map(),
    });
    const move = res.operations.find((o) => o.type === 'moveBookmark')!;
    expect(move.enabled).toBe(false);
    expect(move.requiresReview).toBe(true);
  });

  it('never pre-selects model renames', async () => {
    const { b1, flattened, scope } = await aiScopeSetup();
    const res = validatePlanDraft({
      draftOps: [{ type: 'renameBookmark', nodeId: b1.id, newTitle: 'IGNORE PREVIOUS', reason: 'r' }],
      flattened,
      scope,
      metadataByNodeId: new Map(),
    });
    const rename = res.operations.find((o) => o.type === 'renameBookmark')!;
    expect(rename.enabled).toBe(false);
    expect(rename.requiresReview).toBe(true);
  });

  it('does not flag rule plans that file into existing category folders under the chosen base', async () => {
    const mock = new MockChromeBookmarks();
    const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
    const base = await mock.create({ parentId: '2', title: 'Topics' });
    await mock.create({ parentId: base.id, title: '設計與靈感' });
    await mock.create({ parentId: inbox.id, title: 'Figma tips', url: 'https://figma.com/x' });
    const flattened = buildProjections(await mock.getTree(), 'p');
    const plan = generateRuleBasedPlan({
      flattened,
      scope: { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] },
      instruction: '',
      metadataByNodeId: new Map(),
      profileKey: 'p',
      snapshotId: 's',
      baseParentId: base.id,
    });
    const move = plan.operations.find((o) => o.type === 'moveBookmark')!;
    expect(move.enabled).toBe(true);
    expect(move.requiresReview).toBeFalsy();
  });
});

describe('P2 the model sees in-scope folders first and caps are reported', () => {
  it('orders scope folders first and counts what was left out', async () => {
    const { flattened, scope, inScopeSub } = await aiScopeSetup();
    const folders = getWritableFolders(flattened.projections);
    const bookmarks = Array.from({ length: 5 }, (_, i) => bm(`x${i}`, `https://x${i}.example/`));
    const batch = buildSanitizedAiBatch({
      bookmarks,
      writableFolders: folders,
      metadataByNodeId: new Map(),
      includePath: false,
      maxBookmarks: 3,
      maxFolders: 2,
      priorityFolderIds: new Set([scope.folderId!, inScopeSub.id]),
    });
    expect(batch.bookmarks).toHaveLength(3);
    expect(batch.truncatedBookmarks).toBe(2);
    expect(batch.truncatedFolders).toBe(folders.length - 2);
    expect(batch.folders.map((f) => f.title).sort()).toEqual(['Inbox', 'Sub']);
  });

  it('tells the user when only part of a large scope was analysed', async () => {
    const mock = new MockChromeBookmarks();
    const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
    for (let i = 0; i < 85; i++) {
      await mock.create({ parentId: inbox.id, title: `T${i}`, url: `https://t${i}.example/` });
    }
    const flattened = buildProjections(await mock.getTree(), 'p');
    const plan = await orchestrateOrganizePlan({
      preferredProvider: 'auto',
      flattened,
      scope: { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] },
      instruction: '',
      metadataByNodeId: new Map(),
      profileKey: 'p',
      snapshotId: 's',
      settings: createDefaultSettings('p'),
      precomputedChromeAiDraft: { draftOps: [], warnings: [] },
    });
    expect(plan.warnings.some((w) => w.includes('僅分析前 80 筆') && w.includes('5 筆'))).toBe(true);
  });
});

describe('P2 Prompt API session pool and input quota', () => {
  const batch = {
    bookmarks: [{ id: 'b1', title: 't', domain: 'a.com' }],
    folders: [{ id: 'f1', title: 'F', path: 'F' }],
    bookmarkIdByTemp: new Map([['b1', '10']]),
    folderIdByTemp: new Map([['f1', '20']]),
    skippedSpecialUrls: 0,
  };

  it('creates a single shared base session for concurrent tasks and leaks nothing', async () => {
    let created = 0;
    let destroyed = 0;
    const lm: LanguageModelGlobal = {
      availability: async () => 'available',
      create: async () => {
        created++;
        await new Promise((r) => setTimeout(r, 5));
        const base: LanguageModelSession = {
          prompt: async () => '{"operations":[]}',
          destroy: () => {
            destroyed++;
          },
          clone: async () => ({
            prompt: async () => '{"operations":[]}',
            destroy: () => {
              destroyed++;
            },
          }),
        };
        return base;
      },
    };
    const pool = new PromptApiSessionPool();
    await Promise.all(
      [1, 2, 3].map(() =>
        requestChromePromptApiPlan({ instruction: 'x', batch, lmGlobal: lm, sessionPool: pool }),
      ),
    );
    pool.dispose();
    expect(created).toBe(1);
    expect(destroyed).toBe(created + 3);
  });

  it('fails fast with a clear error when the batch exceeds the input quota', async () => {
    let prompted = false;
    const lm: LanguageModelGlobal = {
      availability: async () => 'available',
      create: async () => ({
        inputQuota: 100,
        inputUsage: 40,
        measureInputUsage: async () => 80,
        prompt: async () => {
          prompted = true;
          return '{"operations":[]}';
        },
        destroy: () => {},
      }),
    };
    await expect(
      requestChromePromptApiPlan({ instruction: 'x', batch, lmGlobal: lm }),
    ).rejects.toBeInstanceOf(PromptApiInputTooLargeError);
    expect(prompted).toBe(false);
  });
});

describe('P2 backup restore is validated in the worker and all-or-nothing', () => {
  async function ctx() {
    const mock = new MockChromeBookmarks();
    const store = new FavorsiteStore(`p2_${Math.random().toString(36).slice(2)}`);
    const profileKey = await store.getOrCreateProfileKey();
    return { mock, store, profileKey };
  }

  it('sanitizes malformed metadata instead of aborting half-way', async () => {
    const { mock, store, profileKey } = await ctx();
    const raw = {
      schemaVersion: 1,
      tree: [
        {
          originalId: 'f',
          title: 'F',
          isFolder: true,
          children: [
            { originalId: 'a', title: 'ok', url: 'https://a.example/' },
            { originalId: 'b', title: 'bad tags', url: 'https://b.example/' },
            { originalId: 'c', title: 'after', url: 'https://c.example/' },
            { originalId: 'j', title: 'js', url: 'javascript:alert(1)' },
          ],
        },
      ],
      metadata: [
        { nodeId: 'b', tags: 'notarray' },
        { nodeId: 'a', tags: ['x', 42, 'x', ' y '] },
      ],
    };
    const res = await restoreBackupToFolder({
      adapter: mock,
      store,
      profileKey,
      payload: raw as never,
      targetParentId: '2',
    });
    expect(res.createdBookmarks).toBe(3);
    expect(res.skippedCount).toBe(1);
    const tree = JSON.stringify(await mock.getTree());
    expect(tree).toContain('https://c.example/');
    expect(tree).not.toContain('javascript:');
    const all = await store.getAllMetadata(profileKey);
    expect(all.some((m) => m.tags.join(',') === 'x,y')).toBe(true);
  });

  it('drops nodes deeper than the preview limit in BOTH preview and restore', async () => {
    const { mock, store, profileKey } = await ctx();
    let deep: unknown = { originalId: 'leaf', title: 'deep', url: 'https://deep.example/' };
    for (let i = 0; i < 55; i++) {
      deep = { originalId: `d${i}`, title: `d${i}`, isFolder: true, children: [deep] };
    }
    const raw = { schemaVersion: 1, tree: [deep], metadata: [] };
    const preview = validateAndPreviewBackup(JSON.stringify(raw));
    expect(preview.preview.skippedCount).toBeGreaterThan(0);
    const res = await restoreBackupToFolder({
      adapter: mock,
      store,
      profileKey,
      payload: raw as never,
      targetParentId: '2',
    });
    expect(res.createdBookmarks).toBe(0);
    expect(JSON.stringify(await mock.getTree())).not.toContain('deep.example');
  });

  it('rolls back the half-built branch when Chrome fails mid-restore', async () => {
    const { mock, store, profileKey } = await ctx();
    let creates = 0;
    const flaky = new Proxy(mock, {
      get(target, key) {
        if (key === 'create') {
          return async (d: Parameters<MockChromeBookmarks['create']>[0]) => {
            creates++;
            if (creates === 4) throw new Error('quota');
            return target.create(d);
          };
        }
        const v = Reflect.get(target, key);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    });
    const raw = {
      schemaVersion: 1,
      tree: [1, 2, 3, 4].map((i) => ({ originalId: `n${i}`, title: `n${i}`, url: `https://n${i}.example/` })),
      metadata: [{ nodeId: 'n1', tags: ['t'] }],
    };
    const before = JSON.stringify(await mock.getTree());
    await expect(
      restoreBackupToFolder({ adapter: flaky, store, profileKey, payload: raw as never, targetParentId: '2' }),
    ).rejects.toThrow('已移除未完成的還原分支');
    expect(JSON.stringify(await mock.getTree())).toBe(before);
    expect(await store.getAllMetadata(profileKey)).toEqual([]);
  });

  it('rejects unsupported or oversized payloads sent straight to the worker', async () => {
    const { mock, store, profileKey } = await ctx();
    await expect(
      restoreBackupToFolder({
        adapter: mock,
        store,
        profileKey,
        payload: { schemaVersion: 2, tree: [], metadata: [] } as never,
        targetParentId: '2',
      }),
    ).rejects.toThrow('schemaVersion');
    const huge = { schemaVersion: 1, tree: [{ originalId: 'x', title: 'x'.repeat(11 * 1024 * 1024), url: 'https://x.example/' }], metadata: [] };
    await expect(
      restoreBackupToFolder({ adapter: mock, store, profileKey, payload: huge as never, targetParentId: '2' }),
    ).rejects.toThrow('10 MB');
  });

  it('sanitizeBackupPayload tolerates garbage input', () => {
    expect(sanitizeBackupPayload(null).payload.tree).toEqual([]);
    expect(sanitizeBackupPayload({ tree: 'x', metadata: {} }).payload.metadata).toEqual([]);
  });
});

describe('P2 reordering with a vanished anchor fails loudly', () => {
  it('throws instead of silently appending at the end', () => {
    expect(() =>
      resolveMoveIndex({
        liveTargetChildIds: ['a', 'b', 'c'],
        movingNodeId: 'a',
        sameParent: true,
        beforeSiblingId: 'gone',
      }),
    ).toThrow(StaleMoveAnchorError);
    expect(() =>
      resolveMoveIndex({
        liveTargetChildIds: ['a', 'b', 'c'],
        movingNodeId: 'a',
        sameParent: true,
        afterSiblingId: 'gone',
      }),
    ).toThrow(StaleMoveAnchorError);
    expect(
      resolveMoveIndex({ liveTargetChildIds: ['a', 'b', 'c'], movingNodeId: 'c', sameParent: true, beforeSiblingId: 'a' }),
    ).toBe(0);
  });
});

describe('P2 runtime message validation and slim bootstrap payload', () => {
  it.each([
    [{ type: 'GET_BOOTSTRAP_STATE' }, null],
    [{ type: 'UPDATE_TAGS', payload: { nodeId: '1', tags: ['a'] } }, null],
    [{ type: 'MOVE_BOOKMARK', payload: { nodeId: '1', toParentId: '2', desiredFinalIndex: 3 } }, null],
    [
      {
        type: 'CREATE_PLAN',
        payload: { scope: { type: 'all', targetFolderIds: [] }, instruction: '', mode: 'rule' },
      },
      null,
    ],
  ])('accepts %j', (msg, expected) => {
    expect(validateStudioMessage(msg)).toBe(expected);
  });

  it.each([
    [null],
    [{ type: 'NOPE' }],
    [{ type: 'UPDATE_TAGS', payload: { nodeId: '1', tags: 'a,b' } }],
    [{ type: 'MOVE_BOOKMARK', payload: { nodeId: '1', toParentId: '2', desiredFinalIndex: -1 } }],
    [{ type: 'RESOLVE_JOB_STEP', payload: { jobId: 'j', opId: 'o', resolution: 'delete' } }],
    [{ type: 'CREATE_PLAN', payload: { scope: { type: 'evil', targetFolderIds: [] }, instruction: '', mode: 'rule' } }],
    [{ type: 'CHECK_LINKS', payload: { bookmarkIds: [1, 2] } }],
    [{ type: 'RESTORE_BACKUP', payload: { backup: 'x', targetParentId: '1' } }],
  ])('rejects %j', (msg) => {
    expect(validateStudioMessage(msg)).not.toBeNull();
  });

  it('summarizes snapshots without their node trees', () => {
    const snap: Snapshot = {
      snapshotId: 's',
      schemaVersion: 1,
      profileKey: 'p',
      createdAt: 1,
      reason: 'delete',
      label: 'L',
      scope: { type: 'all', targetFolderIds: [] },
      nodes: Array.from({ length: 3 }, (_, i) => ({ id: String(i), index: i, title: 't', isFolder: false })),
      metadata: [],
    };
    const summary = summarizeSnapshot(snap);
    expect(summary).toEqual({ snapshotId: 's', profileKey: 'p', createdAt: 1, reason: 'delete', label: 'L', nodeCount: 3 });
    expect('nodes' in summary).toBe(false);
  });
});
