import React, { useState } from 'react';
import type { BookmarkProjection } from '@/core/types';
import {
  IconBookmark,
  IconClock,
  IconCopy,
  IconFolder,
  IconLinkOff,
  IconTagOff,
} from './Icons';

export type SmartViewType =
  | 'all'
  | 'recent'
  | 'duplicates'
  | 'untagged'
  | 'deadlinks'
  | 'folder';

interface FolderTreeProps {
  projections: BookmarkProjection[];
  childrenByParent: Map<string, BookmarkProjection[]>;
  smartView: SmartViewType;
  selectedFolderId: string | null;
  expandedIds: Set<string>;
  duplicateCount: number;
  untaggedCount: number;
  deadLinkCount: number;
  onSelectSmartView: (view: SmartViewType) => void;
  onSelectFolder: (folderId: string) => void;
  onToggleExpand: (folderId: string) => void;
  onDropBookmarkOnFolder: (nodeId: string, folderId: string) => void;
  onDeleteEmptyFolder: (folder: BookmarkProjection) => void;
}

export function FolderTree({
  projections,
  childrenByParent,
  smartView,
  selectedFolderId,
  expandedIds,
  duplicateCount,
  untaggedCount,
  deadLinkCount,
  onSelectSmartView,
  onSelectFolder,
  onToggleExpand,
  onDropBookmarkOnFolder,
  onDeleteEmptyFolder,
}: FolderTreeProps) {
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const totalBookmarks = projections.filter((p) => !p.isFolder).length;

  // Detect duplicate titles among top-level folders to show local vs account tag clearly
  const topFolders = (childrenByParent.get('0') ?? []).filter((n) => n.isFolder);
  const topTitleCount = new Map<string, number>();
  for (const f of topFolders) {
    topTitleCount.set(f.title, (topTitleCount.get(f.title) ?? 0) + 1);
  }

  const renderFolder = (folder: BookmarkProjection, depth: number) => {
    const childNodes = childrenByParent.get(folder.nodeId) ?? [];
    const subFolders = childNodes.filter((c) => c.isFolder);
    const isExpanded = expandedIds.has(folder.nodeId);
    const isSelected = smartView === 'folder' && selectedFolderId === folder.nodeId;
    const isEmptyWritable = folder.writable && childNodes.length === 0;
    const showSyncBadge =
      (folder.parentId === '0' || Boolean(folder.folderType)) &&
      (topTitleCount.get(folder.title) ?? 0) > 1 &&
      typeof folder.syncing === 'boolean';

    return (
      <div key={folder.nodeId} role="treeitem" aria-expanded={subFolders.length > 0 ? isExpanded : undefined}>
        <div
          className={`tree-row ${isSelected ? 'selected' : ''} ${dragOverId === folder.nodeId ? 'drag-over' : ''}`}
          style={{ paddingLeft: `${depth * 14 + 4}px` }}
          onDragOver={(e) => {
            if (!folder.canAddChild) return;
            e.preventDefault();
            setDragOverId(folder.nodeId);
          }}
          onDragLeave={() => {
            if (dragOverId === folder.nodeId) setDragOverId(null);
          }}
          onDrop={(e) => {
            e.preventDefault();
            setDragOverId(null);
            if (!folder.canAddChild) return;
            const draggedId = e.dataTransfer.getData('text/favorsite-node-id');
            if (draggedId && draggedId !== folder.nodeId) {
              onDropBookmarkOnFolder(draggedId, folder.nodeId);
            }
          }}
        >
          <button
            type="button"
            className="tree-toggle"
            aria-label={isExpanded ? `收合 ${folder.title}` : `展開 ${folder.title}`}
            disabled={subFolders.length === 0}
            onClick={() => onToggleExpand(folder.nodeId)}
          >
            {subFolders.length > 0 ? (isExpanded ? '▾' : '▸') : '·'}
          </button>

          <button
            type="button"
            className="tree-label-btn"
            onClick={() => onSelectFolder(folder.nodeId)}
            title={folder.path}
          >
            <IconFolder size={15} />
            <span className="tree-label-text">
              {folder.title || '未命名資料夾'}
            </span>
          </button>

          {showSyncBadge && (
            <span className="wf-badge">{folder.syncing ? '帳戶' : '本機'}</span>
          )}
          {!folder.canAddChild && <span className="wf-badge warn">唯讀</span>}
          {isEmptyWritable && (
            <button
              type="button"
              className="ghost sm"
              title="移除空資料夾"
              aria-label={`移除空資料夾 ${folder.title}`}
              onClick={(e) => {
                e.stopPropagation();
                onDeleteEmptyFolder(folder);
              }}
            >
              刪空
            </button>
          )}
          <span className="wf-muted" style={{ fontSize: 11 }}>
            {childNodes.length}
          </span>
        </div>

        {isExpanded && subFolders.length > 0 && (
          <div role="group">
            {subFolders.map((sub) => renderFolder(sub, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  return (
    <nav aria-label="書籤導覽">
      <div className="tree-section-title">快速檢視</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
        <button
          type="button"
          className="nav-item"
          aria-current={smartView === 'all' ? 'true' : undefined}
          onClick={() => onSelectSmartView('all')}
        >
          <span className="nav-item-label">
            <IconBookmark size={16} />
            <span>全部書籤</span>
          </span>
          <span className="wf-muted">{totalBookmarks}</span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-current={smartView === 'recent' ? 'true' : undefined}
          onClick={() => onSelectSmartView('recent')}
        >
          <span className="nav-item-label">
            <IconClock size={16} />
            <span>最近新增</span>
          </span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-current={smartView === 'duplicates' ? 'true' : undefined}
          onClick={() => onSelectSmartView('duplicates')}
        >
          <span className="nav-item-label">
            <IconCopy size={16} />
            <span>重複書籤</span>
          </span>
          <span className={`wf-badge ${duplicateCount > 0 ? 'warn' : ''}`}>
            {duplicateCount}
          </span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-current={smartView === 'untagged' ? 'true' : undefined}
          onClick={() => onSelectSmartView('untagged')}
        >
          <span className="nav-item-label">
            <IconTagOff size={16} />
            <span>待分類（無標籤）</span>
          </span>
          <span className="wf-muted">{untaggedCount}</span>
        </button>
        <button
          type="button"
          className="nav-item"
          aria-current={smartView === 'deadlinks' ? 'true' : undefined}
          onClick={() => onSelectSmartView('deadlinks')}
        >
          <span className="nav-item-label">
            <IconLinkOff size={16} />
            <span>失效連結</span>
          </span>
          <span className={`wf-badge ${deadLinkCount > 0 ? 'danger' : ''}`}>
            {deadLinkCount}
          </span>
        </button>
      </div>

      <div className="tree-section-title" style={{ marginTop: 14 }}>
        資料夾樹
      </div>
      <div role="tree" aria-label="Chrome 書籤資料夾">
        {topFolders.map((f) => renderFolder(f, 0))}
      </div>
    </nav>
  );
}
