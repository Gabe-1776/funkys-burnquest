// Gabriel: the snake "moves left to right to much and goes off the grass row".
// Two candidate meanings needing opposite fixes: (a) it overhangs ACROSS the row
// (rows are 1.0 deep - worldZ(y) = y - (rows-1)/2 - and the fattened snake
// measured 1.164 across), or (b) it travels the full board width and ends up at
// the edges. Look, do not theorise.
//
// ONE browser, foreground. Usage: node tools/snake-look.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(1000);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(3500);

  // Park the camera on the snake's row so it is in frame, and report geometry.
  const info = await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    const st = S.getState();
    const snake = st.hazards.find(h => h.kind === 'snake');
    if (!snake) return { note: 'no snake' };
    // hop the frog up to the snake's row so the camera follows him there
    return { row: snake.y, frogRow: st.frog.y, cols: S.getCols(), rows: S.ROWS,
             x: +snake.x.toFixed(2), w: snake.w };
  });
  console.log('SNAKE:', JSON.stringify(info));

  // walk the frog up until the snake's row is on screen (deaths are fine, the
  // camera is what matters)
  await page.evaluate(async (row) => {
    const S = window.BurnQuestSim || window.Sim;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 400 && S.getState().frog.y > row + 1; i++) {
      S.moveFrog(0, -1); await sleep(35);
      if (!S.isRunning()) break;
    }
  }, info.row);
  await page.waitForTimeout(1200);

  const shots = [];
  for (let attempt = 0; attempt < 60; attempt++) {
    const s = await page.evaluate(() => {
      const S = window.BurnQuestSim || window.Sim;
      const st = S.getState();
      const sn = st.hazards.find(h => h.kind === 'snake');
      return sn ? { x: +sn.x.toFixed(2), dir: sn.dir, frog: st.frog.y, running: S.isRunning() } : null;
    });
    if (!s) break;
    if (s.x <= 0.6 && !shots.includes('left')) {
      await page.screenshot({ path: 'test-shots/snake-at-left-wall.png' });
      shots.push('left'); console.log('shot: left wall at x', s.x);
    }
    if (s.x >= 8 && s.x <= 13 && !shots.includes('mid')) {
      await page.screenshot({ path: 'test-shots/snake-mid-row.png' });
      shots.push('mid'); console.log('shot: mid row at x', s.x);
    }
    if (shots.length === 2) break;
    await page.waitForTimeout(500);
  }
  // geometry: how wide is the snake across the row, vs one row of depth?
  const geo = await page.evaluate(() => {
    let out = null;
    window.__scene && window.__scene.traverse(o => {
      if (o.userData && o.userData.kind === 'snake') {
        const b = new window.THREE.Box3().setFromObject(o);
        out = { acrossRow: +(b.max.z - b.min.z).toFixed(3),
                alongRow: +(b.max.x - b.min.x).toFixed(3),
                height: +(b.max.y - b.min.y).toFixed(3) };
      }
    });
    return out;
  });
  console.log('GEOMETRY (a row is 1.0 deep):', JSON.stringify(geo));
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
