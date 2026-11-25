import type { BookmarkApiAdapter, ChromeBookmarkNode } from '@/core/types';

function cloneNode(node: ChromeBookmarkNode): ChromeBookmarkNode {
  return {
    ...node,
    children: node.children ? node.children.map(cloneNode) : undefined,
  };
}

/**
 * In-memory Chrome Bookmarks API mock faithfully implementing Chromium's
 * parent/index bookkeeping and `BookmarkModel::Move` index adjustment rules.
 */
export class MockChromeBookmarks implements BookmarkApiAdapter {
  private root: ChromeBookmarkNode;
  private nextId = 100;

  constructor(initialTree?: ChromeBookmarkNode) {
    this.root = initialTree
      ? cloneNode(initialTree)
      : {
          id: '0',
          title: '',
          children: [
            {
              id: '1',
              parentId: '0',
              index: 0,
              title: '書籤列',
              folderType: 'bookmarks-bar',
              syncing: false,
              children: [],
            },
            {
              id: '2',
              parentId: '0',
              index: 1,
              title: '其他書籤',
              folderType: 'other',
              syncing: false,
              children: [],
            },
          ],
        };
    this.reindex(this.root);
  }

  private reindex(node: ChromeBookmarkNode): void {
    if (!node.children) return;
    node.children.forEach((child, i) => {
      child.parentId = node.id;
      child.index = i;
      this.reindex(child);
    });
  }

  private find(
    id: string,
    cursor: ChromeBookmarkNode = this.root,
  ): ChromeBookmarkNode | null {
    if (cursor.id === id) return cursor;
    if (!cursor.children) return null;
    for (const c of cursor.children) {
      const hit = this.find(id, c);
      if (hit) return hit;
    }
    return null;
  }

  private isManagedOrAncestorManaged(node: ChromeBookmarkNode): boolean {
    let cur: ChromeBookmarkNode | null = node;
    while (cur) {
      if (cur.unmodifiable) return true;
      cur = cur.parentId ? this.find(cur.parentId) : null;
    }
    return false;
  }

  async getTree(): Promise<ChromeBookmarkNode[]> {
    return [cloneNode(this.root)];
  }

  async get(id: string): Promise<ChromeBookmarkNode[]> {
    const node = this.find(id);
    if (!node) throw new Error(`Bookmark not found: ${id}`);
    const copy = cloneNode(node);
    delete copy.children;
    return [copy];
  }

  async getChildren(id: string): Promise<ChromeBookmarkNode[]> {
    const node = this.find(id);
    if (!node || !node.children) throw new Error(`Folder not found: ${id}`);
    return node.children.map((c) => {
      const copy = cloneNode(c);
      delete copy.children;
      return copy;
    });
  }

  async getSubTree(id: string): Promise<ChromeBookmarkNode[]> {
    const node = this.find(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    return [cloneNode(node)];
  }

  async create(details: {
    parentId?: string;
    index?: number;
    title?: string;
    url?: string;
  }): Promise<ChromeBookmarkNode> {
    const parentId = details.parentId ?? '2';
    const parent = this.find(parentId);
    if (!parent || !parent.children) {
      throw new Error(`Parent folder not found: ${parentId}`);
    }
    if (parent.id === '0' || this.isManagedOrAncestorManaged(parent)) {
      throw new Error(`Parent folder is not writable: ${parentId}`);
    }

    const id = String(this.nextId++);
    const created: ChromeBookmarkNode = {
      id,
      parentId,
      title: details.title ?? '',
      url: details.url,
      dateAdded: Date.now(),
      children: details.url === undefined ? [] : undefined,
    };

    const insertAt =
      typeof details.index === 'number'
        ? Math.max(0, Math.min(details.index, parent.children.length))
        : parent.children.length;
    parent.children.splice(insertAt, 0, created);
    this.reindex(parent);
    return cloneNode(created);
  }

  async update(
    id: string,
    changes: { title?: string; url?: string },
  ): Promise<ChromeBookmarkNode> {
    const node = this.find(id);
    if (!node) throw new Error(`Node not found: ${id}`);
    if (node.id === '0' || node.parentId === '0' || this.isManagedOrAncestorManaged(node)) {
      throw new Error(`Cannot modify protected node: ${id}`);
    }
    if (changes.title !== undefined) node.title = changes.title;
    if (changes.url !== undefined && node.url !== undefined) {
      node.url = changes.url;
    }
    return cloneNode(node);
  }

  async move(
    id: string,
    destination: { parentId?: string; index?: number },
  ): Promise<ChromeBookmarkNode> {
    const node = this.find(id);
    if (!node || !node.parentId) throw new Error(`Node not found: ${id}`);
    if (node.parentId === '0' || this.isManagedOrAncestorManaged(node)) {
      throw new Error(`Cannot move protected node: ${id}`);
    }

    const oldParent = this.find(node.parentId)!;
    const newParentId = destination.parentId ?? node.parentId;
    const newParent = this.find(newParentId);
    if (!newParent || !newParent.children) {
      throw new Error(`Destination folder not found: ${newParentId}`);
    }
    if (newParent.id === '0' || this.isManagedOrAncestorManaged(newParent)) {
      throw new Error(`Destination folder not writable: ${newParentId}`);
    }

    const oldIndex = oldParent.children!.findIndex((c) => c.id === id);
    let targetIndex =
      typeof destination.index === 'number'
        ? destination.index
        : newParent.children.length;

    // Match Chromium's BookmarkModel::Move same-parent forward adjustment
    if (oldParent.id === newParent.id && targetIndex > oldIndex) {
      targetIndex -= 1;
    }

    oldParent.children!.splice(oldIndex, 1);
    targetIndex = Math.max(0, Math.min(targetIndex, newParent.children.length));
    newParent.children.splice(targetIndex, 0, node);

    this.reindex(oldParent);
    if (newParent.id !== oldParent.id) {
      this.reindex(newParent);
    }
    return cloneNode(node);
  }

  async remove(id: string): Promise<void> {
    const node = this.find(id);
    if (!node || !node.parentId) throw new Error(`Node not found: ${id}`);
    if (node.parentId === '0' || this.isManagedOrAncestorManaged(node)) {
      throw new Error(`Cannot remove protected node: ${id}`);
    }
    if (node.children && node.children.length > 0) {
      throw new Error(`Cannot remove non-empty folder: ${id}`);
    }
    const parent = this.find(node.parentId)!;
    parent.children = parent.children!.filter((c) => c.id !== id);
    this.reindex(parent);
  }

  async removeTree(id: string): Promise<void> {
    const node = this.find(id);
    if (!node || !node.parentId) throw new Error(`Node not found: ${id}`);
    if (node.parentId === '0' || this.isManagedOrAncestorManaged(node)) {
      throw new Error(`Cannot remove protected folder: ${id}`);
    }
    const parent = this.find(node.parentId)!;
    parent.children = parent.children!.filter((c) => c.id !== id);
    this.reindex(parent);
  }
}
