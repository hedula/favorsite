import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test } from '@playwright/test';

const EXTENSION_PATH = path.resolve(process.cwd(), '.output/chrome-mv3');
const SCREENSHOT_DIR = process.env.FAVORSITE_E2E_SCREENSHOTS || '';

test.describe('Favorsite MV3 Extension E2E (Real Chromium Profile)', () => {
  test('vertical slice: create -> reorder -> preview organize -> apply -> verify chrome.bookmarks -> undo + responsive 1440/768/390', async () => {
    expect(fs.existsSync(path.join(EXTENSION_PATH, 'manifest.json'))).toBe(true);
    expect(fs.existsSync(path.join(EXTENSION_PATH, 'icons/icon-16.png'))).toBe(true);
    expect(fs.existsSync(path.join(EXTENSION_PATH, 'icons/icon-48.png'))).toBe(true);
    expect(fs.existsSync(path.join(EXTENSION_PATH, 'icons/icon-128.png'))).toBe(true);

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorsite-e2e-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });

    try {
      // Wait for MV3 service worker to start and grab extensionId
      let [serviceWorker] = context.serviceWorkers();
      if (!serviceWorker) {
        serviceWorker = await context.waitForEvent('serviceworker', {
          timeout: 15_000,
        });
      }
      const extensionId = new URL(serviceWorker.url()).host;
      expect(extensionId).toBeTruthy();

      // 1. Seed synthetic bookmarks directly via real chrome.bookmarks in the isolated profile
      const seeded = await serviceWorker.evaluate(async () => {
        const inbox = await chrome.bookmarks.create({
          parentId: '1',
          title: 'Inbox',
        });
        const kv = await chrome.bookmarks.create({
          parentId: inbox.id,
          title: 'Cloudflare Workers KV Docs',
          url: 'https://developers.cloudflare.com/kv/get-started/',
        });
        const r2 = await chrome.bookmarks.create({
          parentId: inbox.id,
          title: 'Cloudflare R2 Storage Guide',
          url: 'https://developers.cloudflare.com/r2/',
        });
        const queues = await chrome.bookmarks.create({
          parentId: inbox.id,
          title: 'Cloudflare Queues Intro',
          url: 'https://developers.cloudflare.com/queues/',
        });
        const cross = await chrome.bookmarks.create({
          parentId: inbox.id,
          title: 'Workers KV and R2 Integration',
          url: 'https://developers.cloudflare.com/workers/examples/kv-r2/',
        });
        return {
          inboxId: inbox.id,
          kvId: kv.id,
          r2Id: r2.id,
          queuesId: queues.id,
          crossId: cross.id,
        };
      });

      // 2. Verify Popup loads and displays bookmark count
      const popupPage = await context.newPage();
      await popupPage.setViewportSize({ width: 360, height: 420 });
      await popupPage.goto(`chrome-extension://${extensionId}/popup.html`);
      await expect(popupPage.getByText('Favorsite', { exact: true })).toBeVisible();
      await expect(popupPage.getByText('開啟 Bookmark Studio')).toBeVisible();
      if (SCREENSHOT_DIR) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await popupPage.screenshot({
          path: path.join(SCREENSHOT_DIR, 'popup-360.png'),
        });
      }
      await popupPage.close();

      // 3. Open Studio full page at 1440x900
      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`chrome-extension://${extensionId}/studio.html`);
      await expect(
        page.getByText('Favorsite Studio', { exact: true }),
      ).toBeVisible();
      // Right sidebar AI Organize panel is immediately visible by default on load
      await expect(page.getByText('AI 與整理引擎（隱私零成本優先）')).toBeVisible();

      // Dismiss first-run notice if shown
      const dismissBtn = page.getByRole('button', { name: '知道了' });
      if (await dismissBtn.isVisible()) {
        await dismissBtn.click();
      }

      // Navigate into Inbox folder
      await page.getByRole('button', { name: 'Inbox', exact: true }).click();
      await expect(page.getByText('Cloudflare Workers KV Docs')).toBeVisible();
      await expect(page.getByText('Cloudflare R2 Storage Guide')).toBeVisible();

      // 4. Test real Chrome same-folder forward move ("下移" on first item KV)
      await page.getByRole('button', { name: '下移 Cloudflare Workers KV Docs' }).click();
      await page.waitForTimeout(300);
      const orderAfterDown = await serviceWorker.evaluate(async (inboxId) => {
        const children = await chrome.bookmarks.getChildren(inboxId);
        return children.map((c) => c.title);
      }, seeded.inboxId);
      expect(orderAfterDown[0]).toBe('Cloudflare R2 Storage Guide');
      expect(orderAfterDown[1]).toBe('Cloudflare Workers KV Docs');

      // Move KV back up ("上移")
      await page.getByRole('button', { name: '上移 Cloudflare Workers KV Docs' }).click();
      await page.waitForTimeout(300);
      const orderAfterUp = await serviceWorker.evaluate(async (inboxId) => {
        const children = await chrome.bookmarks.getChildren(inboxId);
        return children.map((c) => c.title);
      }, seeded.inboxId);
      expect(orderAfterUp[0]).toBe('Cloudflare Workers KV Docs');

      // 5. Open Organize panel and run representative Cloudflare KV/R2/Queues scenario
      await page.getByRole('button', { name: '整理此範圍' }).click();
      await page
        .getByLabel('整理指令')
        .fill('把 Inbox 裡的 Cloudflare Workers 書籤依 KV、R2、Queues 分類');
      await page.getByRole('button', { name: '產生整理預覽方案' }).click();

      // Verify preview shows created folders, moves, and cross-topic pending review
      await expect(page.getByText('建立資料夾 (3)')).toBeVisible();
      await expect(page.getByText('待人工確認 (1)')).toBeVisible();

      if (SCREENSHOT_DIR) {
        fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, 'studio-1440-preview.png'),
        });
      }

      // Confirm and Apply
      await page.getByRole('button', { name: /確認套用/ }).click();
      await expect(page.getByText(/整理完成：已套用/)).toBeVisible();

      // Verify directly against real Chrome native bookmarks API
      const nativeAfterApply = await serviceWorker.evaluate(async (ids) => {
        const inboxChildren = await chrome.bookmarks.getChildren(ids.inboxId);
        const folders = inboxChildren.filter((c) => !c.url);
        const [kvNode] = await chrome.bookmarks.get(ids.kvId);
        const [r2Node] = await chrome.bookmarks.get(ids.r2Id);
        const [qNode] = await chrome.bookmarks.get(ids.queuesId);
        const [crossNode] = await chrome.bookmarks.get(ids.crossId);
        const folderById = Object.fromEntries(folders.map((f) => [f.id, f.title]));
        return {
          folderNames: folders.map((f) => f.title).sort(),
          kvParentName: folderById[kvNode.parentId!],
          r2ParentName: folderById[r2Node.parentId!],
          qParentName: folderById[qNode.parentId!],
          crossParentId: crossNode.parentId,
        };
      }, seeded);

      expect(nativeAfterApply.folderNames).toEqual(['KV', 'Queues', 'R2']);
      expect(nativeAfterApply.kvParentName).toBe('KV');
      expect(nativeAfterApply.r2ParentName).toBe('R2');
      expect(nativeAfterApply.qParentName).toBe('Queues');
      expect(nativeAfterApply.crossParentId).toBe(seeded.inboxId);

      // 6. Click Undo ("復原此批次") and verify real Chrome native bookmarks restored!
      await page.getByRole('button', { name: '復原此批次' }).click();
      await expect(page.getByText(/已完整復原此批次/)).toBeVisible();

      const nativeAfterUndo = await serviceWorker.evaluate(async (ids) => {
        const inboxChildren = await chrome.bookmarks.getChildren(ids.inboxId);
        return {
          foldersRemaining: inboxChildren.filter((c) => !c.url).length,
          bookmarkTitles: inboxChildren.filter((c) => c.url).map((c) => c.title),
        };
      }, seeded);

      expect(nativeAfterUndo.foldersRemaining).toBe(0);
      expect(nativeAfterUndo.bookmarkTitles).toHaveLength(4);

      // 7. Responsive checks at 1440px, 768px, 390px (no horizontal overflow)
      for (const vp of [
        { name: '1440', width: 1440, height: 900 },
        { name: '768', width: 768, height: 900 },
        { name: '390', width: 390, height: 844 },
      ]) {
        await page.setViewportSize({ width: vp.width, height: vp.height });
        await page.waitForTimeout(150);
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow).toBeLessThanOrEqual(1);
        if (SCREENSHOT_DIR) {
          await page.screenshot({
            path: path.join(SCREENSHOT_DIR, `studio-${vp.name}.png`),
          });
        }
      }

      // 8. Simulate external modification after preview (two-window conflict) & verify zero external network calls
      const externalRequests: string[] = [];
      page.on('request', (req) => {
        const u = req.url();
        if (!u.startsWith('chrome-extension://') && !u.startsWith('data:') && !u.startsWith('blob:')) {
          externalRequests.push(u);
        }
      });

      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Inbox', exact: true }).click();
      await page.getByRole('button', { name: '整理此範圍' }).click();
      await page.getByLabel('整理指令').fill('依 KV、R2 分類');
      await page.getByRole('button', { name: '產生整理預覽方案' }).click();
      await expect(page.getByText(/差異預覽/)).toBeVisible();

      // Mutate bookmark externally via Chrome API (as if another Chrome window renamed it)
      await serviceWorker.evaluate(async (kvId) => {
        await chrome.bookmarks.update(kvId, {
          title: 'Cloudflare Workers KV Docs (Renamed Externally)',
        });
      }, seeded.kvId);

      // Studio should automatically detect stale plan and disable apply button
      await expect(page.getByText('書籤狀態已變更')).toBeVisible();
      await expect(page.getByRole('button', { name: /確認套用/ })).toBeDisabled();

      // Confirm zero external vendor network requests occurred during core operations
      expect(externalRequests).toEqual([]);

      // 9. Verify dead-link cleanup UI controls (Option A quarantine + Option B direct remove) render cleanly
      await expect(page.getByText('失效連結檢查與清理（選用）')).toBeVisible();
      await expect(page.getByLabel('失效書籤處理方式')).toBeVisible();
      await page.getByLabel('失效書籤處理方式').selectOption('remove');
      await expect(page.getByLabel('失效書籤處理方式')).toHaveValue('remove');
      await page.getByLabel('失效書籤處理方式').selectOption('quarantine');
      await expect(page.getByLabel('失效書籤處理方式')).toHaveValue('quarantine');

      // 10. Capture History & Settings desktop screenshots for visual QA against Stitch references
      if (SCREENSHOT_DIR) {
        await page.getByRole('button', { name: '歷程與備份' }).click();
        await page.waitForTimeout(150);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, 'studio-1440-history.png'),
        });
        await page.getByRole('button', { name: '設定' }).click();
        await page.waitForTimeout(150);
        await page.screenshot({
          path: path.join(SCREENSHOT_DIR, 'studio-1440-settings.png'),
        });
      }
    } finally {
      await context.close();
      fs.rmSync(userDataDir, { recursive: true, force: true });
    }
  });
});
