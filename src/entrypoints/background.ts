import { orchestrateOrganizePlan } from '@/core/ai-orchestrator';
import { exportBackupPayload, restoreBackupToFolder } from '@/core/backup';
import {
  buildProjections,
  createChromeBookmarkAdapter,
  extractFullSnapshotNodes,
  extractSnapshotNodes,
  isSafeBookmarkUrl,
  resolveMoveIndex,
  wouldCreateCycle,
} from '@/core/bookmark-engine';
import {
  applyApprovedPlan,
  reconcileInterruptedJobs,
  resolveJobStep,
  restoreJob,
} from '@/core/executor';
import { runBatchLinkCheck } from '@/core/link-checker';
import {
  generateDeadLinkCleanupPlan,
  generateDuplicateCleanupPlan,
} from '@/core/planner';
import {
  isTrustedExtensionSender,
  summarizeSnapshot,
  validateStudioMessage,
  type BootstrapState,
  type StudioMessage,
  type StudioResponse,
} from '@/core/protocol';
import { defaultStore } from '@/core/store';
import type { BookmarkMetadata, Snapshot } from '@/core/types';

// Ephemeral guard ONLY to tell whether a 'running'/'restoring' job is live in THIS SW turn
// vs orphaned by a terminated SW (persisted truth remains in IndexedDB).
const liveWorkerJobIds = new Set<string>();

function makeSnapshotId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `snap_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `snap_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

async function notifyBookmarkChange(reason: string): Promise<void> {
  try {
    await chrome.runtime.sendMessage({
      type: 'BOOKMARKS_CHANGED',
      reason,
      timestamp: Date.now(),
    });
  } catch {
    // No open extension pages listening — expected when Studio/Popup are closed
  }
}

async function refreshProjections(): Promise<{
  profileKey: string;
  flattened: ReturnType<typeof buildProjections>;
}> {
  const adapter = createChromeBookmarkAdapter();
  const profileKey = await defaultStore.getOrCreateProfileKey();
  const tree = await adapter.getTree();
  const flattened = buildProjections(tree, profileKey);
  await defaultStore.replaceProjections(profileKey, flattened.projections);
  return { profileKey, flattened };
}

async function openStudioTab(tab?: string): Promise<void> {
  const baseUrl = chrome.runtime.getURL('/studio.html');
  const targetUrl = tab ? `${baseUrl}#${tab}` : baseUrl;
  await chrome.tabs.create({ url: targetUrl });
}

