import { describe, expect, it } from 'vitest';
import {
  exportBackupPayload,
  restoreBackupToFolder,
  validateAndPreviewBackup,
} from '@/core/backup';
import { buildProjections, extractSnapshotNodes } from '@/core/bookmark-engine';
import {
  applyApprovedPlan,
  reconcileInterruptedJobs,
  restoreJob,
} from '@/core/executor';
import {
  generateRuleBasedPlan,
  togglePlanOperation,
} from '@/core/planner';
import { FavorsiteStore } from '@/core/store';
import type { PlanScope } from '@/core/types';
import { MockChromeBookmarks } from './mock-bookmarks';

async function setupCloudflareScenario() {
  const mock = new MockChromeBookmarks();
  const inbox = await mock.create({ parentId: '1', title: 'Inbox' });
  const bKv = await mock.create({
    parentId: inbox.id,
    title: 'Cloudflare Workers KV Getting Started',
    url: 'https://developers.cloudflare.com/kv/get-started/',
  });
  const bR2 = await mock.create({
    parentId: inbox.id,
    title: 'Cloudflare R2 Bucket Pricing & API',
    url: 'https://developers.cloudflare.com/r2/api/',
  });
  const bQueues = await mock.create({
    parentId: inbox.id,
    title: 'Cloudflare Queues Consumer Guide',
    url: 'https://developers.cloudflare.com/queues/get-started/',
  });
  const bCross = await mock.create({
    parentId: inbox.id,
    title: 'Using Workers KV together with R2 Storage',
    url: 'https://developers.cloudflare.com/workers/examples/kv-and-r2/',
  });

  const store = new FavorsiteStore(`test_db_${Math.random().toString(36).slice(2)}`);
  const profileKey = await store.getOrCreateProfileKey();
  return { mock, store, profileKey, inbox, bKv, bR2, bQueues, bCross };
}

