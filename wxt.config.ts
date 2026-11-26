import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  vite: () => ({ worker: { format: 'es' } }),
  hooks: {
    'build:publicAssets': (_, files) => {
      const runtimeDist = dirname(createRequire(import.meta.url).resolve('@huggingface/transformers'));
      for (const asset of ['ort-wasm-simd-threaded.jsep.mjs', 'ort-wasm-simd-threaded.jsep.wasm']) {
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
      'Local-First Bookmark Studio for native Chrome bookmarks with Gemini Nano, local semantic classification, offline rules, and reversible batch actions.',
    version: '0.1.0',
    minimum_chrome_version: '134',
    permissions: ['bookmarks'],
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
