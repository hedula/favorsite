import React, { useEffect, useId, useState } from 'react';
import type { McpConnectionSummary, McpSettings as McpSettingsState } from '@/core/knowledge-protocol';
import { sendStudioMessage } from '@/core/protocol';
import type { BookmarkProjection } from '@/core/types';
import { IconShield } from './Icons';

interface ScopeFieldsProps {
  folders: BookmarkProjection[];
  folderIds: string[];
  includeContent: boolean;
  disabled: boolean;
  onFolderIdsChange: (ids: string[]) => void;
  onIncludeContentChange: (enabled: boolean) => void;
}

function ScopeFields({ folders, folderIds, includeContent, disabled, onFolderIdsChange, onIncludeContentChange }: ScopeFieldsProps) {
  const prefix = useId();
  return <>
    <fieldset className="knowledge-scope" disabled={disabled}>
      <legend>可查詢資料夾（包含子資料夾）</legend>
      {folders.map((folder) => <label key={folder.nodeId} htmlFor={`${prefix}-${folder.nodeId}`} className="knowledge-check">
        <input
          id={`${prefix}-${folder.nodeId}`}
          type="checkbox"
          checked={folderIds.includes(folder.nodeId)}
          onChange={(event) => onFolderIdsChange(event.target.checked
            ? [...folderIds, folder.nodeId]
            : folderIds.filter((id) => id !== folder.nodeId))}
        />
        <span>{folder.nodeId === '0' ? '全部書籤' : folder.path || folder.title}</span>
      </label>)}
    </fieldset>
    <label className="knowledge-check">
      <input type="checkbox" checked={includeContent} disabled={disabled} onChange={(event) => onIncludeContentChange(event.target.checked)} />
      提供已收錄的正文片段
    </label>
  </>;
}

interface ConnectionEditorProps {
  connection: McpConnectionSummary;
  folders: BookmarkProjection[];
  onChanged: () => Promise<void>;
}

