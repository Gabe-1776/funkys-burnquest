// Per-stage boards, the stage clock and steady traffic - headless, no browser.
//
// Gabriel 2026-09-11: stages 2-3 get another river crossing, stages 4-5 one
// more on top, each with its own road so the board alternates river/road; a 2-minute clock from stage 2 (run out = game over); and the
// cars were creeping faster over time (an uncapped in-stage speed ramp, now
// removed). Each of those is asserted here against the real sim.
//
// Run: node tools/stage-layout-check.js
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
// Read the layout back from the LIVE row classes, section by section.
function sections() {
  const out = [];
  for (let base = 1; base < Sim.ROWS - 1; base += 6) out.push(Sim.rowClass(base));
  return out.join(' ');
}

Sim.resetData();
Sim.selectCampaign('ksto');

// Every layout alternates river/road all the way (Gabriel 2026-09-11); a
// stage adds a river AND its road, so the pattern never doubles up.
const L1 = 'water road water road water road';
const L2 = L1 + ' water road';
const L4 = L2 + ' water road';
const EXPECT = { 1: [L1, 37], 2: [L2, 49], 3: [L2, 49], 4: [L4, 61], 5: [L4, 61] };
for (const [n, [lay, rows]] of Object.entries(EXPECT)) {
  test(`stage ${n}: ${rows} rows - ${lay}`, () => {
    Sim.startRun({ stage: +n });
    const st = Sim.getState();
    assert.strictEqual(Sim.getStage(), +n);
    assert.strictEqual(Sim.ROWS, rows, 'Sim.ROWS');
    assert.strictEqual(st.rows, rows, 'state.rows');
    assert.strictEqual(sections(), lay);
    assert.strictEqual(Math.round(st.frog.y), rows - 1, 'the frog is not on the start row');
    const plats = [...st.logs, ...st.turtles, ...st.lilypads];
    Sim.WATER_LANES.forEach(l => assert.ok(plats.some(p => p.y === l.row), `water row ${l.row} has no platforms`));
    Sim.ROAD_LANES.forEach(l => assert.ok(st.cars.some(c => c.y === l.row), `road row ${l.row} has no cars`));
    assert.ok(!/water water|road road/.test(sections()), 'two sections of the same kind in a row');
    const fast = Sim.ROAD_LANES.filter(l => l.fast);
    assert.strictEqual(fast.length, Sim.ROAD_LANES.length / 5, 'one fast lane per road section');
    fast.forEach(l => assert.ok(Sim.rowClass(l.row - 1) !== 'median' && Sim.rowClass(l.row + 1) !== 'median',
                                `fast lane ${l.row} sits right off a median`));
  });
}

test('stage 1 is the original board, row for row', () => {
  Sim.startRun();
  assert.strictEqual(Sim.WATER_LANES.map(l => l.row).join(','), '1,2,3,4,5,13,14,15,16,17,25,26,27,28,29');
  assert.strictEqual(Sim.ROAD_LANES.map(l => l.row).join(','), '7,8,9,10,11,19,20,21,22,23,31,32,33,34,35');
  assert.deepStrictEqual(Sim.getState().medianRows, [6, 12, 18, 24, 30, 36]);
  assert.deepStrictEqual(Sim.ROAD_LANES.filter(l => l.fast).map(l => l.row), [10, 21, 32]);
});

test('stage 1 is untimed', () => {
  Sim.startRun();
  const st = Sim.getState();
  assert.strictEqual(st.timeLimit, null);
  assert.strictEqual(st.timeLeft, null);
});

test('stage 2 starts a 2:30 clock that counts down with play', () => {
  Sim.startRun({ stage: 2 });
  assert.strictEqual(Sim.getState().timeLimit, 150000);
  for (let i = 0; i < 600; i++) Sim.update(1);            // 600 frames = 10 s
  const left = Sim.getState().timeLeft;
  assert.ok(Math.abs(left - 140000) < 50, `timeLeft ${left} after 10 s of play`);
});

test('pause stops the clock', () => {
  Sim.startRun({ stage: 2 });
  for (let i = 0; i < 300; i++) Sim.update(1);
  const a = Sim.getState().timeLeft;
  Sim.pause();
  for (let i = 0; i < 300; i++) Sim.update(1);
  const b = Sim.getState().timeLeft;
  Sim.resume();
  assert.strictEqual(b, a, `paused for 5 s and the clock went ${a} -> ${b}`);
});

