// In-game screenshot of every track mid-race: node scripts/shot-tracks.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const [base = 'http://localhost:5195/', out = '.'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
const screen = (s) => page.waitForFunction((x) => window.__game?.state.screen === x, s, { timeout: 180000, polling: 250 });
await page.goto(base + '?laps=1&autopilot');
await screen('title');
const chars = ['dad', 'mom', 'bro1', 'bro2', 'lupin', 'grandma'];
for (const [i, t] of ['chicago', 'neighborhood', 'kitchen', 'dogpark', 'snow'].entries()) {
  await page.evaluate(() => { const g = window.__game; g.showMainMenu(); });
  await screen('menu');
  await page.click('[data-testid=btn-quick-race]');
  await screen('character');
  await page.click(`[data-testid=char-${chars[i]}]`);
  await page.click('[data-testid=btn-confirm-character]');
  await screen('track');
  await page.click(`[data-testid=track-${t}]`);
  await screen('race');
  for (const [j, sec] of [12, 18].entries()) {
    await page.evaluate((s) => window.__game.fastForward(s), sec);
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${out}/${t}-${j}.png` });
  }
  await page.keyboard.press('Escape');
  await page.click('[data-testid=btn-quit]');
}
console.log('errors', errors.length, errors.slice(0, 8));
await browser.close();
