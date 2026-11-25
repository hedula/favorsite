import React, { useEffect, useRef, useState } from 'react';
import {
  enableDead404Removals,
  getDependentOperations,
  overrideMoveDestination,
  togglePlanOperation,
  type DeadLinkCleanupAction,
} from '@/core/planner';
import type { PromptApiStatus } from '@/core/prompt-api';
import type {
  AiProviderPreference,
  AppSettings,
  BookmarkMetadata,
  BookmarkProjection,
  ExecutionJob,
  OrganizePlan,
  PlanScope,
  PlanSource,
} from '@/core/types';
import { IconBolt, IconLinkOff, IconSparkles } from './Icons';

export type RightPaneMode = 'inspect' | 'create' | 'organize';

const PLAN_SOURCE_LABEL: Record<PlanSource, string> = {
  'chrome-prompt-api': 'Chrome 內建 AI (Gemini Nano)',
  rule: '本機離線規則',
  manual: '手動批次',
};

interface InspectorPanelProps {
  mode: RightPaneMode;
  createKind: 'bookmark' | 'folder';
  activeNode: BookmarkProjection | null;
  activeMetadata: BookmarkMetadata | undefined;
  writableFolders: BookmarkProjection[];
  defaultParentId: string;
  selectedIds: Set<string>;
  selectedFolder: BookmarkProjection | null;
  settings: AppSettings;
  promptApiStatus: PromptApiStatus | null;
  aiDownloadFraction: number | null;
  aiLiveStatus: string;
  isGeneratingAi: boolean;
  activePlan: OrganizePlan | null;
  isPlanStale: boolean;
  lastAppliedJob: ExecutionJob | null;
  busy: boolean;
  onSetMode: (mode: RightPaneMode) => void;
  onCreateNode: (payload: {
    parentId: string;
    title: string;
    url?: string;
  }) => Promise<void>;
  onSaveNode: (payload: {
    nodeId: string;
    title: string;
    url?: string;
    tags: string[];
    newParentId?: string;
  }) => Promise<void>;
  onDeleteNode: (node: BookmarkProjection) => Promise<void>;
  onGeneratePlan: (params: {
    scope: PlanScope;
    instruction: string;
    mode: AiProviderPreference;
    baseParentId: string;
  }) => Promise<void>;
  onCheckLinksInScope: (scope: PlanScope) => void;
  onGenerateDeadLinkPlan: (params: {
    scope: PlanScope;
    action: DeadLinkCleanupAction;
    baseParentId: string;
    includeUnreachable: boolean;
  }) => Promise<void>;
  onAbortAiGeneration: () => void;
  onUpdatePlan: (plan: OrganizePlan) => Promise<void>;
  onApplyPlan: (plan: OrganizePlan) => Promise<void>;
  onCancelPlan: () => void;
  onRestoreJob: (jobId: string) => Promise<void>;
}

