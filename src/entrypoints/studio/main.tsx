import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { buildSanitizedAiBatch } from '@/core/ai-schema';
import {
  collectScopeNodes,
  computeScopeFingerprint,
  getWritableFolders,
  type FlattenedTree,
} from '@/core/bookmark-engine';
import { findDuplicateGroups } from '@/core/duplicates';
import {
  collectAllowedDestinationIds,
  getDuplicateInstructionIntent,
  isDomainGroupingInstruction,
} from '@/core/planner';
import {
  collectCheckableOrigins,
  isDeadLinkCandidate,
  isLinkCheckCurrent,
  planHostPermissionRequest,
} from '@/core/link-checker';
import {
  probePromptApiAvailability,
  PromptApiSessionPool,
  PromptApiUserAbortError,
  requestChromePromptApiPlan,
  type PromptApiStatus,
} from '@/core/prompt-api';
import {
  BACKGROUND_UPDATE_REQUIRED,
  UnsupportedStudioMessageError,
  requestDuplicateDeletion,
  sendStudioMessage,
  type BootstrapState,
} from '@/core/protocol';
import { backgroundMatchesStudio } from '@/core/runtime-status';
import { BookmarkSearchIndex } from '@/core/search';
import { buildSemanticDraft, type SemanticDraft } from '@/core/semantic-classifier';
import { embedWithTransformers } from '@/core/semantic-client';
import type {
  AiProviderPreference,
  AppSettings,
  BackupPayload,
  BookmarkMetadata,
  BookmarkProjection,
  ExecutionJob,
  OrganizePlan,
  PlanScope,
} from '@/core/types';
import { BookmarkList } from './components/BookmarkList';
import { FolderTree, type SmartViewType } from './components/FolderTree';
import { HistoryBackupView } from './components/HistoryBackupView';
import { IconSearch, IconShield } from './components/Icons';
import { InspectorPanel, type RightPaneMode } from './components/InspectorPanel';
import { KnowledgeView } from './components/KnowledgeView';
import { SettingsView } from './components/SettingsView';
import '@/styles/theme.css';

type StudioTab = 'workspace' | 'knowledge' | 'history' | 'settings';
type MobilePane = 'folders' | 'list' | 'inspector';

const EXPANDED_STORAGE_KEY = 'favorsite_expanded_folders_v1';

