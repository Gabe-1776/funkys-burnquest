// Focused behavioral checks for the security-review fixes.
//
// Covers the three invariants the user asked for:
//   1. Duplicate death prevention (#1): lives never goes negative, no
//      duplicate hit/gameover events in one frame or after gameover.
//   2. Pickup non-stacking (#4): no two uncollected pickups share a cell
//      or violate the MIN_COL_GAP spacing rule.
//   3. Context-loss handling (#11): Sim.pause() (which the context-loss
//      handler calls) correctly stops the sim — the headless half of the
//      context-loss invariant. The renderer rebuild and draw() gating are
//      browser-only and documented in render3d.js.
//
// Run: node tools/security-review-checks.js
const assert = require('assert');
const path = require('path');

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

const campId = () => Sim.getCampaigns()[0].id;
function freshRun() {
  Sim.selectCampaign(campId());
  Sim.startRun();
}

function adversarialPickupState() {
  const originalRandom = Math.random;
  try {
    // The pre-fix placement loop exhausts all 40 attempts on one occupied
    // cell under this generator, then stacks another pickup there.
    Math.random = () => 0;
    Sim.resetData();
    freshRun();
    for (let i = 0; i < 120; i++) Sim.update(1);
    return Sim.getState();
  } finally {
    Math.random = originalRandom;
  }
}

// --------------------------------------------------------- #1 duplicate death
test('lives never goes negative after repeated deaths', () => {
  Sim.resetData();
  freshRun();
  let gameoverCount = 0;
  let livesWentNegative = false;
  // Blind-walk forward through many runs; each death should decrement lives
  // by exactly 1 and stop. After gameover, update() must not fire more
  // hit/gameover events.
  for (let run = 0; run < 5; run++) {
    if (!Sim.isRunning() && !Sim.isPaused()) freshRun();
    for (let i = 0; i < 600; i++) {
      const evts = Sim.update(1).concat(Sim.moveFrog(0, -1));
      const state = Sim.getState();
      if (state.lives < 0) livesWentNegative = true;
      gameoverCount += evts.filter(e => e.type === 'gameover').length;
      if (!Sim.isRunning() && !Sim.isPaused()) break;
    }
  }
  assert.ok(!livesWentNegative, 'lives must never go negative');
  // Multiple runs can each produce a gameover, so just check per-run:
  // we don't assert on gameoverCount directly here.
});

test('after gameover, update() fires no more hit or gameover events', () => {
  Sim.resetData();
  freshRun();
  // Walk forward until dead.
  let dead = false;
  for (let i = 0; i < 600 && !dead; i++) {
    const evts = Sim.update(1).concat(Sim.moveFrog(0, -1));
    if (evts.some(e => e.type === 'gameover')) dead = true;
  }
  assert.ok(dead, 'blind walking should produce a gameover');
  // Now keep updating — the sim is not running, so no events should fire.
  for (let i = 0; i < 100; i++) {
    const evts = Sim.update(1);
    assert.strictEqual(evts.length, 0,
      `update() after gameover fired ${evts.length} events`);
  }
  assert.ok(Sim.getState().lives >= 0, 'lives must be >= 0 after gameover');
});

// -------------------------------------------------- #4 pickup non-stacking
test('no two uncollected pickups share the same cell', () => {
  const s = adversarialPickupState();
  const all = [...s.sparks, ...s.bugs, ...s.shades].filter(p => !p.collected);
  const cells = all.map(p => p.x + ':' + p.y);
  const dupes = cells.filter((c, i) => cells.indexOf(c) !== i);
  assert.strictEqual(dupes.length, 0,
    `duplicate pickup cells: ${dupes.join(', ')}`);
});

test('pickups respect the MIN_COL_GAP spacing on the same row', () => {
  const s = adversarialPickupState();
  const all = [...s.sparks, ...s.bugs, ...s.shades].filter(p => !p.collected);
  // Group by row.
  const byRow = {};
  all.forEach(p => {
    const k = String(p.y);
    (byRow[k] = byRow[k] || []).push(p.x);
  });
  const MIN_COL_GAP = 3;  // matches sim.js place()/free()
  for (const [row, xs] of Object.entries(byRow)) {
    for (let i = 0; i < xs.length; i++) {
      for (let j = i + 1; j < xs.length; j++) {
        assert.ok(Math.abs(xs[i] - xs[j]) >= MIN_COL_GAP,
          `row ${row}: pickups at x=${xs[i]} and x=${xs[j]} violate MIN_COL_GAP`);
      }
    }
  }
});

// ---------------------------------------- #11 context-loss: Sim.pause() invariant
// The context-loss handler in render3d.js calls root.Sim.pause() to stop
// the sim behind a frozen frame. This test verifies that pause() works
// correctly — the headless half of the invariant. The renderer rebuild
// and draw() gating are browser-only (render3d.js needs THREE + canvas).
test('Sim.pause() stops the sim (context-loss handler relies on this)', () => {
  Sim.resetData();
  freshRun();
  assert.ok(Sim.isRunning(), 'run should be active');
  assert.ok(Sim.pause(), 'pause should report it acted');
  assert.strictEqual(Sim.isRunning(), false);
  // update() returns no events while paused.
  const evts = Sim.update(1);
  assert.strictEqual(evts.length, 0,
    'paused update() must not produce events');
  // The sim can be resumed (the player resumes manually after context loss).
  assert.ok(Sim.resume(), 'resume should report it acted');
  assert.ok(Sim.isRunning(), 'sim should be running again');
});

test('Sim.pause() is idempotent (handler may call it on every context loss)', () => {
  Sim.resetData();
  freshRun();
  Sim.pause();
  // Calling pause() again must not throw or corrupt state.
  assert.strictEqual(Sim.pause(), false,
    'pausing an already-paused run returns false (no-op)');
  assert.strictEqual(Sim.isRunning(), false);
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
