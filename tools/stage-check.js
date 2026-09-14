// Can a run actually CLEAR a board, and does clearing a non-final stage
// continue the run instead of ending it?
//
// This is the gate tools/goal-check.js never managed to be. That one hopped
// blindly up 37 rows, drowned or was run over long before the gateway, and
// reported nothing while exiting 0. The difference here is that the walker
// checks the row it is about to enter - it reads the sim's own car and
// platform lists and waits when the target cell is not safe - so it plays the
// board rather than sprinting into it.
//
// Headless: no browser, no renderer. Run: node tools/stage-check.js
const path = require('path');
const assert = require('assert');

const store = {};
global.localStorage = {
  getItem: k => (k in store ? store[k] : null),
  setItem: (k, v) => { store[k] = String(v); },
  removeItem: k => { delete store[k]; },
};
const Sim = require(path.join(__dirname, '..', 'sim.js'));

// Safety is decided with the SIM'S OWN predicates, not invented margins.
//   a car hits when  fc > c.x + 0.18 && fc < c.x + c.w - 0.18
//   the frog rides when  fc > p.x && fc < p.x + p.w
// An earlier version of this walker used a hand-picked 1.35-tile clearance on
// each side of a car. Vehicles repeat about every 4.6 tiles, so that margin was
// wider than the gaps and NO cell was ever safe - the frog waited on the start
// median forever and the gate reported the board uncrossable.
//
// Platforms get no look-ahead at all: getState() exposes dir and w for logs,
// turtles and lilypads but NOT speed, so any projection of where a platform
// will be is NaN and silently false. (Cars do carry speed, so they can be
// projected.) Measured, not assumed: a platform covers the frog's column in
// ~73% of frames, so present-tense coverage is plenty.
const EPS = 0.12;                 // the frog is a point; give it a little body
const HOP_FRAMES = 13;            // HOP_MS 190 at 60fps, plus slack

function roadClear(row, fc, frames) {
  const st = Sim.getState();
  return !st.cars.some(c => {
    if (Math.round(c.y) !== row) return false;
    const travel = c.dir * c.speed * Sim.CAR_RATE * frames;
    for (let k = 0; k <= 8; k++) {          // sample the path, not the ends
      const x = c.x + travel * k / 8;
      if (fc > x + 0.18 - EPS && fc < x + c.w - 0.18 + EPS) return true;
    }
    return false;
  });
}

function platformUnder(row, fc) {
  const st = Sim.getState();
  return [...st.logs, ...st.turtles, ...st.lilypads].some(
    p => Math.round(p.y) === row && fc > p.x + EPS && fc < p.x + p.w - EPS);
}

function safeToEnter(row) {
  const st = Sim.getState();
  const cls = Sim.rowClass(row);
  const fc = st.frog.x + 0.5;
  if (cls === 'goal' || cls === 'median') return true;
  if (cls === 'water') return platformUnder(row, fc);
  return roadClear(row, fc, HOP_FRAMES + 6);
}

