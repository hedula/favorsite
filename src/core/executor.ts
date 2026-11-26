import {
  buildProjections,
  computeScopeFingerprint,
  resolveMoveIndex,
  wouldCreateCycle,
} from './bookmark-engine';
import type { FavorsiteStore } from './store';
import type {
  BookmarkApiAdapter,
  ConflictItem,
  ExecutionJob,
  JobStep,
  JobStepResolution,
  OrganizePlan,
  PlanOperation,
} from './types';

function makeJobId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `job_${crypto.randomUUID().slice(0, 12)}`;
  }
  return `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * In-process registry of jobs currently executing (apply / restore / step resolution)
 * inside THIS Service Worker instance. Ephemeral on purpose and never persisted: after the
 * SW is terminated it starts empty, which is exactly how reconciliation tells a live job
 * from one orphaned by a crash. Every writer registers here, so no caller can forget to
 * pass its live IDs to `reconcileInterruptedJobs`.
 */
const liveJobIds = new Set<string>();

export function isJobLiveInProcess(jobId: string): boolean {
  return liveJobIds.has(jobId);
}

function claimLiveJob(jobId: string): void {
  if (liveJobIds.has(jobId)) {
    throw new Error('此工作正在執行中，請稍候再操作。');
  }
  liveJobIds.add(jobId);
}

async function pauseStepOnConflict(params: {
  store: FavorsiteStore;
  job: ExecutionJob;
  step: JobStep;
  resultCode: string;
  kind: ConflictItem['kind'];
  message: string;
  nodeId?: string;
}): Promise<ExecutionJob> {
  const { store, job, step, resultCode, kind, message, nodeId } = params;
  const now = Date.now();
  step.status = 'conflict';
  step.resultCode = resultCode;
  step.errorMessage = message;
  step.updatedAt = now;
  job.status = 'paused_conflict';
  job.conflicts.push({ opId: step.opId, nodeId, kind, message });
  job.completedCount = countCompleted(job.steps);
  job.updatedAt = now;
  await store.saveJob(job);
  return job;
}

function buildInitialSteps(operations: PlanOperation[]): JobStep[] {
  const now = Date.now();
  return operations.map((op) => ({
    opId: op.opId,
    opType: op.type,
    intent: op,
    status: op.enabled ? 'pending' : 'skipped',
    resultCode: op.enabled ? 'PENDING' : 'USER_SKIPPED',
    updatedAt: now,
  }));
}

function countCompleted(steps: JobStep[]): number {
  return steps.filter((s) => s.status === 'applied').length;
}

/**
 * Reconciles any jobs left in `running` or `restoring` state after a Service Worker
 * termination/restart. Never blindly re-executes ambiguous operations.
 */
export async function reconcileInterruptedJobs(params: {
  adapter: BookmarkApiAdapter;
  store: FavorsiteStore;
  profileKey: string;
  /** Job IDs actively executing in the current live worker instance (not orphaned) */
  activeJobIds?: ReadonlySet<string>;
}): Promise<ExecutionJob[]> {
  const { adapter, store, profileKey, activeJobIds } = params;
  const jobs = await store.listJobs(profileKey);
  const interrupted: ExecutionJob[] = [];

  const stuckJobs = jobs.filter(
    (j) =>
      (j.status === 'running' || j.status === 'restoring') &&
      !liveJobIds.has(j.jobId) &&
      !activeJobIds?.has(j.jobId) &&
      !activeJobIds?.has(`plan:${j.planId}`),
  );
  if (stuckJobs.length === 0) {
    await releaseOrphanedLock(store, profileKey, activeJobIds);
    return interrupted;
  }

  const liveTree = await adapter.getTree();
  const flattened = buildProjections(liveTree, profileKey);

  for (const job of stuckJobs) {
    const conflicts: ConflictItem[] = [...job.conflicts];
    const now = Date.now();

    for (const step of job.steps) {
      if (step.status !== 'in_progress') continue;

      const intent = step.intent;
      if (intent.type === 'createFolder') {
        const parentId = intent.parentId;
        const siblings = flattened.childrenByParent.get(parentId) ?? [];
        const matches = siblings.filter(
          (c) => c.isFolder && c.title === intent.title,
        );
        if (matches.length > 0) {
          // Ambiguous whether this folder was created by us just before crash or externally
          step.status = 'needs_confirmation';
          step.resultCode = 'AMBIGUOUS_CREATE';
          step.errorMessage = `資料夾「${intent.title}」已存在，需確認是否沿用或略過以避免重複建立`;
          conflicts.push({
            opId: step.opId,
            kind: 'ambiguous_state',
            message: step.errorMessage,
          });
        } else {
          step.status = 'pending';
          step.resultCode = 'RECONCILED_PENDING';
        }
      } else if (intent.type === 'moveBookmark') {
        const liveNode = flattened.byId.get(intent.nodeId);
        const targetParentId = intent.toTempFolderId
          ? job.tempFolderMap[intent.toTempFolderId]
          : intent.toParentId;

        if (!liveNode) {
          step.status = 'conflict';
          step.resultCode = 'NODE_MISSING';
          conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: `書籤「${intent.bookmarkTitle}」已不存在`,
          });
        } else if (targetParentId && liveNode.parentId === targetParentId) {
          step.status = 'applied';
          step.afterRef = {
            nodeId: liveNode.nodeId,
            parentId: liveNode.parentId,
            index: liveNode.index,
            title: liveNode.title,
          };
          step.resultCode = 'RECONCILED_APPLIED';
        } else if (
          step.beforeRef &&
          liveNode.parentId === step.beforeRef.parentId
        ) {
          step.status = 'pending';
          step.resultCode = 'RECONCILED_PENDING';
        } else {
          step.status = 'needs_confirmation';
          step.resultCode = 'AMBIGUOUS_MOVE';
          conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'ambiguous_state',
            message: `書籤「${intent.bookmarkTitle}」目前位置與預期不符，請確認後再續跑`,
          });
        }
      } else if (intent.type === 'renameBookmark') {
        const liveNode = flattened.byId.get(intent.nodeId);
        if (!liveNode) {
          step.status = 'conflict';
          step.resultCode = 'NODE_MISSING';
          conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: `書籤「${intent.oldTitle}」已不存在`,
          });
        } else if (liveNode.title === intent.newTitle) {
          step.status = 'applied';
          step.afterRef = { nodeId: liveNode.nodeId, title: liveNode.title };
          step.resultCode = 'RECONCILED_APPLIED';
        } else if (liveNode.title === intent.oldTitle) {
          step.status = 'pending';
          step.resultCode = 'RECONCILED_PENDING';
        } else {
          step.status = 'conflict';
          step.resultCode = 'NODE_MODIFIED';
          conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_modified',
            message: `書籤標題已被改為「${liveNode.title}」`,
          });
        }
      } else if (intent.type === 'addTag') {
        const meta = await store.getMetadata(profileKey, intent.nodeId);
        const currentTags = new Set(meta?.tags ?? []);
        const allPresent = intent.tagsToAdd.every((t) => currentTags.has(t));
        if (allPresent) {
          step.status = 'applied';
          step.afterRef = { nodeId: intent.nodeId, tags: meta?.tags ?? [] };
          step.resultCode = 'RECONCILED_APPLIED';
        } else {
          step.status = 'pending';
          step.resultCode = 'RECONCILED_PENDING';
        }
      } else if (intent.type === 'removeBookmark') {
        const liveNode = flattened.byId.get(intent.nodeId);
        if (!liveNode) {
          step.status = 'applied';
          step.afterRef = { removedNodeId: intent.nodeId };
          step.resultCode = 'RECONCILED_APPLIED';
        } else if (
          step.beforeRef &&
          liveNode.parentId === step.beforeRef.parentId &&
          liveNode.url === step.beforeRef.url
        ) {
          step.status = 'pending';
          step.resultCode = 'RECONCILED_PENDING';
        } else {
          step.status = 'needs_confirmation';
          step.resultCode = 'AMBIGUOUS_REMOVE';
          conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'ambiguous_state',
            message: `書籤「${intent.bookmarkTitle}」在中斷期間狀態已變動，請確認後再處理`,
          });
        }
      }
      step.updatedAt = now;
    }

    job.status = 'interrupted';
    job.conflicts = conflicts;
    job.completedCount = countCompleted(job.steps);
    job.updatedAt = now;

    await store.saveJob(job);
    await store.releaseJobLock(profileKey, job.jobId);
    interrupted.push(job);
  }

  await releaseOrphanedLock(store, profileKey, activeJobIds);
  return interrupted;
}

/**
 * A lock whose owner is not executing in this SW instance can only be left over from a
 * terminated worker (e.g. killed between acquiring the lock and persisting the job), so it
 * would otherwise block every future write for this profile forever.
 */
async function releaseOrphanedLock(
  store: FavorsiteStore,
  profileKey: string,
  activeJobIds?: ReadonlySet<string>,
): Promise<void> {
  const lock = await store.getJobLock(profileKey);
  if (!lock) return;
  if (liveJobIds.has(lock.jobId) || activeJobIds?.has(lock.jobId)) return;
  await store.releaseJobLock(profileKey, lock.jobId);
}

export interface ApplyPlanOptions {
  adapter: BookmarkApiAdapter;
  store: FavorsiteStore;
  plan: OrganizePlan;
  approvedRevision: number;
  resumeJobId?: string;
  /** Optional test hook called right after writing `in_progress` and before Chrome API call */
  onBeforeStepWrite?: (step: JobStep) => Promise<void> | void;
  /** Optional test hook called right after Chrome API call and BEFORE updating step to `applied` */
  onAfterApiBeforeLog?: (step: JobStep) => Promise<void> | void;
}

export async function applyApprovedPlan(
  options: ApplyPlanOptions,
): Promise<ExecutionJob> {
  const { adapter, store, plan, approvedRevision, resumeJobId } = options;
  const profileKey = plan.profileKey;

  if (plan.revision !== approvedRevision) {
    throw new Error(
      `方案版本不符（已確認 v${approvedRevision}，目前為 v${plan.revision}），請重新預覽並確認。`,
    );
  }

  // Reconcile any previously crashed jobs first
  await reconcileInterruptedJobs({ adapter, store, profileKey });

  let job: ExecutionJob;
  const isResuming = Boolean(resumeJobId);

  if (resumeJobId) {
    const existing = await store.getJob(resumeJobId);
    if (!existing) {
      throw new Error(`找不到要繼續的工作：${resumeJobId}`);
    }
    if (existing.status === 'completed' || existing.status === 'restored') {
      return existing;
    }
    job = existing;
  } else {
    const enabledCount = plan.operations.filter((o) => o.enabled).length;
    const now = Date.now();
    job = {
      jobId: makeJobId(),
      profileKey,
      planId: plan.planId,
      approvedRevision,
      snapshotId: plan.snapshotId,
      instruction: plan.instruction,
      status: 'pending',
      steps: buildInitialSteps(plan.operations),
      tempFolderMap: {},
      conflicts: [],
      completedCount: 0,
      totalCount: enabledCount,
      createdAt: now,
      updatedAt: now,
    };
  }

  claimLiveJob(job.jobId);
  let lockAcquired = false;
  try {
    lockAcquired = await store.acquireJobLock(profileKey, job.jobId);
  } finally {
    if (!lockAcquired) liveJobIds.delete(job.jobId);
  }
  if (!lockAcquired) {
    throw new Error('此 Chrome 設定檔目前已有另一個寫入工作正在執行中。');
  }

  try {
    // Pre-flight check against live Chrome bookmark tree
    const initialTree = await adapter.getTree();
    const initialFlattened = buildProjections(initialTree, profileKey);

    if (!isResuming) {
      const liveFingerprint = computeScopeFingerprint(
        initialFlattened,
        plan.scope,
      );
      if (liveFingerprint !== plan.scopeFingerprint) {
        job.status = 'paused_conflict';
        job.conflicts = [
          {
            kind: 'scope_changed',
            message:
              '書籤或資料夾順序已發生外部變更，已暫停套用。請先檢查最新的書籤狀態。',
          },
        ];
        job.updatedAt = Date.now();
        await store.saveJob(job);
        await store.savePlan({
          ...plan,
          status: 'stale',
          updatedAt: Date.now(),
        });
        return job;
      }
    }

    job.status = 'running';
    job.conflicts = [];
    job.updatedAt = Date.now();
    await store.saveJob(job);

    for (const step of job.steps) {
      if (
        step.status === 'applied' ||
        step.status === 'skipped' ||
        step.status === 'restored'
      ) {
        continue;
      }

      if (step.status === 'needs_confirmation' || step.status === 'conflict') {
        job.status = 'paused_conflict';
        job.conflicts.push({
          opId: step.opId,
          kind: 'ambiguous_state',
          message:
            step.errorMessage ?? '此步驟狀態待確認，已暫停以避免重複寫入',
        });
        job.updatedAt = Date.now();
        await store.saveJob(job);
        return job;
      }

      const intent = step.intent;

      // Check dependency on createFolder
      if (intent.dependsOnOpId) {
        const dep = job.steps.find((s) => s.opId === intent.dependsOnOpId);
        if (!dep || dep.status !== 'applied') {
          step.status = 'skipped';
          step.resultCode = 'DEPENDENCY_SKIPPED';
          step.updatedAt = Date.now();
          await store.saveJob(job);
          continue;
        }
      }

      // Refresh live tree before each write step for accurate verification & indices
      const liveTree = await adapter.getTree();
      const liveFlattened = buildProjections(liveTree, profileKey);

      if (intent.type === 'createFolder') {
        const parent = liveFlattened.byId.get(intent.parentId);
        if (!parent || !parent.isFolder || !parent.canAddChild) {
          const msg = `目的父資料夾不可寫入或已刪除：${intent.parentPath}`;
          step.status = 'conflict';
          step.resultCode = 'PARENT_NOT_WRITABLE';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: intent.parentId,
            kind: 'parent_not_writable',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        step.status = 'in_progress';
        step.beforeRef = { parentId: intent.parentId, title: intent.title };
        step.resultCode = 'IN_PROGRESS';
        step.updatedAt = Date.now();
        await store.saveJob(job);
        if (options.onBeforeStepWrite) await options.onBeforeStepWrite(step);

        const created = await adapter.create({
          parentId: intent.parentId,
          title: intent.title,
          index: intent.index,
        });
        if (options.onAfterApiBeforeLog) await options.onAfterApiBeforeLog(step);

        // Read-back verify
        const [verified] = await adapter.get(created.id);
        if (!verified || verified.parentId !== intent.parentId) {
          throw new Error(`新建資料夾讀回驗證失敗：${intent.title}`);
        }

        job.tempFolderMap[intent.tempFolderId] = verified.id;
        step.afterRef = {
          nodeId: verified.id,
          parentId: verified.parentId,
          index: verified.index,
          title: verified.title,
        };
        step.status = 'applied';
        step.resultCode = 'OK';
        step.updatedAt = Date.now();
        job.completedCount = countCompleted(job.steps);
        job.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'moveBookmark') {
        const liveNode = liveFlattened.byId.get(intent.nodeId);
        if (!liveNode || !liveNode.writable) {
          const msg = `書籤「${intent.bookmarkTitle}」已遺失或不可寫入`;
          step.status = 'conflict';
          step.resultCode = 'NODE_MISSING';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        // Drift guard (also covers resumed jobs, which skip the scope fingerprint):
        // never re-move a bookmark the user relocated after the preview.
        if (!step.confirmedByUser && liveNode.parentId !== intent.fromParentId) {
          return pauseStepOnConflict({
            store,
            job,
            step,
            resultCode: 'NODE_MODIFIED',
            kind: 'node_modified',
            nodeId: intent.nodeId,
            message: `書籤「${intent.bookmarkTitle}」在預覽後已被移至其他資料夾，已暫停以免覆蓋您的變更`,
          });
        }

        const destParentId = intent.toTempFolderId
          ? job.tempFolderMap[intent.toTempFolderId]
          : intent.toParentId;

        const destFolder = destParentId
          ? liveFlattened.byId.get(destParentId)
          : undefined;

        if (!destParentId || !destFolder || !destFolder.isFolder || !destFolder.canAddChild) {
          const msg = `目的資料夾不可寫入或不存在：${intent.toPath}`;
          step.status = 'conflict';
          step.resultCode = 'PARENT_NOT_WRITABLE';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: destParentId,
            kind: 'parent_not_writable',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        if (
          liveNode.isFolder &&
          wouldCreateCycle(liveNode.nodeId, destParentId, liveFlattened.byId)
        ) {
          const msg = `偵測到資料夾循環搬移：${liveNode.title}`;
          step.status = 'conflict';
          step.resultCode = 'CYCLE_DETECTED';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: liveNode.nodeId,
            kind: 'cycle_detected',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        const liveDestChildren = await adapter.getChildren(destParentId);
        const moveIndex = resolveMoveIndex({
          liveTargetChildIds: liveDestChildren.map((c) => c.id),
          movingNodeId: liveNode.nodeId,
          sameParent: liveNode.parentId === destParentId,
          desiredFinalIndex: intent.toIndex,
          beforeSiblingId: intent.beforeSiblingId,
          afterSiblingId: intent.afterSiblingId,
        });

        step.status = 'in_progress';
        step.beforeRef = {
          nodeId: liveNode.nodeId,
          parentId: liveNode.parentId,
          index: liveNode.index,
          title: liveNode.title,
        };
        step.resultCode = 'IN_PROGRESS';
        step.updatedAt = Date.now();
        await store.saveJob(job);
        if (options.onBeforeStepWrite) await options.onBeforeStepWrite(step);

        const moveDest: { parentId: string; index?: number } = {
          parentId: destParentId,
        };
        if (moveIndex !== undefined) {
          moveDest.index = moveIndex;
        }
        await adapter.move(liveNode.nodeId, moveDest);
        if (options.onAfterApiBeforeLog) await options.onAfterApiBeforeLog(step);

        // Read-back verify
        const [verified] = await adapter.get(liveNode.nodeId);
        if (!verified || verified.parentId !== destParentId) {
          throw new Error(`書籤「${liveNode.title}」搬移讀回驗證失敗`);
        }

        step.afterRef = {
          nodeId: verified.id,
          parentId: verified.parentId,
          index: verified.index,
          title: verified.title,
        };
        step.status = 'applied';
        step.resultCode = 'OK';
        step.updatedAt = Date.now();
        job.completedCount = countCompleted(job.steps);
        job.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'renameBookmark') {
        const liveNode = liveFlattened.byId.get(intent.nodeId);
        if (!liveNode || !liveNode.writable) {
          const msg = `書籤「${intent.oldTitle}」已遺失或不可寫入`;
          step.status = 'conflict';
          step.resultCode = 'NODE_MISSING';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        if (!step.confirmedByUser && liveNode.title !== intent.oldTitle) {
          return pauseStepOnConflict({
            store,
            job,
            step,
            resultCode: 'NODE_MODIFIED',
            kind: 'node_modified',
            nodeId: intent.nodeId,
            message: `書籤標題在預覽後已被改為「${liveNode.title}」，已暫停以免覆蓋您的變更`,
          });
        }

        step.status = 'in_progress';
        step.beforeRef = {
          nodeId: liveNode.nodeId,
          title: liveNode.title,
        };
        step.resultCode = 'IN_PROGRESS';
        step.updatedAt = Date.now();
        await store.saveJob(job);
        if (options.onBeforeStepWrite) await options.onBeforeStepWrite(step);

        await adapter.update(liveNode.nodeId, { title: intent.newTitle });
        if (options.onAfterApiBeforeLog) await options.onAfterApiBeforeLog(step);

        const [verified] = await adapter.get(liveNode.nodeId);
        if (!verified || verified.title !== intent.newTitle) {
          throw new Error(`書籤「${liveNode.title}」重新命名讀回驗證失敗`);
        }

        step.afterRef = { nodeId: verified.id, title: verified.title };
        step.status = 'applied';
        step.resultCode = 'OK';
        step.updatedAt = Date.now();
        job.completedCount = countCompleted(job.steps);
        job.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'addTag') {
        const existingMeta = await store.getMetadata(profileKey, intent.nodeId);
        const beforeTags = existingMeta?.tags ?? [];
        const mergedTags = Array.from(
          new Set([...beforeTags, ...intent.tagsToAdd]),
        );

        step.status = 'in_progress';
        step.beforeRef = { nodeId: intent.nodeId, tags: beforeTags };
        step.resultCode = 'IN_PROGRESS';
        step.updatedAt = Date.now();
        await store.saveJob(job);
        if (options.onBeforeStepWrite) await options.onBeforeStepWrite(step);

        await store.upsertMetadata({
          profileKey,
          nodeId: intent.nodeId,
          tags: mergedTags,
          originalDateAdded: existingMeta?.originalDateAdded,
          linkCheck: existingMeta?.linkCheck,
          updatedAt: Date.now(),
        });
        if (options.onAfterApiBeforeLog) await options.onAfterApiBeforeLog(step);

        step.afterRef = { nodeId: intent.nodeId, tags: mergedTags };
        step.status = 'applied';
        step.resultCode = 'OK';
        step.updatedAt = Date.now();
        job.completedCount = countCompleted(job.steps);
        job.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'removeBookmark') {
        const liveNode = liveFlattened.byId.get(intent.nodeId);
        if (!liveNode || !liveNode.writable || liveNode.isFolder) {
          const msg = `書籤「${intent.bookmarkTitle}」已遺失、為資料夾或不可移除`;
          step.status = 'conflict';
          step.resultCode = 'NODE_MISSING';
          step.errorMessage = msg;
          step.updatedAt = Date.now();
          job.status = 'paused_conflict';
          job.conflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
          job.completedCount = countCompleted(job.steps);
          job.updatedAt = Date.now();
          await store.saveJob(job);
          return job;
        }

        if (
          !step.confirmedByUser &&
          (liveNode.url !== intent.bookmarkUrl ||
            liveNode.parentId !== intent.parentId)
        ) {
          return pauseStepOnConflict({
            store,
            job,
            step,
            resultCode: 'NODE_MODIFIED',
            kind: 'node_modified',
            nodeId: intent.nodeId,
            message: `書籤「${intent.bookmarkTitle}」的網址或位置已變更，已暫停移除。`,
          });
        }

        if (intent.removalKind === 'duplicate_exact' && intent.keepNodeId) {
          const keeper = liveFlattened.byId.get(intent.keepNodeId);
          if (!keeper || keeper.url !== liveNode.url) {
            return pauseStepOnConflict({
              store,
              job,
              step,
              resultCode: 'DUPLICATE_KEEPER_CHANGED',
              kind: 'node_modified',
              nodeId: intent.keepNodeId,
              message: `要保留的書籤「${intent.keepTitle || intent.bookmarkTitle}」已變更或遺失，請核對後再操作。`,
            });
          }
        }

        const existingMeta = await store.getMetadata(profileKey, liveNode.nodeId);
        step.status = 'in_progress';
        step.beforeRef = {
          nodeId: liveNode.nodeId,
          parentId: liveNode.parentId,
          index: liveNode.index,
          title: liveNode.title,
          url: liveNode.url,
          dateAdded: existingMeta?.originalDateAdded ?? liveNode.dateAdded,
          tags: existingMeta?.tags ?? [],
          linkCheck: existingMeta?.linkCheck,
        };
        step.resultCode = 'IN_PROGRESS';
        step.updatedAt = Date.now();
        await store.saveJob(job);
        if (options.onBeforeStepWrite) await options.onBeforeStepWrite(step);

        await adapter.remove(liveNode.nodeId);
        if (options.onAfterApiBeforeLog) await options.onAfterApiBeforeLog(step);

        // Read-back verify removal
        let stillExists = false;
        try {
          const check = await adapter.get(liveNode.nodeId);
          stillExists = check.length > 0;
        } catch {
          stillExists = false;
        }
        if (stillExists) {
          throw new Error(`書籤「${liveNode.title}」移除讀回驗證失敗`);
        }

        step.afterRef = { removedNodeId: liveNode.nodeId };
        step.status = 'applied';
        step.resultCode = 'OK';
        step.updatedAt = Date.now();
        job.completedCount = countCompleted(job.steps);
        job.updatedAt = Date.now();
        await store.saveJob(job);
      }
    }

    job.status = 'completed';
    job.completedCount = countCompleted(job.steps);
    job.updatedAt = Date.now();
    await store.saveJob(job);
    await store.savePlan({
      ...plan,
      status: 'applied',
      updatedAt: Date.now(),
    });

    return job;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    job.status = 'failed';
    job.conflicts.push({
      kind: 'api_error',
      message,
    });
    job.completedCount = countCompleted(job.steps);
    job.updatedAt = Date.now();
    await store.saveJob(job);
    throw err;
  } finally {
    try {
      await store.releaseJobLock(profileKey, job.jobId);
    } finally {
      liveJobIds.delete(job.jobId);
    }
  }
}

export async function restoreJob(params: {
  adapter: BookmarkApiAdapter;
  store: FavorsiteStore;
  jobId: string;
}): Promise<ExecutionJob> {
  const { adapter, store, jobId } = params;
  const job = await store.getJob(jobId);
  if (!job) {
    throw new Error(`找不到工作紀錄：${jobId}`);
  }
  const profileKey = job.profileKey;

  await reconcileInterruptedJobs({ adapter, store, profileKey });

  claimLiveJob(job.jobId);
  let lockAcquired = false;
  try {
    lockAcquired = await store.acquireJobLock(profileKey, job.jobId);
  } finally {
    if (!lockAcquired) liveJobIds.delete(job.jobId);
  }
  if (!lockAcquired) {
    throw new Error('此 Chrome 設定檔目前已有另一個寫入工作正在執行中。');
  }

  const restoreConflicts: ConflictItem[] = [];
  try {
    job.status = 'restoring';
    job.updatedAt = Date.now();
    await store.saveJob(job);

    // Reverse walk applied steps
    const reversedSteps = [...job.steps].reverse();

    for (const step of reversedSteps) {
      if (step.status !== 'applied') continue;

      const intent = step.intent;
      const beforeRef = step.beforeRef ?? {};
      const afterRef = step.afterRef ?? {};

      // Write-ahead marker: persisted BEFORE any Chrome write so that a re-run after a
      // crash between the Chrome write and the log update can recognise its own effect
      // instead of repeating it (e.g. recreating a removed bookmark twice).
      const resumingThisStep = step.resultCode === 'RESTORE_IN_PROGRESS';
      step.resultCode = 'RESTORE_IN_PROGRESS';
      step.updatedAt = Date.now();
      await store.saveJob(job);

      if (intent.type === 'addTag') {
        const currentMeta = await store.getMetadata(profileKey, intent.nodeId);
        const currentTags = currentMeta?.tags ?? [];
        const expectedAfterTags = (afterRef.tags as string[]) ?? [];
        const beforeTags = (beforeRef.tags as string[]) ?? [];
        const sameSet = (a: string[], b: string[]) =>
          a.length === b.length && b.every((t) => a.includes(t));

        if (resumingThisStep && sameSet(currentTags, beforeTags)) {
          step.status = 'restored';
          step.resultCode = 'RESTORED';
        } else if (!sameSet(currentTags, expectedAfterTags)) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_MODIFIED';
          const msg = `書籤「${intent.bookmarkTitle}」的標籤後來已被修改，保留目前標籤`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_modified',
            message: msg,
          });
        } else {
          await store.upsertMetadata({
            profileKey,
            nodeId: intent.nodeId,
            tags: beforeTags,
            originalDateAdded: currentMeta?.originalDateAdded,
            linkCheck: currentMeta?.linkCheck,
            updatedAt: Date.now(),
          });
          step.status = 'restored';
          step.resultCode = 'RESTORED';
        }
        step.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'removeBookmark') {
        const liveTree = await adapter.getTree();
        const liveFlattened = buildProjections(liveTree, profileKey);
        const origParentId = String(beforeRef.parentId ?? intent.parentId);
        const origParent = liveFlattened.byId.get(origParentId);
        const origUrl = String(beforeRef.url ?? intent.bookmarkUrl ?? '');
        const origTitle = String(beforeRef.title ?? intent.bookmarkTitle);

        if (!origParent || !origParent.canAddChild) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_PARENT';
          const msg = `原資料夾已不存在或不可寫入，無法還原已移除的書籤「${origTitle}」`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'parent_not_writable',
            message: msg,
          });
        } else if (!origUrl) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_URL';
          const msg = `書籤「${origTitle}」缺少原始網址紀錄，無法自動重建`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
        } else {
          const liveChildren = await adapter.getChildren(origParentId);
          // After an interrupted restore, adopt the bookmark we already recreated
          const alreadyRecreated = resumingThisStep
            ? liveChildren.find(
                (c) =>
                  c.url === origUrl &&
                  c.title === origTitle &&
                  c.id !== intent.nodeId,
              )
            : undefined;
          let recreatedId: string;
          if (alreadyRecreated) {
            recreatedId = alreadyRecreated.id;
          } else {
            const origIndex =
              typeof beforeRef.index === 'number'
                ? Math.max(0, Math.min(beforeRef.index, liveChildren.length))
                : liveChildren.length;
            const recreated = await adapter.create({
              parentId: origParentId,
              index: origIndex,
              title: origTitle,
              url: origUrl,
            });
            recreatedId = recreated.id;
          }
          const beforeTags = Array.isArray(beforeRef.tags)
            ? (beforeRef.tags as string[])
            : [];
          const origDateAdded =
            typeof beforeRef.dateAdded === 'number'
              ? beforeRef.dateAdded
              : undefined;
          const origLinkCheck = beforeRef.linkCheck as
            | import('./types').LinkCheckRecord
            | undefined;
          if (beforeTags.length > 0 || origDateAdded !== undefined || origLinkCheck) {
            await store.upsertMetadata({
              profileKey,
              nodeId: recreatedId,
              tags: beforeTags,
              originalDateAdded: origDateAdded,
              linkCheck: origLinkCheck,
              updatedAt: Date.now(),
            });
          }
          step.afterRef = {
            ...afterRef,
            restoredNodeId: recreatedId,
          };
          step.status = 'restored';
          step.resultCode = alreadyRecreated ? 'RESTORED_RECONCILED' : 'RESTORED';
        }
        step.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'renameBookmark') {
        const liveTree = await adapter.getTree();
        const liveFlattened = buildProjections(liveTree, profileKey);
        const liveNode = liveFlattened.byId.get(intent.nodeId);
        const originalTitle = String(beforeRef.title ?? intent.oldTitle);

        if (!liveNode) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_MISSING';
          const msg = `書籤「${intent.newTitle}」已不存在，無法復原名稱`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
        } else if (resumingThisStep && liveNode.title === originalTitle) {
          step.status = 'restored';
          step.resultCode = 'RESTORED_RECONCILED';
        } else if (liveNode.title !== afterRef.title) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_MODIFIED';
          const msg = `書籤名稱後來已被改為「${liveNode.title}」，保留目前名稱`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_modified',
            message: msg,
          });
        } else {
          await adapter.update(intent.nodeId, { title: originalTitle });
          step.status = 'restored';
          step.resultCode = 'RESTORED';
        }
        step.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'moveBookmark') {
        const liveTree = await adapter.getTree();
        const liveFlattened = buildProjections(liveTree, profileKey);
        const liveNode = liveFlattened.byId.get(intent.nodeId);
        const origParentId = String(beforeRef.parentId ?? intent.fromParentId);
        const origParent = liveFlattened.byId.get(origParentId);

        if (!liveNode) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_MISSING';
          const msg = `書籤「${intent.bookmarkTitle}」已不存在，無法復原位置`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_missing',
            message: msg,
          });
        } else if (resumingThisStep && liveNode.parentId === origParentId) {
          step.status = 'restored';
          step.resultCode = 'RESTORED_RECONCILED';
        } else if (liveNode.parentId !== afterRef.parentId) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_MODIFIED';
          const msg = `書籤「${intent.bookmarkTitle}」後來已被移動至其他位置，保留目前資料`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'node_modified',
            message: msg,
          });
        } else if (!origParent || !origParent.canAddChild) {
          step.status = 'conflict';
          step.resultCode = 'RESTORE_CONFLICT_PARENT';
          const msg = `原資料夾已不存在或不可寫入，無法移回「${intent.bookmarkTitle}」`;
          step.errorMessage = msg;
          restoreConflicts.push({
            opId: step.opId,
            nodeId: intent.nodeId,
            kind: 'parent_not_writable',
            message: msg,
          });
        } else {
          const liveOrigChildren = await adapter.getChildren(origParentId);
          const origIndex =
            typeof beforeRef.index === 'number'
              ? beforeRef.index
              : intent.fromIndex;
          const moveIdx = resolveMoveIndex({
            liveTargetChildIds: liveOrigChildren.map((c) => c.id),
            movingNodeId: liveNode.nodeId,
            sameParent: liveNode.parentId === origParentId,
            desiredFinalIndex: origIndex,
          });
          await adapter.move(liveNode.nodeId, {
            parentId: origParentId,
            ...(moveIdx !== undefined ? { index: moveIdx } : {}),
          });
          step.status = 'restored';
          step.resultCode = 'RESTORED';
        }
        step.updatedAt = Date.now();
        await store.saveJob(job);
      } else if (intent.type === 'createFolder') {
        const createdId =
          String(afterRef.nodeId ?? '') || job.tempFolderMap[intent.tempFolderId];

        if (!createdId) {
          step.status = 'restored';
          step.resultCode = 'NOTHING_TO_RESTORE';
        } else if (afterRef.adopted === true) {
          // The user chose to reuse a pre-existing folder; never delete it on undo
          step.status = 'restored';
          step.resultCode = 'ADOPTED_KEPT';
        } else {
          const liveTree = await adapter.getTree();
          const liveFlattened = buildProjections(liveTree, profileKey);
          const liveFolder = liveFlattened.byId.get(createdId);

          if (!liveFolder) {
            step.status = 'restored';
            step.resultCode = 'ALREADY_REMOVED';
          } else {
            const children = await adapter.getChildren(createdId);
            if (children.length > 0) {
              // Preserve folder if it contains subsequent content
              step.status = 'conflict';
              step.resultCode = 'FOLDER_NOT_EMPTY';
              const msg = `新建資料夾「${liveFolder.title}」目前仍有 ${children.length} 筆內容，已保留資料夾`;
              step.errorMessage = msg;
              restoreConflicts.push({
                opId: step.opId,
                nodeId: createdId,
                kind: 'folder_not_empty',
                message: msg,
              });
            } else {
              await adapter.remove(createdId);
              step.status = 'restored';
              step.resultCode = 'RESTORED';
            }
          }
        }
        step.updatedAt = Date.now();
        await store.saveJob(job);
      }
    }

    job.conflicts = restoreConflicts;
    job.status = 'restored';
    job.updatedAt = Date.now();
    await store.saveJob(job);
    return job;
  } catch (err) {
    // Leave a resumable record: steps still marked RESTORE_IN_PROGRESS are
    // reconciled (not repeated) when the user runs the restore again.
    const message = err instanceof Error ? err.message : String(err);
    job.status = 'interrupted';
    job.conflicts = [
      ...restoreConflicts,
      { kind: 'api_error', message: `復原中斷：${message}；請再次執行「復原此批次」。` },
    ];
    job.updatedAt = Date.now();
    try {
      await store.saveJob(job);
    } catch {
      // The persisted 'restoring' state is reconciled to 'interrupted' on next start
    }
    throw err;
  } finally {
    try {
      await store.releaseJobLock(profileKey, job.jobId);
    } finally {
      liveJobIds.delete(job.jobId);
    }
  }
}

/**
 * Lets the user settle a step that the executor or crash reconciliation paused on
 * (`needs_confirmation` / `conflict`), so an interrupted job is never stuck forever:
 * - `skip`: leave Chrome as is and continue with the remaining steps on resume;
 * - `retry`: re-run the step on resume, accepting the drift the user has reviewed;
 * - `adopt`: (createFolder only) reuse the existing same-named folder instead of
 *   creating a duplicate; an adopted folder is never deleted by undo.
 */
export async function resolveJobStep(params: {
  adapter: BookmarkApiAdapter;
  store: FavorsiteStore;
  jobId: string;
  opId: string;
  resolution: JobStepResolution;
}): Promise<ExecutionJob> {
  const { adapter, store, jobId, opId, resolution } = params;
  claimLiveJob(jobId);
  try {
    const job = await store.getJob(jobId);
    if (!job) {
      throw new Error(`找不到工作紀錄：${jobId}`);
    }
    if (job.status !== 'paused_conflict' && job.status !== 'interrupted') {
      throw new Error('只有「衝突暫停」或「中斷待核對」的工作可以處理待確認步驟。');
    }
    const step = job.steps.find((s) => s.opId === opId);
    if (!step) {
      throw new Error(`找不到步驟：${opId}`);
    }
    if (step.status !== 'needs_confirmation' && step.status !== 'conflict') {
      throw new Error('此步驟目前不需要確認。');
    }

    if (resolution === 'skip') {
      step.status = 'skipped';
      step.resultCode = 'USER_SKIPPED_AFTER_CONFLICT';
    } else if (resolution === 'retry') {
      step.status = 'pending';
      step.resultCode = 'USER_RETRY';
      step.confirmedByUser = true;
      step.errorMessage = undefined;
    } else if (resolution === 'adopt') {
      const intent = step.intent;
      if (intent.type !== 'createFolder') {
        throw new Error('只有「新建資料夾」步驟可以沿用既有資料夾。');
      }
      const flattened = buildProjections(await adapter.getTree(), job.profileKey);
      const matches = (flattened.childrenByParent.get(intent.parentId) ?? []).filter(
        (c) => c.isFolder && c.canAddChild && c.title === intent.title,
      );
      if (matches.length === 0) {
        throw new Error(`找不到可沿用的資料夾「${intent.title}」，請改選重試或略過。`);
      }
      const chosen = matches.reduce((a, b) =>
        (b.dateAdded ?? 0) >= (a.dateAdded ?? 0) ? b : a,
      );
      job.tempFolderMap[intent.tempFolderId] = chosen.nodeId;
      step.status = 'applied';
      step.resultCode = 'USER_ADOPTED';
      step.errorMessage = undefined;
      step.afterRef = {
        nodeId: chosen.nodeId,
        parentId: chosen.parentId,
        index: chosen.index,
        title: chosen.title,
        adopted: true,
      };
    } else {
      throw new Error('未知的處理方式。');
    }

    const now = Date.now();
    step.updatedAt = now;
    job.conflicts = job.conflicts.filter((c) => c.opId !== opId);
    job.completedCount = countCompleted(job.steps);
    job.updatedAt = now;
    await store.saveJob(job);
    return job;
  } finally {
    liveJobIds.delete(jobId);
  }
}
