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
    const fw = new THREE.Vector3(); frog.getWorldPosition(fw);
    const out = { frogLocalZ: frog.position.z, frogWorldZ: fw.z, frogParent: frog.parent && frog.parent.type, plats: [] };
    let n = 0;
    window.__scene.traverse(o => {
      if (!o.userData || !['log','turtle','lilypad'].includes(o.userData.kind)) return;
      if (n++ > 5) return;
      o.updateMatrixWorld(true);
      const bx = new THREE.Box3().setFromObject(o);
      const c = bx.getCenter(new THREE.Vector3());
      out.plats.push({ kind: o.userData.kind, cz: +c.z.toFixed(3), cx: +c.x.toFixed(3),
                       top: +bx.max.y.toFixed(3), parent: o.parent && o.parent.type });
    });
    return out;
  }));
  await b.close();
})();
