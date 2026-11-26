import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { orchestrateOrganizePlan } from '@/core/ai-orchestrator';
import { buildProjections } from '@/core/bookmark-engine';
import { applyApprovedPlan, restoreJob } from '@/core/executor';
import {
  generateDuplicateCleanupPlan,
  getDuplicateInstructionIntent,
} from '@/core/planner';
import { validateStudioMessage } from '@/core/protocol';
import { createDefaultSettings, FavorsiteStore } from '@/core/store';
import type {
  BookmarkMetadata,
  PlanScope,
  RemoveBookmarkOperation,
} from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

const ALL: PlanScope = { type: 'all', targetFolderIds: [] };

async function setup() {
  const mock = new MockChromeBookmarks();
  const store = new FavorsiteStore(`dup_${Math.random().toString(36).slice(2)}`);
  const profileKey = await store.getOrCreateProfileKey();
  const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
  const archive = await mock.create({ parentId: '2', title: 'Archive' });
  return { mock, store, profileKey, inbox, archive };
}

async function metaMap(store: FavorsiteStore, profileKey: string) {
  return new Map<string, BookmarkMetadata>(
    (await store.getAllMetadata(profileKey)).map((m) => [m.nodeId, m]),
  );
}

const removals = (ops: { type: string }[]) =>
  ops.filter((o): o is RemoveBookmarkOperation => o.type === 'removeBookmark');

