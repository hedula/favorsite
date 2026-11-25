import type {
  BookmarkApiAdapter,
  BookmarkProjection,
  ChromeBookmarkNode,
  PlanScope,
  SnapshotNode,
} from './types';

export function createChromeBookmarkAdapter(): BookmarkApiAdapter {
  return {
    getTree: () => chrome.bookmarks.getTree() as Promise<ChromeBookmarkNode[]>,
    get: (id) => chrome.bookmarks.get(id) as Promise<ChromeBookmarkNode[]>,
    getChildren: (id) =>
      chrome.bookmarks.getChildren(id) as Promise<ChromeBookmarkNode[]>,
    getSubTree: (id) =>
      chrome.bookmarks.getSubTree(id) as Promise<ChromeBookmarkNode[]>,
    create: (details) =>
      chrome.bookmarks.create(details) as Promise<ChromeBookmarkNode>,
    update: (id, changes) =>
      chrome.bookmarks.update(id, changes) as Promise<ChromeBookmarkNode>,
    move: (id, destination) =>
      chrome.bookmarks.move(id, destination) as Promise<ChromeBookmarkNode>,
    remove: (id) => chrome.bookmarks.remove(id),
    removeTree: (id) => chrome.bookmarks.removeTree(id),
  };
}

export function extractDomain(url?: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return parsed.protocol.replace(/:$/, '');
    }
    return parsed.hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function isHttpUrl(url?: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function isSafeBookmarkUrl(url: string): boolean {
  const trimmed = url.trim();
  if (!trimmed) return false;
  try {
    const parsed = new URL(trimmed);
    return (
      parsed.protocol === 'http:' ||
      parsed.protocol === 'https:' ||
      parsed.protocol === 'ftp:' ||
      parsed.protocol === 'file:' ||
      parsed.protocol === 'chrome:'
    );
  } catch {
    return false;
  }
}

export function isSystemFolderNode(node: ChromeBookmarkNode): boolean {
  if (node.id === '0') return true;
  if (!node.parentId) return true;
  if (node.parentId === '0') return true;
  if (node.folderType) return true;
  return false;
}

export function isFolderNode(node: ChromeBookmarkNode): boolean {
  return node.url === undefined;
}

export interface FlattenedTree {
  projections: BookmarkProjection[];
  byId: Map<string, BookmarkProjection>;
  childrenByParent: Map<string, BookmarkProjection[]>;
  rawById: Map<string, ChromeBookmarkNode>;
}

function getFolderDisplayLabel(
  node: ChromeBookmarkNode,
  duplicateTitles: Set<string>,
): string {
  const baseTitle = node.title || (node.id === '0' ? '根目錄' : '未命名資料夾');
  if (node.parentId === '0' || node.folderType) {
    if (duplicateTitles.has(baseTitle) && typeof node.syncing === 'boolean') {
      return `${baseTitle} (${node.syncing ? '帳戶' : '本機'})`;
    }
    if (node.folderType === 'managed' || node.unmodifiable === 'managed') {
      return `${baseTitle} (受管理)`;
    }
  }
  return baseTitle;
}

export function buildProjections(
  tree: ChromeBookmarkNode[],
  profileKey: string,
): FlattenedTree {
  const rawById = new Map<string, ChromeBookmarkNode>();
  const topLevelTitles = new Map<string, number>();

  function indexRaw(node: ChromeBookmarkNode) {
    rawById.set(node.id, node);
    if (node.parentId === '0' || node.folderType) {
      const t = node.title || '未命名資料夾';
      topLevelTitles.set(t, (topLevelTitles.get(t) ?? 0) + 1);
    }
    if (node.children) {
      for (const child of node.children) {
        indexRaw(child);
      }
    }
  }

  for (const root of tree) {
    indexRaw(root);
  }

  const duplicateTopTitles = new Set<string>();
  for (const [title, count] of topLevelTitles.entries()) {
    if (count > 1) duplicateTopTitles.add(title);
  }

  const projections: BookmarkProjection[] = [];
  const byId = new Map<string, BookmarkProjection>();
  const childrenByParent = new Map<string, BookmarkProjection[]>();

  function walk(
    node: ChromeBookmarkNode,
    parentPath: string,
    ancestorManaged: boolean,
  ) {
    const isFolder = isFolderNode(node);
    const isManaged = ancestorManaged || Boolean(node.unmodifiable);
    const isSystem = isSystemFolderNode(node);
    const displayTitle = isFolder
      ? getFolderDisplayLabel(node, duplicateTopTitles)
      : node.title || node.url || '(無標題)';

    const currentPath =
      node.id === '0'
        ? ''
        : parentPath
          ? `${parentPath} / ${displayTitle}`
          : displayTitle;

    const writable = !isManaged && !isSystem;
    const canAddChild = isFolder && node.id !== '0' && !isManaged;

    const proj: BookmarkProjection = {
      profileKey,
      nodeId: node.id,
      parentId: node.parentId ?? '',
      index: node.index ?? 0,
      title: node.title,
      url: node.url,
      domain: extractDomain(node.url),
      dateAdded: node.dateAdded,
      folderType: node.folderType,
      syncing: node.syncing,
      unmodifiable: node.unmodifiable,
      isFolder,
      isSystemFolder: isSystem,
      writable,
      canAddChild,
      path: currentPath,
      childCount: node.children?.length ?? 0,
    };

    projections.push(proj);
    byId.set(proj.nodeId, proj);

    if (proj.parentId) {
      const siblings = childrenByParent.get(proj.parentId) ?? [];
      siblings.push(proj);
      childrenByParent.set(proj.parentId, siblings);
    }

    if (node.children) {
      for (const child of node.children) {
        walk(child, currentPath, isManaged);
      }
    }
  }

  for (const root of tree) {
    walk(root, '', false);
  }

  for (const siblings of childrenByParent.values()) {
    siblings.sort((a, b) => a.index - b.index);
  }

  return { projections, byId, childrenByParent, rawById };
}

export function wouldCreateCycle(
  movingFolderId: string,
  targetParentId: string,
  byId: Map<string, BookmarkProjection>,
): boolean {
  if (movingFolderId === targetParentId) return true;
  let cursor: string | undefined = targetParentId;
  const visited = new Set<string>();
  while (cursor) {
    if (cursor === movingFolderId) return true;
    if (visited.has(cursor)) return true;
    visited.add(cursor);
    const parent = byId.get(cursor);
    cursor = parent?.parentId || undefined;
  }
  return false;
}

export function getDescendantIds(
  folderId: string,
  childrenByParent: Map<string, BookmarkProjection[]>,
): string[] {
  const result: string[] = [];
  const stack = [...(childrenByParent.get(folderId) ?? [])];
  while (stack.length > 0) {
    const item = stack.shift()!;
    result.push(item.nodeId);
    if (item.isFolder) {
      const children = childrenByParent.get(item.nodeId) ?? [];
      stack.push(...children);
    }
  }
  return result;
}

export function getEmptyWritableFolders(
  projections: BookmarkProjection[],
): BookmarkProjection[] {
  return projections.filter(
    (p) => p.isFolder && p.writable && p.childCount === 0,
  );
}

export function getWritableFolders(
  projections: BookmarkProjection[],
): BookmarkProjection[] {
  return projections.filter((p) => p.isFolder && p.canAddChild);
}

/**
 * Computes the exact `index` argument to pass to `chrome.bookmarks.move(id, { parentId, index })`
 * given the current live sibling IDs of the destination folder.
 *
 * Chrome's `BookmarkModel::Move` adjusts same-parent forward moves by decrementing `index`
 * when `index > oldIndex` (it behaves like inserting before the slot in the pre-removal array).
 *
 * This helper translates a clear post-move slot (`desiredFinalIndex` in 0..finalLen-1) or
 * anchor (`beforeSiblingId` / `afterSiblingId`) into the exact index Chrome expects.
 */
/** Thrown when a reorder anchor no longer exists among the destination's live children. */
export class StaleMoveAnchorError extends Error {
  constructor() {
    super('目標位置在您操作前已變更（參考書籤已移動或刪除），請重新整理後再試。');
    this.name = 'StaleMoveAnchorError';
  }
}

export function resolveMoveIndex(params: {
  liveTargetChildIds: string[];
  movingNodeId: string;
  sameParent: boolean;
  desiredFinalIndex?: number;
  beforeSiblingId?: string;
  afterSiblingId?: string;
}): number | undefined {
  const {
    liveTargetChildIds,
    movingNodeId,
    sameParent,
    desiredFinalIndex,
    beforeSiblingId,
    afterSiblingId,
  } = params;

  const currentIdx = liveTargetChildIds.indexOf(movingNodeId);
  const withoutMoving = liveTargetChildIds.filter((id) => id !== movingNodeId);

  let finalIndex: number | undefined;
  if (beforeSiblingId) {
    const idx = withoutMoving.indexOf(beforeSiblingId);
    // A vanished anchor must not silently turn into "append at the end"
    if (idx === -1) throw new StaleMoveAnchorError();
    finalIndex = idx;
  } else if (afterSiblingId) {
    const idx = withoutMoving.indexOf(afterSiblingId);
    if (idx === -1) throw new StaleMoveAnchorError();
    finalIndex = idx + 1;
  } else if (typeof desiredFinalIndex === 'number') {
    finalIndex = Math.max(0, Math.min(desiredFinalIndex, withoutMoving.length));
  }

  if (finalIndex === undefined) {
    return undefined;
  }

  if (sameParent && currentIdx !== -1 && finalIndex > currentIdx) {
    return finalIndex + 1;
  }
  return finalIndex;
}

/**
 * Deterministic 64-bit FNV-1a hex hash (dual 32-bit lanes) for scope fingerprinting.
 * Pure JS & synchronous so it works identically in Service Workers, Studio UI, and Node.
 */
function fnv1aHex(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x9e3779b9;
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    h1 ^= code;
    h1 = Math.imul(h1, 0x01000193);
    h2 ^= code + (i & 0xff);
    h2 = Math.imul(h2, 0x01000193);
  }
  return (
    (h1 >>> 0).toString(16).padStart(8, '0') +
    (h2 >>> 0).toString(16).padStart(8, '0')
  );
}

