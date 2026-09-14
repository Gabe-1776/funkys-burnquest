// Walks the frog to the left edge and photographs the barrier.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);
  // Park on a median row first: on a road row the frog dies and respawns at
  // the centre column, so it never reaches the edge and the barrier never shows.
  for (let i = 0; i < 30; i++) {
    const onMedian = await p.evaluate(() => {
      const S = window.Sim, y = Math.round(S.getState().frog.y);
      if (S.rowClass(y) === 'median' && y > 1 && y < S.ROWS - 1) return true;
      S.moveFrog(0, -1);
      return false;
    });
    await p.waitForTimeout(300);
    if (onMedian) break;
  }

  // Hops are gated on SIMULATION time, which advances with the render loop -
  // and headless Chrome throttles that, so a wall-clock wait is not a sim-clock
  // wait. A rejected hop is normal here; only many consecutive rejections mean
  // we have actually reached the edge.
  let x = 99, stuck = 0;
  for (let i = 0; i < 200 && stuck < 20; i++) {
    const nx = await p.evaluate(() => { window.Sim.moveFrog(-1, 0); return window.Sim.getState().frog.x; });
    stuck = (nx === x) ? stuck + 1 : 0;
    x = nx;
    await p.waitForTimeout(90);
  }
  await p.waitForTimeout(600);
  const st = await p.evaluate(() => {
    let l = null, r = null;
    window.__scene.traverse(o => {
      if (!o.material || o.material.opacity === undefined) return;
      if (o.geometry && o.geometry.type === 'BoxGeometry' && o.material.transparent
          && o.material.color && o.material.color.getHexString() === 'b9bcc8') {
        if (l === null) l = +o.material.opacity.toFixed(2);
        else r = +o.material.opacity.toFixed(2);
      }
    });
    return { x: window.Sim.getState().frog.x, cols: window.Sim.getCols(),
             barrierOpacities: [l, r] };
  });
  console.log('  frog at x', st.x, 'of', st.cols, 'columns; barrier opacity', JSON.stringify(st.barrierOpacities));
  await p.screenshot({ path: 'test-shots/barrier-left.png' });
  await b.close();
})();
