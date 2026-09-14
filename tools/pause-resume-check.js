// Exercises pause/resume through the REAL UI, not the sim API: click the pause
// button, confirm the dashboard offers RESUME, click it, confirm the same run
// continues from the same row. The audit found the control abandoned the run.
const { chromium } = require('playwright');
const ui = process.argv.indexOf('--url');
const debugURL = require('./lib/debug-url');
const URL = debugURL(ui > -1 && process.argv[ui + 1]
  ? process.argv[ui + 1]
  : 'http://127.0.0.1:8099/index.html?render=3d&debug=1');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);

  let fail = false;
  const say = (ok, msg) => { console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${msg}`); if (!ok) fail = true; };

  // Advance to a MEDIAN row before pausing. Parking on a road row means the
  // frog resumes into traffic and can be hit within the assertion window, which
  // looks exactly like the run having been reset - a false failure seen on the
  // live site at row 35.
  for (let i = 0; i < 14; i++) {
    const safe = await p.evaluate(() => {
      const S = window.Sim, y = Math.round(S.getState().frog.y);
      return S.rowClass(y) === 'median' && y < S.ROWS - 1;
    });
    if (safe) break;
    await p.evaluate(() => window.Sim.moveFrog(0, -1));
    await p.waitForTimeout(330);
  }
  const before = await p.evaluate(() => window.Sim.getState().frog.y);
  const livesBefore = await p.evaluate(() => window.Sim.getState().lives);

  await p.locator('#btn-pause-game').click();
  await p.waitForTimeout(500);
  say(await p.evaluate(() => window.Sim.isPaused()), 'pause leaves the run intact');
  const label = (await p.locator('#btn-play-run').textContent()).trim();
  say(/RESUME/i.test(label), `dashboard offers resume (button reads "${label}")`);
  say(await p.locator('#btn-abandon-run').isVisible(), 'abandon is offered separately');

  await p.locator('#btn-play-run').click();
  await p.waitForTimeout(150);            // read before traffic can intervene
  const after = await p.evaluate(() => window.Sim.getState().frog.y);
  const livesAfter = await p.evaluate(() => window.Sim.getState().lives);
  say(await p.evaluate(() => window.Sim.isRunning()), 'resume restarts the loop');
  say(after === before, `same run continues (row ${before} -> ${after})`);
  // A reset would RESTORE lives to 3. Losing one to traffic during the resume
  // window is ordinary play, so the assertion is that lives never go UP.
  say(livesAfter <= livesBefore,
      `lives carried over, not reset (${livesBefore} -> ${livesAfter})`);

  // REAL KEYBOARD after resume. The harness previously moved the frog through
  // Sim.moveFrog(), which bypasses the input layer entirely - so a resume that
  // silently killed keyboard input passed every check while the game was
  // unplayable. Drive the actual keys.
  const rowPreKey = await p.evaluate(() => Math.round(window.Sim.getState().frog.y));
  let moved = false;
  for (let i = 0; i < 6 && !moved; i++) {
    await p.keyboard.press('ArrowUp');
    await p.waitForTimeout(300);
    const r = await p.evaluate(() => Math.round(window.Sim.getState().frog.y));
    if (r !== rowPreKey) moved = true;
  }
  say(moved, 'arrow keys still move the frog after a resume');

  // a fresh run after abandoning must reset
  await p.locator('#btn-pause-game').click(); await p.waitForTimeout(400);
  await p.locator('#btn-abandon-run').click(); await p.waitForTimeout(300);
  const lbl2 = (await p.locator('#btn-play-run').textContent()).trim();
  say(/PLAY/i.test(lbl2), `after abandoning, button reads "${lbl2}"`);

  await b.close();
  console.log(fail ? '\nFAIL' : '\nPASS: pause is a pause, not an abandon');
  process.exit(fail ? 1 : 0);
})();
