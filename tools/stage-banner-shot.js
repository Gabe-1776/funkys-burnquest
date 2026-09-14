// The stage change as a PLAYER sees it: the HUD switches to STAGE 2, the
// banner appears, and the run keeps going underneath it.
//
// The walk is driven through Sim directly (the browser cannot be trusted to
// play well enough to clear a board in a test), but the assertions are all on
// what game.js and the renderer did in response to the real event.
//
// Usage: node tools/stage-banner-shot.js
const { chromium } = require('playwright');
const fs = require('fs');
const debugURL = require('./lib/debug-url');
const URL = debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 });
  await p.waitForTimeout(2500);

  const before = await p.evaluate(() => ({
    stage: document.getElementById('stage-num').textContent,
    hasBurnLevelInHud: document.body.innerHTML.includes('id="level-num"'),
  }));

  // Walk to the gateway with the same sim-mirrored safety test as
  // tools/stage-check.js, but drive it from Node with REAL key presses so the
  // hop goes through game.js's own listener and the stage event reaches the
  // real handler. An earlier version ran the whole walk inside one
  // page.evaluate with synthetic KeyboardEvents; it never advanced a row and
  // burned ten minutes proving nothing.
  const safeNext = () => p.evaluate(() => {
    const S = window.Sim, EPS = 0.12;
    if (!S.isRunning()) return { dead: true };
    const st = S.getState(), fc = st.frog.x + 0.5, row = Math.round(st.frog.y);
    if (row <= 0) return { atGoal: true, row };
    const next = row - 1, cls = S.rowClass(next);
    let ok;
    if (cls === 'goal' || cls === 'median') ok = true;
    else if (cls === 'water') {
      ok = [...st.logs, ...st.turtles, ...st.lilypads].some(
        q => Math.round(q.y) === next && fc > q.x + EPS && fc < q.x + q.w - EPS);
    } else {
      ok = !st.cars.some(c => {
        if (Math.round(c.y) !== next) return false;
        const travel = c.dir * c.speed * S.CAR_RATE * 19;
        for (let k = 0; k <= 8; k++) {
          const x = c.x + travel * k / 8;
          if (fc > x + 0.18 - EPS && fc < x + c.w - 0.18 + EPS) return true;
        }
        return false;
      });
    }
    return { ok, row, stage: S.getStage() };
  });

  let result = { gaveUp: 'never cleared a board in the browser' };
  outer:
  for (let attempt = 0; attempt < 6; attempt++) {
    for (let i = 0; i < 1400; i++) {
      const s = await safeNext();
      if (s.dead) break;
      if (s.stage > 1) { result = { advanced: true }; break outer; }
      if (s.ok) await p.keyboard.press('ArrowUp');
      else await p.waitForTimeout(24);
    }
    const again = await p.evaluate(() => window.Sim.isRunning());
    if (!again) {
      await p.locator('#btn-play-run').click({ timeout: 30000 }).catch(() => {});
      await p.waitForTimeout(1500);
    }
  }

  let shot = 'not taken';
  if (result.advanced) {
    await p.waitForTimeout(500);
    const cdp = await p.context().newCDPSession(p);
    const r = await cdp.send('Page.captureScreenshot',
                             { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync('test-shots/stage-banner.png', Buffer.from(r.data, 'base64'));
    shot = 'test-shots/stage-banner.png';
  }

  const after = await p.evaluate(() => ({
    stage: document.getElementById('stage-num').textContent,
    simStage: window.Sim.getStage(),
    running: window.Sim.isRunning(),
    bannerVisible: !document.getElementById('stage-banner').classList.contains('hidden'),
    bannerName: document.querySelector('#stage-banner .stage-banner-name').textContent,
    score: window.Sim.getState().score,
    lives: window.Sim.getState().lives,
  }));
  await b.close();

  const fails = [];
  if (!result.advanced) fails.push(result.gaveUp);
  else {
    if (after.stage !== '2') fails.push(`HUD reads STAGE ${after.stage}, expected 2`);
    if (after.simStage !== 2) fails.push('sim did not advance');
    if (!after.running) fails.push('the run ended instead of continuing');
    if (!after.bannerVisible) fails.push('stage banner never shown');
    if (!/STAGE 2/.test(after.bannerName)) fails.push(`banner says "${after.bannerName}"`);
  }
  if (before.hasBurnLevelInHud) fails.push('the old LEVEL readout is still in the HUD');

  console.log(`  HUD before          STAGE ${before.stage}`);
  console.log(`  HUD after           STAGE ${after.stage} (sim ${after.simStage})`);
  console.log(`  run continues       ${after.running ? 'ok' : 'FAIL'}`);
  console.log(`  banner              ${after.bannerVisible ? after.bannerName : 'not shown'}`);
  console.log(`  carried             score ${after.score}, ${after.lives} lives`);
  console.log(`  still shot          ${shot}`);
  console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nPASS: stage 2 begins in the browser and the run continues');
  process.exit(fails.length ? 1 : 0);
})();
