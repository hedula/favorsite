import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'wxt';
import { semanticModel, validateSemanticAssets } from './scripts/semantic-model.mjs';
import packageJson from './package.json';

function getBuildId(): string {
  const projectRoot = import.meta.dirname;
  const sourceFiles = [
    'package.json',
    'wxt.config.ts',
    ...readdirSync(resolve(projectRoot, 'src'), { recursive: true }).map((file) => `src/${file}`),
  ].filter((file) => statSync(resolve(projectRoot, file)).isFile()).sort();
  const hash = createHash('sha256');
  for (const file of sourceFiles) {
    hash.update(file);
    hash.update(readFileSync(resolve(projectRoot, file)));
  }
  return `${packageJson.version}-${hash.digest('hex').slice(0, 12)}`;
}

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  vite: () => ({
    worker: { format: 'es' },
    define: {
      __FAVORSITE_BUILD__: JSON.stringify({
        extensionVersion: packageJson.version,
        buildId: getBuildId(),
        protocolVersion: 2,
      }),
    },
  }),
  hooks: {
    'build:publicAssets': async (_, files) => {
      const runtimeDist = dirname(createRequire(import.meta.url).resolve('@huggingface/transformers'));
      await validateSemanticAssets({
        modelRoot: resolve(import.meta.dirname, 'public/semantic-models', semanticModel.modelId),
        runtimeRoot: runtimeDist,
      });
      for (const asset of semanticModel.runtimeFiles) {
        files.push({
          absoluteSrc: resolve(runtimeDist, asset),
          relativeDest: `semantic-runtime/${asset}`,
        });
      }
    },
  },
  manifest: {
    name: 'Favorsite',
    description:
      'Local-first bookmark studio: organize Chrome bookmarks with on-device AI, offline rules, and reversible batch actions.',
    version: packageJson.version,
    minimum_chrome_version: '134',
    permissions: ['bookmarks', 'nativeMessaging', 'offscreen', 'activeTab', 'scripting'],
    content_security_policy: {
      extension_pages: "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';",
    },
    optional_host_permissions: [
      'https://*/*',
      'http://*/*',
    ],
    icons: {
      16: 'icons/icon-16.png',
      48: 'icons/icon-48.png',
      128: 'icons/icon-128.png',
    },
    action: {
      default_title: 'Favorsite Bookmark Studio',
      default_icon: {
        16: 'icons/icon-16.png',
        48: 'icons/icon-48.png',
        128: 'icons/icon-128.png',
      },
    },
  },
});
