// Points count toward the burn only for levels the player actually PASSED.
//
// Gabriel 2026-09-11: "the points accumilated can go towards the burn after they
// pass a level ok, if they lose game before passing a level then that level
// accumilated point wont count to the burn ok".
//
// Headless, no browser. Run: node tools/burn-bank-check.js
const path = require('path');
const assert = require('assert');
const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const Sim = require(path.join(__dirname, '..', 'sim.js'));

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}
const banked = () => Sim.getCampaignData('ksto').points;

// A blind walker CANNOT clear a board: measured over five attempts it never got
// past row 27-30 of a 36-row start and was dead (lives 0) within 192-276 frames,
// scoring 0 because score comes only from pickups. So drive the seam directly -
// which is exactly how the existing banking tests in stage-layout-check.js work
// (they call Sim.finishRun() rather than playing five boards).
//
// Score is raised by collecting; to get a deterministic non-zero score the test
// walks the frog onto a spark on its own row before committing.
// Start a run and collect ONE spark, retrying across fresh boards until it
// lands. Reaching a spark is probabilistic (traffic + spark placement), so a
// `score > 0` precondition flakes ~1 run in 10 per caller; patching that per
// test just moved the flake from test 4 to tests 1 and 3. One retry policy,
// owned by the helper, and every caller gets a scored run or a clear failure.
//
// Walking: match the sim's OWN collection rule (|dx|, |dy| < 0.8) rather than
// rounded equality. Traced - with rounding, a spark whose x rounded to the
// frog's column read as "already aligned" while sitting too far away to
// collect, so neither branch fired and the frog stood still for the whole
// budget with lives 3 and the run still alive.
function startScoredRun(opts, attempts) {
  for (let a = 0; a < (attempts || 12); a++) {
    Sim.resetData(); Sim.selectCampaign('ksto');
    Sim.startRun(opts);
    for (let f = 0; f < 6000 && Sim.isRunning(); f++) {
      Sim.update(1);
      const s = Sim.getState();
      if (s.score > 0) return s.score;
      const live = (s.sparks || []).filter(x => !x.collected);
      if (!live.length) continue;
      live.sort((p, q) => (Math.abs(p.y - s.frog.y) + Math.abs(p.x - s.frog.x))
                        - (Math.abs(q.y - s.frog.y) + Math.abs(q.x - s.frog.x)));
      const t = live[0];
      if (Math.abs(t.y - s.frog.y) >= 0.8) {
        Sim.moveFrog(0, t.y < s.frog.y ? -1 : 1);
      } else if (Math.abs(t.x - s.frog.x) >= 0.8) {
        Sim.moveFrog(t.x > s.frog.x ? 1 : -1, 0);
      }
    }
  }
  return 0;
}

// --- 1. passing a level pays it in -----------------------------------------
test('clearing a stage banks that stage points', () => {
  const scored = startScoredRun({ stage: 1, practice: false });
  assert.ok(scored > 0, 'need a non-zero score to have anything to bank');
  assert.strictEqual(banked(), 0, 'nothing should be banked mid-level');
  const ev = Sim.advanceStage();
  assert.strictEqual(ev.type, 'stage');
  assert.strictEqual(ev.banked, scored, 'the stage should bank exactly what it scored');
  assert.strictEqual(banked(), scored, 'campaign total should equal the stage score');
});

// --- 2. dying AFTER a clear keeps the cleared level's points ----------------
test('dying later keeps the points from levels already passed', () => {
  assert.ok(startScoredRun({ stage: 1, practice: false }) > 0, 'need a score to bank');
  Sim.advanceStage();
  const afterClear = banked();
  assert.ok(afterClear > 0, 'stage 1 should be banked');
  // burn the remaining lives on the new board
  for (let f = 0; f < 60 * 600 && Sim.isRunning(); f++) Sim.update(1);
  assert.ok(!Sim.isRunning(), 'run should have ended');
  assert.strictEqual(banked(), afterClear,
    'a later game over must not take back points from a level already passed');
});

// --- 3. the level in progress is forfeited ---------------------------------
// Asserting "banked() === 0 after dying" was a FALSE GREEN: with commits
// disabled nothing ever banks, so zero is trivially true and the invert run
// passed this test 4 times out of 4. The real claim is a CONTRAST - the cleared
// level's points survive the death, the unfinished level's do not - so the test
// now needs a successful commit first, which is exactly what the invert breaks.
test('losing before passing a level forfeits that level points', () => {
  assert.ok(startScoredRun({ stage: 1, practice: false }) > 0, 'need a score to bank');
  const cleared = Sim.advanceStage().banked;
  assert.ok(cleared > 0, 'stage 1 should have banked something to contrast against');
  assert.strictEqual(banked(), cleared, 'the cleared level should be in the bank');

  // Score more on the NEW board, then die without ever reaching its portal.
  const before = Sim.getState().score;
  for (let f = 0; f < 6000 && Sim.isRunning(); f++) {
    Sim.update(1);
    const s = Sim.getState();
    const live = (s.sparks || []).filter(x => !x.collected);
    if (!live.length) continue;
    live.sort((p, q) => (Math.abs(p.y - s.frog.y) + Math.abs(p.x - s.frog.x))
                      - (Math.abs(q.y - s.frog.y) + Math.abs(q.x - s.frog.x)));
    const t = live[0];
    if (Math.abs(t.y - s.frog.y) >= 0.8) Sim.moveFrog(0, t.y < s.frog.y ? -1 : 1);
    else if (Math.abs(t.x - s.frog.x) >= 0.8) Sim.moveFrog(t.x > s.frog.x ? 1 : -1, 0);
  }
  const earnedOnDoomedBoard = Sim.getState().score - before;
  for (let f = 0; f < 60 * 600 && Sim.isRunning(); f++) {
    Sim.update(1);
    const s = Sim.getState();
    if (s.frog.y > 0) Sim.moveFrog(0, -1);       // wander into traffic, never clear
  }
  assert.ok(!Sim.isRunning(), 'run should have ended');
  assert.strictEqual(banked(), cleared,
    `only the PASSED level counts: banked ${banked()}, expected ${cleared} ` +
    `(${earnedOnDoomedBoard} earned on the level that was never passed)`);
});

// --- 4. practice never pays ------------------------------------------------
test('a practice run banks nothing even when it clears a stage', () => {
  Sim.resetData(); Sim.selectCampaign('ksto');
  // Stage 1 with an EXPLICIT practice flag. Using {stage: 2} relied on the
  // implicit practice default and incidentally tested a bigger 49-row board,
  // where the walk to a spark is longer and failed 1 run in 8. The claim here
  // is about the practice flag, not about board size.
  // Reaching a spark is probabilistic (traffic + spark placement), so a
  // `score > 0` PRECONDITION flakes about 1 run in 10 no matter how big the
  // budget is. The practice claim does not need it: banking nothing is true
  // whether the score is 0 or 50 - a zero score just makes it a weaker witness.
  // So try a couple of fresh runs for a non-zero score, then assert regardless.
  const scored = startScoredRun({ stage: 1, practice: true });
  const ev = Sim.advanceStage();
  assert.strictEqual(ev.banked, 0,
    `a practice stage must report banking nothing (scored ${scored})`);
  assert.strictEqual(banked(), 0, 'practice must never bank');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
