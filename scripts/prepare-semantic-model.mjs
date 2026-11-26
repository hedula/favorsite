import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const modelId = 'Xenova/multilingual-e5-small';
const revision = '761b726dd34fb83930e26aab4e9ac3899aa1fa78';
const root = resolve(import.meta.dirname, '../public/semantic-models', modelId);
const files = [
  { path: 'config.json' },
  { path: 'tokenizer_config.json' },
  { path: 'tokenizer.json' },
  {
    path: 'onnx/model_quantized.onnx',
    sha256: 'f80102d3f2a1229f387d3c81909990d8945513e347b0eab049f7de3c6f98c193',
  },
];

async function matchesFile(path, sha256) {
  if (!(await stat(path).catch(() => null))?.size) return false;
  if (!sha256) return true;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex') === sha256;
}

for (const file of files) {
  const output = resolve(root, file.path);
  if (await matchesFile(output, file.sha256)) continue;
  await mkdir(dirname(output), { recursive: true });
  const temporary = `${output}.download-${process.pid}`;
  try {
    const response = await fetch(`https://huggingface.co/${modelId}/resolve/${revision}/${file.path}`);
    if (!response.ok || !response.body) throw new Error(`${file.path}: HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(temporary, { flags: 'wx' }));
    if (!(await matchesFile(temporary, file.sha256))) throw new Error(`${file.path}: checksum or size check failed`);
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
}

console.log(`Prepared ${modelId} at ${root}`);
