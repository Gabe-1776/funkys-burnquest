// Desktop keyboard input check. Instruments Sim.moveFrog in-page (the call is
// made from the game loop, so the trace is recorded inside the loop per the
// no-external-sampling rule) and drives real KeyboardEvents through the window
// listener. Asserts:
//   1. one tap = one hop
//   2. a tap inside the 190ms rate gate BUFFERS and lands when the gate opens
//   3. up+right pressed ~20ms apart = ONE diagonal hop
//   4. holding a key = exactly one hop (no machine-gun)
//   5. synthetic key-repeat = zero extra hops
// Headless renders far below 10fps under load, so every step waits on hop
// CALLS via waitForFunction - never on fixed wall-clock sleeps. Lateral hops
// keep the frog on the safe start row; the diagonal test is the only upward
// move and is checked immediately.
//
// ONE browser, foreground. Usage: node tools/keyboard-input-check.js [--url URL]
const { chromium } = require('playwright');
const arg = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg > 0 ? process.argv[arg + 1] : 'http://localhost:8099/');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  const errs = [];
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message.slice(0, 180)));
  page.on('console', m => { if (m.type() === 'error') errs.push('CONSOLE ' + m.text().slice(0, 180)); });
  await page.goto(URL, { waitUntil: 'load', timeout: 90000 });
  await page.waitForTimeout(2500);

  await page.click('.campaign-btn', { timeout: 10000 });
  await page.click('#btn-play-run', { timeout: 5000, noWaitAfter: true })
    .catch(() => page.evaluate(() => document.getElementById('btn-play-run').click()));
  await page.waitForFunction(() => {
    const S = window.BurnQuestSim || window.Sim;
    return S.isRunning && S.isRunning();
  }, null, { timeout: 20000 });
  await page.waitForTimeout(500);

  await page.evaluate(() => {
    const S = window.BurnQuestSim || window.Sim;
    window.__hopTrace = [];
    const orig = S.moveFrog;
    S.moveFrog = function (dx, dy) {
      const b = S.getState().frog;
      const ev = orig(dx, dy);
      const a = S.getState().frog;
      window.__hopTrace.push({ t: performance.now(), dx, dy,
        moved: a.x !== b.x || a.y !== b.y });
      return ev;
    };
    window.__tap = (code, ms = 30) => new Promise(res => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      setTimeout(() => { window.dispatchEvent(new KeyboardEvent('keyup', { code })); res(); }, ms);
    });
    window.__tapRepeat = code => {
      window.dispatchEvent(new KeyboardEvent('keydown', { code }));
      window.dispatchEvent(new KeyboardEvent('keydown', { code, repeat: true }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code }));
    };
    window.__moved = () => window.__hopTrace.filter(h => h.moved).length;
    window.__keys = [];
    window.addEventListener('keydown', e => window.__keys.push(
      { code: e.code, rep: e.repeat, t: performance.now() }));
    window.__keys.length = 0;
    window.__trace = () => {
      const tr = window.__hopTrace.slice();
      const keys = window.__keys.slice();
      window.__hopTrace.length = 0;
      window.__keys.length = 0;
      return { trace: tr, keys, running: S.isRunning(), paused: S.isPaused && S.isPaused() };
    };
    window.__frog = () => { const f = S.getState().frog; return { x: f.x, y: f.y }; };
  });

  const results = [];
  const waitMoved = (n, ms) => page.waitForFunction(
    k => window.__moved() >= k, n, { timeout: ms }).then(() => true).catch(() => false);

  // --- 1. single tap = one hop (lateral, safe row) ------------------------
  await page.evaluate(() => window.__trace());
  await page.evaluate(() => window.__tap('ArrowLeft'));
  const got1 = await waitMoved(1, 8000);
  let r = await page.evaluate(() => window.__trace());
  let moved = r.trace.filter(h => h.moved);
  results.push(['1 tap -> 1 hop', got1 && moved.length === 1 && moved[0].dx === -1,
    { moved, keys: r.keys, running: r.running }]);

  // --- 2. tap inside the rate gate buffers, then lands --------------------
  await page.evaluate(() => window.__trace());
  await page.evaluate(() => window.__tap('ArrowRight'));
  await waitMoved(1, 8000);
  await page.waitForTimeout(50);             // still inside the 190ms gate
  await page.evaluate(() => window.__tap('ArrowRight'));
  const got2 = await waitMoved(2, 8000);     // buffered press must land
  r = await page.evaluate(() => window.__trace());
  moved = r.trace.filter(h => h.moved);
  results.push(['mid-gate tap buffered -> 2 hops', got2 && moved.length === 2,
    { moved: moved.length, calls: r.trace.length, keys: r.keys }]);

  // --- 3. up+right ~20ms apart = ONE diagonal hop --------------------------
  await page.evaluate(() => window.__trace());
  // Both keydowns in one dispatch: headless setTimeout throttles seconds-late,
  // so a staggered pair cannot be produced here. Synchronous lands both in the
  // tapped set before the next poll - the same state a real <40ms pair creates.
  await page.evaluate(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowUp' }));
    window.dispatchEvent(new KeyboardEvent('keydown', { code: 'ArrowRight' }));
    setTimeout(() => {
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowUp' }));
      window.dispatchEvent(new KeyboardEvent('keyup', { code: 'ArrowRight' }));
    }, 120);
  });
  const gotD = await waitMoved(1, 8000);
  await page.waitForTimeout(300);
  r = await page.evaluate(() => window.__trace());
  moved = r.trace.filter(h => h.moved);
  // The committed call's direction is authoritative - the frog's live position
  // is not (a death/respawn on the landing row rewrites it within the wait).
  const diagOk = moved.length === 1 && moved[0].dx === 1 && moved[0].dy === -1;
  results.push(['up+right -> 1 diagonal hop', gotD && diagOk,
    { moved, keys: r.keys }]);

  // --- 4. hold key = exactly one hop --------------------------------------
  await page.waitForTimeout(500);            // frog may have respawned; let gate open
  await page.evaluate(() => window.__trace());
  await page.evaluate(() => window.dispatchEvent(
    new KeyboardEvent('keydown', { code: 'ArrowLeft' })));
  const gotH = await waitMoved(1, 8000);
  await page.waitForTimeout(600);            // keep holding - must not re-hop
  await page.evaluate(() => window.dispatchEvent(
    new KeyboardEvent('keyup', { code: 'ArrowLeft' })));
  r = await page.evaluate(() => window.__trace());
  moved = r.trace.filter(h => h.moved);
  results.push(['hold -> 1 hop only', gotH && moved.length === 1,
    { moved: moved.length, keys: r.keys }]);

  // --- 5. synthetic repeat = no extra hop ---------------------------------
  await page.waitForTimeout(400);
  await page.evaluate(() => window.__trace());
  await page.evaluate(() => window.__tapRepeat('ArrowLeft'));
  const gotR = await waitMoved(1, 8000);
  await page.waitForTimeout(300);
  r = await page.evaluate(() => window.__trace());
  moved = r.trace.filter(h => h.moved);
  results.push(['key-repeat -> 1 hop only', gotR && moved.length === 1,
    { moved: moved.length, keys: r.keys }]);

  let fail = 0;
  for (const [name, ok, detail] of results) {
    console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + '  ' + JSON.stringify(detail));
    if (!ok) fail++;
  }
  console.log('errors:', errs.length ? errs.slice(0, 5) : 'none');
  await browser.close();
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error('PROBE FAILED', e.message); process.exit(1); });
