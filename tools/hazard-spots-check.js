// Hand-placed hazard spots stay exactly where Gabriel put them.
//
// Gabriel 2026-09-12: "when we place the hazards this will be there permanent
// spots unless we move them around again" - so this is a pin, not a smoke test.
// grass N and river N count from the START going up: grass 1 is the first verge
// you reach, river 1 the first water.
//
// Run: node tools/hazard-spots-check.js
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

// Resolve the same way the sim does, from the LIVE layout.
function verges() {
  return Sim.MEDIAN_ROWS.filter(r => r !== Sim.ROWS - 1).slice().sort((a, b) => b - a);
}
function rivers() {
  const out = [];
  Sim.WATER_LANES.slice().sort((a, b) => b.row - a.row).forEach(l => {
    const last = out[out.length - 1];
    if (last && last.rows[last.rows.length - 1] - l.row === 1) last.rows.push(l.row);
    else out.push({ rows: [l.row] });
  });
  return out;
}
// What actually spawned, as {kind, grass} / {kind, river}
function placed(stage) {
  Sim.startRun({ stage, practice: true });
  const v = verges(), rv = rivers();
  return Sim.getState().hazards.map(h => {
    if (h.kind === 'gator') {
      const i = rv.findIndex(r => r.rows.includes(Math.round(h.y)));
      return { kind: 'gator', river: i + 1 };
    }
    return { kind: h.kind, grass: v.indexOf(h.y) + 1 };
  }).sort((a, b) => (a.grass || 0) - (b.grass || 0) || (a.river || 0) - (b.river || 0)
                 || a.kind.localeCompare(b.kind));
}
const sorted = list => list.slice().sort((a, b) =>
  (a.grass || 0) - (b.grass || 0) || (a.river || 0) - (b.river || 0) || a.kind.localeCompare(b.kind));

Sim.resetData();
Sim.selectCampaign('ksto');

test('stage 1: completely clear - the teaching board', () => {
  assert.deepStrictEqual(placed(1), [], 'stage 1 must carry no hazards at all');
});

test('stage 2: snakes on grass 2, 3 and 7 - nothing else', () => {
  assert.deepStrictEqual(placed(2), sorted([
    { kind: 'snake', grass: 2 }, { kind: 'snake', grass: 3 }, { kind: 'snake', grass: 7 }]));
});

test('stage 3: birds on grass 2, 3 and 7, snake on grass 5', () => {
  assert.deepStrictEqual(placed(3), sorted([
    { kind: 'bird', grass: 2 }, { kind: 'bird', grass: 3 },
    { kind: 'bird', grass: 7 }, { kind: 'snake', grass: 5 }]));
});

// CUMULATIVE (Gabriel 2026-09-12): "stage 4 will keep all of stage 3, and stage
// 5 will keep all of stage 3 and 4, we are just adding on".
const STAGE3 = [{ kind: 'bird', grass: 2 }, { kind: 'bird', grass: 3 },
                { kind: 'bird', grass: 7 }, { kind: 'snake', grass: 5 }];

test('stage 4: everything from stage 3, plus gators in rivers 2 and 5', () => {
  assert.deepStrictEqual(placed(4), sorted(STAGE3.concat([
    { kind: 'gator', river: 2 }, { kind: 'gator', river: 5 }])));
});

test('stage 5: stage 4 kept, snakes only in the EMPTY verges, every river gated', () => {
  // "no all snakes for all grasses just for the empty ones" - 2, 3, 5 and 7 are
  // already taken by stage 3's birds and snake, so the snakes fill 1, 4, 6, 8, 9.
  const want = sorted(STAGE3.concat(
    [1, 4, 6, 8, 9].map(g => ({ kind: 'snake', grass: g })),
    [1, 2, 3, 4, 5].map(r => ({ kind: 'gator', river: r }))));
  assert.deepStrictEqual(placed(5), want);
  const snakes = placed(5).filter(s => s.kind === 'snake').map(s => s.grass);
  assert.ok(!snakes.includes(2) && !snakes.includes(3) && !snakes.includes(7),
    'a snake landed on a verge stage 3 had already taken');
});

test('the spots survive a re-roll - they are permanent, not random', () => {
  const a = JSON.stringify(placed(3));
  for (let i = 0; i < 8; i++) {
    assert.strictEqual(JSON.stringify(placed(3)), a, 'stage 3 moved between runs');
  }
});

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