describe('planner, executor, reconciliation, undo, and backup', () => {
  it('executes Cloudflare KV/R2/Queues organize flow, handles multi-topic review, and fully restores on undo', async () => {
    const { mock, store, profileKey, inbox, bKv, bR2, bQueues, bCross } =
      await setupCloudflareScenario();

    const tree = await mock.getTree();
    const flattened = buildProjections(tree, profileKey);
    const scope: PlanScope = {
      type: 'folder',
      folderId: inbox.id,
      targetFolderIds: [inbox.id],
    };

    const plan = generateRuleBasedPlan({
      flattened,
      scope,
      instruction: '把 Inbox 裡的 Cloudflare Workers 書籤依 KV、R2、Queues 分類',
      metadataByNodeId: new Map(),
      profileKey,
      snapshotId: 'snap_1',
      baseParentId: inbox.id,
    });
    await store.savePlan(plan);

    // Should create KV, R2, Queues folders
    const folderOps = plan.operations.filter((o) => o.type === 'createFolder');
    expect(folderOps.map((o) => o.title).sort()).toEqual(['KV', 'Queues', 'R2']);

    // Multi-topic bookmark (KV + R2) should be flagged requiresReview (disabled by default) AND tagged with both KV and R2
    const crossMove = plan.operations.find(
      (o) => o.type === 'moveBookmark' && o.nodeId === bCross.id,
    );
    expect(crossMove?.requiresReview).toBe(true);
    expect(crossMove?.enabled).toBe(false);

    const crossTags = plan.operations.find(
      (o) => o.type === 'addTag' && o.nodeId === bCross.id,
    );
    expect(crossTags?.type === 'addTag' && crossTags.tagsToAdd.sort()).toEqual([
      'KV',
      'R2',
    ]);

    // Apply approved plan
    const job = await applyApprovedPlan({
      adapter: mock,
      store,
      plan,
      approvedRevision: plan.revision,
    });
    expect(job.status).toBe('completed');
    expect(job.conflicts).toHaveLength(0);

    // Verify Chrome bookmarks tree now has KV, R2, Queues folders containing their bookmarks
    const afterTree = buildProjections(await mock.getTree(), profileKey);
    const kvFolder = afterTree.projections.find(
      (p) => p.isFolder && p.parentId === inbox.id && p.title === 'KV',
    );
    const r2Folder = afterTree.projections.find(
      (p) => p.isFolder && p.parentId === inbox.id && p.title === 'R2',
    );
    const qFolder = afterTree.projections.find(
      (p) => p.isFolder && p.parentId === inbox.id && p.title === 'Queues',
    );
    expect(kvFolder).toBeDefined();
    expect(r2Folder).toBeDefined();
    expect(qFolder).toBeDefined();

    expect(afterTree.byId.get(bKv.id)?.parentId).toBe(kvFolder!.nodeId);
    expect(afterTree.byId.get(bR2.id)?.parentId).toBe(r2Folder!.nodeId);
    expect(afterTree.byId.get(bQueues.id)?.parentId).toBe(qFolder!.nodeId);
    // Cross-topic bookmark stayed in Inbox because requiresReview was unchecked
    expect(afterTree.byId.get(bCross.id)?.parentId).toBe(inbox.id);
    // Tags applied
    expect((await store.getMetadata(profileKey, bCross.id))?.tags.sort()).toEqual([
      'KV',
      'R2',
    ]);

    // Now reverse restore (undo)
    const restored = await restoreJob({
      adapter: mock,
      store,
      jobId: job.jobId,
    });
    expect(restored.status).toBe('restored');
    expect(restored.conflicts).toHaveLength(0);

    // All bookmarks returned to Inbox, newly created empty folders removed, tags restored to empty
    const restoredTree = buildProjections(await mock.getTree(), profileKey);
    expect(restoredTree.byId.get(bKv.id)?.parentId).toBe(inbox.id);
    expect(restoredTree.byId.get(bR2.id)?.parentId).toBe(inbox.id);
    expect(restoredTree.byId.get(bQueues.id)?.parentId).toBe(inbox.id);
    expect(
      restoredTree.projections.find(
        (p) => p.isFolder && p.parentId === inbox.id && p.title === 'KV',
      ),
    ).toBeUndefined();
    expect((await store.getMetadata(profileKey, bCross.id))?.tags).toEqual([]);
  });

  it('cascades disabling dependent moveBookmark ops when createFolder is unchecked and pauses on external edit', async () => {
    const { mock, store, profileKey, inbox, bKv } =
      await setupCloudflareScenario();
    const flattened = buildProjections(await mock.getTree(), profileKey);
    const scope: PlanScope = {
      type: 'folder',
      folderId: inbox.id,
      targetFolderIds: [inbox.id],
    };

    const plan = generateRuleBasedPlan({
      flattened,
      scope,
      instruction: '依 KV、R2、Queues 分類',
      metadataByNodeId: new Map(),
      profileKey,
      snapshotId: 'snap_2',
      baseParentId: inbox.id,
    });

    const kvCreate = plan.operations.find(
      (o) => o.type === 'createFolder' && o.title === 'KV',
    )!;
    const toggled = togglePlanOperation(plan, kvCreate.opId, false);
    expect(toggled.plan.revision).toBe(plan.revision + 1);
    expect(toggled.affectedDependentOpIds.length).toBeGreaterThan(0);

    const kvMove = toggled.plan.operations.find(
      (o) => o.type === 'moveBookmark' && o.nodeId === bKv.id,
    )!;
    expect(kvMove.enabled).toBe(false);

    // Simulate external rename in another Chrome window BEFORE apply
    await mock.update(bKv.id, { title: 'Externally Edited KV Title' });
    await store.savePlan(toggled.plan);

    const pausedJob = await applyApprovedPlan({
      adapter: mock,
      store,
      plan: toggled.plan,
      approvedRevision: toggled.plan.revision,
    });
    expect(pausedJob.status).toBe('paused_conflict');
    expect(pausedJob.conflicts[0]?.kind).toBe('scope_changed');
  });

  it('reconciles interrupted worker crash mid-batch without duplicate writes and handles restore conflict when folder is non-empty', async () => {
    const { mock, store, profileKey, inbox, bKv } =
      await setupCloudflareScenario();
    const flattened = buildProjections(await mock.getTree(), profileKey);
    const scope: PlanScope = {
      type: 'folder',
      folderId: inbox.id,
      targetFolderIds: [inbox.id],
    };

    const plan = generateRuleBasedPlan({
      flattened,
      scope,
      instruction: '依 KV、R2 分類',
      metadataByNodeId: new Map(),
      profileKey,
      snapshotId: 'snap_crash',
      baseParentId: inbox.id,
    });
    await store.savePlan(plan);

    // Simulate Service Worker termination right after the 1st createFolder API call succeeded,
    // BEFORE the step status could be persisted as 'applied'.
    let crashedOnce = false;
    await expect(
      applyApprovedPlan({
        adapter: mock,
        store,
        plan,
        approvedRevision: plan.revision,
        onAfterApiBeforeLog: async (step) => {
          if (!crashedOnce && step.opType === 'createFolder') {
            crashedOnce = true;
            // Force job to remain 'running' and step 'in_progress' like an abrupt SW kill
            throw new Error('SIMULATED_SW_TERMINATION');
          }
        },
      }),
    ).rejects.toThrow('SIMULATED_SW_TERMINATION');

    // Simulate abrupt kill state in DB (running + in_progress)
    const jobsAfterCrash = await store.listJobs(profileKey);
    const crashedJob = jobsAfterCrash[0];
    crashedJob.status = 'running';
    await store.saveJob(crashedJob);

    // On SW restart, reconcileInterruptedJobs inspects live Chrome tree
    const reconciled = await reconcileInterruptedJobs({
      adapter: mock,
      store,
      profileKey,
    });
    expect(reconciled).toHaveLength(1);
    expect(reconciled[0].status).toBe('interrupted');
    // The folder already exists in Chrome -> MUST be marked needs_confirmation, NOT blindly duplicated
    const firstStep = reconciled[0].steps.find((s) => s.opType === 'createFolder')!;
    expect(firstStep.status).toBe('needs_confirmation');

    // Test restore preserving non-empty folder when user added another bookmark inside
    const mock2 = new MockChromeBookmarks();
    const inbox2 = await mock2.create({ parentId: '1', title: 'Inbox2' });
    const b1 = await mock2.create({
      parentId: inbox2.id,
      title: 'Workers KV Intro',
      url: 'https://developers.cloudflare.com/kv/',
    });
    const flat2 = buildProjections(await mock2.getTree(), profileKey);
    const plan2 = generateRuleBasedPlan({
      flattened: flat2,
      scope: { type: 'folder', folderId: inbox2.id, targetFolderIds: [inbox2.id] },
      instruction: '依 KV 分類',
      metadataByNodeId: new Map(),
      profileKey,
      snapshotId: 'snap_restore_conflict',
      baseParentId: inbox2.id,
    });
    await store.savePlan(plan2);
    const applied2 = await applyApprovedPlan({
      adapter: mock2,
      store,
      plan: plan2,
      approvedRevision: plan2.revision,
    });
    expect(applied2.status).toBe('completed');

    // User manually adds a new bookmark into the newly created KV folder
    const afterFlat2 = buildProjections(await mock2.getTree(), profileKey);
    const kvFolderId = afterFlat2.byId.get(b1.id)!.parentId;
    const manualExtra = await mock2.create({
      parentId: kvFolderId,
      title: 'Manual New Bookmark',
      url: 'https://example.com/new',
    });

    // Undo should move b1 back to Inbox2, preserve KV folder because manualExtra is inside, and report conflict
    const undo2 = await restoreJob({
      adapter: mock2,
      store,
      jobId: applied2.jobId,
    });
    expect(undo2.conflicts.some((c) => c.kind === 'folder_not_empty')).toBe(true);
    const finalTree = buildProjections(await mock2.getTree(), profileKey);
    expect(finalTree.byId.get(b1.id)?.parentId).toBe(inbox2.id);
    expect(finalTree.byId.get(kvFolderId)).toBeDefined();
    expect(finalTree.byId.get(manualExtra.id)?.parentId).toBe(kvFolderId);
  });

  it('exports versioned JSON backup, previews validation, restores into new branch, and relinks tags + originalDateAdded', async () => {
    const { mock, store, profileKey, inbox, bKv } =
      await setupCloudflareScenario();
    await store.upsertMetadata({
      profileKey,
      nodeId: bKv.id,
      tags: ['KV', 'Cloudflare'],
      updatedAt: Date.now(),
    });

    const tree = await mock.getTree();
    const metadata = await store.getAllMetadata(profileKey);
    const payload = exportBackupPayload({ tree, metadata, profileKey });
    const jsonText = JSON.stringify(payload);

    // Invalid JSON rejected
    expect(validateAndPreviewBackup('{not-json').preview.valid).toBe(false);

    // Valid backup previewed
    const { preview, payload: parsed } = validateAndPreviewBackup(jsonText);
    expect(preview.valid).toBe(true);
    expect(preview.totalBookmarks).toBe(4);
    expect(preview.taggedBookmarkCount).toBe(1);
    expect(parsed).toBeDefined();

    // Restore into a fresh branch under '2' (Other Bookmarks)
    const result = await restoreBackupToFolder({
      adapter: mock,
      store,
      profileKey,
      payload: parsed!,
      targetParentId: '2',
      branchTitle: 'Restore Test Branch',
    });
    expect(result.createdBookmarks).toBe(4);
    expect(result.relinkedTags).toBe(1);

    // Verify relinked tags exist on the newly created Chrome node ID
    const newTree = buildProjections(await mock.getTree(), profileKey);
    const restoredKv = newTree.projections.find(
      (p) =>
        !p.isFolder &&
        p.nodeId !== bKv.id &&
        p.url === 'https://developers.cloudflare.com/kv/get-started/',
    );
    expect(restoredKv).toBeDefined();
    const newMeta = await store.getMetadata(profileKey, restoredKv!.nodeId);
    expect(newMeta?.tags.sort()).toEqual(['Cloudflare', 'KV']);
    expect(newMeta?.originalDateAdded).toBeTypeOf('number');

    // Snapshot extraction sanity check
    expect(
      extractSnapshotNodes(newTree, {
        type: 'folder',
        folderId: inbox.id,
        targetFolderIds: [inbox.id],
      }).length,
    ).toBeGreaterThan(0);
  });
});
