// No GLB may be downloaded more than once.
//
// glb-assets.js keeps a promise map (pending) and a parsed map (templateCache).
// loadTemplate consulted only the promise map, which dedupes callers that
// arrive DURING a load but not after it - so any asset requested again by a
// later buildBoard (theme swap, column change) was re-fetched, re-parsed and
// re-uploaded to the GPU. Measured on the live site before the fix:
// palm.glb x2 and portal-frame.glb x2, about 6.8MB of pointless traffic.
//
// This drives a real theme switch, which is what triggered it.
//
// Usage: node tools/asset-fetch-check.js [--url URL]
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  const glbs = [];
  p.on('response', r => {
    const u = r.url();
    // Key on the PATH, not the basename: fv/turtle.glb and diorama/turtle.glb
    // are different files that happen to share a name, and counting by
    // basename reported every cross-theme asset as a duplicate.
    if (/\.glb(\?|$)/i.test(u)) {
      glbs.push(u.split('/').slice(-2).join('/').split('?')[0]);
    }
  });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4500);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(500);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(9000);

  // Theme switch rebuilds the board - the path that exposed the duplicate.
  await p.evaluate(() => {
    const n = window.Render3D.themeNames();
    window.Render3D.setTheme(n[(n.indexOf(window.Render3D.getTheme()) + 1) % n.length]);
  });
  await p.waitForTimeout(9000);
  // ...and back again.
  await p.evaluate(() => {
    const n = window.Render3D.themeNames();
    window.Render3D.setTheme(n[(n.indexOf(window.Render3D.getTheme()) + 1) % n.length]);
  });
  await p.waitForTimeout(9000);
  await b.close();

  const count = {};
  glbs.forEach(g => { count[g] = (count[g] || 0) + 1; });
  const dupes = Object.entries(count).filter(([, n]) => n > 1);
  const bytesish = dupes.length;
  console.log(`  distinct GLBs fetched: ${Object.keys(count).length}`);
  console.log(`  total GLB requests   : ${glbs.length}`);
  if (dupes.length) {
    dupes.sort((a, b) => b[1] - a[1]).forEach(([g, n]) => console.log(`    ${g} x${n}`));
  }
  console.log(dupes.length
    ? `\nFAIL: ${bytesish} asset(s) fetched more than once - the template cache is being missed`
    : '\nPASS: every GLB fetched exactly once, across two theme switches');
  process.exit(dupes.length ? 1 : 0);
})();
