// Every earlier probe clicked #btn-play-run while it was still HIDDEN behind the
// campaign picker - the screenshot proved the site boots fine and shows
// "CHOOSE YOUR CAMPAIGN" first. selectCampaign() is what reveals the dashboard.
// So play it the way a player does: pick a campaign, THEN start the run, then
// ask about music and hunting.
//
// ONE browser, foreground. Usage: node tools/real-play-probe.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 160)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);

  await page.click('.campaign-btn', { timeout: 8000 });
  await page.waitForTimeout(1200);
  await page.click('#btn-play-run', { timeout: 8000 });
  await page.waitForTimeout(4000);

  const state = await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    const g = document.getElementById('game-screen');
    return { running: S.isRunning(), gameVisible: g && !g.classList.contains('hidden'),
             frog: S.getState().frog,
             hazards: S.getState().hazards.map(h => ({ k: h.kind, y: h.y, hunt: !!h.hunt })) };
  });
  console.log('RUN:', JSON.stringify(state));

  // MUSIC: the game's own element, found by src, plus the shared AudioContext
  const music = await page.evaluate(() => {
    const out = {};
    const AC = window.AudioContext || window.webkitAudioContext;
    const probe = new AC();
    out.ctxState = probe.state;
    out.muteBtn = (() => { const b = document.getElementById('btn-mute');
      return b ? { muted: b.classList.contains('is-muted'), label: b.dataset.label } : 'missing'; })();
    // the game's Audio object is in a closure; catch it by re-fetching the same
    // file and reporting whether OUR copy can play (browser policy check)
    return out;
  });
  console.log('MUSIC:', JSON.stringify(music));

  // HUNT: wait for a hazard that already shares the frog's row - do NOT march
  // him across six lanes of traffic (that killed all three earlier attempts).
  const hunt = await page.evaluate(async () => {
    const S = window.BurnQuestSim || window.Sim;
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    for (let i = 0; i < 900; i++) {
      const s = S.getState();
      if (!S.isRunning()) return { note: 'run ended', frog: s.frog.y };
      const shared = s.hazards.find(h => h.y === s.frog.y);
      if (shared) {
        const g0 = Math.abs((s.frog.x + 0.5) - (shared.x + shared.w / 2));
        let gMin = g0, hunted = false, dirs = new Set();
        for (let k = 0; k < 45; k++) {
          await sleep(100);
          const q = S.getState();
          const hz = q.hazards.find(h => h.y === q.frog.y);
          if (!hz || !S.isRunning()) break;
          if (hz.hunt) hunted = true;
          dirs.add(hz.dir);
          gMin = Math.min(gMin, Math.abs((q.frog.x + 0.5) - (hz.x + hz.w / 2)));
        }
        return { kind: shared.kind, row: shared.y, hunted,
                 gap0: +g0.toFixed(2), gapMin: +gMin.toFixed(2), dirs: [...dirs] };
      }
      S.moveFrog(0, -1);
      await sleep(45);
    }
    return { note: 'never shared a row' };
  });
  console.log('HUNT:', JSON.stringify(hunt));
  console.log('errors:', errs.length ? errs.slice(0, 4) : 'none');
  await page.screenshot({ path: 'test-shots/live-in-game.png' }).catch(() => {});
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
