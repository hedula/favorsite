import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { semanticModel, validateSemanticAssets } from './semantic-model.mjs';

await validateSemanticAssets({
  modelRoot: resolve(import.meta.dirname, '../public/semantic-models', semanticModel.modelId),
  runtimeRoot: dirname(createRequire(import.meta.url).resolve('@huggingface/transformers')),
});

console.log(`Verified ${semanticModel.modelId} at revision ${semanticModel.revision}`);
