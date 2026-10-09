import { expect, test, type Page } from '@playwright/test';

type GameWin = Window & { __game: { state: { screen: string } } };
const waitScreen = (page: Page, screen: string) =>
  page.waitForFunction((s) => (window as unknown as GameWin).__game?.state.screen === s, screen, { timeout: 120_000, polling: 250 });
const screenNow = (page: Page) => page.evaluate(() => (window as unknown as GameWin).__game.state.screen);

/** A touch gesture on an element: down at its centre, optional drag, up. */
async function gesture(page: Page, selector: string, dx: number, dy: number) {
  await page.evaluate(({ selector, dx, dy }) => {
    const el = document.querySelector(selector)!;
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    const ev = (type: string, px: number, py: number) =>
      el.dispatchEvent(new PointerEvent(type, { pointerId: 7, pointerType: 'touch', isPrimary: true, bubbles: true, cancelable: true, clientX: px, clientY: py }));
    ev('pointerdown', x, y);
    ev('pointermove', x + dx / 2, y + dy / 2);
    ev('pointermove', x + dx, y + dy);
    ev('pointerup', x + dx, y + dy);
  }, { selector, dx, dy });
}

test.use({ viewport: { width: 667, height: 375 }, hasTouch: true, isMobile: true });

test('landscape phone menus: wobbly taps work, swipes do not, no ghost clicks, settings scrolls', async ({ page }) => {
  await page.goto('/?nointro');
  await waitScreen(page, 'title');
  // trusted tap on the title must open the menu and NOT also press the menu button that appears under the finger
  await page.tap('.title-screen');
  await waitScreen(page, 'menu');
  await page.waitForTimeout(800);
  expect(await screenNow(page)).toBe('menu');

  // a swipe that starts on a button is not a tap
  await gesture(page, '[data-testid=btn-quick-race]', 0, 60);
  await page.waitForTimeout(300);
  expect(await screenNow(page)).toBe('menu');

  // a slightly wobbly tap still counts
  await gesture(page, '[data-testid=btn-quick-race]', 9, -6);
  await waitScreen(page, 'character');
  await gesture(page, '[data-testid=char-lupin]', 5, 4);
  await expect(page.locator('.char-info h2')).toHaveText('Lupin');
  await gesture(page, '[data-testid=btn-confirm-character]', -7, 3);
  await waitScreen(page, 'track');
  // track cards live in a horizontal swipe row: swiping scrolls, tapping picks
  await gesture(page, '[data-testid=track-chicago]', -80, 0);
  await page.waitForTimeout(300);
  expect(await screenNow(page)).toBe('track');
  await gesture(page, '[data-testid=btn-back]', 0, 0);
  await waitScreen(page, 'character');
  await gesture(page, '[data-testid=btn-back]', 0, 0);
  await waitScreen(page, 'menu');

  // settings: taller than the screen, so it must be scrollable by touch and "Done" reachable
  await gesture(page, '[data-testid=btn-settings]', 0, 0);
  const modal = page.locator('[data-testid=settings] .modal');
  await expect(modal).toBeVisible();
  expect(await modal.evaluate((el) => getComputedStyle(el).touchAction)).toBe('pan-y');
  expect(await modal.evaluate((el) => el.scrollHeight > el.clientHeight)).toBe(true);
  await modal.evaluate((el) => (el.scrollTop = el.scrollHeight));
  await expect(page.locator('[data-testid=btn-settings-done]')).toBeInViewport();
  await gesture(page, '[data-testid=btn-settings-done]', 4, 4);
  await expect(page.locator('[data-testid=settings]')).toHaveCount(0);
});
