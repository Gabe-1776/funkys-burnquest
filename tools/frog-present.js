const { chromium } = require('playwright');
const THEME = process.env.THEME || 'diorama';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const errs = [];
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${THEME}`, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3500);
  const r = await p.evaluate(() => {
    const THREE = window.THREE, rig = window.__frogRig;
    if (!rig) return { rig: false };
    let tris = 0, meshes = 0;
    rig.traverse(o => { if (o.isMesh && o.visible) { meshes++;
      const g = o.geometry; tris += g.index ? g.index.count/3 : g.attributes.position.count/3; } });
    const bx = new THREE.Box3().setFromObject(rig);
    return { rig: true, meshes, tris: Math.round(tris),
             size: [+(bx.max.x-bx.min.x).toFixed(2), +(bx.max.y-bx.min.y).toFixed(2)] };
  });
  console.log(`  theme=${THEME}`, JSON.stringify(r));
  if (errs.length) console.log('  console errors:', errs.slice(0,3));
  await b.close();
})();
