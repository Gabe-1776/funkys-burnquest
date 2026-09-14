// Capture a clean plate of the real game world for the landing page background.
// No HUD, no frog, no overlays - just the board, from the game's own renderer,
// so the menu is backed by the actual game rather than by stock art.
//
// Usage: THEME=funkyverse node tools/menu-plate.js
const { chromium } = require('playwright');
const fs = require('fs');
const THEME = process.env.THEME || 'funkyverse';

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${THEME}`, { waitUntil: 'load' });
  await p.waitForTimeout(4500);
  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 });
  await p.waitForTimeout(3500);
  // Let the traffic spread out so the plate is not a start-line grid.
  await p.waitForTimeout(9000);
  await p.evaluate(() => {
    document.getElementById('hud').style.display = 'none';
    const c = document.getElementById('combo-hud'); if (c) c.style.display = 'none';
    const m = document.getElementById('mobile-controls'); if (m) m.classList.add('hidden');
    // Hide the frog: a menu plate should not show a player parked at the start.
    if (window.__frogRig) window.__frogRig.visible = false;
  });
  await p.waitForTimeout(400);
  const cdp = await p.context().newCDPSession(p);
  const r = await cdp.send('Page.captureScreenshot',
                           { format: 'png', fromSurface: true, captureBeyondViewport: false });
  fs.writeFileSync(`/tmp/claude-501/menu-plate-${THEME}.png`, Buffer.from(r.data, 'base64'));
  await b.close();
  console.log(`wrote /tmp/claude-501/menu-plate-${THEME}.png`);
})();
