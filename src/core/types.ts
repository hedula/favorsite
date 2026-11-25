export type FolderType =
  | 'bookmarks-bar'
  | 'other'
  | 'mobile'
  | 'managed'
  | (string & {});

export interface ChromeBookmarkNode {
  id: string;
  parentId?: string;
  index?: number;
  url?: string;
  title: string;
  dateAdded?: number;
  dateGroupModified?: number;
  unmodifiable?: 'managed' | string;
  folderType?: FolderType;
  syncing?: boolean;
  children?: ChromeBookmarkNode[];
}

export interface BookmarkProjection {
  profileKey: string;
  nodeId: string;
  parentId: string;
  index: number;
  title: string;
  url?: string;
  domain: string;
  dateAdded?: number;
  folderType?: FolderType;
  syncing?: boolean;
  unmodifiable?: string;
  isFolder: boolean;
  isSystemFolder: boolean;
  writable: boolean;
  canAddChild: boolean;
  path: string;
  childCount: number;
}

export type LinkCheckStatus =
  | 'ok'
  | 'dead_404_410'
  | 'dead_unreachable'
  | 'redirect'
  | 'auth_blocked'
  | 'rate_limited'
  | 'server_error'
  | 'timeout'
  | 'skipped_private'
  | 'skipped_sensitive'
  | 'not_authorized';

export interface LinkCheckRecord {
  status: LinkCheckStatus;
  httpStatus?: number;
  checkedAt: number;
  redirectTo?: string;
  note?: string;
  /** Exact URL that was probed; a record is only trusted while it still matches the bookmark URL. */
  checkedUrl?: string;
}

export interface BookmarkMetadata {
  profileKey: string;
  nodeId: string;
  tags: string[];
  originalDateAdded?: number;
  linkCheck?: LinkCheckRecord;
  updatedAt: number;
}

export interface PlanScope {
  type: 'folder' | 'selection' | 'all';
  folderId?: string;
  bookmarkIds?: string[];
  targetFolderIds: string[];
}

export interface SnapshotNode {
  id: string;
  parentId?: string;
  index?: number;
  title: string;
  url?: string;
  dateAdded?: number;
  folderType?: FolderType;
  syncing?: boolean;
  unmodifiable?: string;
  isFolder: boolean;
}

export interface Snapshot {
  snapshotId: string;
  schemaVersion: 1;
  profileKey: string;
  createdAt: number;
  reason: 'organize' | 'delete' | 'backup' | 'manual';
  label: string;
  scope: PlanScope;
  nodes: SnapshotNode[];
  metadata: BookmarkMetadata[];
}

/** List-view form of a Snapshot sent to extension pages (no full tree payload). */
export interface SnapshotSummary {
  snapshotId: string;
  profileKey: string;
  createdAt: number;
  reason: Snapshot['reason'];
  label: string;
  nodeCount: number;
}

export type PlanOperationType =
  | 'createFolder'
  | 'moveBookmark'
  | 'renameBookmark'
  | 'addTag'
  | 'removeBookmark';

export interface BasePlanOperation {
  opId: string;
  type: PlanOperationType;
  enabled: boolean;
  requiresReview?: boolean;
  reviewReason?: string;
  confidence?: number;
  reason: string;
  dependsOnOpId?: string;
}

export interface CreateFolderOperation extends BasePlanOperation {
  type: 'createFolder';
  tempFolderId: string;
  parentId: string;
  parentTempId?: string;
  title: string;
  parentPath: string;
  index?: number;
}

export interface MoveBookmarkOperation extends BasePlanOperation {
  type: 'moveBookmark';
  nodeId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  fromParentId: string;
  fromIndex: number;
  fromPath: string;
  toParentId?: string;
  toTempFolderId?: string;
  toPath: string;
  toIndex?: number;
  beforeSiblingId?: string;
  afterSiblingId?: string;
}

export interface RenameBookmarkOperation extends BasePlanOperation {
  type: 'renameBookmark';
  nodeId: string;
  parentId: string;
  oldTitle: string;
  newTitle: string;
  path: string;
}

export interface AddTagOperation extends BasePlanOperation {
  type: 'addTag';
  nodeId: string;
  bookmarkTitle: string;
  tagsToAdd: string[];
  existingTags: string[];
}

export interface RemoveBookmarkOperation extends BasePlanOperation {
  type: 'removeBookmark';
  nodeId: string;
  bookmarkTitle: string;
  bookmarkUrl?: string;
  parentId: string;
  index: number;
  path: string;
  linkStatus?: LinkCheckStatus;
  httpStatus?: number;
  /** Why this removal was proposed; drives the preview label. */
  removalKind?: 'dead_link' | 'duplicate_exact' | 'duplicate_suspected';
  /** For duplicates: the copy that is kept. */
  keepNodeId?: string;
  keepTitle?: string;
  keepPath?: string;
}

