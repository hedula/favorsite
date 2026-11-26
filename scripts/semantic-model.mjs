import { createHash } from 'node:crypto';
import { createReadStream, readFileSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const semanticModel = JSON.parse(
  readFileSync(new URL('../src/core/semantic-model-manifest.json', import.meta.url), 'utf8'),
);

export async function matchesModelFile(path, sha256) {
  const file = await stat(path).catch(() => null);
  if (!file?.isFile() || !file.size) return false;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === sha256;
}

export async function validateSemanticAssets({ modelRoot, runtimeRoot }) {
  const errors = [];
  for (const file of semanticModel.files) {
    if (!(await matchesModelFile(resolve(modelRoot, file.path), file.sha256))) {
      errors.push(`missing or invalid model asset: ${file.path}`);
    }
  }
  for (const file of semanticModel.runtimeFiles) {
    const info = await stat(resolve(runtimeRoot, file)).catch(() => null);
    if (!info?.isFile() || !info.size) errors.push(`missing runtime asset: ${file}`);
  }
  if (errors.length) {
    throw new Error(`Semantic build validation failed. Run npm run prepare:semantic-model and rebuild.\n${errors.join('\n')}`);
  }
}
