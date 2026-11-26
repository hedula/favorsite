import type { EmbeddingBatch } from './semantic-classifier';
import SemanticWorker from './semantic.worker?worker';

export interface EmbeddingRequest {
  id: number;
  assetBase: string;
  texts: string[];
}

export type EmbeddingResponse =
  | { id: number; ok: true; batch: EmbeddingBatch }
  | { id: number; ok: false; error: string };

export type EmbeddingWorker = Pick<
  Worker,
  'postMessage' | 'terminate' | 'addEventListener' | 'removeEventListener'
>;

/** Keep the loaded model this long after the last request before freeing its memory. */
export const SEMANTIC_WORKER_IDLE_MS = 60_000;
export const SEMANTIC_REQUEST_TIMEOUT_MS = 120_000;

interface Pending {
  message: EmbeddingRequest;
  resolve: (batch: EmbeddingBatch) => void;
  reject: (reason: unknown) => void;
}

/**
 * One worker (and one loaded model) shared by successive classifications. Identical
 * texts are encoded once. A cancelled caller releases only its own request. Once
 * no callers are waiting, an abort can also stop the underlying ONNX inference.
 */
export function createEmbeddingClient(options: {
  createWorker: () => EmbeddingWorker;
  getAssetBase: () => string;
  idleMs?: number;
  timeoutMs?: number;
}) {
  const idleMs = options.idleMs ?? SEMANTIC_WORKER_IDLE_MS;
  const timeoutMs = options.timeoutMs ?? SEMANTIC_REQUEST_TIMEOUT_MS;
  let worker: EmbeddingWorker | null = null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Pending>();

  const releaseWorker = () => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    const current = worker;
    worker = null;
    current?.terminate();
  };

  const shutdown = (reason?: unknown) => {
    releaseWorker();
    for (const request of pending.values()) request.reject(reason ?? new Error('本機語意模型已停止。'));
    pending.clear();
    clearTimeout(idleTimer);
    idleTimer = undefined;
  };

  const scheduleIdle = () => {
    clearTimeout(idleTimer);
    idleTimer = pending.size ? undefined : setTimeout(() => shutdown(), idleMs);
  };

  const ensureWorker = (): EmbeddingWorker => {
    if (worker) return worker;
    const created = options.createWorker();
    created.addEventListener('message', (event: Event) => {
      if (worker !== created) return;
      const data = (event as MessageEvent<EmbeddingResponse>).data;
      const request = pending.get(data.id);
      if (!request) return;
      if (data.ok) request.resolve(data.batch);
      else request.reject(new Error(data.error));
    });
    created.addEventListener('error', (event: Event) => {
      if (worker !== created) return;
      const message = (event as ErrorEvent).message;
      shutdown(new Error(message || '無法啟動本機語意模型。'));
    });
    worker = created;
    return created;
  };

  async function embed(texts: string[], signal: AbortSignal): Promise<EmbeddingBatch> {
    signal.throwIfAborted();
    const unique = [...new Set(texts)];
    if (!unique.length) return { backend: 'wasm', vectors: [] };
    const id = nextId++;
    clearTimeout(idleTimer);
    const batch = await new Promise<EmbeddingBatch>((resolve, reject) => {
      let timeout: ReturnType<typeof setTimeout>;
      const abort = () => {
        pending.get(id)?.reject(signal.reason);
        if (pending.size === 0) releaseWorker();
      };
      const settle = <T,>(fn: (value: T) => void) => (value: T) => {
        pending.delete(id);
        signal.removeEventListener('abort', abort);
        clearTimeout(timeout);
        scheduleIdle();
        fn(value);
      };
      const message: EmbeddingRequest = { id, assetBase: '', texts: unique };
      pending.set(id, { message, resolve: settle(resolve), reject: settle(reject) });
      signal.addEventListener('abort', abort, { once: true });
      timeout = setTimeout(() => {
        pending.get(id)?.reject(new Error('本機語意查詢逾時，請縮小範圍後再試。'));
        releaseWorker();
        // Embedding is read-only, so other callers can safely retry on a fresh worker
        // while retaining their original request IDs and individual deadlines.
        try {
          for (const request of pending.values()) ensureWorker().postMessage(request.message);
        } catch (error) {
          shutdown(error);
        }
      }, timeoutMs);
      try {
        message.assetBase = options.getAssetBase();
        ensureWorker().postMessage(message);
      } catch (error) {
        pending.get(id)?.reject(error);
        if (pending.size === 0) releaseWorker();
      }
    });
    if (batch.vectors.length !== unique.length) return batch;
    const vectorByText = new Map(unique.map((text, index) => [text, batch.vectors[index]]));
    return { ...batch, vectors: texts.map((text) => vectorByText.get(text)!) };
  }

  return { embed, dispose: () => shutdown() };
}

let sharedClient: ReturnType<typeof createEmbeddingClient> | undefined;

export function embedWithTransformers(
  texts: string[],
  signal: AbortSignal,
): Promise<EmbeddingBatch> {
  sharedClient ??= createEmbeddingClient({
    createWorker: () => new SemanticWorker(),
    getAssetBase: () => chrome.runtime.getURL('/'),
  });
  return sharedClient.embed(texts, signal);
}
