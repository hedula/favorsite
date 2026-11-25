import React, { useEffect, useState } from 'react';
import type { PromptApiStatus } from '@/core/prompt-api';
import type { AiProviderPreference, AppSettings } from '@/core/types';
import {
  IconHistory,
  IconShield,
  IconSparkles,
  IconSync,
} from './Icons';

interface SettingsViewProps {
  settings: AppSettings;
  promptApiStatus: PromptApiStatus | null;
  busy: boolean;
  onRefreshPromptApiStatus: () => Promise<void>;
  onSaveSettings: (settings: AppSettings) => Promise<void>;
  onRebuildIndex: () => Promise<void>;
}

export function SettingsView({
  settings,
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

      <section className="section-box">
        <div className="section-title-group">
          <span className="icon-circle primary">
            <IconSparkles size={18} />
          </span>
          <h2 className="section-title">
            AI 整理引擎：Chrome Prompt API（內建 Gemini Nano）
          </h2>
        </div>
        <p className="wf-muted" style={{ margin: 0 }}>
          隱私與零成本優先：直接呼叫桌面版 Chrome 內建的 <code>LanguageModel</code>{' '}
          API（底層為本機 Gemini Nano），無需安裝本機伺服器、免 API 費用、零外部連線且不需額外主機權限。若裝置硬體或版本不支援，將自動降級為完全離線的本機規則模式。
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
              <strong>裝置狀態：</strong>
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
            <option value="rule">一律使用本機離線規則（不呼叫 AI）</option>
          </select>
        </div>

        <label style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={includePath}
            onChange={(e) => setIncludePath(e.target.checked)}
          />
          允許將裁剪後的 URL 路徑交由 Chrome 內建模型分析（仍嚴格略過 query、fragment 與憑證）
        </label>
      </section>

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
