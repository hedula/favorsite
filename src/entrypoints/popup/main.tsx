import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { sendStudioMessage, type BootstrapState } from '@/core/protocol';
import { IconSparkles } from '../studio/components/Icons';
import '@/styles/theme.css';

function PopupApp() {
  const [state, setState] = useState<BootstrapState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const data = await sendStudioMessage({ type: 'GET_BOOTSTRAP_STATE' });
        setState(data);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    })();
  }, []);

  const openStudio = async (
    tab?: 'workspace' | 'organize' | 'history' | 'settings',
  ) => {
    await sendStudioMessage({ type: 'OPEN_STUDIO', payload: { tab } });
    window.close();
  };

  const bookmarkCount =
    state?.projections.filter((p) => !p.isFolder).length ?? 0;
  const folderCount =
    state?.projections.filter((p) => p.isFolder && p.nodeId !== '0').length ?? 0;

  const interruptedJob = state?.jobs.find(
    (j) => j.status === 'interrupted' || j.status === 'paused_conflict',
  );
  const latestAppliedJob = state?.jobs.find((j) => j.status === 'completed');

  return (
    <main className="popup-shell">
      <header className="popup-header">
        <div className="popup-brand">
          <div className="brand-mark">
            <img src="/icons/icon-128.png" alt="Favorsite" width={36} height={36} />
          </div>
          <div>
            <div className="brand-title">Favorsite</div>
            <div className="brand-subtitle">Google Chrome Bookmarks</div>
          </div>
        </div>
        <span className="wf-badge ok">100% 本機端</span>
      </header>

      {error && (
        <div className="wf-banner danger" role="alert">
          <span>{error}</span>
        </div>
      )}

      {!state && !error && <p className="wf-muted">正在讀取原生書籤狀態…</p>}

      {state && (
        <>
          <section className="popup-stats" aria-label="書籤統計">
            <div className="popup-stat">
              <div className="wf-muted">書籤總數</div>
              <div className="popup-stat-num">{bookmarkCount}</div>
            </div>
            <div className="popup-stat">
              <div className="wf-muted">資料夾數</div>
              <div className="popup-stat-num">{folderCount}</div>
            </div>
          </section>

          {interruptedJob && (
            <div className="wf-banner warn" role="status">
              <div>
                <strong>有未完成或待核對的整理工作</strong>
                <div className="wf-muted">
                  已完成 {interruptedJob.completedCount} / {interruptedJob.totalCount} 筆
                </div>
              </div>
              <button
                type="button"
                className="sm"
                onClick={() => void openStudio('history')}
              >
                檢視
              </button>
            </div>
          )}

          {!interruptedJob && latestAppliedJob && (
            <div className="wf-banner" role="status">
              <div>
                <strong>最近整理已完成</strong>
                <div className="wf-muted">
                  套用 {latestAppliedJob.completedCount} 筆 · 可復原
                </div>
              </div>
              <button
                type="button"
                className="sm"
                onClick={() => void openStudio('history')}
              >
                歷程
              </button>
            </div>
          )}

          <div className="popup-actions">
            <button
              type="button"
              className="primary"
              onClick={() => void openStudio('workspace')}
            >
              <IconSparkles size={16} />
              開啟 Bookmark Studio
            </button>
            <div className="popup-subactions">
              <button
                type="button"
                className="surface-btn"
                onClick={() => void openStudio('organize')}
              >
                整理面板
              </button>
              <button
                type="button"
                className="surface-btn"
                onClick={() => void openStudio('history')}
              >
                歷程備份
              </button>
              <button
                type="button"
                className="surface-btn"
                onClick={() => void openStudio('settings')}
              >
                設定
              </button>
            </div>
          </div>
        </>
      )}
    </main>
  );
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <PopupApp />
  </React.StrictMode>,
);
