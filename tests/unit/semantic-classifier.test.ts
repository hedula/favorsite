import { describe, expect, it, vi } from 'vitest';
import { orchestrateOrganizePlan } from '@/core/ai-orchestrator';
import { buildProjections } from '@/core/bookmark-engine';
import { applyApprovedPlan, restoreJob } from '@/core/executor';
import { buildSemanticDraft } from '@/core/semantic-classifier';
import { createDefaultSettings, FavorsiteStore } from '@/core/store';
import type { PlanScope } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

async function setup() {
  const mock = new MockChromeBookmarks();
  const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
  const kvFolder = await mock.create({ parentId: inbox.id, title: 'KV' });
  const kv = await mock.create({
    parentId: inbox.id,
    title: '在全球節點以鍵讀寫網站設定',
    url: 'https://example.com/private?token=sensitive#fragment',
  });
  const r2 = await mock.create({
    parentId: inbox.id,
    title: 'Store images in an S3-compatible bucket',
    url: 'https://example.com/reference',
  });
  const ambiguous = await mock.create({
    parentId: inbox.id,
    title: '儲存方式選擇',
    url: 'https://example.com/notes',
  });
  const profileKey = 'semantic-test-profile';
  const flattened = buildProjections(await mock.getTree(), profileKey);
  const scope: PlanScope = {
    type: 'folder',
    folderId: inbox.id,
    targetFolderIds: [inbox.id],
  };
  const params = {
    flattened,
    scope,
    profileKey,
    baseParentId: inbox.id,
    instruction: '依 KV、R2 分類',
    metadataByNodeId: new Map(),
    includePath: false,
  };
  return { mock, inbox, kv, r2, ambiguous, kvFolder, params };
}

describe('semantic bookmark classification', () => {
  it('reuses a category, moves only clear matches on approval, and restores the batch', async () => {
    const { mock, inbox, kv, r2, ambiguous, kvFolder, params } = await setup();
    const embed = vi.fn(async () => ({
      backend: 'wasm' as const,
      vectors: [[1, 0], [0, 1], [1, 0], [0, 1], [Math.SQRT1_2, Math.SQRT1_2]],
    }));
    const semanticDraft = await buildSemanticDraft({ ...params, embed });
    const inference = embed.mock.calls[0];
    expect(JSON.stringify(inference)).toContain('在全球節點以鍵讀寫網站設定');
    expect(JSON.stringify(inference)).not.toContain('token=sensitive');
    expect(JSON.stringify(inference)).not.toContain('/private');
    expect(semanticDraft.warnings[0]).toContain('1 筆');

    const plan = await orchestrateOrganizePlan({
      ...params,
      preferredProvider: 'transformers-js',
      settings: createDefaultSettings(params.profileKey),
      snapshotId: 'snap_semantic',
      semanticDraft,
    });
    expect(plan.source).toBe('transformers-js');
    expect(plan.operations.filter((op) => op.type === 'createFolder').map((op) => op.title)).toEqual(['R2']);
    expect(plan.operations.filter((op) => op.type === 'moveBookmark')).toHaveLength(2);
    expect((await mock.get(kv.id))[0].parentId).toBe(inbox.id);
    expect((await mock.get(r2.id))[0].parentId).toBe(inbox.id);

    const store = new FavorsiteStore('semantic-approval-test');
    await store.savePlan(plan);
    const job = await applyApprovedPlan({
      adapter: mock,
      store,
      plan,
      approvedRevision: plan.revision,
    });
    expect(job).toMatchObject({ status: 'completed', completedCount: 3 });
    expect((await mock.get(kv.id))[0].parentId).toBe(kvFolder.id);
    const [moved] = await mock.get(r2.id);
    expect((await mock.get(moved.parentId!))[0].title).toBe('R2');
    expect((await mock.get(ambiguous.id))[0].parentId).toBe(inbox.id);

    const restored = await restoreJob({ adapter: mock, store, jobId: job.jobId });
    expect(restored.status).toBe('restored');
    expect(await mock.getChildren(inbox.id)).toHaveLength(4);
    expect((await mock.get(kv.id))[0].parentId).toBe(inbox.id);
    expect((await mock.get(r2.id))[0].parentId).toBe(inbox.id);
  });

  it.each(['依主題自動分類', '依 KV、kv 分類', '請勿搬移書籤，依 KV、R2 分類'])(
    'offers guidance without model inference for %s',
    async (instruction) => {
      const { params } = await setup();
      const embed = vi.fn();
      const draft = await buildSemanticDraft({ ...params, instruction, embed });
      expect(draft.draftOps).toEqual([]);
      expect(draft.warnings).toHaveLength(1);
      expect(embed).not.toHaveBeenCalled();
    },
  );

  it('keeps weak matches and high-similarity ties in their current folder', async () => {
    const { kv, params } = await setup();
    const embed = vi.fn(async () => ({
      backend: 'wasm' as const,
      vectors: [
        [1, 0, 0],
        [0.8, 0.6, 0],
        [1, 0, 0],
        [0.5, 0.7, Math.sqrt(0.26)],
        [Math.sqrt(0.9), Math.sqrt(0.1), 0],
      ],
    }));
    const draft = await buildSemanticDraft({ ...params, embed });
    expect(draft.draftOps).toEqual([
      expect.objectContaining({ type: 'moveBookmark', nodeId: kv.id }),
    ]);
    expect(draft.warnings[0]).toContain('2 筆');
  });

  it('accepts a close match with an agreeing label and skips conflicting labels', async () => {
    const { mock, kv, r2, ambiguous, params } = await setup();
    await mock.update(kv.id, { title: '日本關西七日自助旅行' });
    await mock.update(r2.id, { title: '奶油蘑菇義大利麵食譜' });
    await mock.update(ambiguous.id, { title: '旅行與食譜整理' });
    const draft = await buildSemanticDraft({
      ...params,
      flattened: buildProjections(await mock.getTree(), params.profileKey),
      instruction: '依 旅行、食譜 分類',
      embed: async () => ({
        backend: 'wasm',
        vectors: [
          [1, 0, 0],
          [0.8, 0.6, 0],
          [Math.sqrt(0.91), 0.3, 0],
          [1, 0, 0],
          [0.8, 0.6, 0],
        ],
      }),
    });
    expect(draft.draftOps).toEqual([
      expect.objectContaining({ type: 'createFolder', title: '旅行' }),
      expect.objectContaining({ type: 'moveBookmark', nodeId: kv.id }),
    ]);
    expect(draft.warnings[0]).toContain('2 筆');
  });
});
