const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3000);
  console.log(await p.evaluate(() => {
    const THREE = window.THREE, frog = window.__frogRig;
    frog.updateMatrixWorld(true);
    const wp = new THREE.Vector3(); frog.getWorldPosition(wp);
    const ring = frog.userData && frog.userData.ring;
    const parts = [];
    frog.traverse(o => {
      if (!o.isMesh || !o.visible) return;
      const bx = new THREE.Box3().setFromObject(o);
      if (!isFinite(bx.min.y)) return;
      let q = o, isRing = false;
      while (q) { if (q === ring) { isRing = true; break; } q = q.parent; }
      parts.push({ name: o.name || '(unnamed)', ring: isRing,
                   minY: +bx.min.y.toFixed(3), maxY: +bx.max.y.toFixed(3),
                   tris: o.geometry.index ? o.geometry.index.count/3 : o.geometry.attributes.position.count/3 });
    });
    parts.sort((a,b)=>a.minY-b.minY);
    return { frogWorldY: +wp.y.toFixed(3), hasRing: !!ring, parts: parts.slice(0,8) };
  }));
  await b.close();
})();
