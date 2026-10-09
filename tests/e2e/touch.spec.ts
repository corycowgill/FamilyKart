import { expect, test, type Page } from '@playwright/test';

type GameWin = Window & {
  __game: {
    state: { screen: string; speed?: number; time?: number };
    fastForward(s: number): void;
    session: { players: Array<{ steerVisual: number; drift: { active: boolean; hopPending: boolean }; vy: number }> } | null;
  };
};
const waitScreen = (page: Page, screen: string) =>
  page.waitForFunction((s) => (window as unknown as GameWin).__game?.state.screen === s, screen, { timeout: 120_000, polling: 250 });
const frames = (page: Page, n = 3) =>
  page.evaluate((count) => new Promise<void>((r) => { let i = 0; const f = () => (++i >= count ? r() : requestAnimationFrame(f)); requestAnimationFrame(f); }), n);

/** Fire a touch pointer event at an element's centre (optionally offset). */
async function touch(page: Page, selector: string, type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, dx = 0) {
  await page.evaluate(({ selector, type, id, dx }) => {
    const el = document.querySelector(selector)!;
    const r = el.getBoundingClientRect();
    el.dispatchEvent(new PointerEvent(type, { pointerId: id, pointerType: 'touch', isPrimary: id === 1, bubbles: true, cancelable: true,
      clientX: r.left + r.width / 2 + dx, clientY: r.top + r.height / 2 }));
  }, { selector, type, id, dx });
}

test.use({ viewport: { width: 844, height: 390 }, hasTouch: true, isMobile: true });

test('touch screen: tap through menus and race with on-screen controls', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?nointro');
  await waitScreen(page, 'title');
  await expect(page.locator('body')).toHaveClass(/touch-mode/);
  await page.tap('.title-screen');
  await waitScreen(page, 'menu');
  await page.tap('[data-testid=btn-quick-race]');
  await waitScreen(page, 'character');
  await page.tap('[data-testid=char-parker]');
  await page.tap('[data-testid=btn-confirm-character]');
  await waitScreen(page, 'track');
  await page.tap('[data-testid=track-chicago]');
  await waitScreen(page, 'race');
  await expect(page.locator('[data-testid=touch-controls]')).toBeVisible();
  await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(3.8));

  // gas is automatic on touch
  await page.waitForFunction(() => ((window as unknown as GameWin).__game.state.speed ?? 0) > 3, null, { timeout: 120_000 });
  // slide the steering stick to the right while holding drift with a second finger
  await touch(page, '.touch-steer-zone', 'pointerdown', 1);
  await touch(page, '.touch-steer-zone', 'pointermove', 1, 70);
  await touch(page, '.touch-btn.drift', 'pointerdown', 2);
  await frames(page);
  const st = await page.evaluate(() => {
    const k = (window as unknown as GameWin).__game.session!.players[0];
    return { steer: k.steerVisual, drifting: k.drift.active || k.drift.hopPending || k.vy !== 0 };
  });
  expect(st.steer).toBeGreaterThan(0.2);
  expect(st.drifting).toBe(true);
  await page.screenshot({ path: 'test-results/touch-race.png' });
  await touch(page, '.touch-btn.drift', 'pointerup', 2);
  await touch(page, '.touch-steer-zone', 'pointerup', 1);

  // on-screen pause button
  await page.tap('.touch-pause');
  await expect(page.locator('[data-testid=pause-menu]')).toBeVisible();
  await page.tap('[data-testid=btn-resume]');
  await expect(page.locator('[data-testid=pause-menu]')).toHaveCount(0);
  expect(errors, errors.join('\n')).toEqual([]);
});
