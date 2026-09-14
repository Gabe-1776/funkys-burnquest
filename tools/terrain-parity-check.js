// Two checks the audit asked for:
//  1. the 2D renderer paints terrain for EVERY band, not just band 0
//  2. a failed primary renderer actually reaches the 2D fallback rather than
//     leaving the loading screen up forever
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  let fail = false;
  const say = (ok, m) => { console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${m}`); if (!ok) fail = true; };

  // ---- 2D terrain parity
  const p = await b.newPage({ viewport: { width: 900, height: 900 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=2d', { waitUntil: 'load' });
  await p.waitForTimeout(2500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 60000 }); await p.waitForTimeout(1500);

  const bands = await p.evaluate(() => {
    const S = window.Sim;
    // sample the canvas at the vertical centre of one water row per band
    const c = document.getElementById('game-canvas');
    const g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
    g.getContext('2d').drawImage(c, 0, 0);
    const ctx = g.getContext('2d');
    const rows = S.ROWS;
    const waterRows = S.WATER_LANES.map(l => l.row);
    // one water row from each third of the board
    const picks = [waterRows[0], waterRows[Math.floor(waterRows.length / 2)],
                   waterRows[waterRows.length - 1]];
    const out = [];
    for (const r of picks) {
      const y = Math.round(((r + 0.5) / rows) * c.height);
      // Sample ACROSS the row. A single centre sample lands on whatever log or
      // lilypad happens to be drifting there and reports the sprite's colour,
      // not the terrain - that produced a false failure on row 15.
      let water = 0, total = 0, sample = null;
      for (let i = 1; i < 20; i++) {
        const x = Math.round((i / 20) * c.width);
        const d = ctx.getImageData(x, Math.min(c.height - 1, y), 1, 1).data;
        if (!sample) sample = d;
        total++;
        if (d[2] > d[0] + 20) water++;
      }
      out.push({ row: r, share: Math.round((water / total) * 100),
                 rgb: `#${[sample[0],sample[1],sample[2]].map(v=>v.toString(16).padStart(2,'0')).join('')}`,
                 // Platforms cover much of a water row, so the share varies
                 // (26-47% across bands). What matters is that it is NOT ~0,
                 // which is what a water row painted as tarmac would give -
                 // rows 15 and 29 read 0% before the terrain descriptor fix.
                 blueish: water > total * 0.15 });
    }
    return out;
  });
  bands.forEach(x => say(x.blueish, `water row ${x.row} paints as water (${x.share}% of the row)`));
  await p.close();

  // ---- boot fallback when THREE is missing
  const p2 = await b.newPage({ viewport: { width: 900, height: 700 } });
  await p2.route('**/three.min.js', r => r.abort());        // simulate blocked CDN
  const errs = [];
  p2.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p2.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p2.waitForTimeout(3000);
  const loadingGone = await p2.evaluate(() =>
    document.getElementById('loading-screen').classList.contains('hidden'));
  const pickable = await p2.locator('.campaign-btn').first().isVisible().catch(() => false);
  say(loadingGone, 'loading screen clears when three.js fails to load');
  say(pickable, 'the game is still reachable via the 2D fallback');
  await p2.close();

  await b.close();
  console.log(fail ? '\nFAIL' : '\nPASS: terrain covers all bands; boot failure reaches the fallback');
  process.exit(fail ? 1 : 0);
})();
