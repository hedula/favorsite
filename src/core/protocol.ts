import type { RestoreBackupResult } from './backup';
import type { BatchLinkCheckResult } from './link-checker';
import type { DeadLinkCleanupAction, DraftOperationInput } from './planner';
import type {
  AiProviderPreference,
  AppSettings,
  BackupPayload,
  BookmarkMetadata,
  BookmarkProjection,
  ExecutionJob,
  JobStepResolution,
  OrganizePlan,
  PlanScope,
  Snapshot,
  SnapshotSummary,
} from './types';

export type StudioMessage =
  | { type: 'GET_BOOTSTRAP_STATE' }
  | { type: 'REBUILD_INDEX' }
  | {
      type: 'CREATE_BOOKMARK';
      payload: { parentId: string; title: string; url?: string; index?: number };
    }
  | {
      type: 'UPDATE_BOOKMARK';
      payload: { nodeId: string; title: string; url?: string; tags?: string[] };
    }
  | {
      type: 'MOVE_BOOKMARK';
      payload: {
        nodeId: string;
        toParentId: string;
        desiredFinalIndex?: number;
        beforeSiblingId?: string;
        afterSiblingId?: string;
      };
    }
  | {
      type: 'REMOVE_BOOKMARK';
      payload: { nodeId: string; recursive?: boolean };
    }
  | {
      type: 'UPDATE_TAGS';
      payload: { nodeId: string; tags: string[] };
    }
  | {
      type: 'CREATE_PLAN';
      payload: {
        scope: PlanScope;
        instruction: string;
        mode: AiProviderPreference;
        baseParentId?: string;
        precomputedChromeAiDraft?: {
          draftOps: DraftOperationInput[];
          warnings: string[];
        };
        precomputedChromeAiError?: string;
      };
    }
  | {
      type: 'SAVE_PLAN';
      payload: { plan: OrganizePlan };
    }
  | {
      type: 'APPLY_PLAN';
      payload: { planId: string; approvedRevision: number; resumeJobId?: string };
    }
  | {
      type: 'RESTORE_JOB';
      payload: { jobId: string };
    }
  | {
      type: 'RESOLVE_JOB_STEP';
      payload: { jobId: string; opId: string; resolution: JobStepResolution };
    }
  | {
      type: 'EXPORT_BACKUP';
    }
  | {
      type: 'RESTORE_BACKUP';
      payload: {
        backup: BackupPayload;
        targetParentId: string;
        branchTitle?: string;
      };
    }
  | {
      type: 'SAVE_SETTINGS';
      payload: { settings: AppSettings };
    }
  | {
      type: 'PRUNE_SNAPSHOTS';
      payload: { retainCount: number };
    }
  | {
      type: 'CHECK_LINKS';
      payload: { bookmarkIds: string[] };
    }
  | {
      type: 'CREATE_DEAD_LINK_PLAN';
      payload: {
        scope: PlanScope;
        action: DeadLinkCleanupAction;
        baseParentId?: string;
        includeUnreachable?: boolean;
      };
    }
  | {
      type: 'CREATE_DUPLICATE_PLAN';
      payload: { scope: PlanScope };
    }
  | {
      type: 'OPEN_STUDIO';
      payload?: { tab?: 'workspace' | 'organize' | 'history' | 'settings' };
    };

export interface BootstrapState {
  profileKey: string;
  projections: BookmarkProjection[];
  metadata: BookmarkMetadata[];
  plans: OrganizePlan[];
  jobs: ExecutionJob[];
  /** Summaries only: full snapshot trees stay in the Service Worker's IndexedDB */
  snapshots: SnapshotSummary[];
  settings: AppSettings;
  hasActiveLock: boolean;
}

