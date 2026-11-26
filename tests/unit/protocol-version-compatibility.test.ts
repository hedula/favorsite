import { afterEach, describe, expect, it, vi } from 'vitest';
import { sendStudioMessage, UNKNOWN_STUDIO_MESSAGE } from '@/core/protocol';
import { getBuildIdentity } from '@/core/runtime-status';

afterEach(() => vi.unstubAllGlobals());

describe('background message compatibility', () => {
  it.each([
    { type: 'GET_BOOTSTRAP_STATE' as const },
    { type: 'GET_RUNTIME_STATUS' as const },
    { type: 'SEARCH_KNOWLEDGE' as const, payload: { query: 'R2' } },
    { type: 'CREATE_BOOKMARK' as const, payload: { parentId: '1', title: 'Example' } },
  ])('explains how to update an older worker for $type without retrying the command', async (message) => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: UNKNOWN_STUDIO_MESSAGE });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });

    await expect(sendStudioMessage(message)).rejects.toThrow('重新載入 Favorsite');
    expect(sendMessage).toHaveBeenCalledExactlyOnceWith(message);
  });

  it('recognizes surrounding whitespace in an old worker error', async () => {
    vi.stubGlobal('chrome', { runtime: {
      sendMessage: vi.fn().mockResolvedValue({ ok: false, error: '\n' + UNKNOWN_STUDIO_MESSAGE + '\n' }),
    } });
    await expect(sendStudioMessage({ type: 'GET_RUNTIME_STATUS' })).rejects.toThrow('重新載入 Favorsite');
  });

  it('preserves a real request failure and sends the command once', async () => {
    const sendMessage = vi.fn().mockResolvedValue({ ok: false, error: '書籤已被移除。' });
    vi.stubGlobal('chrome', { runtime: { sendMessage } });
    await expect(sendStudioMessage({ type: 'REMOVE_BOOKMARK', payload: { nodeId: '22' } }))
      .rejects.toThrow('書籤已被移除。');
    expect(sendMessage).toHaveBeenCalledOnce();
  });

  it('returns a current worker response as sent', async () => {
    const status = { ...getBuildIdentity(), semanticModel: { state: 'ready' } };
    vi.stubGlobal('chrome', { runtime: {
      sendMessage: vi.fn().mockResolvedValue({ ok: true, data: status }),
    } });
    await expect(sendStudioMessage({ type: 'GET_RUNTIME_STATUS' })).resolves.toEqual(status);
  });
});
