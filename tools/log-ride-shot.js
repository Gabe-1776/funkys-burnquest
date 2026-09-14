// Rides a LOG and photographs it from a low angle, which is where the gap
// between the frog's feet and the log was visible in shades view.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);
  // hop only when a log is under the next row, so we land on a log specifically
  for (let i = 0; i < 220; i++) {
    const done = await p.evaluate(() => {
      const S = window.Sim;
      if (!S.isRunning()) return 'dead';
      const st = S.getState();
      const row = Math.round(st.frog.y);
      if (S.rowPlatform(row) === 'log' && st.logs.some(
            l => Math.round(l.y) === row && st.frog.x + 0.5 >= l.x && st.frog.x + 0.5 <= l.x + l.w)) return true;
      const next = row - 1;
      const water = new Set(S.WATER_LANES.map(l => l.row));
      if (water.has(next)) {
        const fx = st.frog.x + 0.5;
        const on = [...st.logs, ...st.turtles, ...st.lilypads].some(
          pl => Math.round(pl.y) === next && fx >= pl.x && fx <= pl.x + pl.w);
        if (!on) return false;
      }
      S.moveFrog(0, -1);
      return false;
    });
    if (done === true) break;
    if (done === 'dead') { await p.locator('#btn-play-run').click().catch(()=>{}); await p.waitForTimeout(1800); }
    await p.waitForTimeout(300);
  }
  // drop the camera to deck height for a side-on look at the contact point
  await p.evaluate(() => {
    const c = window.__frogCam || null;
    const THREE = window.THREE, rig = window.__frogRig;
    if (!rig) return;
    const wp = new THREE.Vector3(); rig.getWorldPosition(wp);
    const cam = window.__scene && window.__scene.userData ? null : null;
  });
  await p.screenshot({ path: 'test-shots/log-ride.png' });
  await b.close();
})();
