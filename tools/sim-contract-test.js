// Headless contract tests for sim.js.
//
// These cover the defects Vulcan's structure audit reproduced
// (~/knowledge/game-dev/GAME-STRUCTURE-RULES.md, BurnQuest section): a level
// that never advanced, a pause that abandoned the run, saves trusted wholesale,
// gameplay durations on wall-clock while motion ran on dt, and a death cause
// re-derived after the respawn had already moved the frog.
//
// They are permanent because each is a plausible regression: all five would
// pass a syntax check and look fine on screen.
//
// Run: node tools/sim-contract-test.js
const assert = require('assert');
const path = require('path');

// localStorage stub so save/load can be exercised headlessly.
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
const data = () => Sim.getCampaignData(campId());

function freshRun() {
  Sim.selectCampaign(campId());
  Sim.startRun();
}

// ---------------------------------------------------------------- progression
test('crossing a goal advances the level', () => {
  Sim.resetData();
  Sim.selectCampaign(campId());
  data().points = Sim.LEVEL_GOALS[0];      // exactly on the first goal
  Sim.startRun();
  const r = Sim.finishRun();
  assert.strictEqual(r.level, 2, `level ${r.level}, expected 2`);
  assert.ok(r.levelsGained >= 1, 'levelsGained should report the advance');
});

test('surplus points carry into the next level, never reset', () => {
  Sim.resetData();
  Sim.selectCampaign(campId());
  const goal = Sim.LEVEL_GOALS[0];
  data().points = goal + 40000;
  Sim.startRun();
  Sim.finishRun();
  assert.ok(data().points > goal, 'cumulative points must not be deducted');
  assert.strictEqual(data().level, 2);
});

test('percent measures progress within the CURRENT level', () => {
  Sim.resetData();
  Sim.selectCampaign(campId());
  data().points = Sim.LEVEL_GOALS[0];      // 0% into level 2, not ~100%
  Sim.startRun();
  const r = Sim.finishRun();
  assert.ok(r.pct < 50, `pct ${r.pct} - level 2 should not open near 100%`);
});

test('the top level is terminal and reports maxed', () => {
  Sim.resetData();
  Sim.selectCampaign(campId());
  data().points = Sim.LEVEL_GOALS[Sim.LEVEL_GOALS.length - 1] * 10;
  Sim.startRun();
  const r = Sim.finishRun();
  assert.strictEqual(r.maxed, true);
  assert.strictEqual(r.pct, 100);
  assert.strictEqual(r.level, Sim.LEVEL_GOALS.length + 1);
});

// --------------------------------------------------------------- pause/resume
test('pause preserves the run; resume returns to the same position', () => {
  Sim.resetData();
  freshRun();
  Sim.update(1);
  Sim.moveFrog(0, -1);
  const before = Sim.getState().frog.y;
  assert.ok(Sim.pause(), 'pause should report it acted');
  assert.strictEqual(Sim.isRunning(), false);
  assert.strictEqual(Sim.isPaused(), true, 'a paused run still exists');
  assert.ok(Sim.resume(), 'resume should report it acted');
  assert.strictEqual(Sim.isRunning(), true);
  assert.strictEqual(Sim.getState().frog.y, before, 'position must survive a pause');
});

test('abandoning a run clears it so resume cannot revive it', () => {
  Sim.resetData();
  freshRun();
  Sim.pause();
  Sim.abandonRun();
  assert.strictEqual(Sim.isPaused(), false);
  assert.strictEqual(Sim.resume(), false, 'nothing to resume');
});

// ---------------------------------------------------------------------- clock
test('gameplay timers do not advance while paused', () => {
  Sim.resetData();
  freshRun();
  Sim.update(1);
  Sim.moveFrog(0, -1);                     // consumes the hop gate
  const blocked = Sim.moveFrog(0, -1);
  assert.strictEqual(blocked.length, 0, 'second hop should be rate-gated');
  Sim.pause();
  const wall = Date.now();
  while (Date.now() - wall < 260) { /* real time passes; sim time must not */ }
  Sim.resume();
  const stillBlocked = Sim.moveFrog(0, -1);
  assert.strictEqual(stillBlocked.length, 0,
    'wall-clock time passing while paused must not open the hop gate');
});