export function InspectorPanel({
  mode,
  createKind,
  activeNode,
  activeMetadata,
  writableFolders,
  defaultParentId,
  selectedIds,
  selectedFolder,
  settings,
  promptApiStatus,
  aiDownloadFraction,
  aiLiveStatus,
  isGeneratingAi,
  activePlan,
  isPlanStale,
  lastAppliedJob,
  busy,
  onSetMode,
  onCreateNode,
  onSaveNode,
  onDeleteNode,
  onGeneratePlan,
  onCheckLinksInScope,
  onGenerateDeadLinkPlan,
  onAbortAiGeneration,
  onUpdatePlan,
  onApplyPlan,
  onCancelPlan,
  onRestoreJob,
}: InspectorPanelProps) {
  // Edit form state
  const [editTitle, setEditTitle] = useState('');
  const [editUrl, setEditUrl] = useState('');
  const [editParentId, setEditParentId] = useState('');
  const [editTags, setEditTags] = useState('');

  // Create form state
  const [newTitle, setNewTitle] = useState('');
  const [newUrl, setNewUrl] = useState('');
  const [newParentId, setNewParentId] = useState(defaultParentId);

  // Organize form state
  const [instruction, setInstruction] = useState('');
  const [orgMode, setOrgMode] = useState<AiProviderPreference>(
    settings.aiProvider || 'auto',
  );
  const [baseParentId, setBaseParentId] = useState(defaultParentId);
  const [expandScopeAll, setExpandScopeAll] = useState(false);
  const [deadLinkAction, setDeadLinkAction] =
    useState<DeadLinkCleanupAction>('quarantine');
  const [includeUnreachable, setIncludeUnreachable] = useState(false);
  const generateBtnRef = useRef<HTMLButtonElement | null>(null);
  const stopBtnRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    setOrgMode(settings.aiProvider || 'auto');
  }, [settings.aiProvider]);

  useEffect(() => {
    if (activeNode) {
      setEditTitle(activeNode.title);
      setEditUrl(activeNode.url ?? '');
      setEditParentId(activeNode.parentId);
      setEditTags((activeMetadata?.tags ?? []).join(', '));
    }
  }, [activeNode, activeMetadata]);

  useEffect(() => {
    setNewParentId(defaultParentId);
    setBaseParentId(defaultParentId);
  }, [defaultParentId]);

  const computeCurrentScope = (): PlanScope => {
    if (expandScopeAll) {
      return {
        type: 'all',
        targetFolderIds: baseParentId ? [baseParentId] : [],
      };
    }
    if (selectedIds.size > 0) {
      return {
        type: 'selection',
        bookmarkIds: Array.from(selectedIds),
        targetFolderIds: baseParentId ? [baseParentId] : [],
      };
    }
    if (selectedFolder) {
      return {
        type: 'folder',
        folderId: selectedFolder.nodeId,
        targetFolderIds: [baseParentId || selectedFolder.nodeId],
      };
    }
    return {
      type: 'all',
      targetFolderIds: baseParentId ? [baseParentId] : [],
    };
  };

  const scopeSummaryText = expandScopeAll
    ? '全部可寫書籤'
    : selectedIds.size > 0
      ? `已勾選 ${selectedIds.size} 筆書籤`
      : selectedFolder
        ? `資料夾：${selectedFolder.path || selectedFolder.title}`
        : '全部可寫書籤';

  if (mode === 'create') {
    return (
      <section className="section-box" aria-label="新增項目">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <strong>{createKind === 'folder' ? '新增資料夾' : '新增書籤'}</strong>
          <button type="button" className="sm" onClick={() => onSetMode('organize')}>
            返回
          </button>
        </div>

        <form
          style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
          onSubmit={(e) => {
            e.preventDefault();
            void onCreateNode({
              parentId: newParentId,
              title: newTitle,
              url: createKind === 'bookmark' ? newUrl : undefined,
            }).then(() => {
              setNewTitle('');
              setNewUrl('');
              onSetMode('organize');
            });
          }}
        >
          <div className="form-field">
            <label htmlFor="create-parent">目的資料夾</label>
            <select
              id="create-parent"
              value={newParentId}
              onChange={(e) => setNewParentId(e.target.value)}
            >
              {writableFolders.map((f) => (
                <option key={f.nodeId} value={f.nodeId}>
                  {f.path || f.title}
                </option>
              ))}
            </select>
          </div>
          <div className="form-field">
            <label htmlFor="create-title">標題</label>
            <input
              id="create-title"
              type="text"
              required
              value={newTitle}
              onChange={(e) => setNewTitle(e.target.value)}
              placeholder={createKind === 'folder' ? '例如：KV' : '書籤標題'}
            />
          </div>
          {createKind === 'bookmark' && (
            <div className="form-field">
              <label htmlFor="create-url">網址</label>
              <input
                id="create-url"
                type="url"
                required
                value={newUrl}
                onChange={(e) => setNewUrl(e.target.value)}
                placeholder="https://developers.cloudflare.com/kv/"
              />
            </div>
          )}
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="submit" className="primary" disabled={busy}>
              建立並寫入 Chrome
            </button>
            <button type="button" onClick={() => onSetMode('organize')}>
              取消
            </button>
          </div>
        </form>
      </section>
    );
  }

  const createOps =
    activePlan?.operations.filter((o) => o.type === 'createFolder') ?? [];
  const moveOps =
    activePlan?.operations.filter(
      (o) => o.type === 'moveBookmark' && !o.requiresReview,
    ) ?? [];
  const reviewOps =
    activePlan?.operations.filter(
      (o) => o.type === 'moveBookmark' && o.requiresReview,
    ) ?? [];
  const removeOps =
    activePlan?.operations.filter((o) => o.type === 'removeBookmark') ?? [];
  const renameOps =
    activePlan?.operations.filter((o) => o.type === 'renameBookmark') ?? [];
  const tagOps =
    activePlan?.operations.filter((o) => o.type === 'addTag') ?? [];

  const enabledCount =
    activePlan?.operations.filter((o) => o.enabled).length ?? 0;

  const inspectCard =
    mode === 'inspect' ? (
      activeNode ? (
        <section className="section-box" aria-label="書籤明細編輯">
          <div className="section-header">
            <h3 className="section-title">
              {activeNode.isFolder ? '資料夾明細' : '書籤明細'}
            </h3>
            <button
              type="button"
              className="sm"
              onClick={() => onSetMode('organize')}
            >
              收合明細
            </button>
          </div>

          {!activeNode.writable && (
            <div className="wf-banner warn">
              此項目為 Chrome 系統節點或受企業原則保護，僅供檢視。
            </div>
          )}

          <form
            style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
            onSubmit={(e) => {
              e.preventDefault();
              const parsedTags = editTags
                .split(/[,，\s]+/)
                .map((t) => t.trim().replace(/^#/, ''))
                .filter(Boolean);
              void onSaveNode({
                nodeId: activeNode.nodeId,
                title: editTitle,
                url: activeNode.isFolder ? undefined : editUrl,
                tags: parsedTags,
                newParentId:
                  editParentId !== activeNode.parentId ? editParentId : undefined,
              });
            }}
          >
            <div className="form-field">
              <label htmlFor="edit-title">標題</label>
              <input
                id="edit-title"
                type="text"
                value={editTitle}
                disabled={!activeNode.writable}
                onChange={(e) => setEditTitle(e.target.value)}
              />
            </div>

            {!activeNode.isFolder && (
              <div className="form-field">
                <label htmlFor="edit-url">網址</label>
                <input
                  id="edit-url"
                  type="url"
                  value={editUrl}
                  disabled={!activeNode.writable}
                  onChange={(e) => setEditUrl(e.target.value)}
                />
              </div>
            )}

            <div className="form-field">
              <label htmlFor="edit-folder">所在資料夾</label>
              <select
                id="edit-folder"
                value={editParentId}
                disabled={!activeNode.writable}
                onChange={(e) => setEditParentId(e.target.value)}
              >
                {writableFolders.map((f) => (
                  <option key={f.nodeId} value={f.nodeId}>
                    {f.path || f.title}
                  </option>
                ))}
              </select>
            </div>

            {!activeNode.isFolder && (
              <div className="form-field">
                <label htmlFor="edit-tags">本機標籤（以逗號或空白分隔）</label>
                <input
                  id="edit-tags"
                  type="text"
                  value={editTags}
                  onChange={(e) => setEditTags(e.target.value)}
                  placeholder="設計, 參考, 待閱讀"
                />
              </div>
            )}

            <div className="wf-muted" style={{ fontSize: 12 }}>
              <div>節點 ID：{activeNode.nodeId}</div>
              <div>路徑：{activeNode.path}</div>
              {activeMetadata?.originalDateAdded && (
                <div>
                  原始備份時間：
                  {new Date(activeMetadata.originalDateAdded).toLocaleString('zh-TW')}
                </div>
              )}
            </div>

            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button
                type="submit"
                className="primary"
                disabled={busy || (!activeNode.writable && activeNode.isFolder)}
              >
                儲存變更
              </button>
              {activeNode.writable && (
                <button
                  type="button"
                  className="danger"
                  disabled={busy}
                  onClick={() => void onDeleteNode(activeNode)}
                >
                  移除（保留快照）
                </button>
              )}
            </div>
          </form>
        </section>
      ) : (
        <section className="section-box">
          <div className="section-header">
            <h3 className="section-title">書籤明細</h3>
            <button
              type="button"
              className="sm"
              onClick={() => onSetMode('organize')}
            >
              關閉提示
            </button>
          </div>
          <p className="wf-muted" style={{ margin: 0 }}>
            請於中央列表點選任一書籤以編輯標題、網址與標籤。
          </p>
        </section>
      )
    ) : null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      {inspectCard}
      <section className="section-box" aria-label="整理範圍與指令">
        <div className="section-header">
          <div className="section-title-group">
            <span className="icon-circle secondary">
              <IconSparkles size={17} />
            </span>
            <h3 className="section-title">整理面板</h3>
          </div>
          {mode !== 'inspect' && (
            <button
              type="button"
              className="sm"
              onClick={() => onSetMode('inspect')}
            >
              檢視明細
            </button>
          )}
        </div>

          <div className="tonal-well" style={{ fontSize: 13 }}>
            <div>
              範圍：<strong style={{ color: 'var(--md-primary)' }}>{scopeSummaryText}</strong>
            </div>
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <input
                type="checkbox"
                checked={expandScopeAll}
                onChange={(e) => setExpandScopeAll(e.target.checked)}
              />
              擴大範圍至全部可寫書籤
            </label>
          </div>

          <div className="form-field">
            <label htmlFor="org-base-folder">新建分類資料夾位置</label>
            <select
              id="org-base-folder"
              value={baseParentId}
              onChange={(e) => setBaseParentId(e.target.value)}
            >
              {writableFolders.map((f) => (
                <option key={f.nodeId} value={f.nodeId}>
                  {f.path || f.title}
                </option>
              ))}
            </select>
          </div>

          <div className="form-field">
            <label htmlFor="org-mode">AI 與整理引擎（隱私零成本優先）</label>
            <select
              id="org-mode"
              value={orgMode}
              onChange={(e) => setOrgMode(e.target.value as AiProviderPreference)}
            >
              <option value="auto">
                自動優先：Chrome 內建 AI (Gemini Nano) → 本機離線規則
              </option>
              <option value="chrome-prompt-api">
                Chrome Prompt API (Gemini Nano · 不支援時自動降級)
              </option>
              <option value="rule">純本機離線規則（不呼叫模型）</option>
            </select>
            {promptApiStatus && (
              <div
                className={`ai-status-box ${promptApiStatus.supported ? '' : 'degraded'}`}
              >
                <span
                  className={`wf-badge ${promptApiStatus.supported ? 'ok-solid' : 'warn'}`}
                >
                  {promptApiStatus.availability}
                </span>
                <span>{promptApiStatus.reason}</span>
              </div>
            )}
            {aiDownloadFraction !== null && (
              <div className="wf-banner" style={{ flexDirection: 'column', gap: 6 }}>
                <div>
                  正在由 Chrome 本機下載 Gemini Nano 模型：
                  {Math.round(aiDownloadFraction * 100)}%
                </div>
                <progress
                  max={1}
                  value={aiDownloadFraction}
                  aria-label="Chrome 內建 Gemini Nano 模型下載進度"
                  style={{ width: '100%' }}
                />
              </div>
            )}
            {/* Persistent polite live region for AI status & download completion (WCAG 4.1.3) */}
            <div
              aria-live="polite"
              aria-busy={isGeneratingAi}
              className="wf-muted"
              style={{ fontSize: 12, minHeight: aiLiveStatus ? undefined : 0 }}
            >
              {aiLiveStatus}
            </div>
          </div>

          <div className="form-field">
            <label htmlFor="org-instruction">整理指令</label>
            <textarea
              id="org-instruction"
              rows={3}
              value={instruction}
              onChange={(e) => setInstruction(e.target.value)}
              placeholder="例如：依主題自動歸納目前資料夾，或指定「依 設計、開發、閱讀 分類」"
            />
            <div className="prompt-chips" aria-label="常用指令範本">
              <button
                type="button"
                className="prompt-chip"
                onClick={() =>
                  setInstruction('依主題自動歸納目前範圍書籤並加上標籤')
                }
              >
                依主題自動歸納
              </button>
              <button
                type="button"
                className="prompt-chip"
                onClick={() =>
                  setInstruction('依網站網域把同站台書籤分群整理')
                }
              >
                依網站與服務分群
              </button>
              <button
                type="button"
                className="prompt-chip"
                onClick={() =>
                  setInstruction('不動資料夾，自動幫書籤補上主題標籤')
                }
              >
                自動補上主題標籤
              </button>
            </div>
          </div>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              ref={generateBtnRef}
              type="button"
              className="primary"
              style={{ flex: 1, minHeight: 42, fontWeight: 600 }}
              disabled={busy}
              onClick={() =>
                void onGeneratePlan({
                  scope: computeCurrentScope(),
                  instruction,
                  mode: orgMode,
                  baseParentId,
                })
              }
            >
              <IconBolt size={16} />
              {busy ? '正在產生預覽…' : '產生整理預覽方案'}
            </button>
            {isGeneratingAi && (
              <button
                ref={stopBtnRef}
                type="button"
                className="danger"
                onClick={() => {
                  onAbortAiGeneration();
                  // Restore focus to the trigger control when Stop button hides (WCAG 2.4.3)
                  requestAnimationFrame(() => generateBtnRef.current?.focus());
                }}
              >
                停止產生
              </button>
            )}
          </div>
        </section>

        <section className="section-box" aria-label="失效連結檢查與清理">
          <div className="section-title-group">
            <span className="icon-circle neutral">
              <IconLinkOff size={16} />
            </span>
            <h3 className="section-title">失效連結檢查與清理（選用）</h3>
          </div>
          <div className="wf-muted" style={{ fontSize: 12 }}>
            逐站向 Chrome 申請公開網域的選用權限，自動排除本機/內網/疑似敏感網址，並僅在預覽確認後執行（保留快照可復原）。
          </div>

          <div className="form-field">
            <label htmlFor="dead-link-action">失效書籤處理方式</label>
            <select
              id="dead-link-action"
              value={deadLinkAction}
              onChange={(e) =>
                setDeadLinkAction(e.target.value as DeadLinkCleanupAction)
              }
            >
              <option value="quarantine">
                選項 A：移至「失效連結待清理」資料夾（較安全，可一鍵復原）
              </option>
              <option value="remove">
                選項 B：勾選確認後直接移除（保留快照，可於歷程頁重建）
              </option>
            </select>
          </div>

          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={includeUnreachable}
              onChange={(e) => setIncludeUnreachable(e.target.checked)}
            />
            一併納入「無法連線 / DNS 失敗」項目（預設僅納 404/410）
          </label>

          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button
              type="button"
              disabled={busy}
              onClick={() => onCheckLinksInScope(computeCurrentScope())}
            >
              1. 檢查此範圍失效連結
            </button>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={() =>
                void onGenerateDeadLinkPlan({
                  scope: computeCurrentScope(),
                  action: deadLinkAction,
                  baseParentId,
                  includeUnreachable,
                })
              }
            >
              2. 產生失效清理預覽
            </button>
          </div>
        </section>

        {lastAppliedJob && (
          <section className="wf-banner ok" role="status">
            <div>
              <strong>
                {lastAppliedJob.status === 'completed'
                  ? `已完成套用 (${lastAppliedJob.completedCount}/${lastAppliedJob.totalCount})`
                  : lastAppliedJob.status === 'restored'
                    ? '已完成批次復原'
                    : `工作狀態：${lastAppliedJob.status}`}
              </strong>
              {lastAppliedJob.conflicts.length > 0 && (
                <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
                  {lastAppliedJob.conflicts.map((c, i) => (
                    <li key={i}>{c.message}</li>
                  ))}
                </ul>
              )}
            </div>
            {lastAppliedJob.status === 'completed' && (
              <button
                type="button"
                className="sm"
                disabled={busy}
                onClick={() => void onRestoreJob(lastAppliedJob.jobId)}
              >
                復原此批次
              </button>
            )}
          </section>
        )}

        {activePlan && (
          <section className="section-box" aria-label="方案差異預覽">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 6 }}>
              <strong>
                差異預覽 (v{activePlan.revision} · 已勾選 {enabledCount}/{activePlan.operations.length})
              </strong>
              <span className="wf-badge">
                {PLAN_SOURCE_LABEL[activePlan.source]}
                {activePlan.fallbackFrom ? ' (已降級)' : ''}
              </span>
            </div>

            {isPlanStale && (
              <div className="wf-banner danger" role="alert">
                <div>
                  <strong>書籤狀態已變更</strong>
                  <div>預覽建立後偵測到外部修改，請重新產生預覽再套用。</div>
                </div>
                <button
                  type="button"
                  className="sm"
                  disabled={busy}
                  onClick={() =>
                    void onGeneratePlan({
                      scope: activePlan.scope,
                      instruction: activePlan.instruction,
                      mode: orgMode,
                      baseParentId,
                    })
                  }
                >
                  重新預覽
                </button>
              </div>
            )}

            {activePlan.warnings.length > 0 && (
              <div className="wf-banner warn">
                <ul style={{ margin: 0, paddingLeft: 16 }}>
                  {activePlan.warnings.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ul>
              </div>
            )}

            {activePlan.operations.length === 0 ? (
              <p className="wf-muted">
                目前條件未產生任何變更建議。請調整範圍或輸入更明確的分類關鍵字。
              </p>
            ) : (
              <>
                {createOps.length > 0 && (
                  <div className="op-group">
                    <div className="tree-section-title">建立資料夾 ({createOps.length})</div>
                    {createOps.map((op) => {
                      if (op.type !== 'createFolder') return null;
                      const deps = getDependentOperations(activePlan, op.opId);
                      return (
                        <div key={op.opId} className="op-card">
                          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div>
                              <strong>新建資料夾：{op.title}</strong>
                              <div className="op-path">位置：{op.parentPath}</div>
                              <div className="wf-muted">理由：{op.reason}</div>
                              {!op.enabled && deps.length > 0 && (
                                <div className="wf-badge warn" style={{ marginTop: 4 }}>
                                  已跳過，連帶停用 {deps.length} 筆依賴移動
                                </div>
                              )}
                            </div>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}

                {moveOps.length > 0 && (
                  <div className="op-group">
                    <div className="tree-section-title">移動書籤 ({moveOps.length})</div>
                    {moveOps.map((op) => {
                      if (op.type !== 'moveBookmark') return null;
                      const depSkipped =
                        Boolean(op.dependsOnOpId) &&
                        !activePlan.operations.find((x) => x.opId === op.dependsOnOpId)
                          ?.enabled;
                      return (
                        <div
                          key={op.opId}
                          className={`op-card ${depSkipped ? 'disabled-dep' : ''}`}
                        >
                          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <strong>{op.bookmarkTitle}</strong>
                              <div className="op-path">
                                {op.fromPath} → {op.toPath}
                              </div>
                              <div className="wf-muted">理由：{op.reason}</div>
                              {depSkipped && (
                                <span className="wf-badge warn">依賴的新資料夾已跳過</span>
                              )}
                            </div>
                          </label>
                          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                            <span className="wf-muted" style={{ fontSize: 12 }}>
                              改目的地：
                            </span>
                            <select
                              aria-label={`修改 ${op.bookmarkTitle} 的目的地`}
                              value={op.toParentId ?? ''}
                              onChange={(e) => {
                                const dest = writableFolders.find(
                                  (f) => f.nodeId === e.target.value,
                                );
                                if (!dest) return;
                                const updated = overrideMoveDestination(
                                  activePlan,
                                  op.opId,
                                  dest.nodeId,
                                  dest.path || dest.title,
                                );
                                void onUpdatePlan(updated);
                              }}
                            >
                              <option value="">
                                {op.toTempFolderId ? `(新資料夾) ${op.toPath}` : '選擇資料夾'}
                              </option>
                              {writableFolders.map((f) => (
                                <option key={f.nodeId} value={f.nodeId}>
                                  {f.path || f.title}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}

                {reviewOps.length > 0 && (
                  <div className="op-group">
                    <div className="tree-section-title">
                      待人工確認 ({reviewOps.length})
                    </div>
                    {reviewOps.map((op) => {
                      if (op.type !== 'moveBookmark') return null;
                      return (
                        <div key={op.opId} className="op-card review">
                          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <strong>{op.bookmarkTitle}</strong>
                              <div className="op-path">
                                建議：{op.fromPath} → {op.toPath}
                              </div>
                              <div>原因：{op.reviewReason || op.reason}</div>
                            </div>
                          </label>
                          <select
                            aria-label={`為 ${op.bookmarkTitle} 選擇目的地`}
                            value={op.toParentId ?? ''}
                            onChange={(e) => {
                              const dest = writableFolders.find(
                                (f) => f.nodeId === e.target.value,
                              );
                              if (!dest) return;
                              const updated = overrideMoveDestination(
                                activePlan,
                                op.opId,
                                dest.nodeId,
                                dest.path || dest.title,
                              );
                              void onUpdatePlan(updated);
                            }}
                          >
                            <option value="">保留建議或改選資料夾…</option>
                            {writableFolders.map((f) => (
                              <option key={f.nodeId} value={f.nodeId}>
                                {f.path || f.title}
                              </option>
                            ))}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                )}

                {removeOps.length > 0 && (
                  <div className="op-group">
                    <div
                      style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: 8,
                      }}
                    >
                      <div className="tree-section-title">
                        移除失效書籤（需人工勾選 · {removeOps.length}）
                      </div>
                      {removeOps.some(
                        (o) =>
                          o.type === 'removeBookmark' &&
                          o.linkStatus === 'dead_404_410' &&
                          !o.enabled,
                      ) && (
                        <button
                          type="button"
                          className="sm"
                          onClick={() => {
                            const updated = enableDead404Removals(activePlan);
                            void onUpdatePlan(updated);
                          }}
                        >
                          全選 404/410
                        </button>
                      )}
                    </div>
                    {removeOps.map((op) => {
                      if (op.type !== 'removeBookmark') return null;
                      return (
                        <div key={op.opId} className="op-card danger-card">
                          <label
                            style={{
                              display: 'flex',
                              gap: 8,
                              alignItems: 'flex-start',
                            }}
                          >
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div style={{ flex: 1 }}>
                              <div
                                style={{
                                  display: 'flex',
                                  gap: 6,
                                  alignItems: 'center',
                                  flexWrap: 'wrap',
                                }}
                              >
                                <strong>{op.bookmarkTitle}</strong>
                                <span
                                  className={`wf-badge ${
                                    op.linkStatus === 'dead_404_410'
                                      ? 'danger'
                                      : 'warn'
                                  }`}
                                >
                                  {op.linkStatus === 'dead_404_410'
                                    ? `HTTP ${op.httpStatus ?? 404}`
                                    : '無法連線'}
                                </span>
                              </div>
                              <div className="op-path">
                                位置：{op.path}
                              </div>
                              {op.bookmarkUrl && (
                                <div
                                  className="wf-mono wf-muted"
                                  style={{ wordBreak: 'break-all' }}
                                >
                                  {op.bookmarkUrl}
                                </div>
                              )}
                              <div>原因：{op.reason}</div>
                            </div>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}

                {renameOps.length > 0 && (
                  <div className="op-group">
                    <div className="tree-section-title">重新命名 ({renameOps.length})</div>
                    {renameOps.map((op) => {
                      if (op.type !== 'renameBookmark') return null;
                      return (
                        <div key={op.opId} className="op-card">
                          <label style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div>
                              <div>
                                {op.oldTitle} → <strong>{op.newTitle}</strong>
                              </div>
                              {op.reviewReason && (
                                <span className="wf-badge warn">{op.reviewReason}</span>
                              )}
                              <div className="wf-muted">理由：{op.reason}</div>
                            </div>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}

                {tagOps.length > 0 && (
                  <div className="op-group">
                    <div className="tree-section-title">新增標籤 ({tagOps.length})</div>
                    {tagOps.map((op) => {
                      if (op.type !== 'addTag') return null;
                      return (
                        <div key={op.opId} className="op-card">
                          <label style={{ display: 'flex', gap: 8 }}>
                            <input
                              type="checkbox"
                              checked={op.enabled}
                              onChange={(e) => {
                                const res = togglePlanOperation(
                                  activePlan,
                                  op.opId,
                                  e.target.checked,
                                );
                                void onUpdatePlan(res.plan);
                              }}
                            />
                            <div>
                              <strong>{op.bookmarkTitle}</strong>
                              <div>
                                新增標籤：
                                {op.tagsToAdd.map((t) => (
                                  <span key={t} className="wf-badge" style={{ marginRight: 4 }}>
                                    #{t}
                                  </span>
                                ))}
                              </div>
                              <div className="wf-muted">理由：{op.reason}</div>
                            </div>
                          </label>
                        </div>
                      );
                    })}
                  </div>
                )}

                <div style={{ display: 'flex', gap: 8, paddingTop: 6 }}>
                  <button
                    type="button"
                    className="primary"
                    disabled={busy || enabledCount === 0 || isPlanStale}
                    onClick={() => void onApplyPlan(activePlan)}
                  >
                    確認套用 ({enabledCount} 筆 · v{activePlan.revision})
                  </button>
                  <button type="button" disabled={busy} onClick={onCancelPlan}>
                    取消方案
                  </button>
                </div>
              </>
            )}
          </section>
        )}
    </div>
  );
}
