// Waypoint driver: play up the board, then walk each median edge-to-edge and
// screenshot the frog against the left/right barrier. Compares the wall on
// grass 3 (row 18, no palm) vs grass 4 (row 12, palm row) and left vs right.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'http://127.0.0.1:8099/index.html?render=3d&debug=1';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(p);
  const grab = async name => {
    const r = await cdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(`test-shots/${name}.png`, Buffer.from(r.data, 'base64'));
    console.log('shot:', name);
  };

  const tick = () => p.evaluate(() => {
    const st = window.Sim.getState();
    const road = new Set(st.cars.map(c => c.y));
    const water = new Set([...st.logs, ...st.turtles, ...st.lilypads].map(q => q.y));
    const upRow = Math.round(st.frog.y) - 1;
    const dnRow = Math.round(st.frog.y) + 1;
    const cls = r => st.medianRows.includes(r) || r === 0 ? 'safe'
              : road.has(r) ? 'road'
              : water.has(r) ? 'water' : 'safe';
    const carDangerAt = row => st.cars.some(c => {
      if (c.y !== row) return false;
      const fc = st.frog.x + 0.5;
      for (const ahead of [0, 3, 6, 9]) {
        const cx = c.x + c.dir * c.speed * 0.028 * ahead;
        if (fc > cx + 0.18 - 0.25 && fc < cx + c.w - 0.18 + 0.25) return true;
      }
      return false;
    });
    const plats = r => [...st.logs, ...st.turtles, ...st.lilypads].filter(q => q.y === r);
    const platOkAt = row => plats(row).some(q => {
      const m = Math.min(0.15, q.w * 0.2);
      const fc = st.frog.x + 0.5;
      return fc > q.x + m && fc < q.x + q.w - m;
    });
    const sameRowPlats = plats(Math.round(st.frog.y));
    const sideOk = dir => sameRowPlats.some(q => {
      const c = st.frog.x + dir + 0.5;
      return c > q.x + 0.1 && c < q.x + q.w - 0.1;
    });
    const up = plats(upRow);
    return { x: st.frog.x, y: st.frog.y, lives: st.lives, running: st.gameRunning,
             upCls: cls(upRow), dnCls: cls(dnRow),
             upCar: carDangerAt(upRow), dnCar: carDangerAt(dnRow),
             upPlat: platOkAt(upRow), dnPlat: platOkAt(dnRow),
             sideL: sideOk(-1), sideR: sideOk(1),
             upPlatX: up.length ? up[0].x + up[0].w / 2 : null,
             dnPlatX: (() => { const q = plats(dnRow); return q.length ? q[0].x + q[0].w/2 : null; })(),
             rowCls: cls(Math.round(st.frog.y)) };
  });

  const hop = (dx, dy) => p.evaluate(([dx, dy]) => window.Sim.moveFrog(dx, dy), [dx, dy]);

  // waypoint list: [col, row, shotName|null]
  const WAYPOINTS = [
    [0, 18, 'sweep-g3-left'],
    [22, 18, 'sweep-g3-right'],
    [0, 12, 'sweep-g4-left'],
    [22, 12, 'sweep-g4-right'],
    [0, 6, 'sweep-g5-left'],
    [22, 6, 'sweep-g5-right'],
  ];
  const deadMs = Date.now() + 600000;
  let lastLives = 3;

  for (const [tx, ty, shot] of WAYPOINTS) {
    while (Date.now() < deadMs) {
      const s = await tick();
      if (!s.running) { console.log('run ended'); break; }
      if (s.lives < lastLives) console.log(`died -> ${s.lives} lives`);
      lastLives = s.lives;
      const ry = Math.round(s.y), rx = Math.round(s.x);
      if (ry === ty && rx === tx) break;

      // vertical first (toward target row), then horizontal on safe rows
      if (ry > ty) {
        if (s.upCls === 'safe' || (s.upCls === 'road' && !s.upCar)
            || (s.upCls === 'water' && s.upPlat)) {
          await hop(0, -1); await p.waitForTimeout(200); continue;
        }
        if (s.rowCls === 'water' && s.upPlatX !== null) {
          const d = s.upPlatX - (s.x + 0.5);
          if (d < -0.8 && s.sideL) { await hop(-1, 0); await p.waitForTimeout(180); continue; }
          if (d > 0.8 && s.sideR) { await hop(1, 0); await p.waitForTimeout(180); continue; }
        }
        await p.waitForTimeout(110); continue;
      }
      if (ry < ty) {
        if (s.dnCls === 'safe' || (s.dnCls === 'road' && !s.dnCar)
            || (s.dnCls === 'water' && s.dnPlat)) {
          await hop(0, 1); await p.waitForTimeout(200); continue;
        }
        if (s.rowCls === 'water' && s.dnPlatX !== null) {
          const d = s.dnPlatX - (s.x + 0.5);
          if (d < -0.8 && s.sideL) { await hop(-1, 0); await p.waitForTimeout(180); continue; }
          if (d > 0.8 && s.sideR) { await hop(1, 0); await p.waitForTimeout(180); continue; }
        }
        await p.waitForTimeout(110); continue;
      }
      // on the target row: walk horizontally toward tx
      const dx = tx - rx;
      if (dx === 0) break;
      const step = dx > 0 ? 1 : -1;
      if (s.rowCls === 'water' && !(step < 0 ? s.sideL : s.sideR)) {
        await p.waitForTimeout(110); continue;   // can't sidestep on water w/o platform
      }
      await hop(step, 0); await p.waitForTimeout(190);
    }
    const s = await tick();
    console.log(`waypoint (${tx},${ty}) -> at (${s.x.toFixed(2)}, ${s.y}), lives ${s.lives}`);
    if (shot) { await p.waitForTimeout(1100); await grab(shot); }
    if (!s.running) break;
  }
  await browser.close();
})();
