// WHY is there no music? Both earlier attempts measured the wrong thing:
// counting <audio> DOM nodes (the game uses new Audio(), never DOM) and probing
// a guessed GameAudio.ctx property. game.js:176 does play().catch(() => {}),
// which DISCARDS the reason, and audio.js keeps its AudioContext module-private
// (line 17) - a context built before a user gesture starts suspended.
//
// So: create our own Audio on the same file and try to play it both before and
// after a real gesture, and read any AudioContext state we can reach.
// ONE browser, foreground. Usage: node tools/music-why.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'https://funkyburnquest.project-testing.xyz/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', e => console.log('PAGEERROR', e.message.slice(0, 160)));
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);

  // trap AudioContext construction so we can see the state audio.js gets
  const before = await page.evaluate(async () => {
    const a = new Audio('assets/audio/tatamusic-chiptune-video-game-games-music-552833.mp3');
    a.volume = 0.4;
    let verdict;
    try { await a.play(); verdict = 'PLAYED (no gesture needed)'; a.pause(); }
    catch (e) { verdict = 'REJECTED: ' + e.name + ' - ' + e.message.slice(0, 90); }
    const AC = window.AudioContext || window.webkitAudioContext;
    const probe = new AC();
    return { verdict, ctxStateNoGesture: probe.state, readyState: a.readyState };
  });
  console.log('BEFORE GESTURE:', JSON.stringify(before));

  // a REAL click (trusted event), the way a player starts a run
  await page.click('#btn-play-run').catch(() => {});
  await page.waitForTimeout(4000);

  const after = await page.evaluate(async () => {
    const a = new Audio('assets/audio/tatamusic-chiptune-video-game-games-music-552833.mp3');
    a.volume = 0.4;
    let verdict;
    try { await a.play(); verdict = 'PLAYED'; a.pause(); }
    catch (e) { verdict = 'REJECTED: ' + e.name + ' - ' + e.message.slice(0, 90); }
    const AC = window.AudioContext || window.webkitAudioContext;
    const probe = new AC();
    const S = window.BurnQuestSim || window.Sim;
    return { verdict, ctxStateAfterGesture: probe.state,
             running: S && S.isRunning ? S.isRunning() : null,
             readyState: a.readyState };
  });
  console.log('AFTER  GESTURE:', JSON.stringify(after));

  // corrected hunt check: do NOT march across traffic. Read the flag from a
  // hazard that ALREADY shares the frog's row, wandering only sideways.
  const hunt = await page.evaluate(async () => {
    const S = window.BurnQuestSim || window.Sim;
    if (!S || !S.isRunning()) return 'run not active';
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    let seen = null;
    for (let i = 0; i < 600; i++) {
      const s = S.getState();
      const shared = s.hazards.find(h => h.y === s.frog.y);
      if (shared) {
        const g0 = Math.abs((s.frog.x + 0.5) - (shared.x + shared.w / 2));
        let gMin = g0, hunted = false;
        for (let k = 0; k < 40; k++) {
          await sleep(100);
          const q = S.getState();
          const hz = q.hazards.find(h => h.y === q.frog.y);
          if (!hz) break;
          if (hz.hunt) hunted = true;
          gMin = Math.min(gMin, Math.abs((q.frog.x + 0.5) - (hz.x + hz.w / 2)));
        }
        seen = { kind: shared.kind, row: shared.y, hunted,
                 gap0: +g0.toFixed(2), gapMin: +gMin.toFixed(2) };
        break;
      }
      S.moveFrog(0, -1);
      await sleep(40);
      if (!S.isRunning()) return { note: 'died before sharing a row' };
    }
    return seen || { note: 'never shared a row' };
  });
  console.log('HUNT:', JSON.stringify(hunt));
  await browser.close();
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
