// Two of Gabriel's reports that the first probe could NOT answer:
//   - music: <audio> tag counting was useless (the game uses new Audio()), so
//     read the element's own state plus the WebAudio context after a click.
//   - hunt: the first probe read hunt:false while the frog was at row 36 and
//     every hazard sat at rows 24/30/2 - nobody shared a row, so false was
//     correct and proved nothing. Walk him INTO a hazard row first.
//
// ONE browser, foreground. Usage: node tools/music-hunt-probe.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push(e.message.slice(0, 160)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(3000);
  await page.evaluate(() => { const b = document.getElementById('btn-play-run'); if (b) b.click(); });
  await page.waitForTimeout(4000);

  const music = await page.evaluate(() => {
    const out = { found: [], ctx: null, muteBtn: null };
    // the game keeps Audio objects in a closure; find them via the prototype trap
    const el = document.querySelector('audio');
    out.domAudio = !!el;
    if (window.GameAudio) {
      out.gameAudio = { exists: true, ctxState: (window.GameAudio.ctx && window.GameAudio.ctx.state) || 'n/a' };
    }
    const btn = document.getElementById('btn-mute');
    if (btn) out.muteBtn = { muted: btn.classList.contains('is-muted'), label: btn.dataset.label };
    // any AudioContext the page created
    out.ctx = window.__audioCtx ? window.__audioCtx.state : 'not exposed';
    return out;
  });
  console.log('MUSIC', JSON.stringify(music));

  // walk the frog into a hazard row, then watch the flag and the closing gap
  const hunt = await page.evaluate(async () => {
    const S = window.BurnQuestSim || window.Sim;
    if (!S) return 'no sim';
    const row = S.getState().hazards.filter(h => h.kind !== 'gator')
      .sort((a, b) => Math.abs(a.y - S.getState().frog.y) - Math.abs(b.y - S.getState().frog.y))[0];
    if (!row) return 'no grass hazard';
    const target = row.y;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 400 && S.getState().frog.y > target; i++) {
      S.moveFrog(0, -1);
      await sleep(30);
      if (!S.isRunning()) break;
    }
    const st = S.getState();
    const h = st.hazards.find(x => x.y === target);
    if (!h) return { reached: st.frog.y, target, note: 'hazard gone' };
    const gap0 = Math.abs((st.frog.x + 0.5) - (h.x + h.w / 2));
    let sawHunt = false, gapMin = gap0;
    for (let i = 0; i < 60; i++) {
      await sleep(100);
      const s = S.getState();
      const hz = s.hazards.find(x => x.y === target);
      if (!hz || s.frog.y !== target) break;
      if (hz.hunt) sawHunt = true;
      gapMin = Math.min(gapMin, Math.abs((s.frog.x + 0.5) - (hz.x + hz.w / 2)));
    }
    return { target, reachedRow: S.getState().frog.y, sawHunt,
             gap0: +gap0.toFixed(2), gapMin: +gapMin.toFixed(2) };
  });
  console.log('HUNT', JSON.stringify(hunt));
  console.log('page errors:', errs.length ? errs : 'none');
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
