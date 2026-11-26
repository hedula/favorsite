import { createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { matchesModelFile, semanticModel } from './semantic-model.mjs';

const { modelId, revision, files } = semanticModel;
const root = resolve(import.meta.dirname, '../public/semantic-models', modelId);

for (const file of files) {
  const output = resolve(root, file.path);
  if (await matchesModelFile(output, file.sha256)) continue;
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.download-${process.pid}`;
  try {
    const response = await fetch(`https://huggingface.co/${modelId}/resolve/${revision}/${file.path}`);
    if (!response.ok || !response.body) throw new Error(`${file.path}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (!(await matchesModelFile(temporary, file.sha256))) throw new Error(`${file.path}: checksum or size check failed`);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

console.log(`Prepared ${modelId} at ${root}`);
