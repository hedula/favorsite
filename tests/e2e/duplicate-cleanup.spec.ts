import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_PATH = path.resolve(process.cwd(), '.output/chrome-mv3');

test.describe('Duplicate bookmark cleanup (real Chromium profile)', () => {
  test('exports a backup and removes bookmarks directly from the instruction and list', async () => {
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
        const single = await chrome.bookmarks.create({
          parentId: inbox.id, title: 'Test single', url: 'https://example.test/single',
        });
        return { first: first.id, singleUrl: single.url! };
      }, URL_DUP);
      const countCopies = () =>
        sw.evaluate(async (url) => (await chrome.bookmarks.search({ url })).length, URL_DUP);

      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`chrome-extension://${extensionId}/studio.html`);
      await page.waitForSelector('.bookmark-row');
      let dialogs = 0;
      page.on('dialog', async (dialog) => {
        dialogs++;
        await dialog.dismiss();
      });

      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.getByRole('button', { name: '備份書籤' }).click(),
      ]);
      expect(download.suggestedFilename()).toMatch(/^favorsite-backup-.+\.json$/);
      expect(JSON.parse(fs.readFileSync((await download.path())!, 'utf8')).schemaVersion).toBe(1);

      // The instruction deletes only in-scope exact copies, even with Transformers.js selected.
      await page.locator('.pane-left').getByText('Inbox').first().click();
      await page.getByRole('button', { name: '移除重複書籤' }).click();
      await expect(page.locator('#org-instruction')).toHaveValue('移除重複書籤，每組只保留一筆');
      await page.locator('#org-mode').selectOption('transformers-js');
      await page.locator('#org-instruction').fill('幫我找出重複書籤，再把副本刪掉');
      await page.locator('.pane-right').getByRole('button', { name: '刪除重複書籤' }).click();
      const preview = page.getByRole('region', { name: '方案差異預覽' });
      await expect(page.getByText('已刪除 1 筆重複書籤，已備份。')).toBeVisible();
      await expect(preview).toHaveCount(0);
      expect(await countCopies()).toBe(2);

      // The duplicates view deletes the remaining exact copy across the profile.
      await page.locator('.pane-left').getByText('重複書籤').click();
      const listDelete = page.locator('.pane-center').getByRole('button', { name: '刪除重複書籤' });
      await listDelete.click();
      await expect.poll(countCopies).toBe(1);
      await expect(listDelete).toBeDisabled();
      const survivor = await sw.evaluate(
        async (url) => (await chrome.bookmarks.search({ url }))[0].id,
        URL_DUP,
      );
      expect(survivor).toBe(seeded.first);
      // The suspected tracking-param copy is still there.
      expect(
        await sw.evaluate(async () => (await chrome.bookmarks.search({ url: 'https://news.example/a?utm_source=x' })).length),
      ).toBe(1);

      await page.getByRole('button', { name: '復原此批次' }).click();
      await expect(page.getByText(/已完整復原/)).toBeVisible();
      expect(await countCopies()).toBe(2);

      await page.locator('.pane-left').getByText('Inbox').first().click();
      await page.getByRole('button', { name: '刪除 Test single', exact: true }).click();
      await expect(page.getByText('已刪除 1 筆書籤，已備份。')).toBeVisible();
      const countSingle = () => sw.evaluate(async (url) => (await chrome.bookmarks.search({ url })).length, seeded.singleUrl);
      expect(await countSingle()).toBe(0);
      await page.getByRole('button', { name: '復原此批次' }).click();
      await expect.poll(countSingle).toBe(1);
      expect(dialogs).toBe(0);
    } finally {
      await context.close();
    }
  });
});
