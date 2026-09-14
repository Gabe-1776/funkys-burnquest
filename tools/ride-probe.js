const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3000);
  console.log(await p.evaluate(() => {
    const S = window.Sim;
    const kinds = {};
    window.__scene.traverse(o => {
      const k = o.userData && o.userData.kind;
      if (k === 'log' || k === 'turtle' || k === 'lilypad') kinds[k] = (kinds[k] || 0) + 1;
    });
    return {
      hasWaterLanes: !!(S.WATER_LANES && S.WATER_LANES.length),
      waterRows: (S.WATER_LANES || []).slice(0, 6).map(l => l.row + ':' + l.type),
      kindsInScene: kinds,
      ride: window.__rideDebug ? window.__rideDebug() : 'no hook',
      row29kind: (window.__rideDebug ? window.__rideDebug().rowKind[29] : '?')
    };
  }));
  await b.close();
})();
