// A theme must render identically on a COLD START and after toggling away and
// back. COLORS is one shared object every theme merges into, so a theme that
// omits a key inherits whatever the previously loaded theme left there - and on
// a cold start inherits nothing. Measured before the fix: diorama shipped 9
// keys and borrowed the other 18 from funkyverse, so a fresh diorama load drew
// the ground and water with undefined colours while a toggle "fixed" them.
//
// Compares the PALETTE rather than screen pixels: the board keeps moving, so a
// pixel diff reports the traffic, not the theme.
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch();
  let fail = false;
  const names = ['funkyverse', 'diorama'];
  for (const theme of names) {
    const p = await b.newPage({ viewport: { width: 1000, height: 700 } });
    await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${theme}`, { waitUntil: 'load' });
    await p.waitForTimeout(3500);
    const fresh = await p.evaluate(() => {
      const c = window.__COLORS || {};
      return Object.keys(c).sort().map(k => k + ':' + c[k]);
    });
    await p.evaluate(() => { const n = window.Render3D.themeNames(), c = window.Render3D.getTheme();
                             window.Render3D.setTheme(n.find(x => x !== c)); });
    await p.waitForTimeout(1200);
    await p.evaluate(t => window.Render3D.setTheme(t), theme);
    await p.waitForTimeout(1200);
    const cycled = await p.evaluate(() => {
      const c = window.__COLORS || {};
      return Object.keys(c).sort().map(k => k + ':' + c[k]);
    });
    const missing = cycled.filter(k => !fresh.includes(k));
    const ok = missing.length === 0 && fresh.length === cycled.length;
    if (!ok) fail = true;
    console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${theme}: ${fresh.length} keys cold, ${cycled.length} after a round trip`);
    if (missing.length) console.log(`        differs on a cold start: ${missing.join(', ')}`);
    await p.close();
  }
  await b.close();
  console.log(fail ? '\nFAIL: a theme depends on load order' : '\nPASS: both themes are order-independent');
  process.exit(fail ? 1 : 0);
})();
