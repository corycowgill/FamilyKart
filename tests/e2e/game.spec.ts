import { expect, test, type Page } from '@playwright/test';

type GameWin = Window & { __game: { state: { screen: string; phase?: string; lap?: number; place?: number; speed?: number; time?: number }; fastForward(s: number): void } };
const state = (page: Page) => page.evaluate(() => (window as unknown as GameWin).__game.state);
const waitScreen = (page: Page, screen: string, timeout = 120_000) =>
  page.waitForFunction((s) => (window as unknown as GameWin).__game?.state.screen === s, screen, { timeout, polling: 250 });

test.describe('Cowgill Kart Racing', () => {
  let errors: string[];
  test.beforeEach(async ({ page }) => {
    errors = [];
    page.on('pageerror', (e) => errors.push(String(e)));
    page.on('console', (m) => {
      if (m.type() === 'error' && !/fonts\.g|ERR_|net::/.test(m.text())) errors.push(m.text());
    });
  });

  test('menu → character → track → race → results → replay', async ({ page }) => {
    await page.goto('/?laps=1');
    await waitScreen(page, 'title');
    await page.keyboard.press('Enter');
    await waitScreen(page, 'menu');
    await page.click('[data-testid=btn-quick-race]');
    await waitScreen(page, 'character');
    // all six family members are selectable
    for (const id of ['dad', 'mom', 'brennan', 'parker', 'lupin', 'grandma']) await expect(page.locator(`[data-testid=char-${id}]`)).toBeVisible();
    await page.click('[data-testid=char-grandma]');
    await expect(page.locator('.char-info h2')).toHaveText('Grandma');
    await page.click('[data-testid=btn-confirm-character]');
    await waitScreen(page, 'track');
    await page.click('[data-testid=diff-easy]');
    await page.click('[data-testid=track-chicago]');
    await waitScreen(page, 'race');
    await expect(page.locator('[data-testid=hud]')).toBeVisible();

    // keyboard controls drive the kart once the countdown is over (skip the countdown: headless GL is slow)
    await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(3.8));
    await page.waitForFunction(() => ((window as unknown as GameWin).__game.state.time ?? -1) > 0.2, null, { timeout: 120_000 });
    await page.keyboard.down('KeyW');
    await page.waitForFunction(() => ((window as unknown as GameWin).__game.state.speed ?? 0) > 3, null, { timeout: 120_000 });
    await page.keyboard.up('KeyW');
    const s1 = await state(page);
    expect(s1.phase).toBe('racing');
    expect(s1.lap).toBe(1);
    await expect(page.locator('[data-testid=hud-lap-0]')).toContainText('LAP 1/1');

    // pause menu
    await page.keyboard.press('Escape');
    await expect(page.locator('[data-testid=pause-menu]')).toBeVisible();
    await page.click('[data-testid=btn-resume]');
    await expect(page.locator('[data-testid=pause-menu]')).toHaveCount(0);

    // let the race finish (the human kart is idle; AI finishes and the race is called)
    await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(400));
    await waitScreen(page, 'results', 60_000);
    await expect(page.locator('[data-testid=results-table] tr')).toHaveCount(6);
    await page.click('[data-testid=btn-replay]');
    await waitScreen(page, 'race');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('autopilot race completes with accurate results', async ({ page }) => {
    await page.goto('/?laps=1&autopilot');
    await waitScreen(page, 'title');
    await page.keyboard.press('Enter');
    await waitScreen(page, 'menu');
    await page.click('[data-testid=btn-quick-race]');
    await waitScreen(page, 'character');
    await page.click('[data-testid=char-lupin]');
    await page.click('[data-testid=btn-confirm-character]');
    await page.click('[data-testid=track-chicago]');
    await waitScreen(page, 'race');
    await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(300));
    await waitScreen(page, 'results', 60_000);
    const rows = await page.locator('[data-testid=results-table] tr').allTextContents();
    expect(rows.length).toBe(6);
    expect(rows[0]).toMatch(/^1st/);
    expect(rows.some((r) => r.includes('Lupin'))).toBe(true);
    await page.click('[data-testid=btn-main-menu]');
    await waitScreen(page, 'menu');
    expect(errors, errors.join('\n')).toEqual([]);
  });

  test('settings persist across reloads', async ({ page }) => {
    await page.goto('/?nointro');
    await waitScreen(page, 'title');
    await page.keyboard.press('Enter');
    await waitScreen(page, 'menu');
    await page.click('[data-testid=btn-settings]');
    await page.locator('[data-testid=vol-music]').fill('0.2');
    await page.click('[data-testid=btn-settings-done]');
    await page.reload();
    await waitScreen(page, 'title');
    const music = await page.evaluate(() => JSON.parse(localStorage.getItem('cowgill-kart-save-v1') ?? '{}').settings?.music);
    expect(music).toBeCloseTo(0.2);
  });
});
