// Screenshot every screen on emulated mobile devices: node scripts/shot-mobile.mjs <baseUrl> <outDir>
import { chromium } from '@playwright/test';
import fs from 'node:fs';
const [base = 'http://localhost:5196/', out = '.'] = process.argv.slice(2);
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome', args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const devices = { phone: { width: 844, height: 390 }, small: { width: 667, height: 375 }, tablet: { width: 1024, height: 768 }, portrait: { width: 390, height: 844 } };
const only = process.argv[4]?.split(',');
for (const [name, viewport] of Object.entries(devices)) {
  if (only && !only.includes(name)) continue;
  const page = await browser.newPage({ viewport, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  const screen = (s) => page.waitForFunction((x) => window.__game?.state.screen === x, s, { timeout: 180000, polling: 250 });
  const settle = () => page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 400)))));
  const shot = async (n) => { await page.evaluate(() => document.querySelectorAll('.screen').forEach((s) => (s.style.animation = 'none'))); await settle(); await page.screenshot({ path: `${out}/${name}-${n}.png` }); };
  await page.goto(base + '?nointro');
  await screen('title'); await shot('01-title');
  if (name === 'portrait') { await page.close(); continue; }
  await page.tap('.title-screen'); await screen('menu'); await shot('02-menu');
  await page.tap('[data-testid=btn-settings]'); await shot('03-settings'); await page.tap('[data-testid=btn-settings-done]');
  await page.tap('[data-testid=btn-quick-race]'); await screen('character'); await shot('04-character');
  await page.tap('[data-testid=btn-confirm-character]'); await screen('track'); await shot('05-track');
  await page.tap('[data-testid=track-kitchen]'); await screen('race');
  await page.evaluate(() => window.__game.fastForward(6)); await shot('06-race');
  await page.tap('.touch-pause'); await shot('07-pause'); await page.tap('[data-testid=btn-resume]');
  await page.evaluate(() => window.__game.fastForward(400)); await screen('results'); await shot('08-results');
  console.log(name, 'errors', errors);
  await page.close();
}
await browser.close();
