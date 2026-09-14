// Does the snake stay inside its row, and is the gator creeping visibly?
//
// Gabriel 2026-09-12: "his body still goes out of its row" and "alligator can be
// maybe 1.2x lower in the water". A row is exactly 1.0 deep (worldZ(y) = y -
// (rows - 1) / 2). Sizing this from arithmetic has been wrong twice now: static
// Blender said 0.985 at girth 1.35 and the live scene measured 1.164, so SAMPLE
// the live scene across many frames and take the peak.
//
// ONE browser, foreground. Usage: node tools/hazard-fit-check.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 140)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(900);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(5000);

  const res = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const grab = kind => {
      let hit = null;
      window.__scene && window.__scene.traverse(o => {
        if (o.userData && o.userData.kind === kind && o.visible) {
          const b = new window.THREE.Box3().setFromObject(o);
          hit = { across: b.max.z - b.min.z, height: b.max.y - b.min.y,
                  along: b.max.x - b.min.x, y: o.position.y,
                  minY: b.min.y, maxY: b.max.y };
        }
      });
      return hit;
    };
    const snake = { peak: 0, samples: 0, height: 0 };
    const gator = { y: null, minY: null, maxY: null };
    for (let i = 0; i < 90; i++) {           // ~9s, several slither cycles
      await sleep(100);
      const s = grab('snake');
      if (s) { snake.peak = Math.max(snake.peak, s.across); snake.height = s.height; snake.samples++; }
      const g = grab('gator');
      if (g) { gator.y = g.y; gator.minY = g.minY; gator.maxY = g.maxY; }
    }
    return { snake, gator };
  });

  const s = res.snake, g = res.gator;
  console.log(`SNAKE  peak across-row = ${s.peak.toFixed(3)}  (a row is 1.0 deep)  ` +
              `height ${s.height.toFixed(3)}  samples ${s.samples}`);
  console.log(`       ${s.peak <= 1.0 ? 'FITS its row' : 'STILL OVERHANGS by ' + (s.peak - 1).toFixed(3)}`);
  if (g.y === null) console.log('GATOR  not found on screen');
  else console.log(`GATOR  y ${g.y.toFixed(3)}  body ${g.minY.toFixed(3)}..${g.maxY.toFixed(3)}  ` +
                   `(water rides at ~0.10; above-water part = ${(g.maxY - 0.10).toFixed(3)})`);
  await page.screenshot({ path: 'test-shots/hazard-fit.png' });
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