test('running out of time is game over, cause "time", nothing banked', () => {
  Sim.resetData(); Sim.selectCampaign('ksto');
  Sim.startRun({ stage: 2 });
  let evs = [];
  for (let i = 0; i < 150 * 60 + 10 && Sim.isRunning(); i++) evs = evs.concat(Sim.update(1));
  const go = evs.find(e => e.type === 'gameover');
  assert.ok(go, 'no gameover after 2:30');
  assert.strictEqual(go.cause, 'time');
  assert.strictEqual(Sim.isRunning(), false);
  assert.strictEqual(Sim.getCampaignData('ksto').points, 0, 'a timed-out run banked points');
});

test('traffic does not speed up over time', () => {
  Sim.startRun();
  const stepOf = () => {                                   // one frame of car 0, skipping wraps
    for (let k = 0; k < 5; k++) {
      const a = Sim.getState().cars[0].x; Sim.update(1); const b = Sim.getState().cars[0].x;
      if (Math.abs(b - a) < 1) return Math.abs(b - a);
    }
    throw new Error('car 0 kept wrapping');
  };
  const early = stepOf();
  for (let i = 0; i < 60 * 300; i++) Sim.update(1);        // five minutes
  const late = stepOf();
  assert.ok(Math.abs(late - early) < 1e-9, `car step ${early} per frame -> ${late} after 5 minutes`);
});

test('a practice start banks nothing at the finish', () => {
  Sim.resetData(); Sim.selectCampaign('ksto');
  Sim.startRun({ stage: 5 });
  const fin = Sim.finishRun();
  assert.strictEqual(fin.practice, true);
  assert.strictEqual(fin.points, 0);
  assert.strictEqual(Sim.getCampaignData('ksto').points, 0);
});

test('a normal run still banks at the finish', () => {
  Sim.resetData(); Sim.selectCampaign('ksto');
  Sim.startRun();
  const fin = Sim.finishRun();
  assert.strictEqual(fin.practice, false);
  assert.ok(Sim.getCampaignData('ksto').points > 0, 'a normal run banked nothing');
});

// ---- hazards: snakes and birds on the grass, a gator per river -------------
test('hazards patrol the grass and the rivers, never the start row', () => {
  Sim.startRun({ stage: 2 });
  const hz = Sim.getState().hazards;
  const grass = hz.filter(h => h.kind !== 'gator');
  const gators = hz.filter(h => h.kind === 'gator');
  // Counts are HAND-PLACED now (Gabriel 2026-09-12), not one-per-verge: stage 2
  // is three snakes and no gator at all. Assert against the stage's own spots -
  // the placement rules below are what this test is really for.
  const spots = Sim.STAGES[1].hazardSpots || [];
  assert.strictEqual(grass.length, spots.filter(s => s.grass).length, 'grass hazard count');
  assert.strictEqual(gators.length, spots.filter(s => s.river).length, 'gator count');
  grass.forEach(h => assert.strictEqual(Sim.rowClass(h.y), 'median', `grass hazard on a ${Sim.rowClass(h.y)} row`));
  gators.forEach(h => assert.strictEqual(Sim.rowClass(h.y), 'water', 'gator off the water'));
  assert.ok(!hz.some(h => h.y === Sim.ROWS - 1), 'a hazard sits on the START row');
  assert.ok(!hz.some(h => h.y === 0), 'a hazard sits on the goal row');
});

test('stage 1 carries NO hazards - it is the teaching board', () => {
  // This used to assert one of each animal, which is what Gabriel asked for on
  // 2026-09-11 when he wanted to SEE them. 2026-09-12 he made the call for real:
  // "stage 1 should have no hazards, this stage the user gets used to the
  // gameplay, then as he plays on he gets suprised by all the other creatures".
  Sim.startRun();
  const hz = Sim.getState().hazards;
  assert.deepStrictEqual(hz, [],
    `stage 1 should be clear, found ${JSON.stringify(hz.map(h => h.kind))}`);
});

test('each stage spawns exactly the kinds it is configured for', () => {
  // This used to demand BOTH kinds on every stage - true under the old density
  // rule, false by design now: Gabriel made stage 2 snakes-only and stage 3
  // birds-plus-one-snake. The real claim is that the board matches its config.
  [2, 3, 4, 5].forEach(n => {
    Sim.startRun({ stage: n });
    const want = {};
    (Sim.STAGES[n - 1].hazardSpots || []).forEach(s => {
      const k = s.river ? 'gator' : s.kind;
      want[k] = (want[k] || 0) + 1;
    });
    const got = {};
    Sim.getState().hazards.forEach(h => { got[h.kind] = (got[h.kind] || 0) + 1; });
    assert.deepStrictEqual(got, want,
      `stage ${n}: spawned ${JSON.stringify(got)}, configured ${JSON.stringify(want)}`);
  });
});

