import { afterEach, describe, expect, it, vi } from 'vitest';
import type { EmbeddingRequest, EmbeddingWorker } from '@/core/semantic-client';

vi.mock('@/core/semantic.worker?worker', () => ({ default: class {} }));
const { createEmbeddingClient } = await import('@/core/semantic-client');

class FakeWorker extends EventTarget implements EmbeddingWorker {
  requests: EmbeddingRequest[] = [];
  terminated = false;
  postMessage(request: EmbeddingRequest) {
    this.requests.push(request);
  }
  terminate() {
    this.terminated = true;
  }
  reply(index = this.requests.length - 1) {
    const { id, texts } = this.requests[index];
    const data = { id, ok: true, batch: { backend: 'wasm', vectors: texts.map((t) => [t.length]) } };
    this.dispatchEvent(new MessageEvent('message', { data }));
  }
}

function setup(idleMs = 1_000) {
  const workers: FakeWorker[] = [];
  const client = createEmbeddingClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    getAssetBase: () => 'chrome-extension://test/',
    idleMs,
  });
  return { client, workers };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => vi.useRealTimers());

describe('semantic embedding client', () => {
  it('reuses one worker across requests and encodes duplicate texts once', async () => {
    const { client, workers } = setup();
    const first = client.embed(['query: a', 'query: bb', 'query: a'], new AbortController().signal);
    expect(workers).toHaveLength(1);
    expect(workers[0].requests[0].texts).toEqual(['query: a', 'query: bb']);
    workers[0].reply();
    expect((await first).vectors).toEqual([[8], [9], [8]]);

    const second = client.embed(['query: ccc'], new AbortController().signal);
    workers[0].reply();
    await second;
    expect(workers).toHaveLength(1);
    expect(workers[0].terminated).toBe(false);
    client.dispose();
  });

  it('frees the model after the idle timeout and starts a new worker next time', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup(1_000);
    const request = client.embed(['query: a'], new AbortController().signal);
    workers[0].reply();
    await request;
    vi.advanceTimersByTime(999);
    expect(workers[0].terminated).toBe(false);
    vi.advanceTimersByTime(1);
    expect(workers[0].terminated).toBe(true);

    const next = client.embed(['query: b'], new AbortController().signal);
    expect(workers).toHaveLength(2);
    workers[1].reply();
    await next;
    client.dispose();
  });

  it('does not idle out while a request is still running', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup(1_000);
    const request = client.embed(['query: a'], new AbortController().signal);
    vi.advanceTimersByTime(5_000);
    expect(workers[0].terminated).toBe(false);
    workers[0].reply();
    await request;
    client.dispose();
  });

  it('terminates the worker on abort and rejects with the abort reason', async () => {
    const { client, workers } = setup();
    const ctrl = new AbortController();
    const request = client.embed(['query: a'], ctrl.signal);
    ctrl.abort(new Error('stopped by user'));
    await expect(request).rejects.toThrow('stopped by user');
    expect(workers[0].terminated).toBe(true);

    const next = client.embed(['query: b'], new AbortController().signal);
    expect(workers).toHaveLength(2);
    workers[1].reply();
    await expect(next).resolves.toMatchObject({ backend: 'wasm' });
    client.dispose();
  });

  it('surfaces worker errors and recovers with a fresh worker', async () => {
    const { client, workers } = setup();
    const request = client.embed(['query: a'], new AbortController().signal);
    workers[0].dispatchEvent(Object.assign(new Event('error'), { message: 'boom' }));
    await expect(request).rejects.toThrow('boom');
    expect(workers[0].terminated).toBe(true);

    const failed = client.embed(['query: b'], new AbortController().signal);
    const { id } = workers[1].requests[0];
    workers[1].dispatchEvent(new MessageEvent('message', { data: { id, ok: false, error: 'no model' } }));
    await expect(failed).rejects.toThrow('no model');
    await tick();
    expect(workers[1].terminated).toBe(false);
    client.dispose();
  });
});
