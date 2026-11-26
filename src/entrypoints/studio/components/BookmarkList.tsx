import React, { useEffect, useState } from 'react';
import type {
  BookmarkMetadata,
  BookmarkProjection,
  DuplicateGroup,
  LinkCheckRecord,
} from '@/core/types';
import { isLinkCheckCurrent } from '@/core/link-checker';
import type { SmartViewType } from './FolderTree';
import { IconDownload, IconFolder, IconGlobe, IconLinkOff, IconSparkles } from './Icons';

function renderLinkBadge(linkCheck?: LinkCheckRecord) {
  if (!linkCheck) return null;
  switch (linkCheck.status) {
    case 'dead_404_410':
      return (
        <span className="wf-badge danger" title={linkCheck.note}>
          失效 {linkCheck.httpStatus ?? 404}
        </span>
      );
    case 'dead_unreachable':
      return (
        <span className="wf-badge warn" title={linkCheck.note}>
          無法連線
        </span>
      );
    case 'redirect':
      return (
        <span className="wf-badge" title={linkCheck.note}>
          重導 {linkCheck.httpStatus ?? 302}
        </span>
      );
    case 'auth_blocked':
      return (
        <span className="wf-badge warn" title={linkCheck.note}>
          需登入/受限 {linkCheck.httpStatus ?? ''}
        </span>
      );
    case 'rate_limited':
      return (
        <span className="wf-badge warn" title={linkCheck.note}>
          限流 429
        </span>
      );
    case 'server_error':
      return (
        <span className="wf-badge warn" title={linkCheck.note}>
          伺服器錯誤 {linkCheck.httpStatus ?? 500}
        </span>
      );
    case 'timeout':
      return (
        <span className="wf-badge warn" title={linkCheck.note}>
          逾時
        </span>
      );
    case 'ok':
      return (
        <span className="wf-badge ok" title={linkCheck.note}>
          正常 {linkCheck.httpStatus ?? 200}
        </span>
      );
    case 'skipped_private':
    case 'skipped_sensitive':
      return (
        <span className="wf-badge" title={linkCheck.note}>
          已略過檢查
        </span>
      );
    case 'not_authorized':
      return (
        <span className="wf-badge" title={linkCheck.note}>
          未授權檢查
        </span>
      );
    default:
      return null;
  }
}

interface BookmarkListProps {
  items: BookmarkProjection[];
  allById: Map<string, BookmarkProjection>;
  writableFolders: BookmarkProjection[];
  metadataByNodeId: Map<string, BookmarkMetadata>;
  smartView: SmartViewType;
  selectedFolder: BookmarkProjection | null;
  duplicateGroups: DuplicateGroup[];
  selectedIds: Set<string>;
  activeNodeId: string | null;
  searchQuery: string;
  busy: boolean;
  onToggleSelect: (nodeId: string, shiftKey: boolean) => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onActivateNode: (nodeId: string) => void;
  onMoveItem: (
    nodeId: string,
    toParentId: string,
    opts?: { desiredFinalIndex?: number; beforeSiblingId?: string },
  ) => void;
  onDeleteItem: (node: BookmarkProjection) => void;
  onExportBackup: () => void;
  onOpenCreateForm: (kind: 'bookmark' | 'folder') => void;
  onStartOrganize: () => void;
  onCheckLinks: () => void;
  onBatchMove: (targetFolderId: string) => void;
  onDeleteDuplicates: () => void;
}

