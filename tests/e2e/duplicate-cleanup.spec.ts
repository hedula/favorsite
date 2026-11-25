import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_PATH = path.resolve(process.cwd(), '.output/chrome-mv3');

test.describe('Duplicate bookmark cleanup (real Chromium profile)', () => {
  test('instruction and 重複書籤 view both remove extra copies, keep the earliest, and undo', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorsite-dup-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    try {
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      const extensionId = new URL(sw.url()).host;
      const URL_DUP = 'https://developers.cloudflare.com/kv/';
      const seeded = await sw.evaluate(async (url) => {
        const inbox = await chrome.bookmarks.create({ parentId: '1', title: 'Inbox' });
        const first = await chrome.bookmarks.create({ parentId: inbox.id, title: 'KV first', url });
        await new Promise((r) => setTimeout(r, 20));
        await chrome.bookmarks.create({ parentId: inbox.id, title: 'KV second', url });
        await chrome.bookmarks.create({ parentId: '2', title: 'KV third', url });
        await chrome.bookmarks.create({ parentId: inbox.id, title: 'Tracked', url: 'https://news.example/a?utm_source=x' });
        await chrome.bookmarks.create({ parentId: inbox.id, title: 'Clean', url: 'https://news.example/a' });
        return { inbox: inbox.id, first: first.id };
      }, URL_DUP);
      const countCopies = () =>
        sw.evaluate(async (url) => (await chrome.bookmarks.search({ url })).length, URL_DUP);

      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`chrome-extension://${extensionId}/studio.html`);
      await page.waitForSelector('.bookmark-row');

      // 1) Typed instruction (engine stays on auto) is routed to the duplicate planner
      await page.locator('.pane-left').getByText('Inbox').first().click();
      await page.getByRole('button', { name: '移除重複書籤' }).click();
      await expect(page.locator('#org-instruction')).toHaveValue('移除重複書籤，每組只保留一筆');
      await page.getByRole('button', { name: '產生整理預覽方案' }).click();
      const preview = page.getByRole('region', { name: '方案差異預覽' });
      await expect(preview.locator('.wf-badge', { hasText: '完全重複' })).toHaveCount(1);
      // In the Inbox scope only the newer Inbox copy is removed; the earliest copy is kept
      await expect(preview.locator('.danger-card')).toHaveCount(2); // 1 exact + 1 suspected
      await expect(preview.getByText(/保留：KV first/)).toBeVisible();
      await expect(preview.locator('.wf-badge', { hasText: '疑似重複' })).toHaveCount(1);
      await preview.getByRole('button', { name: /確認套用/ }).click();
      await expect(page.getByText(/整理完成/)).toBeVisible();
      expect(await countCopies()).toBe(2);

      // 2) 重複書籤 view → whole-profile cleanup removes the remaining extra copy
      await page.locator('.pane-left').getByText('重複書籤').click();
      await page.getByRole('button', { name: '產生重複清理預覽' }).click();
      await expect(preview.locator('.wf-badge', { hasText: '完全重複' })).toHaveCount(1);
      await preview.getByRole('button', { name: /確認套用/ }).click();
      await expect(page.getByText(/整理完成/)).toBeVisible();
      expect(await countCopies()).toBe(1);
      const survivor = await sw.evaluate(
        async (url) => (await chrome.bookmarks.search({ url }))[0].id,
        URL_DUP,
      );
      expect(survivor).toBe(seeded.first);
      // The suspected (tracking-param) copy was never ticked, so it is still there
      expect(
        await sw.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://news.example/a?utm_source=x' })).length),
      ).toBe(1);

      // 3) Undo the last batch → the removed copy comes back
      await page.getByRole('button', { name: '復原此批次' }).click();
      await expect(page.getByText(/已完整復原|復原完成/)).toBeVisible();
      expect(await countCopies()).toBe(2);
    } finally {
      await context.close();
    }
  });
});
