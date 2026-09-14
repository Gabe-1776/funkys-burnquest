// Does the shrink-into-the-portal actually PLAY when a stage is cleared?
//
// Gabriel (2026-09-11): "the animations didnt work the character shrinking and
// going in the portal". Two causes, both asserted here:
//   1. game.js only called celebrate() on 'finish' - after stage 5, which
//      almost no run reaches. A 'stage' clear went straight to the banner.
//   2. Even when celebrating, the sim has already rebuilt the board on a stage
//      clear, so the renderer saw a 36-row "teleport" and cut the camera to
//      the start: the draw-in would have played off-screen.
//
// REAL INPUT ONLY. The goal check lives inside Sim.moveFrog, so its 'stage'
// event reaches the game only through handleMove - calling Sim.moveFrog from
// the page would swallow the event and prove nothing. The walker reads the
// board to DECIDE (stage-check.js's predicates, from the sim's own collision
// rule) and then presses a real key.
//
// UNPROVEN (2026-09-11). In CPU-rendered headless chromium (~10fps) the walker
// never cleared a board in 6 minutes, on the new build or the pre-fix one, so
// this has neither passed nor meaningfully failed. And running two of these at
// once drove load to 17 and hard-reset Gabriel's fanless MacBook. Only run it
// ALONE, on a GPU-backed browser; see AGENTS.md "Traps".
//
// Usage: node tools/portal-stage-check.js [--url URL]
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));
const WALK_BUDGET_MS = 6 * 60 * 1000;

let passed = 0, failed = 0;
const test = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failed++; }
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  p.on('pageerror', e => console.log('        pageerror: ' + e.message));
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForFunction(() => window.__frogRig && window.Sim && Sim.isRunning(),
                          null, { timeout: 90000 });

  // ---- walk to the gate ---------------------------------------------------
  // The decision runs in the page against the live sim; the MOVE is a key.
  const decide = () => p.evaluate(() => {
    const EPS = 0.12, LOOK = 19;          // HOP_FRAMES 13 + 6, as stage-check
    const st = Sim.getState();
    if (!Sim.isRunning()) return { key: null, why: 'not-running', stage: Sim.getStage() };
    const row = Math.round(st.frog.y);
    const fc = st.frog.x + 0.5;
    if (row <= 0) {
      const d = st.goalCol - st.frog.x;
      return { key: Math.abs(d) < 0.6 ? null : (d > 0 ? 'ArrowRight' : 'ArrowLeft'),
               why: 'goal-row', stage: Sim.getStage() };
    }
    const next = row - 1, cls = Sim.rowClass(next);
    let safe;
    if (cls === 'goal' || cls === 'median') safe = true;
    else if (cls === 'water') {
      safe = [...st.logs, ...st.turtles, ...st.lilypads].some(q =>
        Math.round(q.y) === next && fc > q.x + EPS && fc < q.x + q.w - EPS);
    } else {
      safe = !st.cars.some(c => {
        if (Math.round(c.y) !== next) return false;
        const travel = c.dir * c.speed * Sim.CAR_RATE * LOOK;
        for (let k = 0; k <= 8; k++) {
          const x = c.x + travel * k / 8;
          if (fc > x + 0.18 - EPS && fc < x + c.w - 0.18 + EPS) return true;
        }
        return false;
      });
    }
    return { key: safe ? 'ArrowUp' : null, why: cls, row, stage: Sim.getStage() };
  });

  const stage0 = await p.evaluate(() => Sim.getStage());
  const t0 = Date.now();
  let stageSeen = false, deaths = 0, lastRow = 99;
  while (Date.now() - t0 < WALK_BUDGET_MS) {
    const d = await decide();
    if (d.stage !== stage0) { stageSeen = true; break; }
    if (d.why === 'not-running') {
      // Paused by the celebration already, or a game over: tell them apart.
      if (await p.evaluate(() => Sim.isPaused())) { stageSeen = true; break; }
      deaths++;
      await p.locator('#btn-play-run').click({ timeout: 30000, force: true }).catch(() => {});
      await p.waitForTimeout(800);
      continue;
    }
    if (d.row !== undefined && d.row > lastRow + 2) deaths++;   // respawned at the start
    if (d.row !== undefined) lastRow = d.row;
    if (d.key) { await p.keyboard.press(d.key); await p.waitForTimeout(260); }
    else await p.waitForTimeout(40);
  }
  // Said "reached the gate" even when it timed out - it only means the walk ended.
  console.log(`        walked ${((Date.now() - t0) / 1000).toFixed(0)}s, stage cleared: ` +
              `${stageSeen ? 'yes' : 'NO (timed out)'}, ${deaths} deaths`);
  test('the walker reached the teleporter and a stage cleared', stageSeen,
       'never cleared the board - nothing below this line would mean anything');
  if (!stageSeen) { await b.close(); done(); return; }

  // ---- sample the celebration --------------------------------------------
  // Node-side polling: in-page timers are throttled in headless chromium, and
  // the celebration is 2.6s long, so ~100ms samples see all of it.
  const samples = [];
  const tc = Date.now();
  while (Date.now() - tc < 3400) {
    samples.push(await p.evaluate(() => {
      const rig = window.__frogRig, g = rig.parent, cam = window.__frogCam;
      const v = g.getWorldPosition(new (g.position.constructor)()).project(cam);
      const banner = document.getElementById('stage-banner');
      return { scale: rig.scale.x, ndcX: v.x, ndcY: v.y,
               running: Sim.isRunning(), paused: Sim.isPaused(),
               banner: !!(banner && !banner.classList.contains('hidden')),
               frogRow: Math.round(Sim.getState().frog.y), stage: Sim.getStage() };
    }));
    await p.waitForTimeout(90);
  }
  const minScale = Math.min(...samples.map(s => s.scale));
  const drawIn = samples.filter(s => s.scale < 0.95 && s.scale > 0.02);
  const offScreen = drawIn.filter(s => Math.abs(s.ndcX) > 1 || Math.abs(s.ndcY) > 1);
  const heldAtStart = samples.slice(0, 5).every(s => !s.running);
  const end = samples[samples.length - 1];
  console.log(`        ${samples.length} samples; smallest scale ${minScale.toFixed(3)}; ` +
              `${drawIn.length} mid-shrink, ${offScreen.length} of them off screen`);
  console.log(`        end: stage ${end.stage}, running ${end.running}, frog row ${end.frogRow}, banner ${end.banner}`);

  test('the run is held while the celebration plays', heldAtStart,
       'the sim kept running under the celebration');
  test('Funky shrinks into the portal', minScale < 0.3,
       `smallest rig scale ${minScale.toFixed(3)} - the draw-in never ran`);
  test('the shrink plays ON SCREEN', drawIn.length >= 3 && offScreen.length === 0,
       `${offScreen.length} of ${drawIn.length} mid-shrink samples were off screen (camera cut away)`);
  test('the run resumes on the next stage at the start row',
       end.running && end.stage === stage0 + 1 && end.frogRow === 36,
       `stage ${end.stage}, running ${end.running}, row ${end.frogRow}`);
  test('he is full size again for the new stage', Math.abs(end.scale - 1) < 0.05,
       `rig scale ${end.scale.toFixed(3)} after the celebration`);

  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });

function done() {
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
