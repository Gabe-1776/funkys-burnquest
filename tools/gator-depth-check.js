// The fit probe said "GATOR not found on screen" - which is NOT evidence either
// way. It only sampled o.visible meshes, and the gator's river was rows 1..5
// while the camera follows the frog at row 36, so inWindow() almost certainly
// culled it. But the failure that matters looks identical in such a check: at
// -0.04 earlier tonight the gator sank UNDER the opaque water and was invisible.
// So read the mesh regardless of visibility and report y, bbox and the flag
// separately.
//
// ONE browser, foreground. Usage: node tools/gator-depth-check.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 140)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(900);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(5000);

  const out = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const S = window.BurnQuestSim || window.Sim;
    const read = () => {
      let hit = null;
      window.__scene && window.__scene.traverse(o => {
        if (o.userData && o.userData.kind === 'gator') {
          const b = new window.THREE.Box3().setFromObject(o);
          hit = { visible: o.visible, posY: +o.position.y.toFixed(3),
                  minY: +b.min.y.toFixed(3), maxY: +b.max.y.toFixed(3),
                  hasModel: !!o.userData.model };
        }
      });
      const st = S.getState();
      const gz = st.hazards.find(h => h.kind === 'gator');
      return { mesh: hit, simRow: gz ? +gz.y.toFixed(2) : null,
               river: gz ? gz.swimLo + '..' + gz.swimHi : null, frogRow: st.frog.y };
    };
    const first = read();
    // walk the frog toward the river so the camera brings the gator into the
    // window; deaths are fine, the camera is the point
    for (let i = 0; i < 300; i++) {
      const st = S.getState();
      if (!S.isRunning()) break;
      const gz = st.hazards.find(h => h.kind === 'gator');
      if (gz && Math.abs(st.frog.y - gz.y) < 6) break;
      S.moveFrog(0, -1);
      await sleep(40);
    }
    await sleep(800);
    return { atStart: first, nearRiver: read() };
  });

  const show = (tag, r) => {
    const m = r.mesh;
    console.log(`${tag}: simRow ${r.simRow} river ${r.river} frogRow ${r.frogRow}`);
    if (!m) { console.log(`   mesh: NOT IN SCENE`); return; }
    console.log(`   mesh visible=${m.visible} model=${m.hasModel} posY=${m.posY} ` +
                `body ${m.minY}..${m.maxY}  water rides ~0.10  ` +
                `above water=${(m.maxY - 0.10).toFixed(3)}`);
  };
  show('AT START ', out.atStart);
  show('NEAR RIVER', out.nearRiver);
  await page.screenshot({ path: 'test-shots/gator-depth.png' });
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
