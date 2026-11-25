import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium, expect, test, type Page } from '@playwright/test';

const EXTENSION_PATH = path.resolve(process.cwd(), '.output/chrome-mv3');

/** P2 regressions: keyboard focus, drawers, narrow layouts, reduced motion. */
test.describe('Favorsite Studio a11y & responsive (P2 regressions)', () => {
  test('focus survives reorder/move, drawers close on Escape/scrim, narrow layouts fit', async () => {
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'favorsite-a11y-'));
    const context = await chromium.launchPersistentContext(userDataDir, {
      channel: 'chromium',
      headless: true,
      args: [
        `--disable-extensions-except=${EXTENSION_PATH}`,
        `--load-extension=${EXTENSION_PATH}`,
      ],
    });
    const externalRequests: string[] = [];
    context.on('request', (r) => {
      if (!/^(chrome-extension|data|blob):/.test(r.url())) externalRequests.push(r.url());
    });

    try {
      let [sw] = context.serviceWorkers();
      if (!sw) sw = await context.waitForEvent('serviceworker', { timeout: 15_000 });
      const extensionId = new URL(sw.url()).host;
      const seeded = await sw.evaluate(async () => {
        const inbox = await chrome.bookmarks.create({ parentId: '1', title: 'Inbox' });
        const ids: string[] = [];
        for (const [title, url] of [
          ['Figma design tips', 'https://figma.com/a'],
          ['GitHub repo', 'https://github.com/x'],
          ['Dribbble shots', 'https://dribbble.com/z'],
        ]) {
          ids.push((await chrome.bookmarks.create({ parentId: inbox.id, title, url })).id);
        }
        const dest = await chrome.bookmarks.create({ parentId: '2', title: 'Dest' });
        return { inbox: inbox.id, ids, dest: dest.id };
      });

      const page = await context.newPage();
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`chrome-extension://${extensionId}/studio.html`);
      await page.waitForSelector('.bookmark-row');
      await page.locator('.pane-left').getByText('Inbox').first().click();
      await expect(page.locator(`#row-up-${seeded.ids[1]}`)).toBeVisible();

      const activeId = (p: Page) =>
        p.evaluate(() => document.activeElement?.id || document.activeElement?.tagName);

      // 上移 to the top disables that button: focus must move to the same row's 下移
      await page.locator(`#row-up-${seeded.ids[1]}`).focus();
      await page.keyboard.press('Enter');
      await expect(page.locator(`#row-up-${seeded.ids[1]}`)).toBeDisabled();
      await expect.poll(() => activeId(page)).toBe(`row-down-${seeded.ids[1]}`);

      // 下移 keeps focus on the pressed button
      await page.keyboard.press('Enter');
      await expect.poll(() => activeId(page)).toBe(`row-down-${seeded.ids[1]}`);

      // 移至: picker gets focus; after the row leaves this folder, focus lands on a neighbour
      await page.locator(`#row-move-${seeded.ids[2]}`).focus();
      await page.keyboard.press('Enter');
      const picker = page.getByRole('combobox', { name: '選擇目的資料夾' });
      await expect(picker).toBeFocused();
      const destValue = await picker
        .locator('option', { hasText: 'Dest' })
        .first()
        .getAttribute('value');
      await picker.selectOption(destValue!);
      await expect(page.locator(`#row-move-${seeded.ids[2]}`)).toHaveCount(0);
      await expect
        .poll(() => activeId(page))
        .toMatch(/^(row-title-|bookmark-list-heading)/);

      // Reduced motion is honoured
      await page.emulateMedia({ reducedMotion: 'reduce' });
      const duration = await page.evaluate(
        () => getComputedStyle(document.querySelector('button')!).transitionDuration,
      );
      expect(parseFloat(duration)).toBeLessThan(0.01);
      await page.emulateMedia({ reducedMotion: 'no-preference' });

      // 768px drawer: Escape and scrim close it and return focus to its toggle
      await page.setViewportSize({ width: 768, height: 1024 });
      const toggle = page.getByRole('button', { name: /開啟明細\/整理抽屜/ });
      await toggle.click();
      await expect(page.locator('.pane-right.open')).toBeVisible();
      await expect(page.locator('.drawer-scrim')).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(page.locator('.pane-right.open')).toHaveCount(0);
      await expect(page.getByRole('button', { name: /開啟明細\/整理抽屜/ })).toBeFocused();
      await page.getByRole('button', { name: /開啟資料夾導覽/ }).click();
      await expect(page.locator('.pane-left.open')).toBeVisible();
      await page.locator('.drawer-scrim').click({ position: { x: 700, y: 900 } });
      await expect(page.locator('.pane-left.open')).toHaveCount(0);

      // 390px: pane switcher is a button group (no orphan tablist), banner button stays one line
      await page.setViewportSize({ width: 390, height: 844 });
      await expect(page.locator('.mobile-pane-tabs')).toHaveAttribute('role', 'group');
      const dismiss = page.getByRole('button', { name: '知道了' });
      const box = await dismiss.boundingBox();
      expect(box!.height).toBeLessThan(48);
      expect(box!.width).toBeGreaterThan(box!.height);

      // History tables stack at 390px with no horizontal overflow (needs at least one job)
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.locator('.pane-left').getByText('Inbox').first().click();
      await page.locator('#org-mode').selectOption('rule');
      await page.getByRole('button', { name: '產生整理預覽方案' }).click();
      await page.getByRole('button', { name: /確認套用/ }).click();
      await expect(page.getByText(/整理完成/)).toBeVisible();
      await page.getByRole('button', { name: /歷程與備份/ }).click();
      await expect(page.locator('.job-table tbody tr').first()).toBeVisible();
      for (const width of [390, 768, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const overflow = await page.evaluate(
          () => document.documentElement.scrollWidth - window.innerWidth,
        );
        expect(overflow, `history overflow at ${width}px`).toBeLessThanOrEqual(0);
      }

      expect(externalRequests).toEqual([]);
    } finally {
      await context.close();
    }
  });
});