function downloadBackup(payload: BackupPayload, kind: 'backup' | 'snapshot') {
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `favorsite-${kind}-${new Date().toISOString().slice(0, 10)}.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

function loadExpandedIds(): Set<string> {
  try {
    const raw = localStorage.getItem(EXPANDED_STORAGE_KEY);
    if (!raw) return new Set(['1', '2']);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return new Set(parsed.map(String));
  } catch {
    // ignore
  }
  return new Set(['1', '2']);
}

function StudioApp() {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [backgroundUpdateRequired, setBackgroundUpdateRequired] = useState(false);
  const [activeTab, setActiveTab] = useState<StudioTab>('workspace');
  const [smartView, setSmartView] = useState<SmartViewType>('all');
  const [selectedFolderId, setSelectedFolderId] = useState<string | null>(null);
  const [expandedIds, setExpandedIds] = useState<Set<string>>(() =>
    loadExpandedIds(),
  );
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [activeNodeId, setActiveNodeId] = useState<string | null>(null);

  const [rightMode, setRightMode] = useState<RightPaneMode>('organize');
  const [createKind, setCreateKind] = useState<'bookmark' | 'folder'>('bookmark');
  const [activePlan, setActivePlan] = useState<OrganizePlan | null>(null);
  const [lastAppliedJob, setLastAppliedJob] = useState<ExecutionJob | null>(null);

  // Responsive drawer / pane states for 768px & 390px
  const [tabletLeftOpen, setTabletLeftOpen] = useState(false);
  const [tabletRightOpen, setTabletRightOpen] = useState(false);
  const [mobilePane, setMobilePane] = useState<MobilePane>('list');

  const [busy, setBusy] = useState(false);
  const [promptApiStatus, setPromptApiStatus] = useState<PromptApiStatus | null>(
    null,
  );
  const [aiDownloadFraction, setAiDownloadFraction] = useState<number | null>(
    null,
  );
  const [aiLiveStatus, setAiLiveStatus] = useState('');
  const [isGeneratingAi, setIsGeneratingAi] = useState(false);
  const [banner, setBanner] = useState<{
    kind: 'ok' | 'warn' | 'danger';
    text: string;
    restoreJobId?: string;
  } | null>(null);

  const searchIndexRef = useRef(new BookmarkSearchIndex());
  const shellRef = useRef<HTMLDivElement>(null);
  const topbarRef = useRef<HTMLElement>(null);
  const leftToggleRef = useRef<HTMLButtonElement | null>(null);
  const rightToggleRef = useRef<HTMLButtonElement | null>(null);
  const promptPoolRef = useRef(new PromptApiSessionPool());
  const aiAbortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    const shell = shellRef.current;
    const topbar = topbarRef.current;
    if (!shell || !topbar) return;

    const syncTopbarHeight = () => {
      const height = topbar.getBoundingClientRect().height;
      shell.style.setProperty('--studio-topbar-height', `${height}px`);
    };
    syncTopbarHeight();
    const observer = new ResizeObserver(syncTopbarHeight);
    observer.observe(topbar, { box: 'border-box' });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const pool = promptPoolRef.current;
    return () => {
      aiAbortRef.current?.abort();
      pool.dispose();
    };
  }, []);

  const refreshPromptApiStatus = useCallback(async () => {
    const status = await probePromptApiAvailability();
    setPromptApiStatus(status);
  }, []);

  const refreshState = useCallback(async () => {
    try {
      const data = await sendStudioMessage({ type: 'GET_BOOTSTRAP_STATE' });
      setState(data);
      searchIndexRef.current.rebuild(data.projections, data.metadata);
      setBackgroundUpdateRequired(!backgroundMatchesStudio(data.runtime));
    } catch (err) {
      if (err instanceof UnsupportedStudioMessageError) setBackgroundUpdateRequired(true);
      setBanner({
        kind: 'danger',
        text: err instanceof Error ? err.message : String(err),
      });
    }
  }, []);

  // Parse hash navigation from Popup (#workspace, #organize, #history, #settings)
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, '');
    if (hash === 'knowledge') {
      setActiveTab('knowledge');
    } else if (hash === 'history') {
      setActiveTab('history');
    } else if (hash === 'settings') {
      setActiveTab('settings');
    } else if (hash === 'organize') {
      setActiveTab('workspace');
      setRightMode('organize');
      setTabletRightOpen(true);
      setMobilePane('inspector');
    }
  }, []);

  useEffect(() => {
    void refreshState();
    void refreshPromptApiStatus();

    // A batch apply fires one Chrome event per step; coalesce them into one refresh
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const onRuntimeMsg = (msg: { type?: string }) => {
      if (msg?.type === 'BOOKMARKS_CHANGED') {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => void refreshState(), 250);
      }
    };
    chrome.runtime.onMessage.addListener(onRuntimeMsg);
    return () => {
      clearTimeout(refreshTimer);
      chrome.runtime.onMessage.removeListener(onRuntimeMsg);
    };
  }, [refreshState, refreshPromptApiStatus]);

  const flattened = useMemo<FlattenedTree>(() => {
    const projections = state?.projections ?? [];
    const byId = new Map<string, BookmarkProjection>();
    const childrenByParent = new Map<string, BookmarkProjection[]>();
    for (const p of projections) {
      byId.set(p.nodeId, p);
      if (p.parentId) {
        const arr = childrenByParent.get(p.parentId) ?? [];
        arr.push(p);
        childrenByParent.set(p.parentId, arr);
      }
    }
    for (const arr of childrenByParent.values()) {
      arr.sort((a, b) => a.index - b.index);
    }
    return { projections, byId, childrenByParent, rawById: new Map() };
  }, [state]);

  const metadataByNodeId = useMemo(() => {
    const m = new Map<string, BookmarkMetadata>();
    for (const item of state?.metadata ?? []) {
      m.set(item.nodeId, item);
    }
    return m;
  }, [state]);

  const writableFolders = useMemo(
    () => getWritableFolders(flattened.projections),
    [flattened],
  );

  const duplicateGroups = useMemo(
    () => findDuplicateGroups(flattened.projections),
    [flattened],
  );

  const untaggedBookmarks = useMemo(
    () =>
      flattened.projections.filter(
        (p) => !p.isFolder && (metadataByNodeId.get(p.nodeId)?.tags.length ?? 0) === 0,
      ),
    [flattened, metadataByNodeId],
  );

  const deadLinkBookmarks = useMemo(
    () =>
      flattened.projections.filter(
        (p) => {
          if (p.isFolder) return false;
          const linkCheck = metadataByNodeId.get(p.nodeId)?.linkCheck;
          return (
            isLinkCheckCurrent(linkCheck, p.url) &&
            isDeadLinkCandidate(linkCheck.status, true)
          );
        },
      ),
    [flattened, metadataByNodeId],
  );

  const visibleItems = useMemo(() => {
    const q = searchQuery.trim();
    if (q) {
      return searchIndexRef.current.search({
        query: q,
        folderId: smartView === 'folder' && selectedFolderId ? selectedFolderId : undefined,
      });
    }

    if (smartView === 'folder' && selectedFolderId) {
      return flattened.childrenByParent.get(selectedFolderId) ?? [];
    }
    if (smartView === 'recent') {
      return flattened.projections
        .filter((p) => !p.isFolder)
        .sort((a, b) => (b.dateAdded ?? 0) - (a.dateAdded ?? 0));
    }
    if (smartView === 'untagged') {
      return untaggedBookmarks;
    }
    if (smartView === 'deadlinks') {
      return deadLinkBookmarks;
    }
    if (smartView === 'duplicates') {
      return [];
    }
    return flattened.projections.filter((p) => !p.isFolder);
  }, [
    searchQuery,
    smartView,
    selectedFolderId,
    flattened,
    untaggedBookmarks,
    deadLinkBookmarks,
  ]);

  const isPlanStale = useMemo(() => {
    if (!activePlan || !state) return false;
    const liveFp = computeScopeFingerprint(flattened, activePlan.scope);
    return liveFp !== activePlan.scopeFingerprint;
  }, [activePlan, state, flattened]);

  const selectedFolder = selectedFolderId
    ? flattened.byId.get(selectedFolderId) ?? null
    : null;

  const defaultParentId =
    selectedFolder?.canAddChild
      ? selectedFolder.nodeId
      : writableFolders[0]?.nodeId ?? '1';

  const activeNode = activeNodeId ? flattened.byId.get(activeNodeId) ?? null : null;

  const toggleExpand = (folderId: string) => {
    setExpandedIds((prev) => {
      const next = new Set(prev);
      if (next.has(folderId)) next.delete(folderId);
      else next.add(folderId);
      try {
        localStorage.setItem(EXPANDED_STORAGE_KEY, JSON.stringify([...next]));
      } catch {
        // ignore
      }
      return next;
    });
  };

  // 768px drawers: Escape (or the scrim) closes them and returns focus to the toggle
  const closeDrawers = useCallback(() => {
    if (tabletLeftOpen) leftToggleRef.current?.focus();
    else if (tabletRightOpen) rightToggleRef.current?.focus();
    setTabletLeftOpen(false);
    setTabletRightOpen(false);
  }, [tabletLeftOpen, tabletRightOpen]);

  useEffect(() => {
    if (!tabletLeftOpen && !tabletRightOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeDrawers();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [tabletLeftOpen, tabletRightOpen, closeDrawers]);

  const runAction = async <T,>(
    fn: () => Promise<T>,
    successMsg?: string,
  ): Promise<T | undefined> => {
    setBusy(true);
    setBanner(null);
    try {
      const result = await fn();
      if (successMsg) {
        setBanner({ kind: 'ok', text: successMsg });
      }
      await refreshState();
      return result;
    } catch (err) {
      setBanner({
        kind: 'danger',
        text: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    } finally {
      setBusy(false);
    }
  };

  const showDeletionResult = (job: ExecutionJob, label: string) => {
    const removedIds = new Set<string>();
    for (const step of job.steps) {
      if (step.status === 'applied' && step.intent.type === 'removeBookmark') {
        removedIds.add(step.intent.nodeId);
      }
    }
    if (removedIds.size > 0) {
      setSelectedIds((ids) => new Set([...ids].filter((id) => !removedIds.has(id))));
      setActiveNodeId((id) => id && removedIds.has(id) ? null : id);
    }

    const removed = removedIds.size;
    const summary = removed > 0 ? `已刪除 ${removed} 筆${label}，已備份。` : '這次沒有刪除書籤。';
    const completed = job.status === 'completed';
    setBanner({
      kind: completed && removed > 0 ? 'ok' : 'warn',
      text: completed
        ? summary
        : `${summary}${job.conflicts[0]?.message ?? '刪除已暫停，可在「歷程與備份」查看。'}`,
      restoreJobId: removed > 0 ? job.jobId : undefined,
    });
  };

  const handleDeleteNode = async (node: BookmarkProjection) => {
    if (node.isFolder && !window.confirm(`確定要移除資料夾「${node.title}」及其內部項目？移除前會備份。`)) {
      return;
    }
    const result = await runAction(() =>
      sendStudioMessage({
        type: 'REMOVE_BOOKMARK',
        payload: { nodeId: node.nodeId, recursive: node.isFolder },
      }),
    );
    if (!result) return;
    if (result.job) {
      showDeletionResult(result.job, '書籤');
    } else {
      setActiveNodeId((id) => id === node.nodeId ? null : id);
      const kind = node.isFolder ? '資料夾' : '書籤';
      setBanner({ kind: 'ok', text: `已移除${kind}「${node.title}」，已備份。` });
    }
  };

  const handleDeleteDuplicates = async (scope: PlanScope) => {
    setActivePlan(null);
    setLastAppliedJob(null);
    const job = await runAction(() =>
      requestDuplicateDeletion({ ...scope, targetFolderIds: [] }),
    );
    if (job) {
      showDeletionResult(job, '重複書籤');
    } else if (job === null) {
      setBanner({ kind: 'warn', text: '目前範圍沒有可刪除的完全重複書籤。' });
    }
  };

  const handleRestoreJob = async (jobId: string) => {
    const job = await runAction(() =>
      sendStudioMessage({ type: 'RESTORE_JOB', payload: { jobId } }),
    );
    if (!job) return;
    setLastAppliedJob(job);
    setBanner({
      kind: job.conflicts.length > 0 ? 'warn' : 'ok',
      text: job.conflicts.length > 0
        ? `復原完成，但有 ${job.conflicts.length} 筆因後續修改保留現狀。`
        : '已完整復原此批次的所有書籤與標籤變更。',
    });
  };

  const handleToggleSelect = (nodeId: string, shiftKey: boolean) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (shiftKey && lastSelectedId) {
        const ids = visibleItems.filter((i) => !i.isFolder).map((i) => i.nodeId);
        const a = ids.indexOf(lastSelectedId);
        const b = ids.indexOf(nodeId);
        if (a !== -1 && b !== -1) {
          const [start, end] = a < b ? [a, b] : [b, a];
          for (let i = start; i <= end; i++) next.add(ids[i]);
          return next;
        }
      }
      if (next.has(nodeId)) next.delete(nodeId);
      else next.add(nodeId);
      return next;
    });
    setLastSelectedId(nodeId);
  };

  const handleBatchMovePreview = async (targetFolderId: string) => {
    const dest = flattened.byId.get(targetFolderId);
    if (!dest || selectedIds.size === 0) return;
    await runAction(async () => {
      const scope: PlanScope = {
        type: 'selection',
        bookmarkIds: Array.from(selectedIds),
        targetFolderIds: [targetFolderId],
      };
      // Create a manual move plan via rule engine base or explicit draft
      const plan = await sendStudioMessage({
        type: 'CREATE_PLAN',
        payload: {
          scope,
          instruction: `批次搬移 ${selectedIds.size} 筆書籤至「${dest.path || dest.title}」`,
          mode: 'rule',
          baseParentId: targetFolderId,
        },
      });
      // Replace operations with direct move operations to targetFolderId
      const ops = Array.from(selectedIds)
        .map((id) => flattened.byId.get(id))
        .filter((n): n is BookmarkProjection => Boolean(n && !n.isFolder && n.writable && n.parentId !== targetFolderId))
        .map((n, idx) => ({
          opId: `op_batch_${idx + 1}`,
          type: 'moveBookmark' as const,
          enabled: true,
          reason: `手動批次搬移至「${dest.title}」`,
          nodeId: n.nodeId,
          bookmarkTitle: n.title,
          bookmarkUrl: n.url,
          fromParentId: n.parentId,
          fromIndex: n.index,
          fromPath: flattened.byId.get(n.parentId)?.path ?? '',
          toParentId: targetFolderId,
          toPath: dest.path || dest.title,
        }));

      const manualPlan: OrganizePlan = {
        ...plan,
        source: 'manual',
        operations: ops,
        revision: plan.revision + 1,
        updatedAt: Date.now(),
      };
      await sendStudioMessage({ type: 'SAVE_PLAN', payload: { plan: manualPlan } });
      setActivePlan(manualPlan);
      setRightMode('organize');
      setTabletRightOpen(true);
      setMobilePane('inspector');
    });
  };

  // Direct click-gesture handler so chrome.permissions.request() preserves user activation
  const handleCheckLinks = (targetBookmarks: BookmarkProjection[]) => {
    const bookmarksOnly = targetBookmarks.filter((b) => !b.isFolder);
    if (bookmarksOnly.length === 0) {
      setBanner({ kind: 'warn', text: '目前範圍沒有可檢查的書籤。' });
      return;
    }

    const { origins, skippedCount } = collectCheckableOrigins(bookmarksOnly);
    const manifestOptional =
      chrome.runtime.getManifest().optional_host_permissions ?? [];
    const hasPublicWildcard =
      manifestOptional.includes('https://*/*') ||
      manifestOptional.includes('http://*/*');

    if (origins.length > 0 && !hasPublicWildcard) {
      setBanner({
        kind: 'danger',
        text: '目前 Chrome 載入的擴充功能清單尚未包含公開網站檢查權限（optional_host_permissions）。請至 chrome://extensions/ 重新載入 Favorsite（若仍未更新請先移除再重新載入未封裝目錄）。',
      });
      return;
    }

    // For >15 distinct domains, request the declared scheme wildcard(s) so Chrome's prompt
    // stays usable; such an all-sites grant is revoked again right after this check.
    const { requestOrigins, revokeAfterCheck } = planHostPermissionRequest(origins);

    const permPromise =
      requestOrigins.length > 0
        ? chrome.permissions.request({ origins: requestOrigins })
        : Promise.resolve(false);

    void (async () => {
      setBusy(true);
      setBanner(null);
      try {
        await permPromise;
        let result;
        try {
          result = await sendStudioMessage({
            type: 'CHECK_LINKS',
            payload: { bookmarkIds: bookmarksOnly.map((b) => b.nodeId) },
          });
        } finally {
          if (revokeAfterCheck.length > 0) {
            try {
              await chrome.permissions.remove({ origins: revokeAfterCheck });
            } catch {
              // Already revoked or never granted
            }
          }
        }
        await refreshState();
        const revokedNote =
          revokeAfterCheck.length > 0 ? ' 已於檢查後自動撤銷「所有網站」權限。' : '';
        if (result.offlineSuspected) {
          setBanner({
            kind: 'warn',
            text: `所有網站皆無回應，裝置疑似離線或網路中斷；結果已記為「逾時」，不會列為失效。請恢復連線後重新檢查。${revokedNote}`,
          });
          return;
        }
        setBanner({
          kind:
            result.dead404Count > 0 || result.unreachableCount > 0
              ? 'warn'
              : 'ok',
          text: `失效連結檢查完成：已檢查 ${result.checkedCount} 筆 · 404/410 失效 ${result.dead404Count} 筆 · 無法連線 ${result.unreachableCount} 筆 · 略過內網/敏感 ${result.skippedCount || skippedCount} 筆${result.unauthorizedCount > 0 ? ` · 未授權 ${result.unauthorizedCount} 筆` : ''}。${revokedNote}`,
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const hint = msg.includes('Only permissions specified in the manifest')
          ? `（請求來源：${requestOrigins.slice(0, 3).join(', ')}；若剛更新版本，請至 chrome://extensions/ 重新載入或移除後重裝未封裝項目）`
          : '';
        setBanner({
          kind: 'danger',
          text: `${msg}${hint}`,
        });
      } finally {
        setBusy(false);
      }
    })();
  };

  const handleExportBackup = async () => {
    const payload = await runAction(
      () => sendStudioMessage({ type: 'EXPORT_BACKUP' }),
      '已產生 JSON 備份檔並開始下載。',
    );
    if (!payload) return;
    downloadBackup(payload, 'backup');
  };

  const interruptedJob = state?.jobs.find(
    (j) => j.status === 'interrupted' || j.status === 'paused_conflict',
  );
  const restoreJobId = banner?.restoreJobId;

  return (
    <div ref={shellRef} className="studio-shell">
      <header ref={topbarRef} className="studio-topbar">
        <div className="studio-topbar-inner">
          <div className="studio-brand">
            <div className="brand-mark">
              <img src="/icons/icon-128.png" alt="Favorsite" width={36} height={36} />
            </div>
            <div>
              <div className="brand-title">Favorsite Studio</div>
              <div className="brand-subtitle">Google Chrome Bookmarks</div>
            </div>
          </div>

          <nav className="studio-nav" aria-label="主要功能頁">
            <button
              type="button"
              aria-current={activeTab === 'workspace' ? 'page' : undefined}
              onClick={() => setActiveTab('workspace')}
            >
              書籤工作台
            </button>
            <button
              type="button"
              aria-current={activeTab === 'knowledge' ? 'page' : undefined}
              onClick={() => setActiveTab('knowledge')}
            >
              知識庫
            </button>
            <button
              type="button"
              aria-current={activeTab === 'history' ? 'page' : undefined}
              onClick={() => setActiveTab('history')}
            >
              歷程與備份
              {interruptedJob && <span className="wf-badge warn">!</span>}
            </button>
            <button
              type="button"
              aria-current={activeTab === 'settings' ? 'page' : undefined}
              onClick={() => setActiveTab('settings')}
            >
              設定
            </button>
          </nav>

          {activeTab !== 'knowledge' && <div className="studio-search-wrap">
            <IconSearch size={16} />
            <input
              type="search"
              aria-label="搜尋書籤標題、網域、路徑或標籤"
              placeholder="搜尋標題、domain:github.com、tag:設計…"
              value={searchQuery}
              onChange={(e) => {
                setSearchQuery(e.target.value);
                if (activeTab !== 'workspace') setActiveTab('workspace');
              }}
            />
            {searchQuery && (
              <button type="button" className="sm" onClick={() => setSearchQuery('')}>
                清除
              </button>
            )}
          </div>}
        </div>
      </header>

      <div className="studio-content-wrap">
        {backgroundUpdateRequired && (
          <div className="wf-banner warn" role="status">
            <span>{BACKGROUND_UPDATE_REQUIRED}</span>
            <button
              type="button"
              className="surface-btn sm"
              onClick={() => {
                void chrome.tabs.create({ url: 'chrome://extensions/?id=' + chrome.runtime.id })
                  .catch(() => setBanner({
                    kind: 'warn',
                    text: '請在 Chrome 網址列開啟 chrome://extensions，重新載入 Favorsite 後再重開工作台。',
                  }));
              }}
            >
              開啟擴充功能管理
            </button>
          </div>
        )}
        {state && !state.settings.firstRunNoticeDismissed && (
          <div className="wf-banner" role="note">
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, minWidth: 0 }}>
              <span className="icon-circle primary">
                <IconShield size={18} />
              </span>
              <div>
                <span style={{ fontWeight: 700, color: 'var(--md-primary)' }}>
                  權限說明：
                </span>
                Favorsite 使用 Chrome 原生書籤權限整理目前設定檔。正文由您在網頁中主動收錄，本機 AI 負責索引與整理。啟用桌面 MCP 後，指定的 AI 可讀取已授權範圍的來源。
              </div>
            </div>
            <button
              type="button"
              className="surface-btn sm"
              onClick={() =>
                void runAction(() =>
                  sendStudioMessage({
                    type: 'SAVE_SETTINGS',
                    payload: {
                      settings: { ...state.settings, firstRunNoticeDismissed: true },
                    },
                  }),
                )
              }
            >
              知道了
            </button>
          </div>
        )}

        {banner && (
          <div
            className={`wf-banner ${banner.kind}`}
            role={banner.kind === 'danger' ? 'alert' : 'status'}
          >
            <span>{banner.text}</span>
            {restoreJobId && (
              <button
                type="button"
                className="surface-btn sm"
                disabled={busy}
                onClick={() => void handleRestoreJob(restoreJobId)}
              >
                復原此批次
              </button>
            )}
            <button
              type="button"
              className="surface-btn sm"
              onClick={() => setBanner(null)}
            >
              關閉
            </button>
          </div>
        )}

      {!state ? (
        <div style={{ padding: 24 }} className="wf-muted">
          正在載入 Chrome 原生書籤樹…
        </div>
      ) : activeTab === 'knowledge' ? (
        <KnowledgeView
          folders={flattened.projections.filter((projection) => projection.isFolder)}
          initialFolderId={selectedFolderId}
        />
      ) : activeTab === 'history' ? (
        <HistoryBackupView
          jobs={state.jobs}
          snapshots={state.snapshots}
          writableFolders={writableFolders}
          busy={busy}
          onResumeJob={async (job) => {
            await runAction(async () => {
              const res = await sendStudioMessage({
                type: 'APPLY_PLAN',
                payload: {
                  planId: job.planId,
                  approvedRevision: job.approvedRevision,
                  resumeJobId: job.jobId,
                },
              });
              setLastAppliedJob(res);
            }, '已嘗試續跑剩餘項目，請檢視最新狀態。');
          }}
          onRestoreJob={handleRestoreJob}
          onResolveStep={async (params) => {
            await runAction(async () => {
              await sendStudioMessage({ type: 'RESOLVE_JOB_STEP', payload: params });
            }, '已更新待確認步驟，可繼續剩餘項目。');
          }}
          onExportBackup={handleExportBackup}
          onLoadSnapshot={async (snapshotId) => runAction(() =>
            sendStudioMessage({ type: 'EXPORT_SNAPSHOT', payload: { snapshotId } }),
          )}
          onExportSnapshot={async (snapshotId) => {
            const payload = await runAction(() =>
              sendStudioMessage({ type: 'EXPORT_SNAPSHOT', payload: { snapshotId } }),
            );
            if (payload) downloadBackup(payload, 'snapshot');
          }}
          onRestoreBackup={async (params) => {
            const res = await runAction(
              () => sendStudioMessage({ type: 'RESTORE_BACKUP', payload: params }),
            );
            if (res) {
              setBanner({
                kind: 'ok',
                text: `還原完成：建立分支「${res.branchTitle}」（${res.createdFolders} 資料夾、${res.createdBookmarks} 書籤，回連 ${res.relinkedTags} 筆標籤）。`,
              });
            }
            return Boolean(res);
          }}
          onPruneSnapshots={async (retainCount) => {
            const res = await runAction(() =>
              sendStudioMessage({
                type: 'PRUNE_SNAPSHOTS',
                payload: { retainCount },
              }),
            );
            if (res) {
              setBanner({ kind: 'ok', text: `已清理 ${res.removed} 筆舊快照。` });
            }
          }}
        />
      ) : activeTab === 'settings' ? (
        <SettingsView
          settings={state.settings}
          folders={flattened.projections.filter((projection) => projection.isFolder)}
          promptApiStatus={promptApiStatus}
          busy={busy}
          onRefreshPromptApiStatus={refreshPromptApiStatus}
          onSaveSettings={async (next: AppSettings) => {
            await runAction(() =>
              sendStudioMessage({
                type: 'SAVE_SETTINGS',
                payload: { settings: next },
              }),
            );
          }}
          onRebuildIndex={async () => {
            await runAction(() => sendStudioMessage({ type: 'REBUILD_INDEX' }));
          }}
        />
      ) : (
        <>
          {/* 768px Tablet drawer bar */}
          <div className="tablet-drawer-bar">
            <button
              ref={leftToggleRef}
              type="button"
              className="sm"
              aria-expanded={tabletLeftOpen}
              onClick={() => {
                setTabletLeftOpen((v) => !v);
                setTabletRightOpen(false);
              }}
            >
              {tabletLeftOpen ? '收合資料夾導覽' : '開啟資料夾導覽'}
            </button>
            <button
              ref={rightToggleRef}
              type="button"
              className="sm"
              aria-expanded={tabletRightOpen}
              onClick={() => {
                setTabletRightOpen((v) => !v);
                setTabletLeftOpen(false);
              }}
            >
              {tabletRightOpen ? '收合明細/整理抽屜' : '開啟明細/整理抽屜'}
            </button>
          </div>

          {/* 390px Narrow extension page pane switcher */}
          <div className="mobile-pane-tabs" role="group" aria-label="窄版畫面切換">
            <button
              type="button"
              aria-pressed={mobilePane === 'folders'}
              onClick={() => setMobilePane('folders')}
            >
              資料夾
            </button>
            <button
              type="button"
              aria-pressed={mobilePane === 'list'}
              onClick={() => setMobilePane('list')}
            >
              列表 ({visibleItems.length})
            </button>
            <button
              type="button"
              aria-pressed={mobilePane === 'inspector'}
              onClick={() => setMobilePane('inspector')}
            >
              明細/整理
            </button>
          </div>

          {(tabletLeftOpen || tabletRightOpen) && (
            <div className="drawer-scrim" aria-hidden="true" onClick={closeDrawers} />
          )}

          <div className="workspace-grid">
            <aside
              className={`pane-left ${tabletLeftOpen ? 'open' : ''} ${mobilePane === 'folders' ? 'mobile-active' : ''}`}
            >
              <FolderTree
                projections={flattened.projections}
                childrenByParent={flattened.childrenByParent}
                smartView={smartView}
                selectedFolderId={selectedFolderId}
                expandedIds={expandedIds}
                duplicateCount={duplicateGroups.length}
                untaggedCount={untaggedBookmarks.length}
                deadLinkCount={deadLinkBookmarks.length}
                onSelectSmartView={(view) => {
                  setSmartView(view);
                  setSelectedFolderId(null);
                  setSelectedIds(new Set());
                  setTabletLeftOpen(false);
                  setMobilePane('list');
                }}
                onSelectFolder={(folderId) => {
                  setSmartView('folder');
                  setSelectedFolderId(folderId);
                  setSelectedIds(new Set());
                  setTabletLeftOpen(false);
                  setMobilePane('list');
                }}
                onToggleExpand={toggleExpand}
                onDropBookmarkOnFolder={(nodeId, folderId) => {
                  void runAction(
                    () =>
                      sendStudioMessage({
                        type: 'MOVE_BOOKMARK',
                        payload: { nodeId, toParentId: folderId },
                      }),
                    '已移動至目標資料夾。',
                  );
                }}
                onDeleteEmptyFolder={(folder) => {
                  if (!window.confirm(`確定要移除空資料夾「${folder.title}」？將保留快照。`)) {
                    return;
                  }
                  void runAction(
                    () =>
                      sendStudioMessage({
                        type: 'REMOVE_BOOKMARK',
                        payload: { nodeId: folder.nodeId },
                      }),
                    `已移除空資料夾「${folder.title}」（已保存快照）。`,
                  );
                }}
              />
            </aside>

            <main
              className={`pane-center ${mobilePane === 'list' ? 'mobile-active' : ''}`}
            >
              <BookmarkList
                items={visibleItems}
                allById={flattened.byId}
                writableFolders={writableFolders}
                metadataByNodeId={metadataByNodeId}
                smartView={smartView}
                selectedFolder={selectedFolder}
                duplicateGroups={duplicateGroups}
                selectedIds={selectedIds}
                activeNodeId={activeNodeId}
                searchQuery={searchQuery}
                busy={busy}
                onToggleSelect={handleToggleSelect}
                onSelectAll={() => {
                  setSelectedIds(
                    new Set(
                      visibleItems
                        .filter((i) => !i.isFolder && i.writable)
                        .map((i) => i.nodeId),
                    ),
                  );
                }}
                onClearSelection={() => setSelectedIds(new Set())}
                onActivateNode={(nodeId) => {
                  const target = flattened.byId.get(nodeId);
                  if (target?.isFolder) {
                    setSmartView('folder');
                    setSelectedFolderId(nodeId);
                    setActiveNodeId(nodeId);
                  } else {
                    setActiveNodeId(nodeId);
                    setRightMode('inspect');
                    setTabletRightOpen(true);
                    setMobilePane('inspector');
                  }
                }}
                onMoveItem={(nodeId, toParentId, opts) => {
                  void runAction(
                    () =>
                      sendStudioMessage({
                        type: 'MOVE_BOOKMARK',
                        payload: {
                          nodeId,
                          toParentId,
                          desiredFinalIndex: opts?.desiredFinalIndex,
                          beforeSiblingId: opts?.beforeSiblingId,
                        },
                      }),
                    '已更新書籤位置。',
                  );
                }}
                onDeleteItem={(node) => void handleDeleteNode(node)}
                onExportBackup={() => void handleExportBackup()}
                onOpenCreateForm={(kind) => {
                  setCreateKind(kind);
                  setRightMode('create');
                  setTabletRightOpen(true);
                  setMobilePane('inspector');
                }}
                onStartOrganize={() => {
                  setRightMode('organize');
                  setTabletRightOpen(true);
                  setMobilePane('inspector');
                }}
                onCheckLinks={() => {
                  const targets =
                    selectedIds.size > 0
                      ? Array.from(selectedIds)
                          .map((id) => flattened.byId.get(id))
                          .filter((n): n is BookmarkProjection => Boolean(n))
                      : visibleItems;
                  handleCheckLinks(targets);
                }}
                onBatchMove={(destId) => void handleBatchMovePreview(destId)}
                onDeleteDuplicates={() =>
                  void handleDeleteDuplicates({ type: 'all', targetFolderIds: [] })
                }
              />
            </main>

            <aside
              className={`pane-right ${tabletRightOpen ? 'open' : ''} ${mobilePane === 'inspector' ? 'mobile-active' : ''}`}
            >
              <InspectorPanel
                mode={rightMode}
                createKind={createKind}
                activeNode={activeNode}
                activeMetadata={
                  activeNode ? metadataByNodeId.get(activeNode.nodeId) : undefined
                }
                writableFolders={writableFolders}
                defaultParentId={defaultParentId}
                selectedIds={selectedIds}
                selectedFolder={selectedFolder}
                settings={state.settings}
                promptApiStatus={promptApiStatus}
                aiDownloadFraction={aiDownloadFraction}
                aiLiveStatus={aiLiveStatus}
                isGeneratingAi={isGeneratingAi}
                activePlan={activePlan}
                isPlanStale={isPlanStale}
                lastAppliedJob={lastAppliedJob}
                busy={busy}
                onSetMode={setRightMode}
                onCreateNode={async (payload) => {
                  const created = await runAction(
                    () => sendStudioMessage({ type: 'CREATE_BOOKMARK', payload }),
                    '已建立並寫回 Chrome 原生書籤。',
                  );
                  return created !== undefined;
                }}
                onSaveNode={async (payload) => {
                  await runAction(async () => {
                    await sendStudioMessage({
                      type: 'UPDATE_BOOKMARK',
                      payload: {
                        nodeId: payload.nodeId,
                        title: payload.title,
                        url: payload.url,
                        tags: payload.tags,
                      },
                    });
                    if (payload.newParentId) {
                      await sendStudioMessage({
                        type: 'MOVE_BOOKMARK',
                        payload: {
                          nodeId: payload.nodeId,
                          toParentId: payload.newParentId,
                        },
                      });
                    }
                  }, '已儲存書籤與標籤變更。');
                }}
                onDeleteNode={handleDeleteNode}
                onDeleteDuplicates={handleDeleteDuplicates}
                onGeneratePlan={async (params: {
                  scope: PlanScope;
                  instruction: string;
                  mode: AiProviderPreference;
                  baseParentId: string;
                }) => {
                  let precomputedChromeAiDraft:
                    | { draftOps: import('@/core/planner').DraftOperationInput[]; warnings: string[] }
                    | undefined;
                  let precomputedChromeAiError: string | undefined;
                  let semanticDraft: SemanticDraft | undefined;
                  const usesRules =
                    isDomainGroupingInstruction(params.instruction) ||
                    getDuplicateInstructionIntent(params.instruction) !== null;

                  if (params.mode === 'transformers-js' && !usesRules) {
                    const abortCtrl = new AbortController();
                    aiAbortRef.current = abortCtrl;
                    setBusy(true);
                    setBanner(null);
                    setIsGeneratingAi(true);
                    setAiLiveStatus('正在載入本機模型並比對書籤與分類…');
                    try {
                      semanticDraft = await buildSemanticDraft({
                        ...params,
                        flattened,
                        metadataByNodeId,
                        includePath: state.settings.includePathInAi,
                        embed: (texts) => embedWithTransformers(texts, abortCtrl.signal),
                      });
                    } catch (error) {
                      if (abortCtrl.signal.aborted) {
                        setAiLiveStatus('已停止產生整理方案。');
                        setBusy(false);
                        return;
                      }
                      semanticDraft = {
                        draftOps: [],
                        warnings: [error instanceof Error ? error.message : String(error)],
                      };
                    } finally {
                      setIsGeneratingAi(false);
                      aiAbortRef.current = null;
                    }
                  } else if (!usesRules && (params.mode === 'auto' || params.mode === 'chrome-prompt-api')) {
                    // The foreground click can activate Gemini Nano's model download.
                    const { inScopeBookmarks } = collectScopeNodes(
                      flattened,
                      params.scope,
                    );
                    const batch = buildSanitizedAiBatch({
                      bookmarks: inScopeBookmarks,
                      writableFolders,
                      metadataByNodeId,
                      includePath: state.settings.includePathInAi,
                      baseParentId: params.baseParentId || params.scope.targetFolderIds[0],
                      priorityFolderIds: collectAllowedDestinationIds(
                        flattened,
                        params.scope,
                      ),
                    });
                    if (batch.bookmarks.length > 0) {
                      setBusy(true);
                      setBanner(null);
                      setIsGeneratingAi(true);
                      setAiLiveStatus('正在使用 Chrome 內建 Gemini Nano 產生整理建議…');
                      const abortCtrl = new AbortController();
                      aiAbortRef.current = abortCtrl;
                      try {
                        const res = await requestChromePromptApiPlan({
                          instruction: params.instruction,
                          batch,
                          sessionPool: promptPoolRef.current,
                          hasUserGesture: true,
                          signal: abortCtrl.signal,
                          onDownloadProgress: (fraction) =>
                            setAiDownloadFraction(fraction),
                          onDownloadComplete: () =>
                            setAiLiveStatus('Chrome 內建 Gemini Nano 模型下載完成，正在推理…'),
                        });
                        precomputedChromeAiDraft = {
                          draftOps: res.draftOps,
                          warnings: res.warnings,
                        };
                        setAiLiveStatus('已完成本機模型推理，正在驗證差異方案…');
                      } catch (err) {
                        if (err instanceof PromptApiUserAbortError) {
                          setAiLiveStatus('已停止產生整理方案。');
                          setBusy(false);
                          setIsGeneratingAi(false);
                          setAiDownloadFraction(null);
                          aiAbortRef.current = null;
                          return;
                        }
                        precomputedChromeAiError =
                          err instanceof Error ? err.message : String(err);
                        setAiLiveStatus('正在檢查本機規則能否處理這項指令…');
                      } finally {
                        setAiDownloadFraction(null);
                        setIsGeneratingAi(false);
                        aiAbortRef.current = null;
                      }
                    }
                  }

                  const plan = await runAction(
                    () =>
                      sendStudioMessage({
                        type: 'CREATE_PLAN',
                        payload: {
                          ...params,
                          precomputedChromeAiDraft,
                          precomputedChromeAiError,
                          semanticDraft,
                        },
                      }),
                  );
                  if (plan) {
                    setActivePlan(plan);
                    setLastAppliedJob(null);
                    setAiLiveStatus('');
                    const enabledCount = plan.operations.filter((op) => op.enabled).length;
                    if (enabledCount > 0) {
                      setBanner({
                        kind: 'ok',
                        text: `已產生 ${enabledCount} 項可套用的變更。檢查差異後按「確認套用」。`,
                      });
                    } else {
                      setBanner({
                        kind: 'warn',
                        text: plan.operations.length > 0
                          ? '請在差異預覽勾選要套用的變更。'
                          : '這次沒有可套用的變更。請查看差異預覽。',
                      });
                    }
                  }
                }}
                onCheckLinksInScope={(scope) => {
                  const { inScopeBookmarks } = collectScopeNodes(flattened, scope);
                  handleCheckLinks(inScopeBookmarks);
                }}
                onGenerateDeadLinkPlan={async (params) => {
                  const plan = await runAction(
                    () =>
                      sendStudioMessage({
                        type: 'CREATE_DEAD_LINK_PLAN',
                        payload: params,
                      }),
                    '已產生失效連結清理預覽（尚未修改 Chrome 書籤）。',
                  );
                  if (plan) {
                    setActivePlan(plan);
                    setLastAppliedJob(null);
                  }
                }}
                onAbortAiGeneration={() => {
                  aiAbortRef.current?.abort();
                }}
                onUpdatePlan={async (plan) => {
                  setActivePlan(plan);
                  await sendStudioMessage({ type: 'SAVE_PLAN', payload: { plan } });
                }}
                onApplyPlan={async (plan) => {
                  const job = await runAction(() =>
                    sendStudioMessage({
                      type: 'APPLY_PLAN',
                      payload: {
                        planId: plan.planId,
                        approvedRevision: plan.revision,
                      },
                    }),
                  );
                  if (job) {
                    setLastAppliedJob(job);
                    if (job.status === 'completed') {
                      setActivePlan(null);
                      setBanner({
                        kind: 'ok',
                        text: `整理完成：已套用 ${job.completedCount} 筆變更並驗證通過，可隨時復原。`,
                      });
                    } else if (job.status === 'paused_conflict') {
                      setBanner({
                        kind: 'warn',
                        text: `套用已暫停（偵測到衝突）：${job.conflicts[0]?.message ?? '請重新預覽'}`,
                      });
                    }
                  }
                }}
                onCancelPlan={() => {
                  setActivePlan(null);
                  setBanner({ kind: 'ok', text: '已取消整理方案，書籤與標籤未變動。' });
                }}
                onRestoreJob={handleRestoreJob}
              />
            </aside>
          </div>
        </>
      )}
      </div>
      <footer className="studio-footer">
        Favorsite Studio · Google Chrome Bookmarks Manager
      </footer>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <StudioApp />
  </React.StrictMode>,
);