function playOneBoard(budgetFrames) {
  const events = [];
  for (let f = 0; f < budgetFrames; f++) {
    Sim.update(1).forEach(e => events.push(e));
    if (!Sim.isRunning()) return { events, cleared: false, died: true };
    const row = Math.round(Sim.getState().frog.y);
    if (row <= 0) {
      // Reaching the goal ROW is no longer the goal: the stage clears only
      // when the frog touches the teleporter. Walk along row 0 to it.
      const st = Sim.getState();
      const goal = st.goalCol;
      if (st.frog.x === goal) return { events, cleared: true, died: false };
      Sim.moveFrog(st.frog.x < goal ? 1 : -1, 0).forEach(e => events.push(e));
      const done = events.find(e => e.type === 'stage' || e.type === 'finish');
      if (done) return { events, cleared: true, died: false };
      continue;
    }
    if (safeToEnter(row - 1)) {
      Sim.moveFrog(0, -1).forEach(e => events.push(e));
      const done = events.find(e => e.type === 'stage' || e.type === 'finish');
      if (done) return { events, cleared: true, died: false };
    }
  }
  return { events, cleared: false, died: false };
}

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok    ${name}`); passed++; }
  catch (e) { console.log(`  FAIL  ${name}\n        ${e.message}`); failed++; }
}

// --- the board is clearable at all -----------------------------------------
let first = null;
test('a board can be cleared by a player who waits for gaps', () => {
  Sim.resetData();
  Sim.selectCampaign('ksto');
  for (let attempt = 0; attempt < 8 && !first; attempt++) {
    Sim.startRun();
    const r = playOneBoard(9000);
    if (r.cleared) first = r;
  }
  assert.ok(first, 'never reached the gateway in 8 attempts - board may be uncrossable');
});

// --- clearing stage 1 continues the run ------------------------------------
test('clearing stage 1 emits a stage event, not a finish', () => {
  assert.ok(first, 'depends on the previous test');
  const stageEvt = first.events.find(e => e.type === 'stage');
  const finishEvt = first.events.find(e => e.type === 'finish');
  assert.ok(stageEvt, 'no stage event on clearing stage 1');
  assert.ok(!finishEvt, 'the run must NOT finish on a non-final stage');
  assert.strictEqual(stageEvt.stage, 2);
  assert.strictEqual(stageEvt.isFinal, Sim.STAGES.length === 2,
    'isFinal must reflect the real stage count, not a hardcoded 2');
});

test('the run continues: still running, on stage 2, back at the start row', () => {
  assert.strictEqual(Sim.isRunning(), true, 'the run ended when it should have continued');
  assert.strictEqual(Sim.getStage(), 2);
  assert.strictEqual(Math.round(Sim.getState().frog.y), Sim.ROWS - 1);
});

test('score and lives carry across the stage boundary', () => {
  const stageEvt = first.events.find(e => e.type === 'stage');
  const st = Sim.getState();
  assert.strictEqual(st.score, stageEvt.score, 'score was reset by the stage change');
  assert.strictEqual(st.lives, stageEvt.lives, 'lives were reset by the stage change');
  assert.ok(st.lives > 0 && st.lives <= 3, `lives ${st.lives} out of range`);
});

test('no points are banked mid-run', () => {
  assert.strictEqual(Sim.getCampaignData('ksto').points, 0,
    'a stage change must not bank points - a run banks once, at finishRun');
});

// --- the difficulty knobs still WORK, even while every stage is flat -------
// Gabriel 2026-09-09: all five stages carry the same numbers for now ("no need
// to make them more difficult yet"). So there is no ramp to assert - but the
// TUNING MECHANISM must stay guarded, or the knobs quietly rot and the day he
// asks for a ramp nothing happens. This drives the config directly.
test('the STAGES knobs actually change the board', () => {
  Sim.resetData();
  Sim.selectCampaign('ksto');
  const base = Object.assign({}, Sim.STAGES[0]);

  Sim.startRun();
  const flat = Sim.getState();
  const flatCars = flat.cars.length;
  const flatSpeed = flat.cars.reduce((a, c) => a + c.speed, 0) / flat.cars.length;
  const flatPlats = flat.logs.length + flat.turtles.length + flat.lilypads.length;

  // Turn stage 1 up, rebuild, compare, then put it back exactly as it was.
  Object.assign(Sim.STAGES[0], { carSpeed: 1.6, traffic: 1.5, coverage: 0.7 });
  try {
    Sim.startRun();
    const hard = Sim.getState();
    const hardSpeed = hard.cars.reduce((a, c) => a + c.speed, 0) / hard.cars.length;
    const hardPlats = hard.logs.length + hard.turtles.length + hard.lilypads.length;
    console.log(`        flat: ${flatCars} cars @ ${flatSpeed.toFixed(3)}, ${flatPlats} platforms`);
    console.log(`        turned up: ${hard.cars.length} cars @ ${hardSpeed.toFixed(3)}, ${hardPlats} platforms`);
    assert.ok(hard.cars.length > flatCars, 'the traffic knob does nothing');
    assert.ok(hardSpeed > flatSpeed, 'the carSpeed knob does nothing');
    assert.ok(hardPlats < flatPlats, 'the coverage knob does nothing');
  } finally {
    Object.assign(Sim.STAGES[0], base);
  }
});

test('every stage carries the same difficulty for now', () => {
  const keys = ['carSpeed', 'platformSpeed', 'traffic', 'coverage', 'sparks'];
  const first = Sim.STAGES[0];
  Sim.STAGES.forEach(st => {
    keys.forEach(k => assert.strictEqual(st[k], first[k],
      `${st.name} differs on ${k} (${st[k]} vs ${first[k]}) - a ramp was added without being asked for`));
  });
});

// --- the goal row is not the goal; the TELEPORTER is -----------------------
test('standing on the goal row away from the teleporter does NOT clear it', () => {
  Sim.resetData();
  Sim.selectCampaign('ksto');
  Sim.startRun();
  const goal = Sim.getState().goalCol;
  // Walk up the safe way, then step along row 0 AWAY from the teleporter and
  // confirm nothing fires until the frog is actually on it.
  let onGoalRow = false;
  for (let f = 0; f < 9000 && !onGoalRow; f++) {
    Sim.update(1);
    if (!Sim.isRunning()) { Sim.startRun(); continue; }
    const row = Math.round(Sim.getState().frog.y);
    if (row <= 0) { onGoalRow = true; break; }
    if (safeToEnter(row - 1)) Sim.moveFrog(0, -1);
  }
  assert.ok(onGoalRow, 'never reached the goal row');

  // Move to the far end of row 0, away from the teleporter.
  const evts = [];
  for (let i = 0; i < 400; i++) {
    Sim.update(1);
    const st = Sim.getState();
    if (Math.abs(st.frog.x - goal) >= 3) break;
    Sim.moveFrog(st.frog.x > goal ? 1 : -1, 0).forEach(e => evts.push(e));
  }
  const st = Sim.getState();
  assert.strictEqual(Math.round(st.frog.y), 0, 'should still be on the goal row');
  assert.ok(Math.abs(st.frog.x - goal) >= 3,
    `expected to be clear of the teleporter, x ${st.frog.x} vs goal ${goal}`);
  assert.ok(!evts.some(e => e.type === 'stage' || e.type === 'finish'),
    'the stage cleared from the goal ROW rather than from the teleporter');
  assert.strictEqual(Sim.isRunning(), true, 'the frog must be able to stand on row 0');
  console.log(`        stood on row 0 at x ${st.frog.x.toFixed(2)}, teleporter at ${goal}: nothing fired`);

  // Now walk onto it and it must clear.
  let cleared = null;
  for (let i = 0; i < 900 && !cleared; i++) {
    Sim.update(1);
    const s2 = Sim.getState();
    const e = Sim.moveFrog(s2.frog.x < goal ? 1 : -1, 0);
    cleared = e.find(x => x.type === 'stage' || x.type === 'finish') || null;
  }
  assert.ok(cleared, 'touching the teleporter did not clear the stage');
});

test('the stage count is five', () => {
  assert.strictEqual(Sim.STAGES.length, 5,
    `STAGES has ${Sim.STAGES.length} entries`);
});

// --- clearing the FINAL stage does end the run ------------------------------
test('clearing the final stage finishes the run and banks points', () => {
  // ONE board, not five. Chaining all five on a single set of lives was always
  // rare (measured ~3%), and the longer stage 4-5 boards (61 rows, Gabriel's
  // river-road-river-road layouts) made it rarer still: this gate needed 83 of
  // its 150 attempts on 2026-09-11 and failed outright the run before. Starting
  // ON the final board keeps exactly what is under test - that clearing the
  // LAST stage finishes the run and banks - without the survival lottery.
  // practice: false makes it a real run; ?stage=N runs deliberately bank nothing.
  let fin = null, attempts = 0;
  Sim.resetData();
  Sim.selectCampaign('ksto');
  while (!fin && attempts < 60) {
    attempts++;
    Sim.startRun({ stage: Sim.STAGES.length, practice: false });
    for (let f = 0; f < 60000; f++) {
      Sim.update(1);
      if (!Sim.isRunning()) break;          // died, or the stage clock ran out
      const st = Sim.getState();
      const row = Math.round(st.frog.y);
      if (row <= 0) {
        const e = Sim.moveFrog(st.frog.x < st.goalCol ? 1 : -1, 0);
        fin = e.find(x => x.type === 'finish') || null;
        if (fin) break;
        continue;
      }
      if (safeToEnter(row - 1)) Sim.moveFrog(0, -1);
    }
  }
  console.log(`        cleared the final board on attempt ${attempts} of 60`);
  assert.ok(fin, 'never cleared the final board in 60 runs');
  assert.ok(fin.points > 0, 'finish banked no points');
  assert.ok(Sim.getCampaignData('ksto').points > 0, 'points did not reach the campaign');
  assert.strictEqual(Sim.isRunning(), false, 'the run must end on the final stage');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