test('grass hazards stay on the board and turn around', () => {
  Sim.startRun({ stage: 2 });
  const before = Sim.getState().hazards.filter(h => h.kind !== 'gator').map(h => h.dir);
  let turned = false;
  for (let i = 0; i < 60 * 90; i++) {
    Sim.update(1);
    const hz = Sim.getState().hazards.filter(h => h.kind !== 'gator');
    hz.forEach((h, k) => {
      assert.ok(h.x >= -0.001 && h.x <= Sim.getState().cols - h.w + 0.001, `hazard left the board at x ${h.x}`);
      if (h.dir !== before[k]) turned = true;
    });
  }
  assert.ok(turned, 'no grass hazard ever turned around');
});

test('standing on a verge with a hazard costs a life', () => {
  // Real play: climb to the first verge above the start row with the same
  // safe-step rule the other gates use, then stand there and wait.
  const EPS = 0.12, LOOK = 19;
  const safe = row => {
    const st = Sim.getState(), cls = Sim.rowClass(row), fc = st.frog.x + 0.5;
    if (cls === 'goal' || cls === 'median') return true;
    if (cls === 'water') return [...st.logs, ...st.turtles, ...st.lilypads].some(p => Math.round(p.y) === row && fc > p.x + EPS && fc < p.x + p.w - EPS);
    return !st.cars.some(c => {
      if (Math.round(c.y) !== row) return false;
      const travel = c.dir * c.speed * Sim.CAR_RATE * LOOK;
      for (let k = 0; k <= 8; k++) { const x = c.x + travel * k / 8; if (fc > x + 0.18 - EPS && fc < x + c.w - 0.18 + EPS) return true; }
      return false;
    });
  };
  let hit = null;
  for (let attempt = 0; attempt < 12 && !hit; attempt++) {
    Sim.startRun({ stage: 2 });
    // The verge nearest the start is EMPTY now (stage 2's snakes are on grass
    // 2, 3 and 7), so stand on one that actually holds a hazard - the lowest
    // occupied verge, i.e. the first one the frog meets on the way up.
    const occupied = Sim.getState().hazards
      .filter(h => h.kind !== 'gator').map(h => h.y).sort((a, b) => b - a);
    const target = occupied[0];
    if (target === undefined) continue;
    for (let f = 0; f < 60 * 200 && Sim.isRunning(); f++) {
      const evs = Sim.update(1);
      const found = evs.find(e => e.type === 'hit');
      if (found && Math.round(Sim.getState().frog.y) <= target + 0.5) { hit = found; break; }
      const row = Math.round(Sim.getState().frog.y);
      if (row > target && safe(row - 1)) Sim.moveFrog(0, -1);              // climb, then wait
    }
  }
  assert.ok(hit, 'never got attacked while standing on a verge');
  assert.ok(['snake', 'bird'].includes(hit.cause), `hit cause was ${hit.cause}`);
});

// ---- combo: a run of pickups has to climb past 2 -------------------------
// NO COMBO TEST HERE, deliberately (2026-09-11). COMBO_WINDOW went 90 -> 240
// frames because sparks sit 3.6 hops apart on average (up to 8) and the hop
// gate allows ~8 hops in 1.5s, so a third pickup needed two sparks unusually
// close AND a clean run between them - which is exactly what Gabriel reported
// ("it only work for 2 pickups"). Four attempts at automating that failed to
// DISCRIMINATE, and each is worth remembering before writing a fifth:
//   1. walker that beelined to the nearest spark  -> combo 5 even at 90 frames
//   2. best-of-12 attempts                        -> flaky: 1 run in 4 failed
//                                                    on unchanged code
//   3. best-of-40 attempts                        -> stable, but PASSED at 90
//                                                    too (a lucky cluster)
//   4. rate of 3+ over 20 runs                     -> distributions overlap
// Measured over 30 crossings each: 90 frames gives mean 1.43 / max 4 / 3+ in
// 3 of 30; 240 gives mean 1.63 / max 5 / 3+ in 6 of 30. The direction is right
// but no threshold separates them at any sample size this walker can afford,
// because a crossing player's streak is dominated by where sparks happen to
// land. The fix stands on the spacing measurement and on play-testing, not on
// a gate that would only ever block commits at random.

console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
