import { env, pipeline, type FeatureExtractionPipeline } from '@huggingface/transformers';
import { SEMANTIC_MODEL_ID, type EmbeddingBatch } from './semantic-classifier';
import type { EmbeddingRequest, EmbeddingResponse } from './semantic-client';

// Single-threaded WASM only. Measured on Chrome 156 with 102 bookmark texts: WASM
// encoded them in ~4.0 s versus ~7.5 s on WebGPU, and WebGPU vectors drifted from
// the WASM ones. Batching was not faster on WASM and flipped borderline results.
// Multi-threaded WASM hangs inside a worker.
let encoderPromise: Promise<FeatureExtractionPipeline> | undefined;

async function loadEncoder(assetBase: string): Promise<FeatureExtractionPipeline> {
  const modelBase = new URL('semantic-models/', assetBase);
  const config = await fetch(new URL(`${SEMANTIC_MODEL_ID}/config.json`, modelBase)).catch(() => null);
  if (!config?.ok) {
    throw new Error('本機模型資產不完整。請重新安裝完整的 Favorsite，或先使用關鍵字搜尋及離線規則。');
  }

  env.allowRemoteModels = false;
  env.allowLocalModels = true;
  env.useBrowserCache = false;
  env.localModelPath = modelBase.href;
  const wasm = env.backends.onnx.wasm;
  if (wasm) {
    wasm.wasmPaths = new URL('semantic-runtime/', assetBase).href;
    wasm.numThreads = 1;
    wasm.proxy = false;
  }
  // A direct `pipeline(...)` return overflows TypeScript's union limit (TS2590).
  const load = pipeline as (
    task: 'feature-extraction',
    model: string,
    options: { device: 'wasm'; dtype: 'q8' },
  ) => Promise<FeatureExtractionPipeline>;
  return load('feature-extraction', SEMANTIC_MODEL_ID, { device: 'wasm', dtype: 'q8' });
}

async function embed({ assetBase, texts }: EmbeddingRequest): Promise<EmbeddingBatch> {
  encoderPromise ??= loadEncoder(assetBase);
  let encoder: FeatureExtractionPipeline;
  try {
    encoder = await encoderPromise;
  } catch (error) {
    encoderPromise = undefined;
    throw error;
  }
  const vectors: number[][] = [];
  try {
    // Quantized activations can change with other sequences in the same batch.
    for (const text of texts) {
      const result = await encoder(text, { pooling: 'mean', normalize: true });
      const [vector] = result.tolist() as number[][];
      vectors.push(vector);
    }
  } catch (error) {
    throw new Error(`本機語意模型無法完成推論。${error instanceof Error ? error.message : String(error)}`);
  }
  return { vectors, backend: 'wasm' };
}

let queue: Promise<unknown> = Promise.resolve();

self.addEventListener('message', (event: MessageEvent<EmbeddingRequest>) => {
  const request = event.data;
  queue = queue.then(() => embed(request)).then(
    (batch) => self.postMessage({ id: request.id, ok: true, batch } satisfies EmbeddingResponse),
    (error: unknown) => self.postMessage({
      id: request.id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    } satisfies EmbeddingResponse),
  );
});
