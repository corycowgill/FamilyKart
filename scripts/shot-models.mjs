// Screenshot the procedural models via model-preview.html.
// Usage: node scripts/shot-models.mjs [outDir] [baseUrl] [shotsJson]
// Requires the vite dev server running (npx vite --port 5180).
import { chromium } from '@playwright/test';
import fs from 'node:fs';
import path from 'node:path';

const outDir = process.argv[2] ?? 'shots';
const base = process.argv[3] ?? 'http://localhost:5180/model-preview.html';
const defaults = [
  ['row-front', 'yaw=25&freeze=1.0'],
  ['row-chase', 'cam=chase&yaw=0&freeze=1.0'],
];
const shots = process.argv[4] ? JSON.parse(process.argv[4]) : defaults;
fs.mkdirSync(outDir, { recursive: true });

const exe = process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const browser = await chromium.launch({
  executablePath: exe,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') console.log('[console]', m.type(), m.text()); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
for (const [name, qs] of shots) {
  await page.goto(`${base}?${qs}`, { waitUntil: 'load' });
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 120000 });
  await page.waitForTimeout(300);
  const file = path.join(outDir, `${name}.png`);
  await page.screenshot({ path: file });
  const tris = await page.evaluate(() => window.__tris);
  console.log(name, '->', file);
  if (name.startsWith('row')) console.log(JSON.stringify(tris));
}
await browser.close();
