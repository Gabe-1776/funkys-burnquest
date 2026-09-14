// Can the player reach every column of the 1.5x wider grid, at both aspects?
//
// This used to also assert that BOTH grid edges were in frame. That was correct
// when the camera fit the whole board, but the camera now pans with the frog
// and deliberately does NOT contain all 23 columns - standing at the left edge,
// the right edge is off screen by design. Framing is owned by
// tools/camera-check.js, which asserts the edge you are AT stays in frame.
const { chromium } = require('playwright');
const arg = k => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i+1] : null; };
(async () => {
  const b = await chromium.launch();
  let fail = false;
  const say = (ok, m) => { console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${m}`); if (!ok) fail = true; };
  for (const [w, h, label] of [[1280, 800, 'landscape 1280x800'], [430, 900, 'portrait 430x900']]) {
    const p = await b.newPage({ viewport: { width: w, height: h } });
    await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
    await p.waitForTimeout(3500);
    await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
    await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);

    // walk hard left until the sim stops moving us
    let x = 99, stuck = 0;
    for (let i = 0; i < 60 && stuck < 4; i++) {
      const nx = await p.evaluate(() => { window.Sim.moveFrog(-1, 0); return window.Sim.getState().frog.x; });
      stuck = (nx === x) ? stuck + 1 : 0;
      x = nx;
      await p.waitForTimeout(210);
    }
    await p.waitForTimeout(500);
    const r = await p.evaluate(() => {
      const THREE = window.THREE, S = window.Sim;
      const cam = window.__renderCam;
      if (!cam) return { x: S.getState().frog.x, cols: S.getCols(), l: null, r: null };
      cam.updateMatrixWorld(true);
      // Project the OUTER FACES of the playable columns. Measuring the frog
      // alone says nothing: in the normal view the camera is fixed at board
      // centre, so what matters is whether both ends of the grid are in frame.
      const cols = S.getCols();
      const wx = g => g - cols / 2;                 // mirrors render3d worldX()
      const zf = -(S.ROWS - 1) / 2 + 18;            // roughly where play happens
      const proj = gx => new THREE.Vector3(wx(gx), 0.2, 0).project(cam).x;
      return { x: S.getState().frog.x, cols,
               l: +proj(0).toFixed(2), r: +proj(cols).toFixed(2) };
    });
    say(r.x === 0, `${label}: frog reaches column 0 (got ${r.x} of ${r.cols})`);
    if (r.l !== null) {
      // The edge the frog is standing at must be in frame - no empty space
      // beyond the barrier. The far edge is expected to be off screen.
      say(r.l >= -1.02, `${label}: the near edge stays in frame (ndc ${r.l})`);
    } else {
      console.log(`  ...  ${label}: no camera handle, skipping`);
    }
    await p.close();
  }
  await b.close();
  console.log(fail ? '\nFAIL' : '\nPASS');
  process.exit(fail ? 1 : 0);
})();
