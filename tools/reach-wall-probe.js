// Drive the frog to (0, 18) on stage 1 - the left wall at grass 3 - the way a
// player does: hop up only when the landing is provably safe (median free,
// road cell clear of every car's hitbox, water cell covered by a platform),
// then screenshot the real follow-camera view of the left barrier.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'http://127.0.0.1:8099/index.html?render=3d&debug=1';
const TARGET = { x: 0, y: 18 };

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

  // One evaluate per tick: returns frog pos + row classification + safety of
  // hopping up. Column units throughout (frog.x is a column, cars/platforms
  // too; car spans x..x+w, frog centre = frog.x + 0.5).
  const tick = () => p.evaluate(() => {
    const st = window.Sim.getState();
    const road = new Set(st.cars.map(c => c.y));
    const water = new Set([...st.logs, ...st.turtles, ...st.lilypads].map(q => q.y));
    const upRow = Math.round(st.frog.y) - 1;
    const fc = st.frog.x + 0.5;
    const cls = st.medianRows.includes(upRow) || upRow === 0 ? 'safe'
              : road.has(upRow) ? 'road'
              : water.has(upRow) ? 'water' : 'safe';
    // Hops apply instantly in the sim, so the only danger is a car that will
    // overlap the landing column within the next few update ticks.
    const carDanger = st.cars.some(c => {
      if (c.y !== upRow) return false;
      for (const ahead of [0, 3, 6, 9]) {
        const cx = c.x + c.dir * c.speed * 0.028 * ahead;   // CAR_RATE 0.028
        if (fc > cx + 0.18 - 0.25 && fc < cx + c.w - 0.18 + 0.25) return true;
      }
      return false;
    });
    // Hop applies instantly; the platform just has to cover the column NOW
    // (small margin so the next update's drift doesn't drop us).
    const plats = [...st.logs, ...st.turtles, ...st.lilypads].filter(q => q.y === upRow);
    const platOk = plats.some(q => {
      const m = Math.min(0.15, q.w * 0.2);
      return fc > q.x + m && fc < q.x + q.w - m;
    });
    // Sideways hop on water stays alive only if a same-row platform covers the
    // landing column - lets the frog reposition under an upcoming platform.
    const sameRowPlats = [...st.logs, ...st.turtles, ...st.lilypads]
      .filter(q => q.y === Math.round(st.frog.y));
    const sideOk = dir => sameRowPlats.some(q => {
      const c = st.frog.x + dir + 0.5;
      return c > q.x + 0.1 && c < q.x + q.w - 0.1;
    });
    const onWater = water.has(Math.round(st.frog.y));
    return { x: st.frog.x, y: st.frog.y, lives: st.lives, running: st.gameRunning,
             upCls: cls, carDanger, platOk, onWater,
             sideL: sideOk(-1), sideR: sideOk(1),
             // where the next covered column up-row is, for repositioning
             upPlatX: (() => { const q = plats.find(q2 => { const m = Math.min(0.15, q2.w*0.2); return true; }); return q ? q.x + q.w/2 : null; })(),
             rowCls: road.has(Math.round(st.frog.y)) ? 'road'
                   : water.has(Math.round(st.frog.y)) ? 'water' : 'safe' };
  });

  const hop = (dx, dy) => p.evaluate(([dx, dy]) => window.Sim.moveFrog(dx, dy), [dx, dy]);

  const deadMs = Date.now() + 300000;
  let lastLives = 3;
  while (Date.now() < deadMs) {
    const s = await tick();
    if (!s.running) { console.log('run ended'); break; }
    if (s.lives < lastLives) console.log(`died -> ${s.lives} lives (was at y=${s.y})`);
    lastLives = s.lives;
    if (Math.round(s.y) === TARGET.y && Math.round(s.x) === TARGET.x) {
      console.log(`AT target (${s.x.toFixed(2)}, ${s.y})`); break;
    }

    if (Math.round(s.y) > TARGET.y) {
      if (s.upCls === 'safe' || (s.upCls === 'road' && !s.carDanger)
          || (s.upCls === 'water' && s.platOk)) {
        await hop(0, -1);
        await p.waitForTimeout(230);
        continue;
      }
      // No safe hop up. On water, sidestep toward a platform on the row above
      // while staying covered; on roads drift left; medians just wait.
      if (s.rowCls === 'water' && s.upPlatX !== null) {
        const d = s.upPlatX - (s.x + 0.5);
        if (d < -0.8 && s.sideL) { await hop(-1, 0); await p.waitForTimeout(200); continue; }
        if (d > 0.8 && s.sideR) { await hop(1, 0); await p.waitForTimeout(200); continue; }
      }
      if (s.rowCls === 'road' && s.x > 1) { await hop(-1, 0); await p.waitForTimeout(200); }
      else await p.waitForTimeout(110);
    } else if (Math.round(s.x) > TARGET.x) {
      await hop(-1, 0);
      await p.waitForTimeout(230);
    } else {
      await p.waitForTimeout(140);
    }
  }
  const fin = await tick();
  console.log('final:', JSON.stringify(fin));
  await p.waitForTimeout(1200);   // let the follow camera + wall fade settle
  await grab('probe-grass3-leftwall');
  await browser.close();
})();
