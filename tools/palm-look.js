// Are the palms the right size now? They sit outside the playable columns on
// sceneryGroup so they cannot block a lane, but at 2.5x their old size the
// fronds could intrude at the top of the frame. Look, do not theorise.
//
// Serves the LOCAL tree so the change can be seen before it is deployed.
// ONE browser, foreground. Usage: node tools/palm-look.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 140)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(1000);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(5000);            // let the palm GLB land

  const geo = await page.evaluate(() => {
    const out = { palms: 0, heights: [], tallest: 0 };
    if (!window.__scene) return 'no scene';
    window.__scene.traverse(o => {
      // scenery palms are the group's direct children
      if (o.parent && o.parent.type === 'Group' && o.type === 'Group' && o.children.length) {
        const b = new window.THREE.Box3().setFromObject(o);
        const h = b.max.y - b.min.y;
        if (h > 3 && h < 12) { out.palms++; out.heights.push(+h.toFixed(2)); out.tallest = Math.max(out.tallest, +h.toFixed(2)); }
      }
    });
    out.heights = out.heights.slice(0, 8);
    return out;
  });
  console.log('PALMS:', JSON.stringify(geo));
  await page.screenshot({ path: 'test-shots/palms-new.png' });
  console.log('shot: test-shots/palms-new.png');
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