export type PlanOperation =
  | CreateFolderOperation
  | MoveBookmarkOperation
  | RenameBookmarkOperation
  | AddTagOperation
  | RemoveBookmarkOperation;

export type AiProviderPreference = 'auto' | 'chrome-prompt-api' | 'rule';

export type PlanSource = 'rule' | 'chrome-prompt-api' | 'manual';

export interface OrganizePlan {
  planId: string;
  profileKey: string;
  revision: number;
  snapshotId: string;
  scope: PlanScope;
  scopeFingerprint: string;
  instruction: string;
  source: PlanSource;
  fallbackFrom?: string;
  operations: PlanOperation[];
  status: 'draft' | 'stale' | 'approved' | 'applied' | 'cancelled';
  warnings: string[];
  createdAt: number;
  updatedAt: number;
}

export type JobStepStatus =
  | 'pending'
  | 'in_progress'
  | 'applied'
  | 'skipped'
  | 'conflict'
  | 'needs_confirmation'
  | 'failed'
  | 'restored';

export interface ConflictItem {
  opId?: string;
  nodeId?: string;
  kind:
    | 'scope_changed'
    | 'node_missing'
    | 'node_modified'
    | 'parent_not_writable'
    | 'cycle_detected'
    | 'folder_not_empty'
    | 'ambiguous_state'
    | 'api_error';
  message: string;
}

export interface JobStep {
  opId: string;
  opType: PlanOperationType;
  intent: PlanOperation;
  status: JobStepStatus;
  beforeRef?: Record<string, unknown>;
  afterRef?: Record<string, unknown>;
  resultCode: string;
  errorMessage?: string;
  /** Set when the user explicitly retries a conflicted step; skips the pre-write drift check once. */
  confirmedByUser?: boolean;
  updatedAt: number;
}

export type JobStepResolution = 'skip' | 'retry' | 'adopt';

export type ExecutionJobStatus =
  | 'pending'
  | 'running'
  | 'paused_conflict'
  | 'interrupted'
  | 'completed'
  | 'restoring'
  | 'restored'
  | 'failed';

export interface ExecutionJob {
  jobId: string;
  profileKey: string;
  planId: string;
  approvedRevision: number;
  snapshotId: string;
  instruction: string;
  status: ExecutionJobStatus;
  steps: JobStep[];
  tempFolderMap: Record<string, string>;
  conflicts: ConflictItem[];
  completedCount: number;
  totalCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface JobLock {
  profileKey: string;
  jobId: string;
  acquiredAt: number;
}

export interface DuplicateGroup {
  groupId: string;
  kind: 'exact' | 'suspected';
  reason: string;
  normalizedKey: string;
  nodeIds: string[];
}

export interface AppSettings {
  profileKey: string;
  aiProvider: AiProviderPreference;
  includePathInAi: boolean;
  backupRetentionCount: number;
  firstRunNoticeDismissed: boolean;
}

export interface BackupTreeNode {
  originalId: string;
  title: string;
  url?: string;
  dateAdded?: number;
  folderType?: FolderType;
  syncing?: boolean;
  isFolder: boolean;
  children?: BackupTreeNode[];
}

export interface BackupPayload {
  schemaVersion: 1;
  exportedAt: number;
  profileKey: string;
  tree: BackupTreeNode[];
  metadata: BookmarkMetadata[];
}

export interface BackupImportPreview {
  valid: boolean;
  errors: string[];
  warnings: string[];
  schemaVersion?: number;
  exportedAt?: number;
  totalFolders: number;
  totalBookmarks: number;
  reconstructableCount: number;
  skippedCount: number;
  skippedReasons: string[];
  taggedBookmarkCount: number;
}

export interface BookmarkApiAdapter {
  getTree(): Promise<ChromeBookmarkNode[]>;
  get(id: string): Promise<ChromeBookmarkNode[]>;
  getChildren(id: string): Promise<ChromeBookmarkNode[]>;
  getSubTree(id: string): Promise<ChromeBookmarkNode[]>;
  create(details: {
    parentId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<ChromeBookmarkNode>;
  update(
    id: string,
    changes: { title?: string; url?: string },
  ): Promise<ChromeBookmarkNode>;
  move(
    id: string,
    destination: { parentId?: string; index?: number },
  ): Promise<ChromeBookmarkNode>;
  remove(id: string): Promise<void>;
  removeTree(id: string): Promise<void>;
}
