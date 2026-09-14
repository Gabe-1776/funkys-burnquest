// Does the platform's measured deck include the HIDDEN placeholder primitives?
// Box3.setFromObject walks every child regardless of .visible, so a placeholder
// taller than the real model silently raises the deck the frog is placed on.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto('http://127.0.0.1:8099/index.html?render=3d&debug=1', { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3000);
  console.log(await p.evaluate(() => {
    const THREE = window.THREE;
    const seen = {};
    window.__scene.traverse(o => {
      const k = o.userData && o.userData.kind;
      if (!['log','turtle','lilypad'].includes(k) || seen[k]) return;
      o.updateMatrixWorld(true);
      const all = new THREE.Box3().setFromObject(o);
      // The REAL mesh the player sees, recorded by the loader as userData.model.
      // Comparing against it is decisive: Box3.setFromObject(group) walks hidden
      // placeholder primitives too, so a placeholder taller than the model
      // silently raises the deck.
      const m = o.userData && o.userData.model;
      const vis = m ? new THREE.Box3().setFromObject(m) : null;
      seen[k] = {
        allTop: +all.max.y.toFixed(3),
        modelTop: vis && isFinite(vis.max.y) ? +vis.max.y.toFixed(3) : null,
        inflatedBy: vis && isFinite(vis.max.y) ? +(all.max.y - vis.max.y).toFixed(3) : null,
        children: o.children.length,
        hidden: o.children.filter(c => !c.visible).length,
      };
    });
    return seen;
  }));
  await b.close();
})();
