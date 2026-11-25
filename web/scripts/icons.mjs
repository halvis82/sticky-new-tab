// Renders icon.svg to the PNG sizes phones want for the home screen.
import { chromium } from 'playwright';
import fs from 'node:fs';

// Full bleed: iOS and Android round the corners themselves.
const svg = fs.readFileSync(new URL('../icon.svg', import.meta.url), 'utf8').replace('rx="112"', 'rx="0"');
const browser = await chromium.launch();
for (const size of [180, 192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body>`);
  await page.screenshot({ path: new URL(`../icon-${size}.png`, import.meta.url).pathname, omitBackground: true });
  await page.close();
}
await browser.close();
console.log('icons written');
