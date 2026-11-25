import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  srcDir: 'src',
  manifest: {
    name: 'Favorsite',
    description:
      'Local-First Bookmark Studio: organize native Chrome bookmarks with previewable diffs, Chrome built-in AI (Gemini Nano) or offline rules, snapshots, and reversible batch actions.',
    version: '0.1.0',
    minimum_chrome_version: '134',
    permissions: ['bookmarks'],
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
