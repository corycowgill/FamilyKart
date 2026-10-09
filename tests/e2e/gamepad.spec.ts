import { expect, test, type Page } from '@playwright/test';

type GameWin = Window & {
  __game: { state: { screen: string; phase?: string; speed?: number; time?: number }; fastForward(s: number): void };
  __pad: { buttons: Array<{ pressed: boolean; value: number }>; axes: number[] };
};
const waitScreen = (page: Page, screen: string) =>
  page.waitForFunction((s) => (window as unknown as GameWin).__game?.state.screen === s, screen, { timeout: 120_000, polling: 250 });

/** Wait until the game loop has run at least twice (headless GL can be ~1 FPS). */
const frames = (page: Page) => page.evaluate(() => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r()))));

/** Press and release a standard-mapping button on the fake Xbox pad, giving the game loop frames to see both edges. */
async function tap(page: Page, button: number) {
  await page.evaluate((b) => ((window as unknown as GameWin).__pad.buttons[b] = { pressed: true, value: 1 }), button);
  await frames(page);
  await page.evaluate((b) => ((window as unknown as GameWin).__pad.buttons[b] = { pressed: false, value: 0 }), button);
  await frames(page);
}

test('Xbox controller drives menus, racing and pause', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.addInitScript(() => {
    const pad = {
      index: 0, id: 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e)', connected: true, mapping: 'standard', timestamp: 0,
      axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })),
    };
    (window as unknown as { __pad: typeof pad }).__pad = pad;
    Object.defineProperty(navigator, 'getGamepads', { value: () => [pad, null, null, null] });
  });
  await page.goto('/?nointro');
  await waitScreen(page, 'title');
  await tap(page, 0); // A: start
  await waitScreen(page, 'menu');
  await expect(page.locator('body')).toHaveClass(/pad-mode/);
  await tap(page, 0); // A on the focused "Quick Race"
  await waitScreen(page, 'character');
  await tap(page, 15); // d-pad right -> next family member
  await tap(page, 0); // A confirms the highlighted racer
  await waitScreen(page, 'track');
  await tap(page, 0); // A picks the highlighted track
  await waitScreen(page, 'race');
  await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(3.8));
  // hold RT to accelerate
  await page.evaluate(() => ((window as unknown as GameWin).__pad.buttons[7] = { pressed: true, value: 1 }));
  await page.waitForFunction(() => ((window as unknown as GameWin).__game.state.speed ?? 0) > 3, null, { timeout: 120_000 });
  await page.evaluate(() => ((window as unknown as GameWin).__pad.buttons[7] = { pressed: false, value: 0 }));
  await tap(page, 9); // Menu button pauses
  await expect(page.locator('[data-testid=pause-menu]')).toBeVisible();
  await tap(page, 1); // B resumes
  await expect(page.locator('[data-testid=pause-menu]')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
