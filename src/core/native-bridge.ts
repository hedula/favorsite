import { mcpAccess } from './mcp-access';
import { defaultStore } from './store';

export const NATIVE_HOST_NAME = 'com.favorsite.knowledge';
let port: chrome.runtime.Port | undefined;
let lastError: string | undefined;
let handler: NativeToolHandler | undefined;
let connecting: Promise<void> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let retryDelay = 1000;
const active = new Map<string, AbortController>();

type NativeToolHandler = (request: {
  profileKey: string;
  token: string;
  toolName: string;
  args: unknown;
  signal: AbortSignal;
}) => Promise<unknown>;

export function nativeBridgeStatus() {
  return { connected: Boolean(port), hostName: NATIVE_HOST_NAME, error: lastError };
}

export function setNativeToolHandler(value: NativeToolHandler): void {
  handler = value;
}

function disconnect(): void {
  clearTimeout(retryTimer);
  retryTimer = undefined;
  const current = port;
  port = undefined;
  for (const controller of active.values()) controller.abort(new Error('本機橋接已中斷。'));
  active.clear();
  current?.disconnect();
}

export async function ensureNativeBridge(): Promise<void> {
  if (connecting) return connecting;
  connecting = updateConnection().finally(() => { connecting = undefined; });
  return connecting;
}

async function updateConnection(): Promise<void> {
  const profileKey = await defaultStore.getOrCreateProfileKey();
  const grants = await mcpAccess.listConnections(profileKey);
  if (!grants.some((connection) => connection.enabled)) {
    disconnect();
    lastError = undefined;
    return;
  }
  if (port || typeof chrome.runtime.connectNative !== 'function') return;
  try {
    const connected = chrome.runtime.connectNative(NATIVE_HOST_NAME);
    port = connected;
    connected.onDisconnect.addListener(() => {
      if (port !== connected) return;
      lastError = chrome.runtime.lastError?.message ?? '本機橋接已中斷，請檢查安裝後重新連線。';
      port = undefined;
      for (const controller of active.values()) controller.abort(new Error('本機橋接已中斷。'));
      active.clear();
      clearTimeout(retryTimer);
      retryTimer = setTimeout(() => {
        retryTimer = undefined;
        void ensureNativeBridge().catch(() => {});
      }, retryDelay);
      retryDelay = Math.min(retryDelay * 2, 30_000);
    });
    connected.onMessage.addListener((message: unknown) => {
      if (!message || typeof message !== 'object') return;
      const request = message as Record<string, unknown>;
      if (typeof request.requestId !== 'string') return;
      if (request.type === 'mcp_cancel') {
        active.get(request.requestId)?.abort(new Error('客戶端已取消查詢。'));
        return;
      }
      if (request.type !== 'mcp_request' || typeof request.token !== 'string' ||
        typeof request.toolName !== 'string') return;
      if (active.size >= 32 || active.has(request.requestId)) {
        connected.postMessage({
          type: 'mcp_response', requestId: request.requestId,
          error: { code: 'BUSY', message: '知識檢索正在處理其他請求，請稍後重試。' },
        });
        return;
      }
      const controller = new AbortController();
      const requestId = request.requestId;
      active.set(requestId, controller);
      const send = (response: object) => {
        if (port === connected) {
          try { connected.postMessage({ type: 'mcp_response', requestId, ...response }); }
          catch { /* A disconnected desktop request cannot receive its result. */ }
        }
      };
      void (async () => {
        if (!handler) throw new Error('SOURCE_UNAVAILABLE: 知識檢索尚未就緒。');
        const result = await handler({
          profileKey, token: request.token as string, toolName: request.toolName as string,
          args: request.args, signal: controller.signal,
        });
        controller.signal.throwIfAborted();
        send({ result });
      })().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        const code = controller.signal.aborted ? 'CANCELLED' : message.split(':')[0];
        send({ error: { code: /^[A-Z_]+$/.test(code) ? code : 'REQUEST_FAILED', message } });
      }).finally(() => active.delete(requestId));
    });
    connected.postMessage({ type: 'hello', profileKey, protocolVersion: 2 });
    lastError = undefined;
  } catch (error) {
    lastError = error instanceof Error ? error.message : String(error);
    disconnect();
  }
}
