import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function setup() {
  const getContexts = vi.fn().mockResolvedValue([{}]);
  const createDocument = vi.fn().mockResolvedValue(undefined);
  const sendMessage = vi.fn().mockResolvedValue({
    ok: true, data: { backend: 'wasm', vectors: [[1, 0]] },
  });
  vi.stubGlobal('chrome', {
    runtime: {
      ContextType: { OFFSCREEN_DOCUMENT: 'OFFSCREEN_DOCUMENT' },
      getURL: (path: string) => 'chrome-extension://test/' + path,
      getContexts, sendMessage,
    },
    offscreen: { Reason: { WORKERS: 'WORKERS' }, createDocument },
  });
  const { embedKnowledgeTexts } = await import('@/core/offscreen-client');
  return { embedKnowledgeTexts, getContexts, createDocument, sendMessage };
}

describe('offscreen query setup and cancellation', () => {
  it('cancels while getContexts is pending and prevents late setup from starting the query', async () => {
    const env = await setup();
    const contexts = Promise.withResolvers<unknown[]>();
    env.getContexts.mockReturnValue(contexts.promise);
    const controller = new AbortController();
    const pending = env.embedKnowledgeTexts(['query: storage'], controller.signal);
    const rejection = expect(pending).rejects.toThrow('cancel setup');
    controller.abort(new Error('cancel setup'));
    await rejection;
    expect(vi.getTimerCount()).toBe(0);
    contexts.resolve([{}]);
    await vi.advanceTimersByTimeAsync(0);
    expect(env.sendMessage).not.toHaveBeenCalled();
    expect(env.createDocument).not.toHaveBeenCalled();
  });

  it('starts the deadline before offscreen creation finishes and ignores late completion', async () => {
    const env = await setup();
    env.getContexts.mockResolvedValue([]);
    const creation = Promise.withResolvers<void>();
    env.createDocument.mockReturnValue(creation.promise);
    const controller = new AbortController();
    const removeListener = vi.spyOn(controller.signal, 'removeEventListener');
    const pending = env.embedKnowledgeTexts(['query: storage'], controller.signal);
    const rejection = expect(pending).rejects.toThrow('逾時');
    await vi.advanceTimersByTimeAsync(0);
    expect(env.createDocument).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(125_000);
    await rejection;
    expect(removeListener).toHaveBeenCalledWith('abort', expect.any(Function));
    expect(vi.getTimerCount()).toBe(0);
    creation.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(env.sendMessage).not.toHaveBeenCalled();
  });

  it.each(['getContexts', 'createDocument', 'sendMessage'] as const)(
    'cleans up synchronous %s exceptions and allows a later query', async (stage) => {
      const env = await setup();
      env.getContexts.mockResolvedValue([]);
      env[stage].mockImplementationOnce(() => { throw new Error(stage + ' failed'); });
      await expect(env.embedKnowledgeTexts(['query: first'])).rejects.toThrow(stage + ' failed');
      expect(vi.getTimerCount()).toBe(0);
      await expect(env.embedKnowledgeTexts(['query: second'])).resolves.toMatchObject({ vectors: [[1, 0]] });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps cancellation local to its request even when the cancellation notification throws', async () => {
    const env = await setup();
    const replies: Array<(reply: unknown) => void> = [];
    env.sendMessage.mockImplementation((message: { action: string }) => {
      if (message.action === 'cancel') throw new Error('Extension context invalidated');
      return new Promise((resolve) => replies.push(resolve));
    });
    const controller = new AbortController();
    const first = env.embedKnowledgeTexts(['query: first'], controller.signal);
    const firstRejected = expect(first).rejects.toThrow('stop first');
    const second = env.embedKnowledgeTexts(['query: second']);
    await vi.advanceTimersByTimeAsync(0);
    expect(replies).toHaveLength(2);
    const firstRequest = env.sendMessage.mock.calls[0][0];
    controller.abort(new Error('stop first'));
    await firstRejected;
    expect(env.sendMessage).toHaveBeenCalledWith({
      type: 'FAVORSITE_OFFSCREEN', action: 'cancel', requestId: firstRequest.requestId,
    });
    replies[1]({ ok: true, data: { backend: 'wasm', vectors: [[0, 1]] } });
    await expect(second).resolves.toMatchObject({ vectors: [[0, 1]] });
    replies[0]({ ok: true, data: { backend: 'wasm', vectors: [[1, 0]] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('settles a sent request deadline even if the cancel notification throws synchronously', async () => {
    const env = await setup();
    env.sendMessage.mockImplementation((message: { action: string }) => {
      if (message.action === 'cancel') throw new Error('Extension context invalidated');
      return new Promise(() => {});
    });
    const pending = env.embedKnowledgeTexts(['query: stalled']);
    const rejected = expect(pending).rejects.toThrow('逾時');
    await vi.advanceTimersByTimeAsync(125_000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});
