const { chromium } = require('playwright');
const THEME = process.env.THEME || 'diorama';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${THEME}`, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3000);
  // hop up a few times, then hold an up-right diagonal so the facing is visible
  for (let i = 0; i < 3; i++) { await p.evaluate(() => window.Sim.moveFrog(0,-1)); await p.waitForTimeout(320); }
  await p.evaluate(() => window.Sim.moveFrog(1,-1));
  await p.waitForTimeout(90);            // mid-hop, facing already applied
  await p.screenshot({ path: `test-shots/theme-${THEME}.png` });
  await b.close();
})();
