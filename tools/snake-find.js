// "samples 0 / peak 0.000 / FITS its row" is a MEANINGLESS green: the fit probe
// only sampled o.visible meshes, so a culled snake and a snake that failed to
// build look identical. Read every snake node regardless of visibility and
// report presence, the visible flag, the applied scale and the bbox - so
// "culled by distance" can be told apart from "my scale change broke it".
//
// ONE browser, foreground. Usage: node tools/snake-find.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1000, height: 720 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 160)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);
  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(900);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(6000);              // let the GLBs land

  const out = await page.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const S = window.BurnQuestSim || window.Sim;
    const scan = () => {
      const found = [];
      window.__scene && window.__scene.traverse(o => {
        if (o.userData && o.userData.kind === 'snake') {
          const b = new window.THREE.Box3().setFromObject(o);
          const m = o.userData.model;
          found.push({
            visible: o.visible,
            hasModel: !!m,
            modelScale: m ? m.scale.toArray().map(v => +v.toFixed(2)) : null,
            across: +(b.max.z - b.min.z).toFixed(3),
            along: +(b.max.x - b.min.x).toFixed(3),
            height: +(b.max.y - b.min.y).toFixed(3),
          });
        }
      });
      const st = S.getState();
      return { found, frogRow: st.frog.y,
               simSnakes: st.hazards.filter(h => h.kind === 'snake').map(h => ({ y: h.y, w: h.w })) };
    };
    const first = scan();
    // sample the peak across several slither cycles, visibility irrelevant
    let peak = 0, along = 0, height = 0, n = 0;
    for (let i = 0; i < 80; i++) {
      await sleep(100);
      const s = scan();
      s.found.forEach(f => {
        if (f.across > peak) peak = f.across;
        along = Math.max(along, f.along);
        height = Math.max(height, f.height);
        n++;
      });
    }
    return { first, peak, along, height, samples: n };
  });

  const f = out.first;
  console.log('sim snakes:', JSON.stringify(f.simSnakes), 'frog row:', f.frogRow);
  console.log('snake nodes in scene:', f.found.length ? JSON.stringify(f.found) : 'NONE');
  if (!f.found.length) {
    console.log('VERDICT: no snake node at all -> the scale change likely broke instancing');
  } else if (out.samples === 0) {
    console.log('VERDICT: node exists but never sampled');
  } else {
    console.log(`MEASURED over ${out.samples} samples: across ${out.peak.toFixed(3)} ` +
                `(row is 1.0), along ${out.along.toFixed(3)} ` +
                `(hitbox w ${f.simSnakes[0] ? f.simSnakes[0].w : '?'}), height ${out.height.toFixed(3)}`);
    console.log(out.peak <= 1.0 ? 'FITS its row' : 'OVERHANGS by ' + (out.peak - 1).toFixed(3));
  }
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
