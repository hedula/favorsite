import { describe, expect, it } from 'vitest';
import { buildProjections } from '@/core/bookmark-engine';
import { applyApprovedPlan, restoreJob } from '@/core/executor';
import {
  classifyUrlForLinkCheck,
  collectCheckableOrigins,
  probeBookmarkUrl,
  runBatchLinkCheck,
} from '@/core/link-checker';
import {
  enableDead404Removals,
  generateDeadLinkCleanupPlan,
} from '@/core/planner';
import { FavorsiteStore } from '@/core/store';
import type { BookmarkMetadata, PlanScope } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

describe('dead link checker & dual cleanup modes (Option A quarantine + Option B reversible remove)', () => {
  it('excludes localhost, LAN IPs, non-http schemes, credentials, and sensitive token URLs', () => {
    expect(classifyUrlForLinkCheck('https://example.com/docs').eligible).toBe(true);
    expect(classifyUrlForLinkCheck('https://example.com/docs').originPattern).toBe(
      'https://example.com/*',
    );
    // Ports must be stripped from Chrome match patterns
    expect(classifyUrlForLinkCheck('https://example.com:8443/docs').originPattern).toBe(
      'https://example.com/*',
    );
    // Non-standard wildcard/underscore hostnames are skipped cleanly
    expect(classifyUrlForLinkCheck('https://foo*bar.com/x').skipStatus).toBe(
      'skipped_private',
    );

    expect(classifyUrlForLinkCheck('http://127.0.0.1:1234/v1').skipStatus).toBe(
      'skipped_private',
    );
    expect(classifyUrlForLinkCheck('http://localhost:3000/app').skipStatus).toBe(
      'skipped_private',
    );
    expect(classifyUrlForLinkCheck('http://192.168.1.1/admin').skipStatus).toBe(
      'skipped_private',
    );
    expect(classifyUrlForLinkCheck('http://10.0.0.5/internal').skipStatus).toBe(
      'skipped_private',
    );
    expect(classifyUrlForLinkCheck('http://intranet/wiki').skipStatus).toBe(
      'skipped_private',
    );
    expect(classifyUrlForLinkCheck('chrome://extensions/').skipStatus).toBe(
      'skipped_private',
    );
    expect(
      classifyUrlForLinkCheck('https://user:pass@example.com/').skipStatus,
    ).toBe('skipped_sensitive');
    expect(
      classifyUrlForLinkCheck('https://example.com/app?access_token=xyz').skipStatus,
    ).toBe('skipped_sensitive');
    expect(
      classifyUrlForLinkCheck('https://example.com/reset-password/abc').skipStatus,
    ).toBe('skipped_sensitive');
  });

  it('probes HEAD first with omit credentials & manual redirect, falls back to GET on 405, and classifies statuses accurately', async () => {
    const seenMethods: string[] = [];
    const mockFetch = (async (url: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.credentials).toBe('omit');
      expect(init?.referrerPolicy).toBe('no-referrer');
      expect(init?.redirect).toBe('manual');
      seenMethods.push(init?.method ?? 'GET');

      const u = String(url);
      if (u.includes('/gone')) return new Response(null, { status: 410 });
      if (u.includes('/missing')) return new Response(null, { status: 404 });
      if (u.includes('/head-blocked')) {
        if (init?.method === 'HEAD') return new Response(null, { status: 405 });
        return new Response('ok', { status: 200 });
      }
      if (u.includes('/moved')) {
        return new Response(null, {
          status: 301,
          headers: { location: 'https://new.example.com/' },
        });
      }
      if (u.includes('/login')) return new Response(null, { status: 401 });
      if (u.includes('/ratelimit')) return new Response(null, { status: 429 });
      if (u.includes('/down')) return new Response(null, { status: 503 });
      throw new TypeError('Failed to fetch');
    }) as typeof fetch;

    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/gone', fetchImpl: mockFetch }))
        .status,
    ).toBe('dead_404_410');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/missing', fetchImpl: mockFetch }))
        .status,
    ).toBe('dead_404_410');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/head-blocked', fetchImpl: mockFetch }))
        .status,
    ).toBe('ok');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/moved', fetchImpl: mockFetch }))
        .status,
    ).toBe('redirect');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/login', fetchImpl: mockFetch }))
        .status,
    ).toBe('auth_blocked');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/ratelimit', fetchImpl: mockFetch }))
        .status,
    ).toBe('rate_limited');
    expect(
      (await probeBookmarkUrl({ url: 'https://example.com/down', fetchImpl: mockFetch }))
        .status,
    ).toBe('server_error');
    expect(
      (await probeBookmarkUrl({ url: 'https://nxdomain.example.invalid/', fetchImpl: mockFetch }))
        .status,
    ).toBe('dead_unreachable');
    expect(seenMethods).toContain('HEAD');
    expect(seenMethods).toContain('GET');
  });

  it('supports Option A (quarantine folder move + undo) and Option B (manual-confirm removeBookmark + reversible recreate with tags)', async () => {
    const mock = new MockChromeBookmarks();
    const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
    const bDead = await mock.create({
      parentId: inbox.id,
      title: 'Old Dead Doc',
      url: 'https://dead.example.com/404',
    });
    const bAuth = await mock.create({
      parentId: inbox.id,
      title: 'Private Dashboard (403)',
      url: 'https://dash.example.com/private',
    });
    const bLocal = await mock.create({
      parentId: inbox.id,
      title: 'Local Dev',
      url: 'http://127.0.0.1:8787/',
    });

    const store = new FavorsiteStore(`deadlink_db_${Math.random().toString(36).slice(2)}`);
    const profileKey = await store.getOrCreateProfileKey();
    await store.upsertMetadata({
      profileKey,
      nodeId: bDead.id,
      tags: ['Cloudflare', '舊文件'],
      originalDateAdded: 1700000001234,
      updatedAt: Date.now(),
    });

    const flattened = buildProjections(await mock.getTree(), profileKey);
    const bookmarks = flattened.projections.filter((p) => !p.isFolder);

    // Check origin collection excludes localhost
    const originInfo = collectCheckableOrigins(bookmarks);
    expect(originInfo.origins.sort()).toEqual([
      'https://dash.example.com/*',
      'https://dead.example.com/*',
    ]);
    expect(originInfo.skippedCount).toBe(1);

    // Batch check
    const batch = await runBatchLinkCheck({
      bookmarks,
      isOriginAuthorized: async () => true,
      fetchImpl: (async (u: RequestInfo | URL) => {
        if (String(u).includes('dead.example.com')) {
          return new Response(null, { status: 404 });
        }
        return new Response(null, { status: 403 });
      }) as typeof fetch,
    });
    expect(batch.dead404Count).toBe(1);
    expect(batch.results[bAuth.id].status).toBe('auth_blocked');
    expect(batch.results[bLocal.id].status).toBe('skipped_private');

    // Save linkCheck to metadata
    const metaMap = new Map<string, BookmarkMetadata>();
    for (const [nodeId, linkCheck] of Object.entries(batch.results)) {
      const existing = await store.getMetadata(profileKey, nodeId);
      const updated: BookmarkMetadata = {
        profileKey,
        nodeId,
        tags: existing?.tags ?? [],
        originalDateAdded: existing?.originalDateAdded,
        linkCheck,
        updatedAt: Date.now(),
      };
      await store.upsertMetadata(updated);
      metaMap.set(nodeId, updated);
    }

    const scope: PlanScope = {
      type: 'folder',
      folderId: inbox.id,
      targetFolderIds: [inbox.id],
    };

    // --- Option A: Quarantine ---
    const planA = generateDeadLinkCleanupPlan({
      flattened,
      scope,
      metadataByNodeId: metaMap,
      profileKey,
      snapshotId: 'snap_a',
      action: 'quarantine',
      baseParentId: inbox.id,
    });
    await store.savePlan(planA);
    // 403 and localhost MUST NOT be included
    expect(planA.operations.filter((o) => o.type === 'moveBookmark')).toHaveLength(1);
    expect(planA.operations.filter((o) => o.type === 'createFolder')).toHaveLength(1);

    const jobA = await applyApprovedPlan({
      adapter: mock,
      store,
      plan: planA,
      approvedRevision: planA.revision,
    });
    expect(jobA.status).toBe('completed');
    const afterA = buildProjections(await mock.getTree(), profileKey);
    const qFolder = afterA.projections.find(
      (p) => p.isFolder && p.title === '失效連結待清理',
    );
    expect(qFolder).toBeDefined();
    expect(afterA.byId.get(bDead.id)?.parentId).toBe(qFolder!.nodeId);
    expect(afterA.byId.get(bAuth.id)?.parentId).toBe(inbox.id);

    // Undo Option A -> restores bookmark to Inbox & removes empty quarantine folder
    const undoA = await restoreJob({ adapter: mock, store, jobId: jobA.jobId });
    expect(undoA.status).toBe('restored');
    const afterUndoA = buildProjections(await mock.getTree(), profileKey);
    expect(afterUndoA.byId.get(bDead.id)?.parentId).toBe(inbox.id);
    expect(
      afterUndoA.projections.find((p) => p.isFolder && p.title === '失效連結待清理'),
    ).toBeUndefined();

    // --- Option B: Direct removeBookmark (unchecked by default -> user checks -> apply -> restore recreates with tags!) ---
    const freshFlat = buildProjections(await mock.getTree(), profileKey);
    const planB = generateDeadLinkCleanupPlan({
      flattened: freshFlat,
      scope,
      metadataByNodeId: metaMap,
      profileKey,
      snapshotId: 'snap_b',
      action: 'remove',
    });
    expect(planB.operations).toHaveLength(1);
    expect(planB.operations[0].type).toBe('removeBookmark');
    // Safety invariant: removeBookmark is NEVER enabled by default
    expect(planB.operations[0].enabled).toBe(false);

    const approvedPlanB = enableDead404Removals(planB);
    expect(approvedPlanB.operations[0].enabled).toBe(true);
    expect(approvedPlanB.revision).toBe(2);
    await store.savePlan(approvedPlanB);

    const jobB = await applyApprovedPlan({
      adapter: mock,
      store,
      plan: approvedPlanB,
      approvedRevision: approvedPlanB.revision,
    });
    expect(jobB.status).toBe('completed');

    // Verify bookmark is actually deleted from Chrome tree
    const afterB = buildProjections(await mock.getTree(), profileKey);
    expect(afterB.byId.get(bDead.id)).toBeUndefined();
    expect(afterB.byId.get(bAuth.id)).toBeDefined();

    // Restore Option B -> recreates bookmark in Inbox and relinks original tags + originalDateAdded!
    const undoB = await restoreJob({ adapter: mock, store, jobId: jobB.jobId });
    expect(undoB.status).toBe('restored');
    expect(undoB.conflicts).toHaveLength(0);

    const afterUndoB = buildProjections(await mock.getTree(), profileKey);
    const recreated = afterUndoB.projections.find(
      (p) => !p.isFolder && p.url === 'https://dead.example.com/404',
    );
    expect(recreated).toBeDefined();
    expect(recreated!.parentId).toBe(inbox.id);
    expect(recreated!.title).toBe('Old Dead Doc');

    const relinkedMeta = await store.getMetadata(profileKey, recreated!.nodeId);
    expect(relinkedMeta?.tags.sort()).toEqual(['Cloudflare', '舊文件']);
    expect(relinkedMeta?.originalDateAdded).toBe(1700000001234);
  });
});
