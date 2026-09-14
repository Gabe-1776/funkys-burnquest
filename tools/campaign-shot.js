// Campaign picker + dashboard header: the real token coins, and the guarantee
// that a missing file degrades to the old emoji instead of a broken-image box.
// Usage: node tools/campaign-shot.js
const { chromium } = require('playwright');
const debugURL = require('./lib/debug-url');
const URL = debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1100, height: 820 }, deviceScaleFactor: 2 });
  const missing = [];
  p.on('response', r => { if (r.url().includes('/assets/coins/') && r.status() >= 400) missing.push(r.url()); });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.screenshot({ path: 'test-shots/campaign-select.png' });

  // Every coin must have decoded - a 200 that is not an image still renders
  // as a broken box, so check naturalWidth, not the HTTP status.
  const coins = await p.evaluate(() => Array.from(document.querySelectorAll('.campaign-btn .coin img'))
    .map(i => ({ src: i.getAttribute('src'), w: i.naturalWidth })));

  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(600);
  await p.screenshot({ path: 'test-shots/campaign-dashboard.png' });
  const dashOk = await p.evaluate(() => {
    const i = document.querySelector('#dash-icon img');
    return !!i && i.naturalWidth > 0;
  });
  await b.close();

  const broken = coins.filter(c => !c.w);
  console.log(`  coins rendered      ${coins.length - broken.length}/${coins.length}`);
  console.log(`  dashboard coin      ${dashOk ? 'ok' : 'FAIL'}`);
  console.log(`  http failures       ${missing.length ? missing.join(', ') : 'none'}`);
  const fails = [];
  if (coins.length !== 9) fails.push(`expected 9 coins, found ${coins.length}`);
  if (broken.length) fails.push(`did not decode: ${broken.map(c => c.src).join(', ')}`);
  if (!dashOk) fails.push('dashboard header coin missing');
  console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nPASS: all nine coins render');
  process.exit(fails.length ? 1 : 0);
})();