function ConnectionEditor({ connection, folders, onChanged }: ConnectionEditorProps) {
  const [folderIds, setFolderIds] = useState(connection.folderIds);
  const [includeContent, setIncludeContent] = useState(connection.includeContent);
  const [enabled, setEnabled] = useState(connection.enabled);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState('');
  const [error, setError] = useState('');

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await sendStudioMessage({ type: 'UPDATE_MCP_CONNECTION', payload: { connectionId: connection.connectionId, folderIds, includeContent, enabled } });
      await onChanged();
      setFeedback('已更新此連線的查詢範圍。');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    setBusy(true);
    setError('');
    try {
      await sendStudioMessage({ type: 'DELETE_MCP_CONNECTION', payload: { connectionId: connection.connectionId } });
      await onChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <details className="knowledge-connection">
    <summary>{connection.label} · {connection.enabled ? '已啟用' : '已停用'}</summary>
    <div className="knowledge-form">
      <label className="knowledge-check"><input type="checkbox" checked={enabled} disabled={busy} onChange={(event) => setEnabled(event.target.checked)} />啟用這個連線</label>
      <ScopeFields
        folders={folders}
        folderIds={folderIds}
        includeContent={includeContent}
        disabled={busy}
        onFolderIdsChange={setFolderIds}
        onIncludeContentChange={setIncludeContent}
      />
      <div className="knowledge-actions">
        <button type="button" className="primary sm" disabled={busy || folderIds.length === 0} onClick={() => void save()}>儲存連線設定</button>
        <button type="button" className="danger sm" disabled={busy} onClick={() => void remove()}>撤回此連線</button>
      </div>
      {feedback && <p role="status" className="wf-muted">{feedback}</p>}
      {error && <div role="alert" className="wf-banner danger">{error}</div>}
    </div>
  </details>;
}

export function McpSettings({ folders }: { folders: BookmarkProjection[] }) {
  const [settings, setSettings] = useState<McpSettingsState | null>(null);
  const [label, setLabel] = useState('Claude Desktop');
  const [folderIds, setFolderIds] = useState<string[]>([]);
  const [includeContent, setIncludeContent] = useState(false);
  const [token, setToken] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const refresh = async () => {
    try {
      const response = await sendStudioMessage({ type: 'GET_MCP_SETTINGS' });
      setSettings(response);
      setError('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => { void refresh(); }, []);

  const create = async () => {
    setBusy(true);
    setError('');
    setToken('');
    try {
      const response = await sendStudioMessage({ type: 'CREATE_MCP_CONNECTION', payload: { label: label.trim(), folderIds, includeContent } });
      setToken(response.token);
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return <section className="section-box" aria-label="桌面 AI 連線">
    <div className="section-header">
      <div className="section-title-group">
        <span className="icon-circle primary"><IconShield size={18} /></span>
        <h2 className="section-title">提供給桌面 AI</h2>
      </div>
      <button type="button" className="sm" disabled={busy} onClick={() => void refresh()}>重新檢查連線</button>
    </div>
    <p className="wf-muted">讓 ChatGPT 或 Claude Desktop 查詢選定資料夾。使用雲端模型時，工具回傳的來源資料與片段會傳給該模型服務。</p>
    {error && <div className="wf-banner danger" role="alert">{error}</div>}
    {settings && <>
      <div className={`wf-banner ${settings.host.connected ? 'ok' : 'warn'}`} role="status">
        <span>{settings.host.connected ? '本機橋接已連線。' : settings.host.error || '本機橋接尚未連線，請先安裝並啟動橋接。'}</span>
      </div>
      <details className="knowledge-connection">
        <summary>ChatGPT／Claude Desktop 安裝方式</summary>
        <div className="knowledge-form">
          <p>在 Favorsite 專案資料夾執行安裝指令，重新載入擴充功能後加入桌面 MCP 服務。使用時請保持 Chrome 開啟。</p>
          <code className="knowledge-command">node scripts/install-native-host.mjs --extension-id {settings.extensionId}</code>
          <p>桌面 MCP 啟動命令</p>
          <code className="knowledge-command">node scripts/favorsite-mcp.mjs</code>
          <p>環境變數 <code>FAVORSITE_MCP_TOKEN</code> 填入新建連線時顯示的金鑰，工作目錄設為 Favorsite 專案資料夾。</p>
          <p>環境變數 <code>FAVORSITE_PROFILE_KEY</code> 填入這個設定檔的識別值</p>
          <code className="knowledge-command">{settings.profileKey}</code>
        </div>
      </details>
      <form className="knowledge-form" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <div className="form-field">
          <label htmlFor="mcp-client-label">連線名稱</label>
          <input id="mcp-client-label" type="text" required maxLength={80} value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如 Claude Desktop 或 ChatGPT" />
        </div>
        <ScopeFields
          folders={folders}
          folderIds={folderIds}
          includeContent={includeContent}
          disabled={busy}
          onFolderIdsChange={setFolderIds}
          onIncludeContentChange={setIncludeContent}
        />
        <div><button type="submit" className="primary" disabled={busy || !label.trim() || folderIds.length === 0}>建立唯讀連線</button></div>
      </form>
      {token && <div className="knowledge-form" role="status">
        <label htmlFor="mcp-new-token">此金鑰只顯示一次，請貼入桌面 MCP 的環境變數設定</label>
        <textarea id="mcp-new-token" rows={2} readOnly value={token} className="wf-mono" spellCheck={false} />
        <div><button type="button" className="sm" onClick={() => setToken('')}>關閉金鑰</button></div>
      </div>}
      {settings.connections.length > 0 && (
        <div className="knowledge-form">
          {settings.connections.map((connection) => (
            <ConnectionEditor
              key={connection.connectionId + connection.updatedAt}
              connection={connection}
              folders={folders}
              onChanged={refresh}
            />
          ))}
        </div>
      )}
    </>}
  </section>;
}