export function collectScopeNodes(
  flattened: FlattenedTree,
  scope: PlanScope,
): {
  inScopeBookmarks: BookmarkProjection[];
  affectedFolderIds: Set<string>;
} {
  const affectedFolderIds = new Set<string>(scope.targetFolderIds);
  const inScopeBookmarks: BookmarkProjection[] = [];

  if (scope.type === 'folder' && scope.folderId) {
    affectedFolderIds.add(scope.folderId);
    const children = flattened.childrenByParent.get(scope.folderId) ?? [];
    for (const c of children) {
      if (!c.isFolder) {
        inScopeBookmarks.push(c);
      } else {
        affectedFolderIds.add(c.nodeId);
      }
    }
  } else if (scope.type === 'selection' && scope.bookmarkIds) {
    for (const id of scope.bookmarkIds) {
      const node = flattened.byId.get(id);
      if (node && !node.isFolder) {
        inScopeBookmarks.push(node);
        if (node.parentId) affectedFolderIds.add(node.parentId);
      }
    }
  } else {
    for (const node of flattened.projections) {
      if (!node.isFolder) {
        inScopeBookmarks.push(node);
        if (node.parentId) affectedFolderIds.add(node.parentId);
      } else if (node.canAddChild) {
        affectedFolderIds.add(node.nodeId);
      }
    }
  }

  return { inScopeBookmarks, affectedFolderIds };
}

