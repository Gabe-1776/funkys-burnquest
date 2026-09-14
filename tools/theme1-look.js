// Theme 1: are the hunters real models now, is the grey car gone, and what is
// actually going on with those car windows?
//
// Four theories have been discarded from static inspection alone (missing file,
// blanket tint, alpha dithering, double-sided panes). Look at the live scene
// instead: read each car's material flags and take a picture.
//
// ONE browser, foreground. Usage: node tools/theme1-look.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const BASE = arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/';
const debugURL = require('./lib/debug-url');
const URL = debugURL(BASE + (BASE.includes('?') ? '&' : '?') + 'theme=diorama&render=3d');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1100, height: 780 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 140)));
  const failed = [];
  page.on('requestfailed', r => failed.push(r.url().split('/').pop()));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(900);

  const themed = 'via ?theme=diorama (pickTheme honours it first)';
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(7000);            // let the GLBs land

  const out = await page.evaluate(() => {
    const cars = [], hazards = [];
    const seen = new Set();
    window.__scene && window.__scene.traverse(o => {
      const k = o.userData && o.userData.kind;
      if (k !== 'car' && k !== 'snake' && k !== 'bird' && k !== 'gator') return;
      const rec = { kind: k, hasModel: !!o.userData.model, mats: [] };
      o.traverse(c => {
        if (!c.isMesh || !c.material) return;
        const list = Array.isArray(c.material) ? c.material : [c.material];
        list.forEach(m => {
          const sig = `${k}|${m.name || '-'}|${!!m.map}|${m.side}|${m.transparent}|${m.depthWrite}`;
          if (seen.has(sig)) return;
          seen.add(sig);
          rec.mats.push({ name: m.name || '(unnamed)', map: !!m.map, side: m.side,
                          transparent: !!m.transparent, depthWrite: m.depthWrite !== false,
                          vertexColors: !!m.vertexColors,
                          color: m.color ? '#' + m.color.getHexString() : null });
        });
      });
      if (rec.mats.length) (k === 'car' ? cars : hazards).push(rec);
    });
    const S = window.BurnQuestSim || window.Sim;
    let themeNow = 'unknown';
    try { themeNow = new URLSearchParams(location.search).get('theme') || 'unknown'; } catch (e) {}
    return { theme: themeNow,
             cars: cars.slice(0, 4), hazards,
             simHazards: S ? S.getState().hazards.map(h => h.kind) : null };
  });

  console.log('==== THEME RENDERED:', out.theme, '====', themed);
  console.log('sim hazards:', JSON.stringify(out.simHazards));
  console.log('HAZARDS drawn:', out.hazards.map(h =>
    `${h.kind}:${h.hasModel ? 'MODEL' : 'placeholder'}${h.mats[0] ? '(map=' + h.mats[0].map + ')' : ''}`).join('  ') || 'none');
  console.log('CARS:', out.cars.map((c, i) =>
    `#${i} model=${c.hasModel} ` + c.mats.map(m =>
      `[map=${m.map} side=${m.side} transp=${m.transparent} depthW=${m.depthWrite} col=${m.color}]`).join('')).join('\n      '));
  console.log('request failures:', failed.length ? failed.slice(0, 6) : 'none');
  await page.screenshot({ path: 'test-shots/theme1-now.png' });
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
