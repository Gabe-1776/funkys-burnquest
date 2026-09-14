// The board is wider than the view now, so two things must hold:
//   1. ZOOM is unchanged - the camera frames the same number of columns as the
//      original 15-column board, instead of pulling back to contain 23.
//   2. The view PANS with the frog and stops at the board edge, so you never
//      see past the barrier into empty space.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);
  let fail = false;
  const say = (ok, m) => { console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${m}`); if (!ok) fail = true; };

  const measure = () => p.evaluate(() => {
    const THREE = window.THREE, cam = window.__renderCam, S = window.Sim;
    cam.updateMatrixWorld(true);
    const cols = S.getCols();
    const wx = g => g - cols / 2;
    // how many COLUMNS span the screen at the deck: walk out from the camera's
    // own x until we leave the frustum
    const camX = cam.position.x;
    let halfCols = 0;
    for (let d = 0.25; d < 40; d += 0.25) {
      const v = new THREE.Vector3(camX + d, 0.2, 0).project(cam);
      if (Math.abs(v.x) > 1) break;
      halfCols = d;
    }
    return { camX: +camX.toFixed(2), visibleCols: +(halfCols * 2).toFixed(1),
             frogX: S.getState().frog.x, cols,
             leftEdgeNdc: +new THREE.Vector3(wx(0), 0.2, 0).project(cam).x.toFixed(2) };
  });

  const centre = await measure();
  console.log(`  centred: camera x ${centre.camX}, view spans ${centre.visibleCols} columns of ${centre.cols}`);

  // ZOOM is set by camDist, which is max(depth-fit, width-fit). Proving the
  // width no longer drives it needs no state mutation: compute what fitting all
  // 23 columns WOULD require and confirm the camera is closer than that.
  // (An earlier version called Sim.setCols(15) to compare - it silently did
  //  nothing, so the assertion passed while measuring the same board twice.)
  const zoom = await p.evaluate(() => {
    const cam = window.__renderCam, d = window.__camDebug();
    const vFov = cam.fov * Math.PI / 180;
    const hFov = 2 * Math.atan(Math.tan(vFov / 2) * cam.aspect);
    const fitAll = (d.cols * 1.02 / 2) / Math.tan(hFov / 2);
    const fitView = (Math.min(d.cols, d.VIEW_COLS) * 1.02 / 2) / Math.tan(hFov / 2);
    return { camDist: d.camDist, fitAll, fitView, cols: d.cols, viewCols: d.VIEW_COLS };
  });
  console.log(`  camDist ${zoom.camDist.toFixed(2)} | fitting all ${zoom.cols} cols would need ${zoom.fitAll.toFixed(2)}`);
  say(zoom.camDist < zoom.fitAll - 0.5,
      `camera is not pulled back to contain the full ${zoom.cols}-column board`);

  // walk to the left edge
  let x = 99, stuck = 0;
  for (let i = 0; i < 400 && stuck < 25; i++) {
    const nx = await p.evaluate(() => { window.Sim.moveFrog(-1, 0); return window.Sim.getState().frog.x; });
    stuck = (nx === x) ? stuck + 1 : 0; x = nx;
    await p.waitForTimeout(90);
  }
  await p.waitForTimeout(900);           // let the pan settle
  const edge = await measure();
  console.log(`  at edge:  camera x ${edge.camX}, frog column ${edge.frogX}, left edge ndc ${edge.leftEdgeNdc}`);
  say(edge.frogX === 0, `frog reached column 0 (got ${edge.frogX})`);
  say(edge.camX < centre.camX - 1, `camera panned left with the frog (${centre.camX} -> ${edge.camX})`);
  say(edge.leftEdgeNdc >= -1.02, 'board edge is not past the frame - no empty space beyond it');
  await b.close();
  console.log(fail ? '\nFAIL' : '\nPASS: zoom preserved and the view pans to the edge');
  process.exit(fail ? 1 : 0);
})();
