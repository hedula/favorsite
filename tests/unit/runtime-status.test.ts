import { describe, expect, it, vi } from 'vitest';
import { backgroundMatchesStudio, getBuildIdentity, probeRuntimeStatus } from '@/core/runtime-status';

describe('runtime model readiness', () => {
  it('detects an older worker and compares the loaded build and protocol', () => {
    const studio = getBuildIdentity();
    expect(backgroundMatchesStudio(undefined, studio)).toBe(false);
    expect(backgroundMatchesStudio(studio, studio)).toBe(true);
    expect(backgroundMatchesStudio({ ...studio, extensionVersion: '0.1.0' }, studio)).toBe(false);
    expect(backgroundMatchesStudio({ ...studio, buildId: 'previous-build' }, studio)).toBe(false);
    expect(backgroundMatchesStudio({ ...studio, protocolVersion: 1 }, studio)).toBe(false);
  });
  it('checks every bundled asset and reports build identity separately from model loading', async () => {
    const fetchAsset = vi.fn().mockResolvedValue({ ok: true });
    const status = await probeRuntimeStatus({
      getAssetUrl: (path) => `chrome-extension://test/${path}`,
      fetchAsset,
    });
    expect(fetchAsset).toHaveBeenCalledTimes(6);
    expect(fetchAsset.mock.calls.every(([, options]) => options.method === 'HEAD')).toBe(true);
    expect(status).toMatchObject({
      ...getBuildIdentity(),
      semanticModel: { state: 'ready', modelId: 'Xenova/multilingual-e5-small' },
    });
    expect(status.semanticModel.reason).toContain('第一次');
  });

  it('makes missing assets distinguishable from errors and suggests an available local fallback', async () => {
    const missing = await probeRuntimeStatus({
      getAssetUrl: (path) => path,
      fetchAsset: vi.fn().mockResolvedValue({ ok: false }),
    });
    expect(missing.semanticModel.state).toBe('missing');
    expect(missing.semanticModel.reason).toContain('關鍵字搜尋');

    const failed = await probeRuntimeStatus({
      getAssetUrl: (path) => path,
      fetchAsset: vi.fn().mockRejectedValue(new Error('asset access failed')),
    });
    expect(failed.semanticModel.state).toBe('error');
  });
});