describe('duplicate cleanup plan', () => {
  it('keeps the earliest-added copy, pre-ticks the other exact copies and merges their tags', async () => {
    const { mock, store, profileKey, inbox, archive } = await setup();
    const url = 'https://developers.cloudflare.com/kv/';
    const newer = await mock.create({ parentId: inbox.id, title: 'KV (new)', url });
    const oldest = await mock.create({ parentId: archive.id, title: 'KV (old)', url });
    const middle = await mock.create({ parentId: inbox.id, title: 'KV (mid)', url });
    await mock.create({ parentId: inbox.id, title: 'Unique', url: 'https://unique.example/' });
    // Original dates (e.g. restored from backup) decide which copy is "earliest"
    await store.upsertMetadata({ profileKey, nodeId: oldest.id, tags: ['存檔'], originalDateAdded: 1_000, updatedAt: 1 });
    await store.upsertMetadata({ profileKey, nodeId: middle.id, tags: ['KV'], originalDateAdded: 2_000, updatedAt: 1 });
    await store.upsertMetadata({ profileKey, nodeId: newer.id, tags: ['開發', 'KV'], originalDateAdded: 3_000, updatedAt: 1 });

    const plan = generateDuplicateCleanupPlan({
      flattened: buildProjections(await mock.getTree(), profileKey),
      scope: ALL,
      metadataByNodeId: await metaMap(store, profileKey),
      profileKey,
      snapshotId: 's',
    });

    const rm = removals(plan.operations);
    expect(rm.map((o) => o.nodeId).sort()).toEqual([middle.id, newer.id].sort());
    expect(rm.every((o) => o.enabled && o.removalKind === 'duplicate_exact')).toBe(true);
    expect(rm.every((o) => o.keepNodeId === oldest.id)).toBe(true);
    const tagOp = plan.operations.find((o) => o.type === 'addTag');
    expect(tagOp && tagOp.type === 'addTag' && tagOp.nodeId).toBe(oldest.id);
    expect(tagOp && tagOp.type === 'addTag' && [...tagOp.tagsToAdd].sort()).toEqual(['KV', '開發']);

    // Apply → exactly one copy remains, with merged tags; undo → all copies come back
    await store.savePlan(plan);
    const job = await applyApprovedPlan({ adapter: mock, store, plan, approvedRevision: plan.revision });
    expect(job.status).toBe('completed');
    const survivors = buildProjections(await mock.getTree(), profileKey).projections.filter((p) => p.url === url);
    expect(survivors.map((p) => p.nodeId)).toEqual([oldest.id]);
    expect((await store.getMetadata(profileKey, oldest.id))?.tags.sort()).toEqual(['KV', '存檔', '開發'].sort());

    const undone = await restoreJob({ adapter: mock, store, jobId: job.jobId });
    expect(undone.status).toBe('restored');
    expect(undone.conflicts).toEqual([]);
    const after = buildProjections(await mock.getTree(), profileKey).projections.filter((p) => p.url === url);
    expect(after).toHaveLength(3);
    expect((await store.getMetadata(profileKey, oldest.id))?.tags).toEqual(['存檔']);
  });

  it('proposes suspected duplicates (tracking params) without ticking them', async () => {
    const { mock, store, profileKey, inbox } = await setup();
    const clean = await mock.create({ parentId: inbox.id, title: 'Article', url: 'https://news.example/a' });
    const tracked = await mock.create({ parentId: inbox.id, title: 'Article', url: 'https://news.example/a?utm_source=x' });
    const plan = generateDuplicateCleanupPlan({
      flattened: buildProjections(await mock.getTree(), profileKey),
      scope: ALL,
      metadataByNodeId: await metaMap(store, profileKey),
      profileKey,
      snapshotId: 's',
    });
    const rm = removals(plan.operations);
    expect(rm).toHaveLength(1);
    expect(rm[0].nodeId).toBe(tracked.id);
    expect(rm[0].keepNodeId).toBe(clean.id);
    expect(rm[0].enabled).toBe(false);
    expect(rm[0].requiresReview).toBe(true);
    expect(rm[0].removalKind).toBe('duplicate_suspected');
    expect(plan.warnings[0]).toContain('目前只有疑似重複');
  });

  it('only removes copies inside the scope and always leaves one copy', async () => {
    const { mock, store, profileKey, inbox, archive } = await setup();
    const url = 'https://dup.example/';
    const outside = await mock.create({ parentId: archive.id, title: 'Outside', url });
    const inside = await mock.create({ parentId: inbox.id, title: 'Inside', url });
    const flattened = buildProjections(await mock.getTree(), profileKey);
    const meta = await metaMap(store, profileKey);

    const folderPlan = generateDuplicateCleanupPlan({
      flattened,
      scope: { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] },
      metadataByNodeId: meta,
      profileKey,
      snapshotId: 's',
    });
    expect(removals(folderPlan.operations).map((o) => o.nodeId)).toEqual([inside.id]);

    // Scope = Archive only: the in-scope copy is the earliest one, so it is kept
    const archivePlan = generateDuplicateCleanupPlan({
      flattened,
      scope: { type: 'folder', folderId: archive.id, targetFolderIds: [archive.id] },
      metadataByNodeId: meta,
      profileKey,
      snapshotId: 's',
    });
    expect(removals(archivePlan.operations)).toEqual([]);
    expect(archivePlan.warnings[0]).toContain('擴大範圍至全部可寫書籤');
    expect(removals(folderPlan.operations)[0].keepNodeId).toBe(outside.id);
  });

  it('pauses if the bookmark kept outside the selected folder no longer has the same URL', async () => {
    const { mock, store, profileKey, inbox, archive } = await setup();
    const url = 'https://dup.example/';
    const keeper = await mock.create({ parentId: archive.id, title: 'First', url });
    const copy = await mock.create({ parentId: inbox.id, title: 'Copy', url });
    const plan = generateDuplicateCleanupPlan({
      flattened: buildProjections(await mock.getTree(), profileKey),
      scope: { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] },
      metadataByNodeId: await metaMap(store, profileKey),
      profileKey,
      snapshotId: 's',
    });
    expect(removals(plan.operations).map((op) => op.nodeId)).toEqual([copy.id]);
    await store.savePlan(plan);
    await mock.update(keeper.id, { url: 'https://dup.example/updated' });

    const job = await applyApprovedPlan({ adapter: mock, store, plan, approvedRevision: plan.revision });

    expect(job.status).toBe('paused_conflict');
    expect((await mock.get(copy.id))[0].url).toBe(url);
  });

  it('never proposes removing a managed (read-only) copy', async () => {
    const mock = new MockChromeBookmarks({
      id: '0',
      title: '',
      children: [
        { id: '1', parentId: '0', title: '書籤列', folderType: 'bookmarks-bar', children: [] },
        {
          id: '9',
          parentId: '0',
          title: 'Managed',
          folderType: 'managed',
          unmodifiable: 'managed',
          children: [{ id: '91', parentId: '9', title: 'Policy copy', url: 'https://same.example/', dateAdded: 5 }],
        },
      ],
    });
    await mock.create({ parentId: '1', title: 'User copy', url: 'https://same.example/' });
    const store = new FavorsiteStore(`dup_${Math.random().toString(36).slice(2)}`);
    const plan = generateDuplicateCleanupPlan({
      flattened: buildProjections(await mock.getTree(), 'p'),
      scope: ALL,
      metadataByNodeId: await metaMap(store, 'p'),
      profileKey: 'p',
      snapshotId: 's',
    });
    // The managed copy is the earliest and is kept; it is never a removal target
    const rm = removals(plan.operations);
    expect(rm.map((o) => o.nodeId)).not.toContain('91');
    expect(rm.every((o) => o.keepNodeId === '91')).toBe(true);
  });
});

