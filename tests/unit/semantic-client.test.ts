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

function setup(idleMs = 1_000, timeoutMs = 120_000) {
  const workers: FakeWorker[] = [];
  const client = createEmbeddingClient({
    createWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    getAssetBase: () => 'chrome-extension://test/',
    idleMs,
    timeoutMs,
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

  it('does not reject a second caller when the first caller cancels', async () => {
    const { client, workers } = setup();
    const firstAbort = new AbortController();
    const first = client.embed(['first query'], firstAbort.signal);
    const second = client.embed(['second query'], new AbortController().signal)
      .then((batch) => ({ batch }), (error: unknown) => ({ error }));
    const rejection = expect(first).rejects.toThrow('cancel first');
    firstAbort.abort(new Error('cancel first'));
    await rejection;
    expect(workers[0].terminated).toBe(false);
    workers[0].reply(1);
    await expect(second).resolves.toMatchObject({ batch: { vectors: [[12]] } });
    client.dispose();
  });

  it('cleans up synchronous worker creation and postMessage failures', async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const createWorker = vi.fn()
      .mockImplementationOnce(() => { throw new Error('constructor failed'); })
      .mockReturnValue(worker);
    const client = createEmbeddingClient({
      createWorker,
      getAssetBase: () => 'chrome-extension://test/',
      idleMs: 1_000,
    });
    await expect(client.embed(['first'], new AbortController().signal)).rejects.toThrow('constructor failed');
    vi.spyOn(worker, 'postMessage').mockImplementationOnce(() => { throw new Error('post failed'); });
    await expect(client.embed(['second'], new AbortController().signal)).rejects.toThrow('post failed');
    const nextWorker = new FakeWorker();
    createWorker.mockReturnValue(nextWorker);
    const next = client.embed(['third'], new AbortController().signal);
    nextWorker.reply();
    await next;
    vi.advanceTimersByTime(1_000);
    expect(nextWorker.terminated).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    client.dispose();
  });

  it('times out a stalled caller and replays another pending request on a new worker', async () => {
    vi.useFakeTimers();
    const { client, workers } = setup(1_000, 5_000);
    const first = client.embed(['stalled'], new AbortController().signal);
    const firstRejected = expect(first).rejects.toThrow('逾時');
    vi.advanceTimersByTime(1_000);
    const second = client.embed(['second'], new AbortController().signal);
    vi.advanceTimersByTime(4_000);
    await firstRejected;
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].requests.map((request) => request.texts)).toEqual([['second']]);
    workers[0].reply(0);
    workers[1].reply();
    await expect(second).resolves.toMatchObject({ vectors: [[6]] });
    client.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
});
