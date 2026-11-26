import {
  buildProjections,
  isFolderNode,
  isSafeBookmarkUrl,
} from './bookmark-engine';
import type { FavorsiteStore } from './store';
import type {
  BackupImportPreview,
  BackupPayload,
  BackupTreeNode,
  BookmarkApiAdapter,
  BookmarkMetadata,
  ChromeBookmarkNode,
  Snapshot,
  SnapshotNode,
} from './types';

const MAX_BACKUP_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_TREE_DEPTH = 50;
const MAX_TITLE_LENGTH = 1024;
const MAX_URL_LENGTH = 8192;
const MAX_TAGS_PER_BOOKMARK = 50;
const MAX_TAG_LENGTH = 64;

function cleanText(value: unknown, maxLen: number): string {
  return typeof value === 'string'
    ? value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLen)
    : '';
}

/**
 * Normalizes an untrusted backup into the exact shape the restorer expects. Used by the
 * import preview AND again inside the Service Worker before writing, so preview and
 * restore agree (e.g. nodes deeper than MAX_TREE_DEPTH are dropped by both) and a
 * malformed field can never abort a restore half-way.
 */
export function sanitizeBackupPayload(raw: unknown): {
  payload: BackupPayload;
  droppedNodes: number;
  droppedReasons: string[];
} {
  const obj = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  let droppedNodes = 0;
  const droppedReasons: string[] = [];
  const drop = (reason: string) => {
    droppedNodes++;
    if (droppedReasons.length < 20) droppedReasons.push(reason);
  };

  function cleanNode(node: unknown, depth: number): BackupTreeNode | null {
    if (!node || typeof node !== 'object' || depth > MAX_TREE_DEPTH) {
      drop('節點結構無效或層級過深');
      return null;
    }
    const n = node as Record<string, unknown>;
    const title = cleanText(n.title, MAX_TITLE_LENGTH);
    const originalId = typeof n.originalId === 'string' ? n.originalId : '';
    const isFolder = n.isFolder === true || n.url === undefined;
    if (isFolder) {
      const children = Array.isArray(n.children)
        ? n.children
            .map((c) => cleanNode(c, depth + 1))
            .filter((c): c is BackupTreeNode => c !== null)
        : [];
      return {
        originalId,
        title,
        isFolder: true,
        dateAdded: typeof n.dateAdded === 'number' ? n.dateAdded : undefined,
        children,
      };
    }
    const url = typeof n.url === 'string' ? n.url.trim() : '';
    if (!url || url.length > MAX_URL_LENGTH || !isSafeBookmarkUrl(url)) {
      drop(`略過不支援或無效網址的書籤：「${title || '(無標題)'}」`);
      return null;
    }
    return {
      originalId,
      title,
      url,
      isFolder: false,
      dateAdded: typeof n.dateAdded === 'number' ? n.dateAdded : undefined,
    };
  }

  const tree = Array.isArray(obj.tree)
    ? obj.tree
        .map((root) => cleanNode(root, 0))
        .filter((c): c is BackupTreeNode => c !== null)
    : [];

  const metadata: BookmarkMetadata[] = [];
  if (Array.isArray(obj.metadata)) {
    for (const m of obj.metadata) {
      if (!m || typeof m !== 'object') continue;
      const rec = m as Record<string, unknown>;
      if (typeof rec.nodeId !== 'string' || !rec.nodeId) continue;
      const tags = Array.isArray(rec.tags)
        ? Array.from(
            new Set(
              rec.tags
                .filter((t): t is string => typeof t === 'string')
                .map((t) => cleanText(t, MAX_TAG_LENGTH).trim())
                .filter(Boolean),
            ),
          ).slice(0, MAX_TAGS_PER_BOOKMARK)
        : [];
      metadata.push({
        profileKey: typeof rec.profileKey === 'string' ? rec.profileKey : '',
        nodeId: rec.nodeId,
        tags,
        originalDateAdded:
          typeof rec.originalDateAdded === 'number' ? rec.originalDateAdded : undefined,
        updatedAt: typeof rec.updatedAt === 'number' ? rec.updatedAt : 0,
      });
    }
  }

  return {
    payload: {
      schemaVersion: 1,
      exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : Date.now(),
      profileKey: typeof obj.profileKey === 'string' ? obj.profileKey : '',
      tree,
      metadata,
    },
    droppedNodes,
    droppedReasons,
  };
}

