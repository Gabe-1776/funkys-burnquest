// Reproduce Gabriel's two reports on stage 1:
//  1. a bird visible (should be hazard-free)
//  2. "can get close to the left wall" - walk the frog to x=0 on a road row
//     and see what the wall/camera do.
const { chromium } = require('playwright');
const fs = require('fs');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  const cdp = await ctx.newCDPSession(p);
  const grab = async name => {
    const r = await cdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(`test-shots/${name}.png`, Buffer.from(r.data, 'base64'));
  };

  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(3000);

  const state = () => p.evaluate(() => {
    const st = window.Sim.getState();
    const THREE = window.THREE, cam = window.__renderCam;
    const proj = (x, y) => new THREE.Vector3(x - st.cols / 2, 0.2, y - (st.rows - 1) / 2).project(cam);
    const f = proj(st.frog.x + 0.5, st.frog.y);
    const wl = proj(0, st.frog.y);
    return { x: st.frog.x, y: st.frog.y, lives: st.lives,
             frogNdcX: +f.x.toFixed(2), wallNdcX: +wl.x.toFixed(2),
             camFocusX: +window.__camDebug().camFocusX.toFixed(2),
             hazards: st.hazards.map(h => `${h.kind}@${h.x.toFixed(1)},${h.y}`),
             bugs: st.bugs.filter(b => !b.collected).map(b => `${b.x},${b.y}`),
             shades: st.shades.filter(g => !g.collected).map(g => `${g.x},${g.y}`) };
  });
  console.log('stage1 start:', JSON.stringify(await state()));
  await grab('probe-stage1-start');

  const hop = async (dx, dy) => {
    await p.evaluate(([dx, dy]) => window.Sim.moveFrog(dx, dy), [dx, dy]);
    await p.waitForTimeout(230);             // HOP_MS is 190
  };
  // Walk left along the START MEDIAN - no cars there, so the frog survives -
  // then hop up onto the road beside the wall and look at it.
  for (let i = 0; i < 30; i++) {
    const s = await state();
    if (s.x === 0) break;
    await hop(-1, 0);
  }
  console.log('edge median:', JSON.stringify(await state()));
  await p.waitForTimeout(900);               // let the camera pan settle
  await grab('probe-edge-median');
  await hop(0, -1);                          // up onto the road beside the wall
  await p.waitForTimeout(600);
  console.log('edge road:', JSON.stringify(await state()));
  await grab('probe-edge-road');

  await browser.close();
})();