export function computeScopeFingerprint(
  flattened: FlattenedTree,
  scope: PlanScope,
): string {
  const { inScopeBookmarks, affectedFolderIds } = collectScopeNodes(
    flattened,
    scope,
  );
  const lines: string[] = [];

  const sortedBookmarks = [...inScopeBookmarks].sort((a, b) =>
    a.nodeId.localeCompare(b.nodeId),
  );
  for (const b of sortedBookmarks) {
    lines.push(
      `B|${b.nodeId}|${b.parentId}|${b.index}|${b.title}|${b.url ?? ''}`,
    );
  }

  const sortedFolders = [...affectedFolderIds].sort();
  for (const folderId of sortedFolders) {
    const folder = flattened.byId.get(folderId);
    const children = flattened.childrenByParent.get(folderId) ?? [];
    const childSig = children
      .map((c) => `${c.nodeId}:${c.index}:${c.title}:${c.url ?? ''}`)
      .join(',');
    lines.push(
      `F|${folderId}|${folder?.parentId ?? ''}|${folder?.title ?? ''}|[${childSig}]`,
    );
  }

  return fnv1aHex(lines.join('\n'));
}

export function extractSnapshotNodes(
  flattened: FlattenedTree,
  scope: PlanScope,
): SnapshotNode[] {
  const nodeIds = new Set<string>();
  const { inScopeBookmarks, affectedFolderIds } = collectScopeNodes(
    flattened,
    scope,
  );

  for (const b of inScopeBookmarks) {
    nodeIds.add(b.nodeId);
  }
  for (const folderId of affectedFolderIds) {
    nodeIds.add(folderId);
    const children = flattened.childrenByParent.get(folderId) ?? [];
    for (const c of children) {
      nodeIds.add(c.nodeId);
    }
  }

  const result: SnapshotNode[] = [];
  for (const id of nodeIds) {
    const p = flattened.byId.get(id);
    if (!p) continue;
    result.push({
      id: p.nodeId,
      parentId: p.parentId || undefined,
      index: p.index,
      title: p.title,
      url: p.url,
      dateAdded: p.dateAdded,
      folderType: p.folderType,
      syncing: p.syncing,
      unmodifiable: p.unmodifiable,
      isFolder: p.isFolder,
    });
  }
  return result;
}

export function extractFullSnapshotNodes(
  flattened: FlattenedTree,
): SnapshotNode[] {
  return flattened.projections.map((p) => ({
    id: p.nodeId,
    parentId: p.parentId || undefined,
    index: p.index,
    title: p.title,
    url: p.url,
    dateAdded: p.dateAdded,
    folderType: p.folderType,
    syncing: p.syncing,
    unmodifiable: p.unmodifiable,
    isFolder: p.isFolder,
  }));
}