describe('duplicate instructions are routed to the deterministic planner', () => {
  it.each([
    ['我要刪除重複書籤', 'cleanup'],
    ['幫我找出重複書籤，再把副本刪掉', 'cleanup'],
    ['把重覆的書籤刪掉', 'cleanup'],
    ['Find duplicate bookmarks, then delete the extra copies', 'cleanup'],
    ['移除重複書籤，只留 1 個', 'cleanup'],
    ['只移除重複書籤', 'cleanup'],
    ['刪除重複的書籤', 'cleanup'],
    ['重複書籤只保留一筆', 'cleanup'],
    ['幫我去重', 'cleanup'],
    ['remove duplicates', 'cleanup'],
    ["Don't automatically remove duplicates", 'inspect'],
    ['只列出重複書籤', 'inspect'],
    ['找出重複書籤', 'inspect'],
    ['只想檢查可以刪除哪些重複書籤', 'inspect'],
    ['找出重複書籤，請勿刪除', 'inspect'],
    ['找出重複書籤，別刪', 'inspect'],
    ['刪除非重複書籤', null],
    ['依主題自動歸納目前範圍書籤並加上標籤', null],
    ['不動資料夾，自動幫書籤補上主題標籤', null],
    ['依 設計、開發、閱讀 分類', null],
  ])('%s → %s', (instruction, expected) => {
    expect(getDuplicateInstructionIntent(instruction)).toBe(expected);
  });

  it.each([
    ['transformers-js', '我要刪除重複書籤'],
    ['chrome-prompt-api', '幫我找出重複書籤，再把副本刪掉'],
  ] as const)('uses the duplicate planner with %s for %s', async (preferredProvider, instruction) => {
    const { mock, store, profileKey, inbox } = await setup();
    const a = await mock.create({ parentId: inbox.id, title: 'A', url: 'https://x.example/' });
    const b = await mock.create({ parentId: inbox.id, title: 'B', url: 'https://x.example/' });
    const plan = await orchestrateOrganizePlan({
      preferredProvider,
      flattened: buildProjections(await mock.getTree(), profileKey),
      scope: { type: 'folder', folderId: inbox.id, targetFolderIds: [inbox.id] },
      instruction,
      metadataByNodeId: await metaMap(store, profileKey),
      profileKey,
      snapshotId: 's',
      settings: createDefaultSettings(profileKey),
      precomputedChromeAiDraft: { draftOps: [], warnings: [] },
    });
    const rm = removals(plan.operations);
    expect(rm).toHaveLength(1);
    expect(rm[0].enabled).toBe(true);
    expect(rm[0].nodeId).toBe(b.id);
    expect(rm[0].keepNodeId).toBe(a.id);
    expect(plan.source).toBe('rule');
  });

  it('validates explicit scopes for direct duplicate deletion', () => {
    expect(validateStudioMessage({ type: 'DELETE_DUPLICATES', payload: { scope: ALL } })).toBeNull();
    expect(validateStudioMessage({ type: 'DELETE_DUPLICATES', payload: {} })).not.toBeNull();
    for (const type of ['folder', 'selection']) {
      expect(validateStudioMessage({
        type: 'DELETE_DUPLICATES',
        payload: { scope: { type, targetFolderIds: [] } },
      })).not.toBeNull();
    }
  });
});
