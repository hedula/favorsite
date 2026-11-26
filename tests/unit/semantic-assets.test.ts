import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { matchesModelFile, validateSemanticAssets } from '../../scripts/semantic-model.mjs';

describe('semantic release assets', () => {
  it('rejects incomplete releases and detects corrupted cached downloads', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'favorsite-assets-'));
    try {
      await expect(validateSemanticAssets({ modelRoot: directory, runtimeRoot: directory }))
        .rejects.toThrow('missing or invalid model asset: onnx/model_quantized.onnx');
      const path = join(directory, 'file.json');
      const expected = createHash('sha256').update('{"model":"expected"}').digest('hex');
      expect(await matchesModelFile(path, expected)).toBe(false);
      await writeFile(path, '{"model":"different"}');
      expect(await matchesModelFile(path, expected)).toBe(false);
      await writeFile(path, '{"model":"expected"}');
      expect(await matchesModelFile(path, expected)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
