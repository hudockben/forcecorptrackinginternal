// Deterministic frame renderer for the DataWatch explainer.
// Opens demo/explainer.html in headless Chromium, steps a virtual clock
// frame-by-frame via window.seek(), and writes PNG frames to demo/frames/.
//
//   node demo/render.js
//
// Then encode with ffmpeg (see demo/build.sh).
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const ROOT = __dirname;
const FRAMES_DIR = path.join(ROOT, 'frames');
const HTML = 'file://' + path.join(ROOT, 'explainer.html');
const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';

(async () => {
  fs.rmSync(FRAMES_DIR, { recursive: true, force: true });
  fs.mkdirSync(FRAMES_DIR, { recursive: true });

  const browser = await chromium.launch({
    executablePath: fs.existsSync(CHROME) ? CHROME : undefined,
    args: ['--no-sandbox', '--hide-scrollbars', '--force-color-profile=srgb',
           '--disable-gpu', '--font-render-hinting=none'],
  });
  const page = await browser.newPage({
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1,
  });

  await page.addInitScript(() => { window.__capture = true; });
  await page.goto(HTML, { waitUntil: 'load' });
  await page.waitForFunction('window.__ready === true');
  await page.evaluate(() => document.fonts && document.fonts.ready);

  const FPS = await page.evaluate('window.__FPS');
  const TOTAL = await page.evaluate('window.__TOTAL_FRAMES');
  console.log(`Rendering ${TOTAL} frames @ ${FPS}fps ...`);

  const stage = await page.$('#stage');
  const t0 = Date.now();
  for (let f = 0; f < TOTAL; f++) {
    await page.evaluate((fr) => window.seek(fr / window.__FPS), f);
    const file = path.join(FRAMES_DIR, String(f).padStart(5, '0') + '.png');
    await stage.screenshot({ path: file });
    if (f % 30 === 0 || f === TOTAL - 1) {
      const pct = ((f + 1) / TOTAL * 100).toFixed(0);
      const eta = ((Date.now() - t0) / (f + 1) * (TOTAL - f - 1) / 1000).toFixed(0);
      process.stdout.write(`\r  frame ${f + 1}/${TOTAL}  (${pct}%)  eta ${eta}s   `);
    }
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(1)}s -> ${FRAMES_DIR}`);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
