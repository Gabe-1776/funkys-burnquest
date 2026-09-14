// What Gabriel reported, checked in a REAL browser against the deployed site:
// music, the snake's girth, the bird's height, and whether hazards hunt.
// My earlier evidence for these was headless-sim or arithmetic, which is how I
// ended up telling him things worked when he could not see them.
//
// ONE browser, foreground. Usage: node tools/live-probe.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errors = [], warnings = [], failed = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text().slice(0, 200));
    if (m.type() === 'warning') warnings.push(m.text().slice(0, 160));
  });
  page.on('pageerror', e => errors.push('PAGEERROR ' + e.message.slice(0, 200)));
  page.on('requestfailed', r => failed.push(r.url().split('/').pop() + ' :: ' + (r.failure() || {}).errorText));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(3500);

  // start a run the way a player does: click, so autoplay policy is satisfied
  const started = await page.evaluate(async () => {
    const btn = document.getElementById('btn-play-run');
    if (!btn) return 'no play button';
    btn.click();
    return 'clicked';
  });
  await page.waitForTimeout(6000);

  const out = await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    const st = S && S.getState ? S.getState() : null;
    const r = window.__renderer || null;
    // find the hazard meshes through the scene graph
    const found = [];
    if (window.__scene) {
      window.__scene.traverse(o => {
        if (o.userData && o.userData.kind) {
          const box = new window.THREE.Box3().setFromObject(o);
          found.push({ kind: o.userData.kind, hasModel: !!o.userData.model,
                       y: +o.position.y.toFixed(3),
                       w: +(box.max.z - box.min.z).toFixed(3),
                       len: +(box.max.x - box.min.x).toFixed(3),
                       h: +(box.max.y - box.min.y).toFixed(3),
                       scale: o.userData.model ? o.userData.model.scale.toArray().map(v => +v.toFixed(2)) : null });
        }
      });
    }
    const audio = document.querySelectorAll('audio');
    return {
      running: S && S.isRunning ? S.isRunning() : null,
      theme: (document.body && document.body.dataset && document.body.dataset.theme) || 'n/a',
      hazards: st ? st.hazards.map(h => ({ kind: h.kind, y: h.y, hunt: !!h.hunt })) : null,
      frogRow: st ? st.frog.y : null,
      meshes: found,
      audioTags: audio.length,
      sceneExposed: !!window.__scene,
    };
  });

  console.log('started:', started, '| running:', out.running, '| theme:', out.theme);
  console.log('scene exposed:', out.sceneExposed, '| <audio> tags:', out.audioTags);
  console.log('hazard meshes:', JSON.stringify(out.meshes, null, 1));
  console.log('sim hazards:', JSON.stringify(out.hazards));
  console.log('frog row:', out.frogRow);
  console.log('request failures:', failed.length ? failed : 'none');
  console.log('console errors:', errors.length ? errors.slice(0, 6) : 'none');
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