function formatDate(ts?: number): string {
  if (!ts) return '時間未知';
  try {
    return new Date(ts).toLocaleDateString('zh-TW', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
  } catch {
    return '時間未知';
  }
}

export function BookmarkList({
  items,
  allById,
  writableFolders,
  metadataByNodeId,
  smartView,
  selectedFolder,
  duplicateGroups,
  selectedIds,
  activeNodeId,
  searchQuery,
  busy,
  onToggleSelect,
  onSelectAll,
  onClearSelection,
  onActivateNode,
  onMoveItem,
  onDeleteItem,
  onExportBackup,
  onOpenCreateForm,
  onStartOrganize,
  onCheckLinks,
  onBatchMove,
  onDeleteDuplicates,
}: BookmarkListProps) {
  const [dragOverRowId, setDragOverRowId] = useState<string | null>(null);
  const [movePickerNodeId, setMovePickerNodeId] = useState<string | null>(null);
  const [batchDestFolderId, setBatchDestFolderId] = useState<string>('');
  const hasExactDuplicates = duplicateGroups.some((group) => group.kind === 'exact');
  /**
   * Element ids to try (in order) once the list has re-rendered after a move. Moving a
   * row re-orders the DOM and can disable the pressed button (e.g. 上移 at the top), which
   * otherwise drops keyboard focus to <body> (WCAG 2.4.3).
   */
  const [pendingFocusIds, setPendingFocusIds] = useState<string[] | null>(null);

  useEffect(() => {
    if (!pendingFocusIds || busy) return;
    // Only repair LOST focus; never pull focus away from where the user has moved on to
    const current = document.activeElement as HTMLElement | null;
    const focusLost =
      !current ||
      current === document.body ||
      !current.isConnected ||
      (current as HTMLButtonElement).disabled === true ||
      pendingFocusIds.includes(current.id);
    if (!focusLost) {
      setPendingFocusIds(null);
      return;
    }
    for (const id of pendingFocusIds) {
      const el = document.getElementById(id) as HTMLButtonElement | null;
      if (el && !el.disabled) {
        el.focus();
        break;
      }
    }
    setPendingFocusIds(null);
  }, [pendingFocusIds, busy, items]);

  const viewTitle =
    smartView === 'all'
      ? '全部書籤'
      : smartView === 'recent'
        ? '最近新增'
        : smartView === 'duplicates'
          ? '重複書籤檢查'
          : smartView === 'untagged'
            ? '待分類（無標籤）'
            : smartView === 'deadlinks'
              ? '失效連結（404/410 與無法連線）'
              : selectedFolder?.path || '資料夾';

  const canReorderHere = smartView === 'folder' && !searchQuery.trim();

  const renderRow = (item: BookmarkProjection, idx: number, siblings: BookmarkProjection[]) => {
    const meta = metadataByNodeId.get(item.nodeId);
    const tags = meta?.tags ?? [];
    const parent = allById.get(item.parentId);
    const isSelected = selectedIds.has(item.nodeId);
    const isActive = activeNodeId === item.nodeId;
    const isMovingHere = movePickerNodeId === item.nodeId;

    return (
      <li
        key={item.nodeId}
        className={`bookmark-row ${isActive ? 'active' : ''} ${dragOverRowId === item.nodeId ? 'drag-over' : ''}`}
        draggable={item.writable}
        onDragStart={(e) => {
          e.dataTransfer.setData('text/favorsite-node-id', item.nodeId);
          e.dataTransfer.effectAllowed = 'move';
        }}
        onDragOver={(e) => {
          if (!canReorderHere) return;
          e.preventDefault();
          setDragOverRowId(item.nodeId);
        }}
        onDragLeave={() => {
          if (dragOverRowId === item.nodeId) setDragOverRowId(null);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setDragOverRowId(null);
          if (!canReorderHere) return;
          const draggedId = e.dataTransfer.getData('text/favorsite-node-id');
          if (draggedId && draggedId !== item.nodeId) {
            onMoveItem(draggedId, item.parentId, { beforeSiblingId: item.nodeId });
          }
        }}
      >
        {!item.isFolder && (
          <input
            type="checkbox"
            aria-label={`選取 ${item.title || item.url}`}
            checked={isSelected}
            style={{ marginTop: 10 }}
            onChange={(e) =>
              onToggleSelect(
                item.nodeId,
                (e.nativeEvent as MouseEvent).shiftKey === true,
              )
            }
          />
        )}

        <div className={`bookmark-icon-tile ${item.isFolder ? 'folder' : ''}`}>
          {item.isFolder ? <IconFolder size={18} /> : <IconGlobe size={18} />}
        </div>

        <div className="bookmark-main">
          <div className="bookmark-title-line">
            <button
              id={`row-title-${item.nodeId}`}
              type="button"
              className="bookmark-title-btn"
              onClick={() => onActivateNode(item.nodeId)}
            >
              {item.isFolder ? item.title : item.title || '(無標題)'}
            </button>
            {!item.writable && <span className="wf-badge warn">唯讀</span>}
            {!item.isFolder &&
              isLinkCheckCurrent(meta?.linkCheck, item.url) &&
              renderLinkBadge(meta?.linkCheck)}
            {tags.map((tag) => (
              <span key={tag} className="wf-badge primary">
                #{tag}
              </span>
            ))}
          </div>

          <div className="bookmark-meta-line">
            {item.domain && <span className="bookmark-domain">{item.domain}</span>}
            {parent && <span>• 位置：{parent.path || parent.title}</span>}
            <span>
              新增：{formatDate(meta?.originalDateAdded ?? item.dateAdded)}
              {meta?.originalDateAdded ? ' (原始備份)' : ''}
            </span>
          </div>

          {isMovingHere && (
            <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
              <select
                aria-label="選擇目的資料夾"
                autoFocus
                defaultValue={item.parentId}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') {
                    e.stopPropagation();
                    setMovePickerNodeId(null);
                    setPendingFocusIds([`row-move-${item.nodeId}`]);
                  }
                }}
                onChange={(e) => {
                  const destId = e.target.value;
                  if (destId && destId !== item.parentId) {
                    // The row may leave this view: fall back to a neighbour, then the heading
                    const neighbour = siblings[idx + 1] ?? siblings[idx - 1];
                    setPendingFocusIds([
                      `row-move-${item.nodeId}`,
                      ...(neighbour ? [`row-title-${neighbour.nodeId}`] : []),
                      'bookmark-list-heading',
                    ]);
                    onMoveItem(item.nodeId, destId);
                  } else {
                    setPendingFocusIds([`row-move-${item.nodeId}`]);
                  }
                  setMovePickerNodeId(null);
                }}
              >
                {writableFolders.map((f) => (
                  <option key={f.nodeId} value={f.nodeId}>
                    {f.path || f.title}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="sm"
                onClick={() => {
                  setMovePickerNodeId(null);
                  setPendingFocusIds([`row-move-${item.nodeId}`]);
                }}
              >
                取消
              </button>
            </div>
          )}

          <div className="bookmark-row-actions">
            {canReorderHere && item.writable && (
              <>
                <button
                  id={`row-up-${item.nodeId}`}
                  type="button"
                  className="sm"
                  disabled={idx === 0}
                  aria-label={`上移 ${item.title}`}
                  onClick={() => {
                    const prev = siblings[idx - 1];
                    if (prev) {
                      setPendingFocusIds([
                        `row-up-${item.nodeId}`,
                        `row-down-${item.nodeId}`,
                        `row-title-${item.nodeId}`,
                      ]);
                      onMoveItem(item.nodeId, item.parentId, {
                        beforeSiblingId: prev.nodeId,
                      });
                    }
                  }}
                >
                  上移
                </button>
                <button
                  id={`row-down-${item.nodeId}`}
                  type="button"
                  className="sm"
                  disabled={idx === siblings.length - 1}
                  aria-label={`下移 ${item.title}`}
                  onClick={() => {
                    setPendingFocusIds([
                      `row-down-${item.nodeId}`,
                      `row-up-${item.nodeId}`,
                      `row-title-${item.nodeId}`,
                    ]);
                    onMoveItem(item.nodeId, item.parentId, {
                      desiredFinalIndex: item.index + 1,
                    });
                  }}
                >
                  下移
                </button>
              </>
            )}
            {item.writable && (
              <>
                <button
                  id={`row-move-${item.nodeId}`}
                  type="button"
                  className="sm"
                  aria-expanded={isMovingHere}
                  onClick={() =>
                    setMovePickerNodeId(isMovingHere ? null : item.nodeId)
                  }
                >
                  移至
                </button>
                <button
                  type="button"
                  className="sm danger"
                  aria-label={`刪除 ${item.title}`}
                  disabled={busy}
                  onClick={() => onDeleteItem(item)}
                >
                  刪除
                </button>
              </>
            )}
          </div>
        </div>
      </li>
    );
  };

  return (
    <>
      <div className="list-toolbar">
        <div className="list-toolbar-row">
          <h2 className="list-heading" id="bookmark-list-heading" tabIndex={-1}>
            <span>{viewTitle}</span>
            <span className="wf-badge">
              {smartView === 'duplicates'
                ? `${duplicateGroups.length} 組`
                : `${items.length} 筆`}
            </span>
          </h2>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button
              type="button"
              className="sm"
              disabled={busy}
              title="下載目前 Chrome 設定檔的書籤與標籤"
              onClick={onExportBackup}
            >
              <IconDownload size={14} />
              備份書籤
            </button>
            <button
              type="button"
              className="sm"
              onClick={() => onOpenCreateForm('bookmark')}
            >
              + 新增書籤
            </button>
            <button
              type="button"
              className="sm"
              onClick={() => onOpenCreateForm('folder')}
            >
              + 新增資料夾
            </button>
            <button
              type="button"
              className="sm"
              disabled={busy}
              onClick={onCheckLinks}
            >
              <IconLinkOff size={14} />
              檢查失效連結
            </button>
            <button
              type="button"
              className="sm primary"
              onClick={onStartOrganize}
            >
              <IconSparkles size={14} />
              整理此範圍
            </button>
          </div>
        </div>

        {smartView === 'duplicates' && duplicateGroups.length > 0 && (
          <div className="list-toolbar-row">
            <span className="wf-muted">
              {hasExactDuplicates
                ? '刪除完全相同網址的副本，每組保留最早加入的一筆。刪除前會備份。'
                : '目前只有疑似重複。核對網址後，可按該筆書籤的「刪除」。'}
            </span>
            <button
              type="button"
              className="sm danger"
              disabled={busy || !hasExactDuplicates}
              onClick={onDeleteDuplicates}
            >
              刪除重複書籤
            </button>
          </div>
        )}

        {smartView !== 'duplicates' && (
          <div className="list-toolbar-row">
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <button type="button" className="sm" onClick={onSelectAll}>
                全選本頁
              </button>
              {selectedIds.size > 0 && (
                <>
                  <span className="wf-badge">已選 {selectedIds.size} 筆</span>
                  <button type="button" className="sm" onClick={onClearSelection}>
                    清除選取
                  </button>
                  <select
                    aria-label="批次搬移目的資料夾"
                    value={batchDestFolderId}
                    onChange={(e) => setBatchDestFolderId(e.target.value)}
                  >
                    <option value="">批次搬移至…</option>
                    {writableFolders.map((f) => (
                      <option key={f.nodeId} value={f.nodeId}>
                        {f.path || f.title}
                      </option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="sm"
                    disabled={!batchDestFolderId}
                    onClick={() => {
                      if (!batchDestFolderId) return;
                      onBatchMove(batchDestFolderId);
                      setBatchDestFolderId('');
                    }}
                  >
                    產生搬移預覽
                  </button>
                </>
              )}
            </div>
            {searchQuery.trim() && (
              <span className="wf-muted">搜尋條件：{searchQuery}</span>
            )}
          </div>
        )}
      </div>

      {smartView === 'duplicates' ? (
        <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
          {duplicateGroups.length === 0 ? (
            <p className="wf-muted">未偵測到重複或疑似重複的書籤。</p>
          ) : (
            duplicateGroups.map((group) => (
              <section key={group.groupId} className="section-box">
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
                  <strong>{group.reason}</strong>
                  <span className={`wf-badge ${group.kind === 'exact' ? 'danger' : 'warn'}`}>
                    {group.kind === 'exact' ? '精確重複' : '疑似重複（需人工確認）'}
                  </span>
                </div>
                <div className="wf-mono wf-muted" style={{ wordBreak: 'break-all' }}>
                  {group.normalizedKey}
                </div>
                <ul className="bookmark-list" style={{ border: '1px solid var(--wf-border)' }}>
                  {group.nodeIds
                    .map((id) => allById.get(id))
                    .filter((n): n is BookmarkProjection => Boolean(n))
                    .map((n, idx, arr) => renderRow(n, idx, arr))}
                </ul>
              </section>
            ))
          )}
        </div>
      ) : (
        <ul className="bookmark-list" aria-label="書籤列表">
          {items.length === 0 ? (
            <li style={{ padding: 20 }} className="wf-muted">
              此檢視目前沒有書籤項目。
            </li>
          ) : (
            items.map((item, idx) => renderRow(item, idx, items))
          )}
        </ul>
      )}
    </>
  );
}