async function handleStudioMessage(
  message: StudioMessage,
): Promise<StudioResponse> {
  const adapter = createChromeBookmarkAdapter();
  const profileKey = await defaultStore.getOrCreateProfileKey();

  switch (message.type) {
    case 'GET_BOOTSTRAP_STATE': {
      await reconcileInterruptedJobs({
        adapter,
        store: defaultStore,
        profileKey,
        activeJobIds: liveWorkerJobIds,
      });
      const { flattened } = await refreshProjections();
      const [metadata, plans, jobs, snapshots, settings, lock] =
        await Promise.all([
          defaultStore.getAllMetadata(profileKey),
          defaultStore.listPlans(profileKey),
          defaultStore.listJobs(profileKey),
          defaultStore.listSnapshots(profileKey),
          defaultStore.getSettings(profileKey),
          defaultStore.getJobLock(profileKey),
        ]);

      const state: BootstrapState = {
        profileKey,
        projections: flattened.projections,
        metadata,
        plans,
        jobs,
        snapshots: snapshots.map(summarizeSnapshot),
        settings,
        hasActiveLock: Boolean(lock),
      };
      return { ok: true, data: state };
    }

    case 'REBUILD_INDEX': {
      const { flattened } = await refreshProjections();
      return { ok: true, data: { count: flattened.projections.length } };
    }

    case 'CREATE_BOOKMARK': {
      const { parentId, title, url, index } = message.payload;
      const { flattened } = await refreshProjections();
      const parent = flattened.byId.get(parentId);
      if (!parent || !parent.isFolder || !parent.canAddChild) {
        return { ok: false, error: '目的資料夾不存在或不可寫入。' };
      }
      const cleanTitle = title.trim();
      if (!cleanTitle) {
        return { ok: false, error: '標題不可為空。' };
      }
      if (url !== undefined) {
        const cleanUrl = url.trim();
        if (!isSafeBookmarkUrl(cleanUrl)) {
          return {
            ok: false,
            error: '網址格式無效或協定不支援（需為 http/https 等合法網址）。',
          };
        }
        const created = await adapter.create({
          parentId,
          title: cleanTitle,
          url: cleanUrl,
          index,
        });
        await notifyBookmarkChange('created');
        return { ok: true, data: { nodeId: created.id } };
      } else {
        const created = await adapter.create({
          parentId,
          title: cleanTitle,
          index,
        });
        await notifyBookmarkChange('created');
        return { ok: true, data: { nodeId: created.id } };
      }
    }

    case 'UPDATE_BOOKMARK': {
      const { nodeId, title, url, tags } = message.payload;
      const { flattened } = await refreshProjections();
      const node = flattened.byId.get(nodeId);
      if (!node || !node.writable) {
        return { ok: false, error: '此節點受保護或不可編輯。' };
      }
      const cleanTitle = title.trim();
      if (!cleanTitle) {
        return { ok: false, error: '標題不可為空。' };
      }
      const changes: { title: string; url?: string } = { title: cleanTitle };
      if (!node.isFolder && url !== undefined) {
        const cleanUrl = url.trim();
        if (!isSafeBookmarkUrl(cleanUrl)) {
          return { ok: false, error: '網址格式無效。' };
        }
        changes.url = cleanUrl;
      }
      await adapter.update(nodeId, changes);

      // A link-check result belongs to the URL it probed; drop it once the URL changes
      // so a fixed bookmark can never be proposed for dead-link removal.
      const urlChanged = changes.url !== undefined && changes.url !== node.url;
      const existing = await defaultStore.getMetadata(profileKey, nodeId);
      if (Array.isArray(tags) || (urlChanged && existing?.linkCheck)) {
        await defaultStore.upsertMetadata({
          profileKey,
          nodeId,
          tags: Array.isArray(tags) ? tags : existing?.tags ?? [],
          originalDateAdded: existing?.originalDateAdded,
          linkCheck: urlChanged ? undefined : existing?.linkCheck,
          updatedAt: Date.now(),
        });
      }
      await notifyBookmarkChange('updated');
      return { ok: true, data: { nodeId } };
    }

    case 'MOVE_BOOKMARK': {
      const {
        nodeId,
        toParentId,
        desiredFinalIndex,
        beforeSiblingId,
        afterSiblingId,
      } = message.payload;
      const { flattened } = await refreshProjections();
      const node = flattened.byId.get(nodeId);
      const dest = flattened.byId.get(toParentId);

      if (!node || !node.writable) {
        return { ok: false, error: '此項目受系統或企業原則保護，無法移動。' };
      }
      if (!dest || !dest.isFolder || !dest.canAddChild) {
        return { ok: false, error: '目的資料夾不存在或不可寫入。' };
      }
      if (node.isFolder && wouldCreateCycle(nodeId, toParentId, flattened.byId)) {
        return { ok: false, error: '無法將資料夾移入自身或其子資料夾。' };
      }

      const liveDestChildren = await adapter.getChildren(toParentId);
      const moveIdx = resolveMoveIndex({
        liveTargetChildIds: liveDestChildren.map((c) => c.id),
        movingNodeId: nodeId,
        sameParent: node.parentId === toParentId,
        desiredFinalIndex,
        beforeSiblingId,
        afterSiblingId,
      });

      await adapter.move(nodeId, {
        parentId: toParentId,
        ...(moveIdx !== undefined ? { index: moveIdx } : {}),
      });
      await notifyBookmarkChange('moved');
      return { ok: true, data: { nodeId } };
    }

    case 'REMOVE_BOOKMARK': {
      const { nodeId, recursive } = message.payload;
      const { flattened } = await refreshProjections();
      const node = flattened.byId.get(nodeId);
      if (!node || !node.writable) {
        return { ok: false, error: '此節點受保護或為系統資料夾，無法移除。' };
      }
      if (node.isFolder && !recursive && node.childCount > 0) {
        return {
          ok: false,
          error: '資料夾內仍有項目，請先清空或明確選擇移除整個資料夾。',
        };
      }

      // Preserve recoverable snapshot before removal
      const allMeta = await defaultStore.getAllMetadata(profileKey);
      const snapshot: Snapshot = {
        snapshotId: makeSnapshotId(),
        schemaVersion: 1,
        profileKey,
        createdAt: Date.now(),
        reason: 'delete',
        label: `移除前快照：${node.title || node.url || node.nodeId}`,
        scope: {
          type: 'selection',
          bookmarkIds: [nodeId],
          targetFolderIds: node.parentId ? [node.parentId] : [],
        },
        nodes: extractFullSnapshotNodes(flattened),
        metadata: allMeta,
      };
      await defaultStore.saveSnapshot(snapshot);

      if (node.isFolder && recursive) {
        await adapter.removeTree(nodeId);
      } else {
        await adapter.remove(nodeId);
      }

      const settings = await defaultStore.getSettings(profileKey);
      await defaultStore.pruneSnapshots(profileKey, settings.backupRetentionCount);
      await notifyBookmarkChange('removed');
      return { ok: true, data: { snapshotId: snapshot.snapshotId } };
    }

    case 'UPDATE_TAGS': {
      const { nodeId, tags } = message.payload;
      const { flattened } = await refreshProjections();
      const target = flattened.byId.get(nodeId);
      if (!target || target.isFolder) {
        return { ok: false, error: '找不到此書籤，無法更新標籤。' };
      }
      const existing = await defaultStore.getMetadata(profileKey, nodeId);
      const cleaned = Array.from(
        new Set(tags.map((t) => t.trim()).filter(Boolean)),
      );
      await defaultStore.upsertMetadata({
        profileKey,
        nodeId,
        tags: cleaned,
        originalDateAdded: existing?.originalDateAdded,
        linkCheck: existing?.linkCheck,
        updatedAt: Date.now(),
      });
      return { ok: true, data: { nodeId, tags: cleaned } };
    }

    case 'CREATE_PLAN': {
      const {
        scope,
        instruction,
        mode,
        baseParentId,
        precomputedChromeAiDraft,
        precomputedChromeAiError,
      } = message.payload;
      const { flattened } = await refreshProjections();
      const allMeta = await defaultStore.getAllMetadata(profileKey);
      const metaMap = new Map<string, BookmarkMetadata>(
        allMeta.map((m) => [m.nodeId, m]),
      );

      // Save scope snapshot before generating plan
      const snapshot: Snapshot = {
        snapshotId: makeSnapshotId(),
        schemaVersion: 1,
        profileKey,
        createdAt: Date.now(),
        reason: 'organize',
        label: `整理快照：${instruction.trim().slice(0, 40) || '未命名整理'}`,
        scope,
        nodes: extractSnapshotNodes(flattened, scope),
        metadata: allMeta,
      };
      await defaultStore.saveSnapshot(snapshot);

      const settings = await defaultStore.getSettings(profileKey);
      const plan = await orchestrateOrganizePlan({
        preferredProvider: mode,
        flattened,
        scope,
        instruction,
        metadataByNodeId: metaMap,
        profileKey,
        snapshotId: snapshot.snapshotId,
        baseParentId,
        settings,
        precomputedChromeAiDraft,
        precomputedChromeAiError,
      });

      await defaultStore.savePlan(plan);
      await defaultStore.pruneSnapshots(profileKey, settings.backupRetentionCount);
      return { ok: true, data: plan };
    }

    case 'SAVE_PLAN': {
      await defaultStore.savePlan(message.payload.plan);
      return { ok: true, data: message.payload.plan };
    }

    case 'APPLY_PLAN': {
      const { planId, approvedRevision, resumeJobId } = message.payload;
      const plan = await defaultStore.getPlan(planId);
      if (!plan) {
        return { ok: false, error: '找不到指定的整理方案。' };
      }
      const guardKey = resumeJobId ?? `plan:${planId}`;
      liveWorkerJobIds.add(guardKey);
      try {
        const job = await applyApprovedPlan({
          adapter,
          store: defaultStore,
          plan,
          approvedRevision,
          resumeJobId,
          onBeforeStepWrite: () => {
            // Also register the concrete jobId once created
          },
        });
        await notifyBookmarkChange('plan_applied');
        return { ok: true, data: job };
      } finally {
        liveWorkerJobIds.delete(guardKey);
      }
    }

    case 'RESTORE_JOB': {
      const targetJobId = message.payload.jobId;
      liveWorkerJobIds.add(targetJobId);
      try {
        const job = await restoreJob({
          adapter,
          store: defaultStore,
          jobId: targetJobId,
        });
        await notifyBookmarkChange('job_restored');
        return { ok: true, data: job };
      } finally {
        liveWorkerJobIds.delete(targetJobId);
      }
    }

    case 'RESOLVE_JOB_STEP': {
      const { jobId, opId, resolution } = message.payload;
      if (!['skip', 'retry', 'adopt'].includes(resolution)) {
        return { ok: false, error: '未知的處理方式。' };
      }
      const job = await resolveJobStep({
        adapter,
        store: defaultStore,
        jobId,
        opId,
        resolution,
      });
      return { ok: true, data: job };
    }

    case 'EXPORT_BACKUP': {
      const tree = await adapter.getTree();
      const metadata = await defaultStore.getAllMetadata(profileKey);
      const payload = exportBackupPayload({ tree, metadata, profileKey });
      return { ok: true, data: payload };
    }

    case 'RESTORE_BACKUP': {
      const { backup, targetParentId, branchTitle } = message.payload;
      const result = await restoreBackupToFolder({
        adapter,
        store: defaultStore,
        profileKey,
        payload: backup,
        targetParentId,
        branchTitle,
      });
      await notifyBookmarkChange('backup_restored');
      return { ok: true, data: result };
    }

    case 'SAVE_SETTINGS': {
      const next = { ...message.payload.settings, profileKey };
      await defaultStore.saveSettings(next);
      return { ok: true, data: next };
    }

    case 'PRUNE_SNAPSHOTS': {
      const removed = await defaultStore.pruneSnapshots(
        profileKey,
        Math.max(1, message.payload.retainCount),
      );
      return { ok: true, data: { removed } };
    }

    case 'CHECK_LINKS': {
      const { bookmarkIds } = message.payload;
      const { flattened } = await refreshProjections();
      const targets = bookmarkIds
        .map((id) => flattened.byId.get(id))
        .filter((n): n is NonNullable<typeof n> => Boolean(n && !n.isFolder));

      const batchResult = await runBatchLinkCheck({
        bookmarks: targets,
        isOriginAuthorized: async (originPattern) =>
          chrome.permissions.contains({ origins: [originPattern] }),
      });

      // Persist check results ONLY to Studio local metadata
      for (const [nodeId, linkCheck] of Object.entries(batchResult.results)) {
        const existing = await defaultStore.getMetadata(profileKey, nodeId);
        await defaultStore.upsertMetadata({
          profileKey,
          nodeId,
          tags: existing?.tags ?? [],
          originalDateAdded: existing?.originalDateAdded,
          linkCheck,
          updatedAt: Date.now(),
        });
      }

      return { ok: true, data: batchResult };
    }

    case 'CREATE_DEAD_LINK_PLAN': {
      const { scope, action, baseParentId, includeUnreachable } = message.payload;
      const { flattened } = await refreshProjections();
      const allMeta = await defaultStore.getAllMetadata(profileKey);
      const metaMap = new Map<string, BookmarkMetadata>(
        allMeta.map((m) => [m.nodeId, m]),
      );

      // Save full recoverable snapshot before any quarantine/removal plan
      const snapshot: Snapshot = {
        snapshotId: makeSnapshotId(),
        schemaVersion: 1,
        profileKey,
        createdAt: Date.now(),
        reason: action === 'remove' ? 'delete' : 'organize',
        label:
          action === 'remove'
            ? '失效連結移除前快照'
            : '失效連結移至待清理前快照',
        scope,
        nodes: extractFullSnapshotNodes(flattened),
        metadata: allMeta,
      };
      await defaultStore.saveSnapshot(snapshot);

      const plan = generateDeadLinkCleanupPlan({
        flattened,
        scope,
        metadataByNodeId: metaMap,
        profileKey,
        snapshotId: snapshot.snapshotId,
        action,
        baseParentId,
        includeUnreachable,
      });

      await defaultStore.savePlan(plan);
      const settings = await defaultStore.getSettings(profileKey);
      await defaultStore.pruneSnapshots(profileKey, settings.backupRetentionCount);
      return { ok: true, data: plan };
    }

    case 'CREATE_DUPLICATE_PLAN': {
      const { scope } = message.payload;
      const { flattened } = await refreshProjections();
      const allMeta = await defaultStore.getAllMetadata(profileKey);
      const metaMap = new Map<string, BookmarkMetadata>(
        allMeta.map((m) => [m.nodeId, m]),
      );
      const snapshot: Snapshot = {
        snapshotId: makeSnapshotId(),
        schemaVersion: 1,
        profileKey,
        createdAt: Date.now(),
        reason: 'delete',
        label: '重複書籤清理前快照',
        scope,
        nodes: extractFullSnapshotNodes(flattened),
        metadata: allMeta,
      };
      await defaultStore.saveSnapshot(snapshot);
      const plan = generateDuplicateCleanupPlan({
        flattened,
        scope,
        metadataByNodeId: metaMap,
        profileKey,
        snapshotId: snapshot.snapshotId,
      });
      await defaultStore.savePlan(plan);
      const settings = await defaultStore.getSettings(profileKey);
      await defaultStore.pruneSnapshots(profileKey, settings.backupRetentionCount);
      return { ok: true, data: plan };
    }

    case 'OPEN_STUDIO': {
      await openStudioTab(message.payload?.tab);
      return { ok: true, data: { opened: true } };
    }

    default:
      return { ok: false, error: '未知的訊息類型。' };
  }
}