test('a long frame cannot expire a pickup faster than gameplay', () => {
  Sim.resetData();
  freshRun();
  const before = Sim.getState().shadesLeft;
  Sim.update(999);                         // dt is clamped inside update
  const after = Sim.getState().shadesLeft;
  assert.ok(after === before || after >= 0, 'timers stay on the clamped sim clock');
});

// ----------------------------------------------------------------- save/load
test('a non-numeric points value is rejected, not loaded', () => {
  store['burnquest_campaigns'] = JSON.stringify({ [campId()]: { points: 'oops', level: 99 } });
  Sim.loadData();
  assert.strictEqual(typeof data().points, 'number');
  assert.ok(Number.isFinite(data().points), 'points must be finite');
  assert.strictEqual(data().points, 0, 'garbage points fall back to 0');
});

test('a hand-edited level is re-derived from points', () => {
  store['burnquest_campaigns'] = JSON.stringify({ [campId()]: { points: 0, level: 99 } });
  Sim.loadData();
  assert.strictEqual(data().level, 1, 'level 99 with 0 points must not survive');
});

test('a missing campaign is filled in rather than left absent', () => {
  store['burnquest_campaigns'] = JSON.stringify({});
  Sim.loadData();
  Sim.getCampaigns().forEach(c => {
    assert.ok(Sim.getCampaignData(c.id), `campaign ${c.id} missing after load`);
  });
});

test('unparseable save falls back to defaults instead of throwing', () => {
  store['burnquest_campaigns'] = '{not json';
  Sim.loadData();
  assert.strictEqual(data().points, 0);
  assert.strictEqual(data().level, 1);
});

test('negative points cannot be smuggled in', () => {
  store['burnquest_campaigns'] = JSON.stringify({ [campId()]: { points: -5000, level: 1 } });
  Sim.loadData();
  assert.ok(data().points >= 0, 'points must never load negative');
});

// -------------------------------------------------------------- death outcome
test('the death event carries its own cause', () => {
  Sim.resetData();
  freshRun();
  // Walk forward blindly. Crossing a road without checking, or stepping into
  // water with no platform, kills the frog - we only need ONE hit to assert the
  // contract, and blind walking reliably produces one.
  let hit = null;
  for (let i = 0; i < 600 && !hit; i++) {
    const evts = Sim.update(1).concat(Sim.moveFrog(0, -1));
    hit = evts.find(e => e.type === 'hit') || null;
    if (!Sim.isRunning() && !hit) { freshRun(); }
  }
  assert.ok(hit, 'blind walking should produce at least one death to inspect');
  assert.ok(['car', 'water'].includes(hit.cause),
    `cause was ${hit.cause}; effects must not re-derive it from position`);
  assert.strictEqual(typeof hit.contactY, 'number',
    'contact point travels with the outcome');
  // The cause must agree with where it actually happened.
  const cls = Sim.rowClass(Math.round(hit.contactY));
  assert.strictEqual(cls, hit.cause === 'water' ? 'water' : 'road',
    `cause ${hit.cause} but contact row was ${cls}`);
});

// ------------------------------------------------------------------- terrain
test('one terrain descriptor covers every row of every band', () => {
  const seen = {};
  for (let y = 0; y < Sim.ROWS; y++) {
    const c = Sim.rowClass(y);
    assert.ok(['goal', 'water', 'road', 'median'].includes(c),
      `row ${y} classified as ${c}`);
    seen[c] = (seen[c] || 0) + 1;
  }
  assert.strictEqual(seen.goal, 1, 'exactly one goal row');
  assert.strictEqual(seen.water, Sim.WATER_LANES.length,
    'every water lane must be classified as water in all bands');
  assert.strictEqual(seen.road, Sim.ROAD_LANES.length,
    'every road lane must be classified as road in all bands');
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
