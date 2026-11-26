// Captures Chrome Web Store screenshots (1280x800) from the built extension using
// synthetic bookmarks in a throwaway Chromium profile. Usage: npm run build && node scripts/capture-store-screenshots.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from '@playwright/test';

const ext = path.resolve('.output/chrome-mv3');
const out = path.resolve('docs/store/assets');
fs.mkdirSync(out, { recursive: true });
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorsite-shots-'));
const ctx = await chromium.launchPersistentContext(dir, {
  channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1,
  args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`],
});
const shot = async (page, name, { keepRight = false } = {}) => {
  const close = page.getByRole('button', { name: '關閉', exact: true });
  if (await close.isVisible()) await close.click();
  await page.evaluate((keep) => {
    window.scrollTo(0, 0);
    const panes = keep ? '.pane-left, .pane-center' : '.pane-left, .pane-center, .pane-right';
    for (const el of document.querySelectorAll(panes)) el.scrollTop = 0;
  }, keepRight);
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(out, name) });
};
const generatePlan = async (page) => {
  await page.getByRole('button', { name: '整理此範圍' }).click();
  await page.locator('#org-mode').selectOption('rule');
  await page.getByLabel('整理指令').fill('把 Inbox 裡的 Cloudflare 書籤依 KV、R2、Queues 分類');
  await page.getByRole('button', { name: '產生整理預覽方案' }).click();
  await page.getByText(/建立資料夾/).first().waitFor();
};
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker');
  const id = new URL(sw.url()).host;
  await sw.evaluate(async () => {
    const mk = (parentId, title, url) => chrome.bookmarks.create({ parentId, title, url });
    const inbox = await mk('1', 'Inbox');
    const items = [
      ['Cloudflare Workers KV Docs', 'https://developers.cloudflare.com/kv/get-started/'],
      ['Cloudflare R2 Storage Guide', 'https://developers.cloudflare.com/r2/'],
      ['Cloudflare Queues Intro', 'https://developers.cloudflare.com/queues/'],
      ['Workers KV and R2 Integration', 'https://developers.cloudflare.com/workers/examples/kv-r2/'],
      ['R2 Presigned URLs', 'https://developers.cloudflare.com/r2/api/s3/presigned-urls/'],
      ['KV 讀寫限制與最終一致性', 'https://developers.cloudflare.com/kv/concepts/how-kv-works/'],
      ['Queues 批次與重試設定', 'https://developers.cloudflare.com/queues/configuration/batching-retries/'],
      ['Cloudflare R2 Storage Guide', 'https://developers.cloudflare.com/r2/'],
      ['Cloudflare Workers KV Docs', 'https://developers.cloudflare.com/kv/get-started/?utm_source=newsletter'],
    ];
    for (const [t, u] of items) await mk(inbox.id, t, u);
    const read = await mk('1', '稍後閱讀');
    for (const [t, u] of [
      ['Astro Content Collections', 'https://docs.astro.build/en/guides/content-collections/'],
      ['MDN: Using IndexedDB', 'https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API/Using_IndexedDB'],
      ['Chrome Extensions: Manifest V3', 'https://developer.chrome.com/docs/extensions/develop/migrate/what-is-mv3'],
      ['手沖咖啡入門：研磨度與水溫', 'https://example.com/coffee/pour-over-basics'],
    ]) await mk(read.id, t, u);
    const recipes = await mk('1', '食譜');
    await mk(recipes.id, '番茄炒蛋（家常版）', 'https://example.com/recipes/tomato-egg');
    await mk(recipes.id, '日式咖哩', 'https://example.com/recipes/japanese-curry');
  });

  const page = await ctx.newPage();
  await page.goto(`chrome-extension://${id}/studio.html`);
  await page.getByText('Favorsite Studio', { exact: true }).waitFor();
  const dismiss = page.getByRole('button', { name: '知道了' });
  if (await dismiss.isVisible()) await dismiss.click();

  // 1. Workspace
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await page.getByText('Queues 批次與重試設定').waitFor();
  await page.waitForTimeout(300);
  await shot(page, 'screenshot-1-workspace.png');

  // 2. Organize diff preview
  await generatePlan(page);
  await page.getByRole('button', { name: '關閉', exact: true }).click().catch(() => {});
  await page.getByRole('region', { name: '方案差異預覽' }).evaluate((el) => el.scrollIntoView({ block: 'start' }));
  await shot(page, 'screenshot-2-preview.png', { keepRight: true });
  await page.getByRole('button', { name: '取消方案' }).click();

  // 3. Duplicates
  await page.locator('.pane-left').getByText('重複書籤').click();
  await page.waitForTimeout(400);
  await shot(page, 'screenshot-3-duplicates.png');

  // 4. Apply + history with undo
  await page.getByRole('button', { name: 'Inbox', exact: true }).click();
  await generatePlan(page);
  await page.getByRole('button', { name: /確認套用/ }).click();
  await page.getByText(/整理完成：已套用/).waitFor();
  await page.getByRole('button', { name: '歷程與備份' }).click();
  await page.waitForTimeout(400);
  await shot(page, 'screenshot-4-history.png');

  console.log('saved to', out);
} finally {
  await ctx.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
