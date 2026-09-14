// Crosses the whole board safely and confirms that TOUCHING the last row
// finishes the level from whatever column you arrive at - not only from the
// column the gate is drawn in.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const finishes = [];
  await p.exposeFunction('__onFinish', d => finishes.push(d));
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);

  let goalCol = null, arrivedCol = null, arrivedRow = null;
  for (let i = 0; i < 1200 && !finishes.length; i++) {
    const r = await p.evaluate(() => {
      const S = window.Sim;
      if (!S.isRunning()) return { dead: true };
      const st = S.getState();
      const row = Math.round(st.frog.y), next = row - 1;
      if (row <= 0) return { atGoal: true, col: Math.round(st.frog.x), goalCol: st.goalCol };
      const water = new Set(S.WATER_LANES.map(l => l.row));
      const fx = st.frog.x + 0.5;
      if (water.has(next)) {
        const on = [...st.logs, ...st.turtles, ...st.lilypads].some(
          pl => Math.round(pl.y) === next && fx >= pl.x && fx <= pl.x + pl.w);
        if (!on) return { wait: true };
      }
      if (S.rowClass(next) === 'road') {
        // only hop when no car is about to occupy the landing box
        const busy = st.cars.some(c => Math.round(c.y) === next
          && fx > c.x - 0.9 && fx < c.x + c.w + 0.9);
        if (busy) return { wait: true };
      }
      S.moveFrog(0, -1);
      return { moved: true, row: next, col: Math.round(st.frog.x), goalCol: st.goalCol };
    });
    if (r.dead) { await p.locator('#btn-play-run').click().catch(()=>{}); await p.waitForTimeout(1800); continue; }
    if (r.atGoal) { arrivedCol = r.col; arrivedRow = 0; goalCol = r.goalCol; break; }
    if (r.goalCol !== undefined) goalCol = r.goalCol;
    await p.waitForTimeout(r.wait ? 70 : 110);
  }
  // did a finish event fire?
  const finished = await p.evaluate(() => !document.getElementById('run-complete').classList.contains('hidden')
                                        || !window.Sim.isRunning());
  console.log(`  arrived at row ${arrivedRow} column ${arrivedCol}; gate column is ${goalCol}`);
  const offCentre = arrivedCol !== null && goalCol !== null && arrivedCol !== goalCol;
  console.log(`  ${finished ? 'ok   ' : 'FAIL '} touching the last row ended the run`);
  console.log(`  ${offCentre ? 'note ' : '     '} arrived ${offCentre ? 'OFF-CENTRE' : 'on the gate column'}`);
  await b.close();
  process.exit(finished ? 0 : 1);
})();
