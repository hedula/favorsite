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

interface Pending {
  resolve: (batch: EmbeddingBatch) => void;
  reject: (reason: unknown) => void;
}

/**
 * One worker (and one loaded model) shared by successive classifications. Identical
 * texts are encoded once. Aborting terminates the worker, since ONNX inference
 * cannot be interrupted, and the next request starts a fresh one.
 */
export function createEmbeddingClient(options: {
  createWorker: () => EmbeddingWorker;
  getAssetBase: () => string;
  idleMs?: number;
}) {
  const idleMs = options.idleMs ?? SEMANTIC_WORKER_IDLE_MS;
  let worker: EmbeddingWorker | null = null;
  let nextId = 1;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  const pending = new Map<number, Pending>();

  const shutdown = (reason?: unknown) => {
    clearTimeout(idleTimer);
    idleTimer = undefined;
    const current = worker;
    worker = null;
    current?.terminate();
    for (const request of pending.values()) request.reject(reason ?? new Error('本機語意模型已停止。'));
    pending.clear();
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
      pending.delete(data.id);
      if (data.ok) request.resolve(data.batch);
      else request.reject(new Error(data.error));
      scheduleIdle();
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
    const id = nextId++;
    clearTimeout(idleTimer);
    const batch = await new Promise<EmbeddingBatch>((resolve, reject) => {
      const abort = () => shutdown(signal.reason);
      const settle = <T,>(fn: (value: T) => void) => (value: T) => {
        signal.removeEventListener('abort', abort);
        fn(value);
      };
      pending.set(id, { resolve: settle(resolve), reject: settle(reject) });
      signal.addEventListener('abort', abort, { once: true });
      ensureWorker().postMessage({
        id,
        assetBase: options.getAssetBase(),
        texts: unique,
      } satisfies EmbeddingRequest);
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
