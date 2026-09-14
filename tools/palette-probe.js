const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  for (const theme of ['funkyverse', 'diorama']) {
    const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
    await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${theme}`, { waitUntil: 'load' });
    await p.waitForTimeout(3500);
    const fresh = await p.evaluate(() => Object.keys(window.__COLORS || {}).sort());
    await p.evaluate(() => { const n = window.Render3D.themeNames(), c = window.Render3D.getTheme();
                             window.Render3D.setTheme(n.find(x => x !== c)); });
    await p.waitForTimeout(1200);
    await p.evaluate(t => window.Render3D.setTheme(t), theme);
    await p.waitForTimeout(1200);
    const cycled = await p.evaluate(() => Object.keys(window.__COLORS || {}).sort());
    const gained = cycled.filter(k => !fresh.includes(k));
    console.log(`  ${theme}: fresh ${fresh.length} keys, after a round trip ${cycled.length}`);
    if (gained.length) console.log(`     MISSING on a cold start: ${gained.join(', ')}`);
    await p.close();
  }
  await b.close();
})();