export default defineBackground(() => {
  // Synchronous top-level event listener registration (MV3 Service Worker lifecycle rule)
  chrome.runtime.onInstalled.addListener(() => {
    void (async () => {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      const adapter = createChromeBookmarkAdapter();
      await reconcileInterruptedJobs({
        adapter,
        store: defaultStore,
        profileKey,
      });
    })();
  });

  chrome.runtime.onStartup.addListener(() => {
    void (async () => {
      const profileKey = await defaultStore.getOrCreateProfileKey();
      const adapter = createChromeBookmarkAdapter();
      await reconcileInterruptedJobs({
        adapter,
        store: defaultStore,
        profileKey,
      });
    })();
  });

  chrome.bookmarks.onCreated.addListener(() => {
    void notifyBookmarkChange('chrome_created');
  });
  chrome.bookmarks.onChanged.addListener(() => {
    void notifyBookmarkChange('chrome_changed');
  });
  chrome.bookmarks.onMoved.addListener(() => {
    void notifyBookmarkChange('chrome_moved');
  });
  chrome.bookmarks.onRemoved.addListener(() => {
    void notifyBookmarkChange('chrome_removed');
  });
  chrome.bookmarks.onChildrenReordered.addListener(() => {
    void notifyBookmarkChange('chrome_reordered');
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (!isTrustedExtensionSender(sender)) {
      sendResponse({
        ok: false,
        error: '拒絕未受信任來源的訊息。',
      } satisfies StudioResponse);
      return false;
    }

    if (!message || typeof message !== 'object' || typeof message.type !== 'string') {
      return false;
    }

    // Ignore internal broadcast notifications
    if (message.type === 'BOOKMARKS_CHANGED') {
      return false;
    }

    const invalid = validateStudioMessage(message);
    if (invalid) {
      sendResponse({ ok: false, error: invalid } satisfies StudioResponse);
      return false;
    }

    (async () => {
      try {
        const result = await handleStudioMessage(message as StudioMessage);
        sendResponse(result);
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        sendResponse({ ok: false, error: errorMsg } satisfies StudioResponse);
      }
    })();

    return true;
  });
});