export function summarizeSnapshot(snapshot: Snapshot): SnapshotSummary {
  return {
    snapshotId: snapshot.snapshotId,
    profileKey: snapshot.profileKey,
    createdAt: snapshot.createdAt,
    reason: snapshot.reason,
    label: snapshot.label,
    nodeCount: snapshot.nodes.length,
  };
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isOptStr = (v: unknown) => v === undefined || typeof v === 'string';
const isOptInt = (v: unknown) =>
  v === undefined || (typeof v === 'number' && Number.isInteger(v) && v >= 0);
const isStrArray = (v: unknown, max = 10_000): v is string[] =>
  Array.isArray(v) && v.length <= max && v.every(isStr);
const isObj = (v: unknown): v is Record<string, unknown> =>
  Boolean(v) && typeof v === 'object' && !Array.isArray(v);

function isValidScope(v: unknown): boolean {
  if (!isObj(v)) return false;
  if (!['folder', 'selection', 'all'].includes(String(v.type))) return false;
  if (!isStrArray(v.targetFolderIds, 1000)) return false;
  if (!isOptStr(v.folderId)) return false;
  return v.bookmarkIds === undefined || isStrArray(v.bookmarkIds);
}

/**
 * Runtime shape check for messages from extension pages. TypeScript types vanish at
 * runtime, so a malformed payload must be rejected here with a clear error instead of
 * crashing deep inside a handler (e.g. `tags.map` on a string).
 * Returns null when valid, otherwise a user-readable reason.
 */
export function validateStudioMessage(message: unknown): string | null {
  if (!isObj(message) || !isStr(message.type)) return '訊息格式無效。';
  const p = message.payload;
  const bad = '訊息內容格式無效。';
  switch (message.type) {
    case 'GET_BOOTSTRAP_STATE':
    case 'REBUILD_INDEX':
    case 'EXPORT_BACKUP':
      return null;
    case 'OPEN_STUDIO':
      return p === undefined || (isObj(p) && isOptStr(p.tab)) ? null : bad;
    case 'CREATE_BOOKMARK':
      return isObj(p) && isStr(p.parentId) && isStr(p.title) && isOptStr(p.url) && isOptInt(p.index)
        ? null
        : bad;
    case 'UPDATE_BOOKMARK':
      return isObj(p) &&
        isStr(p.nodeId) &&
        isStr(p.title) &&
        isOptStr(p.url) &&
        (p.tags === undefined || isStrArray(p.tags, 200))
        ? null
        : bad;
    case 'MOVE_BOOKMARK':
      return isObj(p) &&
        isStr(p.nodeId) &&
        isStr(p.toParentId) &&
        isOptInt(p.desiredFinalIndex) &&
        isOptStr(p.beforeSiblingId) &&
        isOptStr(p.afterSiblingId)
        ? null
        : bad;
    case 'REMOVE_BOOKMARK':
      return isObj(p) && isStr(p.nodeId) && (p.recursive === undefined || typeof p.recursive === 'boolean')
        ? null
        : bad;
    case 'UPDATE_TAGS':
      return isObj(p) && isStr(p.nodeId) && isStrArray(p.tags, 200) ? null : bad;
    case 'CREATE_PLAN':
      return isObj(p) &&
        isValidScope(p.scope) &&
        isStr(p.instruction) &&
        ['auto', 'chrome-prompt-api', 'rule'].includes(String(p.mode)) &&
        isOptStr(p.baseParentId) &&
        isOptStr(p.precomputedChromeAiError) &&
        (p.precomputedChromeAiDraft === undefined ||
          (isObj(p.precomputedChromeAiDraft) &&
            Array.isArray(p.precomputedChromeAiDraft.draftOps) &&
            isStrArray(p.precomputedChromeAiDraft.warnings, 1000)))
        ? null
        : bad;
    case 'SAVE_PLAN':
      return isObj(p) &&
        isObj(p.plan) &&
        isStr(p.plan.planId) &&
        typeof p.plan.revision === 'number' &&
        isValidScope(p.plan.scope) &&
        Array.isArray(p.plan.operations)
        ? null
        : bad;
    case 'APPLY_PLAN':
      return isObj(p) && isStr(p.planId) && typeof p.approvedRevision === 'number' && isOptStr(p.resumeJobId)
        ? null
        : bad;
    case 'RESTORE_JOB':
      return isObj(p) && isStr(p.jobId) ? null : bad;
    case 'RESOLVE_JOB_STEP':
      return isObj(p) &&
        isStr(p.jobId) &&
        isStr(p.opId) &&
        ['skip', 'retry', 'adopt'].includes(String(p.resolution))
        ? null
        : bad;
    case 'RESTORE_BACKUP':
      return isObj(p) && isObj(p.backup) && isStr(p.targetParentId) && isOptStr(p.branchTitle)
        ? null
        : bad;
    case 'SAVE_SETTINGS':
      return isObj(p) && isObj(p.settings) ? null : bad;
    case 'PRUNE_SNAPSHOTS':
      return isObj(p) && typeof p.retainCount === 'number' && Number.isFinite(p.retainCount)
        ? null
        : bad;
    case 'CHECK_LINKS':
      return isObj(p) && isStrArray(p.bookmarkIds, 20_000) ? null : bad;
    case 'CREATE_DEAD_LINK_PLAN':
      return isObj(p) &&
        isValidScope(p.scope) &&
        ['quarantine', 'remove'].includes(String(p.action)) &&
        isOptStr(p.baseParentId) &&
        (p.includeUnreachable === undefined || typeof p.includeUnreachable === 'boolean')
        ? null
        : bad;
    case 'CREATE_DUPLICATE_PLAN':
      return isObj(p) && isValidScope(p.scope) ? null : bad;
    default:
      return '未知的訊息類型。';
  }
}

export type StudioResponse<T = unknown> =
  | { ok: true; data: T }
  | { ok: false; error: string };

export type MessageResponseMap = {
  GET_BOOTSTRAP_STATE: BootstrapState;
  REBUILD_INDEX: { count: number };
  CREATE_BOOKMARK: { nodeId: string };
  UPDATE_BOOKMARK: { nodeId: string };
  MOVE_BOOKMARK: { nodeId: string };
  REMOVE_BOOKMARK: { snapshotId: string };
  UPDATE_TAGS: { nodeId: string; tags: string[] };
  CREATE_PLAN: OrganizePlan;
  SAVE_PLAN: OrganizePlan;
  APPLY_PLAN: ExecutionJob;
  RESTORE_JOB: ExecutionJob;
  RESOLVE_JOB_STEP: ExecutionJob;
  EXPORT_BACKUP: BackupPayload;
  RESTORE_BACKUP: RestoreBackupResult;
  SAVE_SETTINGS: AppSettings;
  PRUNE_SNAPSHOTS: { removed: number };
  CHECK_LINKS: BatchLinkCheckResult;
  CREATE_DEAD_LINK_PLAN: OrganizePlan;
  CREATE_DUPLICATE_PLAN: OrganizePlan;
  OPEN_STUDIO: { opened: boolean };
};

export function isTrustedExtensionSender(
  sender: chrome.runtime.MessageSender,
): boolean {
  if (!sender || sender.id !== chrome.runtime.id) {
    return false;
  }
  // Only accept messages from our own extension pages (popup, studio), never web pages/content scripts
  const url = sender.url ?? '';
  const extensionOrigin = chrome.runtime.getURL('');
  return url.startsWith(extensionOrigin);
}

export async function sendStudioMessage<M extends StudioMessage>(
  message: M,
): Promise<MessageResponseMap[M['type']]> {
  const res = (await chrome.runtime.sendMessage(message)) as StudioResponse<
    MessageResponseMap[M['type']]
  >;
  if (!res) {
    throw new Error('擴充功能背景服務無回應，請重新整理頁面。');
  }
  if (!res.ok) {
    throw new Error(res.error || '操作失敗');
  }
  return res.data;
}
