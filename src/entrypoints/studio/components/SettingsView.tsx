import React, { useEffect, useState } from 'react';
import type { PromptApiStatus } from '@/core/prompt-api';
import { sendStudioMessage } from '@/core/protocol';
import { getBuildIdentity, type RuntimeStatus } from '@/core/runtime-status';
import type { AiProviderPreference, AppSettings, BookmarkProjection } from '@/core/types';
import { McpSettings } from './McpSettings';
import {
  IconHistory,
  IconShield,
  IconSparkles,
  IconSync,
} from './Icons';

interface SettingsViewProps {
  settings: AppSettings;
  folders: BookmarkProjection[];
  promptApiStatus: PromptApiStatus | null;
  busy: boolean;
  onRefreshPromptApiStatus: () => Promise<void>;
  onSaveSettings: (settings: AppSettings) => Promise<void>;
  onRebuildIndex: () => Promise<void>;
}

export function SettingsView({
  settings,
  folders,
  promptApiStatus,
  busy,
  onRefreshPromptApiStatus,
  onSaveSettings,
  onRebuildIndex,
}: SettingsViewProps) {
  const [aiProvider, setAiProvider] = useState<AiProviderPreference>(
    settings.aiProvider || 'auto',
  );
  const [includePath, setIncludePath] = useState(settings.includePathInAi);
  const [retention, setRetention] = useState(settings.backupRetentionCount);

  const [grantedPublicOrigins, setGrantedPublicOrigins] = useState<string[]>([]);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [runtimeStatus, setRuntimeStatus] = useState<RuntimeStatus | null>(null);
  const studioBuild = getBuildIdentity();

  const refreshRuntimeStatus = async () => {
    try {
      const status = await sendStudioMessage({ type: 'GET_RUNTIME_STATUS' });
      setRuntimeStatus(status);
    } catch (err) {
      setErrorMsg(err instanceof Error ? err.message : String(err));
    }
  };

  const refreshPublicOrigins = async () => {
    try {
      const all = await chrome.permissions.getAll();
      setGrantedPublicOrigins(all.origins ?? []);
    } catch {
      setGrantedPublicOrigins([]);
    }
  };

  useEffect(() => {
    void refreshPublicOrigins();
    void refreshRuntimeStatus();
  }, []);

  return (
    <div className="page-container">
      {statusMsg && (
        <div className="wf-banner ok" role="status">
          <span>{statusMsg}</span>
        </div>
      )}
      {errorMsg && (
        <div className="wf-banner danger" role="alert">
          <span>{errorMsg}</span>
        </div>
      )}

      <section className="section-box" aria-label="版本與本機模型">
        <div className="section-header">
          <h2 className="section-title">版本與本機模型</h2>
          <button type="button" className="sm" onClick={() => void refreshRuntimeStatus()}>檢查版本與模型</button>
        </div>
        <div className="knowledge-build-info">
          <span>工作台版本 {studioBuild.extensionVersion}</span>
          <code>{studioBuild.buildId}</code>
        </div>
        {runtimeStatus && <>
          <div className="knowledge-build-info"><span>背景服務版本 {runtimeStatus.extensionVersion}</span><code>{runtimeStatus.buildId}</code></div>
          {runtimeStatus.buildId !== studioBuild.buildId && <div className="wf-banner warn" role="status">工作台與背景服務版本不同，請重新載入 Favorsite 並重開工作台。</div>}
          <div className={`wf-banner ${runtimeStatus.semanticModel.state === 'ready' ? 'ok' : 'warn'}`} role="status"><span>{runtimeStatus.semanticModel.reason}</span></div>
          <div className="wf-muted">語意模型 {runtimeStatus.semanticModel.modelId} · 首次查詢時載入</div>
        </>}
      </section>

      <section className="section-box">
        <div className="section-title-group">
          <span className="icon-circle primary">
            <IconSparkles size={18} />
          </span>
          <h2 className="section-title">
            AI 整理引擎
          </h2>
        </div>
        <p className="wf-muted" style={{ margin: 0 }}>
          可以使用桌面 Chrome 內建的 Gemini Nano、本機 Transformers.js 語意分類，或直接使用離線規則。
        </p>

        <div className="wf-banner" role="status" style={{ boxShadow: 'none' }}>
          <div>
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                flexWrap: 'wrap',
              }}
            >
              <strong>Gemini Nano 狀態</strong>
              <span
                className={`wf-badge ${promptApiStatus?.supported ? 'ok' : 'warn'}`}
              >
                {promptApiStatus ? promptApiStatus.availability : '偵測中…'}
              </span>
            </div>
            <div className="wf-muted" style={{ marginTop: 4 }}>
              {promptApiStatus?.reason ?? '正在檢查 Chrome 內建模型可用性…'}
            </div>
          </div>
          <button
            type="button"
            className="surface-btn"
            onClick={() => void onRefreshPromptApiStatus()}
          >
            <IconSync size={15} />
            重新偵測
          </button>
        </div>

        <div className="form-field">
          <label htmlFor="ai-provider">預設整理引擎策略</label>
          <select
            id="ai-provider"
            value={aiProvider}
            onChange={(e) =>
              setAiProvider(e.target.value as AiProviderPreference)
            }
          >
            <option value="auto">
              自動（推薦）：優先 Chrome 內建 AI（Gemini Nano）→ 不支援時降級本機離線規則
            </option>
            <option value="chrome-prompt-api">
              Chrome Prompt API（Gemini Nano · 不支援時降級本機離線規則）
            </option>
            <option value="transformers-js" disabled={runtimeStatus?.semanticModel.state !== 'ready'}>本機語意分類（Transformers.js）</option>
            <option value="rule">一律使用本機離線規則（不呼叫 AI）</option>
          </select>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={includePath}
            onChange={(e) => setIncludePath(e.target.checked)}
          />
          允許本機模型分析裁剪後的 URL 路徑。Query、fragment 與憑證會先排除。
        </label>
      </section>

      <McpSettings folders={folders} />

      <section className="section-box">
        <div className="section-title-group">
          <span className="icon-circle neutral">
            <IconHistory size={17} />
          </span>
          <h2 className="section-title">備份保留與本機索引</h2>
        </div>
        <div className="form-field">
          <label htmlFor="retention-count">本機快照保留數量上限</label>
          <input
            id="retention-count"
            type="number"
            min={5}
            max={200}
            value={retention}
            onChange={(e) => setRetention(Number(e.target.value) || 30)}
            style={{ maxWidth: 140 }}
          />
        </div>

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <button
            type="button"
            className="primary"
            disabled={busy}
            onClick={() => {
              setErrorMsg(null);
              void onSaveSettings({
                ...settings,
                aiProvider,
                includePathInAi: includePath,
                backupRetentionCount: Math.max(5, retention),
              })
                .then(() => setStatusMsg('設定已儲存。'))
                .catch((err) =>
                  setErrorMsg(err instanceof Error ? err.message : String(err)),
                );
            }}
          >
            儲存設定
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setErrorMsg(null);
              void onRebuildIndex()
                .then(() => setStatusMsg('已依最新 Chrome 書籤樹重建本機索引。'))
                .catch((err) =>
                  setErrorMsg(err instanceof Error ? err.message : String(err)),
                );
            }}
          >
            重建本機索引
          </button>
        </div>
      </section>

      <section className="section-box">
        <div className="section-title-group">
          <span className="icon-circle secondary">
            <IconShield size={17} />
          </span>
          <h2 className="section-title">權限與隱私摘要</h2>
        </div>
        <ul style={{ margin: 0, paddingLeft: 18 }}>
          <li>
            <strong>必要權限 — bookmarks</strong>：直接讀取與整理目前 Chrome
            設定檔的原生書籤樹。
          </li>
          <li>
            <strong>Chrome 內建 AI（Gemini Nano）</strong>：使用瀏覽器原生{' '}
            <code>LanguageModel</code> API，全程本機運算、無需額外權限與網路請求。
          </li>
          <li>
            <strong>
              選用主機權限 — 已授權之公開網站 ({grantedPublicOrigins.length} 個)
            </strong>
            ：僅於使用者執行「檢查失效連結」時依所選書籤網域申請，可隨時全部撤回。
          </li>
          <li>
            <strong>本機資料儲存</strong>：標籤、快照、方案與執行紀錄僅存於本機
            IndexedDB，不傳送任何外部遙測。
          </li>
        </ul>
        {grantedPublicOrigins.length > 0 && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 6,
              marginTop: 8,
            }}
          >
            <div className="wf-mono wf-muted" style={{ wordBreak: 'break-all' }}>
              {grantedPublicOrigins.join(', ')}
            </div>
            <div>
              <button
                type="button"
                className="danger sm"
                onClick={() => {
                  void (async () => {
                    await chrome.permissions.remove({
                      origins: grantedPublicOrigins,
                    });
                    await refreshPublicOrigins();
                    setStatusMsg('已撤回所有公開網站的失效連結檢查權限。');
                  })();
                }}
              >
                撤回所有失效連結檢查網站權限
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}
