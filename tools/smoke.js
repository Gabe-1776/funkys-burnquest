// Real-browser smoke test. Run: node tools/smoke.js  (needs a server on :8099)
//   python3 -m http.server 8099
// Drives REAL input (page.keyboard.press) and reads observable sim state.
// Never pokes engine internals to manufacture a pass. Screenshots -> test-shots/.
const { chromium, webkit } = require('playwright');
const debugURL = require('./lib/debug-url');

const BASE = process.env.BASE || 'http://127.0.0.1:8099';
const MODES = ['2d', '3d'];

async function run(browserType, name) {
  const browser = await browserType.launch();
  const results = [];
  for (const mode of MODES) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
    const errs = [];
    page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
    page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text()); });

    await page.goto(debugURL(`${BASE}/index.html?render=${mode}`), { waitUntil: 'load' });
    await page.waitForTimeout(1800);                 // loading screen is a 1200ms timer
    await page.locator('.campaign-btn').first().click();
    await page.waitForTimeout(300);
    await page.locator('#btn-play-run').click();
    await page.waitForTimeout(700);

    const before = await page.evaluate(() => window.Sim && window.Sim.getState());
    // Sample after EVERY press. Checking only start-vs-end gives a false FAIL when
    // the frog hops up, gets hit, and respawns back on row 12 looking unmoved.
    const seen = [];
    for (let i = 0; i < 6; i++) {                    // REAL key events
      await page.keyboard.press('ArrowUp');
      await page.waitForTimeout(220);
      seen.push(await page.evaluate(() => window.Sim && window.Sim.getState()));
    }
    const after = seen[seen.length - 1];
    // Input counts as registered if the frog ever left the start row, or if a
    // life or score changed (i.e. it moved and died).
    const reacted = seen.some(s => s && (s.frog.y !== before.frog.y || s.frog.x !== before.frog.x
                                      || s.lives !== before.lives || s.score !== before.score));

    // Is the canvas actually painting, or is it a flat/black rectangle?
    const paint = await page.evaluate(() => {
      const c = document.getElementById('game-canvas');
      if (!c) return null;
      const g = document.createElement('canvas');
      g.width = c.width; g.height = c.height;
      g.getContext('2d').drawImage(c, 0, 0);
      const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
      const seen = new Set(); let lit = 0;
      for (let i = 0; i < d.length; i += 4 * 997) {
        if (d[i] + d[i+1] + d[i+2] > 24) lit++;
        seen.add((d[i] >> 4) + ',' + (d[i+1] >> 4) + ',' + (d[i+2] >> 4));
      }
      return { distinctColors: seen.size, litFraction: +(lit / (d.length / (4 * 997))).toFixed(3) };
    });

    const shot = `test-shots/${name}-${mode}.png`;
    await page.screenshot({ path: shot });
    results.push({ mode, reacted, before: before && before.frog, after: after && after.frog,
                   lives: [before && before.lives, after && after.lives], paint, errs, shot });
    await page.close();
  }
  await browser.close();
  return results;
}

(async () => {
  let bad = false;
  for (const [bt, name] of [[chromium, 'chromium'], [webkit, 'webkit']]) {
    console.log(`\n=== ${name} ===`);
    for (const r of await run(bt, name)) {
      const moved = r.reacted;
      const painted = r.paint && r.paint.distinctColors > 3 && r.paint.litFraction > 0.05;
      console.log(`  ?render=${r.mode}`);
      console.log(`    frog ${JSON.stringify(r.before)} -> ${JSON.stringify(r.after)}  lives ${r.lives[0]}->${r.lives[1]}  reacted: ${moved}`);
      console.log(`    canvas: ${r.paint ? r.paint.distinctColors + ' distinct colors, ' + (r.paint.litFraction*100).toFixed(0) + '% lit' : 'NO CANVAS'}  painted: ${painted}`);
      if (r.errs.length) console.log(`    errors: ${r.errs.slice(0,3).join(' | ')}`);
      console.log(`    shot: ${r.shot}`);
      if (!moved || !painted) { bad = true; console.log('    ^^ FAIL'); }
    }
  }
  console.log(bad ? '\nSMOKE: FAIL' : '\nSMOKE: PASS');
  process.exit(bad ? 1 : 0);
})();
