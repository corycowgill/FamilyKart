import { expect, test, type Page } from '@playwright/test';

type GameWin = Window & { __game: { state: { screen: string }; fastForward(s: number): void } };
const waitScreen = (page: Page, screen: string, timeout = 120_000) =>
  page.waitForFunction((s) => (window as unknown as GameWin).__game?.state.screen === s, screen, { timeout, polling: 250 });
const saved = (page: Page) => page.evaluate(() => JSON.parse(localStorage.getItem('family-kart-save-v1') ?? '{}'));

test('garage paint jobs + night race unlocks a new livery', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto('/?nointro&laps=1&autopilot'); // autopilot: the human kart actually finishes
  await waitScreen(page, 'title');
  await page.keyboard.press('Enter');
  await waitScreen(page, 'menu');

  // Garage: starter livery is unlocked, the rest are locked with a hint
  await page.click('[data-testid=btn-garage]');
  await waitScreen(page, 'garage');
  await expect(page.locator('[data-testid=livery-chicagoFlag]')).not.toHaveClass(/locked/);
  await expect(page.locator('[data-testid=livery-lowerWacker]')).toHaveClass(/locked/);
  await page.click('[data-testid=livery-chicagoFlag]');
  await expect(page.locator('[data-testid=livery-desc]')).toContainText('Equipped');
  await page.click('[data-testid=livery-lTrain]');
  await expect(page.locator('[data-testid=livery-desc]')).toContainText('Locked');
  expect((await saved(page)).liveries.chosen.dad).toBe('chicagoFlag');
  await page.click('[data-testid=btn-back]');
  await waitScreen(page, 'menu');

  // time-of-day picker on the track screen, persisted in settings
  await page.click('[data-testid=btn-quick-race]');
  await waitScreen(page, 'character');
  await expect(page.locator('.char-info .paint-tag')).toContainText('Chicago Flag');
  await page.click('[data-testid=btn-confirm-character]');
  await waitScreen(page, 'track');
  await expect(page.locator('[data-testid=tod-day]')).toHaveClass(/on/);
  await page.click('[data-testid=tod-night]');
  await expect(page.locator('[data-testid=tod-night]')).toHaveClass(/on/);
  expect((await saved(page)).settings.timeOfDay).toBe('night');
  await page.click('[data-testid=track-neighborhood]');
  await waitScreen(page, 'race');
  await page.evaluate(() => (window as unknown as GameWin).__game.fastForward(400));
  await waitScreen(page, 'results', 90_000);
  // finishing a night race unlocks Windy City (any finish) and Lower Wacker (night)
  const toast = page.locator('[data-testid=unlock-toast]');
  await expect(toast).toContainText('Lower Wacker');
  await expect(toast).toContainText('Windy City');
  expect((await saved(page)).liveries.unlocked).toEqual(expect.arrayContaining(['chicagoFlag', 'windyCity', 'lowerWacker']));
  await page.click('[data-testid=btn-main-menu]');
  await waitScreen(page, 'menu');
  await expect(page.locator('[data-testid=btn-garage] .new-badge')).toBeVisible();
  expect(errors, errors.join('\n')).toEqual([]);
});