function toBackupNode(node: ChromeBookmarkNode): BackupTreeNode {
  const isFolder = isFolderNode(node);
  return {
    originalId: node.id,
    title: node.title,
    url: node.url,
    dateAdded: node.dateAdded,
    folderType: node.folderType,
    syncing: node.syncing,
    isFolder,
    children: isFolder
      ? (node.children ?? []).map((c) => toBackupNode(c))
      : undefined,
  };
}

export function exportBackupPayload(params: {
  tree: ChromeBookmarkNode[];
  metadata: BookmarkMetadata[];
  profileKey: string;
}): BackupPayload {
  return {
    schemaVersion: 1,
    exportedAt: Date.now(),
    profileKey: params.profileKey,
    tree: params.tree.map((root) => toBackupNode(root)),
    metadata: params.metadata.map((m) => ({
      ...m,
      tags: [...m.tags],
    })),
  };
}

/** Rebuilds the captured scope without including unrelated branches from a full snapshot. */
export function exportSnapshotBackupPayload(
  snapshot: Snapshot | undefined,
  profileKey: string,
): BackupPayload {
  if (!snapshot || snapshot.profileKey !== profileKey) {
    throw new Error('找不到目前設定檔的快照，可能已清理。');
  }
  if (snapshot.schemaVersion !== 1 || !Array.isArray(snapshot.nodes) ||
    !Array.isArray(snapshot.metadata) || !snapshot.scope) {
    throw new Error('快照內容格式無效，無法匯出。');
  }

  const byId = new Map<string, SnapshotNode>();
  const children = new Map<string, SnapshotNode[]>();
  for (const node of snapshot.nodes) {
    if (!node || typeof node.id !== 'string' || !node.id || byId.has(node.id) ||
      typeof node.title !== 'string' || typeof node.isFolder !== 'boolean' ||
      (node.parentId !== undefined && typeof node.parentId !== 'string') ||
      (node.index !== undefined && (!Number.isInteger(node.index) || node.index < 0))) {
      throw new Error('快照節點格式無效或識別值重複，無法匯出。');
    }
    byId.set(node.id, node);
    if (node.parentId) {
      const siblings = children.get(node.parentId) ?? [];
      siblings.push(node);
      children.set(node.parentId, siblings);
    }
  }
  for (const siblings of children.values()) {
    siblings.sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  }

  let selectedIds: string[];
  if (snapshot.scope.type === 'all') {
    selectedIds = snapshot.nodes.filter((node) => !node.parentId || !byId.has(node.parentId))
      .map((node) => node.id);
  } else if (snapshot.scope.type === 'folder' && typeof snapshot.scope.folderId === 'string') {
    selectedIds = [snapshot.scope.folderId];
  } else if (snapshot.scope.type === 'selection' && Array.isArray(snapshot.scope.bookmarkIds) &&
    snapshot.scope.bookmarkIds.every((id) => typeof id === 'string')) {
    selectedIds = [...new Set(snapshot.scope.bookmarkIds)];
  } else {
    throw new Error('快照的整理範圍無效，無法匯出。');
  }
  if (!selectedIds.length || selectedIds.some((id) => !byId.has(id))) {
    throw new Error('快照缺少所選範圍的節點，無法匯出。');
  }

  const selected = new Set(selectedIds);
  const roots = selectedIds.filter((id) => {
    let parentId = byId.get(id)?.parentId;
    const ancestors = new Set([id]);
    while (parentId && byId.has(parentId)) {
      if (ancestors.has(parentId)) throw new Error('快照含有循環資料夾，無法匯出。');
      if (selected.has(parentId)) return false;
      ancestors.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  }).map((id) => byId.get(id)!).sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (!roots.length) throw new Error('快照含有循環資料夾，無法匯出。');

  const included = new Set<string>();
  const buildNode = (node: SnapshotNode, depth: number): BackupTreeNode => {
    if (depth > MAX_TREE_DEPTH || included.has(node.id) ||
      (node.isFolder && node.url !== undefined) ||
      (!node.isFolder && (typeof node.url !== 'string' || children.has(node.id)))) {
      throw new Error('快照子樹結構無效或層級過深，無法匯出。');
    }
    included.add(node.id);
    return {
      originalId: node.id,
      title: node.title,
      url: node.isFolder ? undefined : node.url,
      dateAdded: node.dateAdded,
      folderType: node.folderType,
      syncing: node.syncing,
      isFolder: node.isFolder,
      children: node.isFolder ? (children.get(node.id) ?? []).map((child) => buildNode(child, depth + 1)) : undefined,
    };
  };
  const tree = roots.map((node) => buildNode(node, 0));
  if (snapshot.scope.type === 'all' && included.size !== byId.size) {
    throw new Error('快照含有無法連接的節點，無法匯出。');
  }
  return {
    schemaVersion: 1,
    exportedAt: snapshot.createdAt,
    profileKey,
    tree,
    metadata: snapshot.metadata.filter((item) => item && item.profileKey === profileKey && included.has(item.nodeId))
      .map((item) => ({ ...item, tags: Array.isArray(item.tags) ? [...item.tags] : [] })),
  };
}

export function validateAndPreviewBackup(rawText: string): {
  preview: BackupImportPreview;
  payload?: BackupPayload;
} {
  const byteLength = new TextEncoder().encode(rawText).byteLength;
  if (byteLength > MAX_BACKUP_BYTES) {
    return {
      preview: {
        valid: false,
        errors: ['備份檔案超過 10 MB 上限，已拒絕匯入。'],
        warnings: [],
        totalFolders: 0,
        totalBookmarks: 0,
        reconstructableCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        taggedBookmarkCount: 0,
      },
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return {
      preview: {
        valid: false,
        errors: ['JSON 格式解析失敗，請確認檔案未損毀。'],
        warnings: [],
        totalFolders: 0,
        totalBookmarks: 0,
        reconstructableCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        taggedBookmarkCount: 0,
      },
    };
  }

  if (!parsed || typeof parsed !== 'object') {
    return {
      preview: {
        valid: false,
        errors: ['備份內容必須為 JSON 物件。'],
        warnings: [],
        totalFolders: 0,
        totalBookmarks: 0,
        reconstructableCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        taggedBookmarkCount: 0,
      },
    };
  }

  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || !Array.isArray(obj.tree)) {
    return {
      preview: {
        valid: false,
        errors: ['不支援的備份版本或缺少 tree 結構（僅支援 schemaVersion: 1）。'],
        warnings: [],
        totalFolders: 0,
        totalBookmarks: 0,
        reconstructableCount: 0,
        skippedCount: 0,
        skippedReasons: [],
        taggedBookmarkCount: 0,
      },
    };
  }

  const sanitized = sanitizeBackupPayload(obj);
  let totalFolders = 0;
  let totalBookmarks = 0;
  const count = (nodes: BackupTreeNode[]) => {
    for (const n of nodes) {
      if (n.isFolder) {
        if (n.originalId !== '0') totalFolders++;
        count(n.children ?? []);
      } else {
        totalBookmarks++;
      }
    }
  };
  count(sanitized.payload.tree);
  const reconstructableCount = totalFolders + totalBookmarks;
  const skippedCount = sanitized.droppedNodes;
  const taggedBookmarkCount = sanitized.payload.metadata.filter(
    (m) => m.tags.length > 0,
  ).length;

  const warnings: string[] = [];
  if (skippedCount > 0) {
    warnings.push(`有 ${skippedCount} 筆節點將被略過，其餘項目可重建。`);
  }
  warnings.push(
    '還原會在您選擇的可寫資料夾下建立新分支；重建後的書籤將取得新的 Chrome ID 與新增時間，原始時間會保留於 Favorsite 附加資料。',
  );

  return {
    preview: {
      valid: true,
      errors: [],
      warnings,
      schemaVersion: 1,
      exportedAt: typeof obj.exportedAt === 'number' ? obj.exportedAt : undefined,
      totalFolders,
      totalBookmarks: totalBookmarks + skippedCount,
      reconstructableCount,
      skippedCount,
      skippedReasons: sanitized.droppedReasons,
      taggedBookmarkCount,
    },
    payload: sanitized.payload,
  };
}

export interface RestoreBackupResult {
  branchFolderId: string;
  branchTitle: string;
  createdFolders: number;
  createdBookmarks: number;
  relinkedTags: number;
  skippedCount: number;
}

export async function restoreBackupToFolder(params: {
  adapter: BookmarkApiAdapter;
  store: FavorsiteStore;
  profileKey: string;
  payload: BackupPayload;
  targetParentId: string;
  branchTitle?: string;
}): Promise<RestoreBackupResult> {
  const { adapter, store, profileKey, targetParentId } = params;

  // The payload crossed a message boundary: never trust the page's preview alone
  let serializedSize = 0;
  try {
    serializedSize = new TextEncoder().encode(JSON.stringify(params.payload)).byteLength;
  } catch {
    throw new Error('備份內容無法序列化，已拒絕還原。');
  }
  if (serializedSize > MAX_BACKUP_BYTES) {
    throw new Error('備份檔案超過 10 MB 上限，已拒絕還原。');
  }
  if ((params.payload as { schemaVersion?: unknown })?.schemaVersion !== 1) {
    throw new Error('不支援的備份版本（僅支援 schemaVersion: 1）。');
  }
  const { payload, droppedNodes } = sanitizeBackupPayload(params.payload);

  const liveTree = await adapter.getTree();
  const flattened = buildProjections(liveTree, profileKey);
  const targetFolder = flattened.byId.get(targetParentId);
  if (!targetFolder || !targetFolder.isFolder || !targetFolder.canAddChild) {
    throw new Error('所選目的資料夾不存在或不可寫入。');
  }

  const dateTag = new Date(payload.exportedAt || Date.now())
    .toISOString()
    .slice(0, 16)
    .replace('T', ' ');
  const branchTitle =
    params.branchTitle?.trim() || `Favorsite 還原 (${dateTag})`;

  const branchFolder = await adapter.create({
    parentId: targetParentId,
    title: branchTitle,
  });

  const metaByOldId = new Map<string, BookmarkMetadata>();
  for (const m of payload.metadata) {
    metaByOldId.set(m.nodeId, m);
  }

  let createdFolders = 0;
  let createdBookmarks = 0;
  let relinkedTags = 0;
  let skippedCount = droppedNodes;
  const createdMetadataIds: string[] = [];

  async function recreateChildren(
    nodes: BackupTreeNode[],
    parentId: string,
  ): Promise<void> {
    for (const node of nodes) {
      const isFolder = node.isFolder || node.url === undefined;
      if (isFolder) {
        // Unwrap Chrome's invisible root '0' directly into branchFolder
        if (node.originalId === '0') {
          if (node.children) {
            await recreateChildren(node.children, parentId);
          }
          continue;
        }
        const folderTitle = node.title || '未命名資料夾';
        const created = await adapter.create({
          parentId,
          title: folderTitle,
        });
        createdFolders++;
        if (node.children && node.children.length > 0) {
          await recreateChildren(node.children, created.id);
        }
      } else {
        if (!node.url || !isSafeBookmarkUrl(node.url)) {
          skippedCount++;
          continue;
        }
        const created = await adapter.create({
          parentId,
          title: node.title || node.url,
          url: node.url,
        });
        createdBookmarks++;

        const oldMeta = metaByOldId.get(node.originalId);
        const origDate = oldMeta?.originalDateAdded ?? node.dateAdded;
        const tags = oldMeta?.tags ?? [];
        if (tags.length > 0 || origDate !== undefined) {
          await store.upsertMetadata({
            profileKey,
            nodeId: created.id,
            tags,
            originalDateAdded: origDate,
            updatedAt: Date.now(),
          });
          createdMetadataIds.push(created.id);
          if (tags.length > 0) relinkedTags++;
        }
      }
    }
  }

  try {
    await recreateChildren(payload.tree, branchFolder.id);
  } catch (err) {
    // All-or-nothing: remove the half-built branch (it only holds what we just created)
    try {
      await adapter.removeTree(branchFolder.id);
      for (const id of createdMetadataIds) {
        await store.deleteMetadata(profileKey, id);
      }
    } catch {
      // Best effort; the original error is what the user needs to see
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`還原失敗，已移除未完成的還原分支：${message}`);
  }

  return {
    branchFolderId: branchFolder.id,
    branchTitle,
    createdFolders,
    createdBookmarks,
    relinkedTags,
    skippedCount,
  };
}
