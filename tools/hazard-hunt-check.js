// Hazards patrol mindlessly until the frog steps into their row, then they hunt
// him - headless, no browser.
//
// Gabriel 2026-09-11: "the animals attacking are mindlessly going back and forth
// from left to right touching left wall to right wall back and forth until
// character steps foot into their row grass section, then snake should go
// towards the frog character".
//
// Run: node tools/hazard-hunt-check.js
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
// dt is in FRAMES, not ms: the sim does simTimeMs += dt * (1000 / 60), so
// update(16) is 267ms and update(1) is one 60fps frame. And moveFrog is gated on
// simTimeMs - lastHopAt >= HOP_MS(190), both zero at startRun, so the clock has
// to advance BEFORE the first hop or it is refused outright.
// STAGE 5, not stage 1: Gabriel made stage 1 the teaching board with no hazards
// at all (2026-09-12), so there was nothing for the walker to find and every
// test failed on "need a grass hazard". Stage 5 also happens to be the KINDEST
// board for this suite: a hunter on all 9 verges, the nearest at row 54 against
// a start of 60 - six rows to climb, where stage 2's nearest is twelve. This
// walk dies in traffic around 5-9 rows up, so the short trip matters.
// It does mean crossing gator water; the loops break out when a run ends.
const FRAME = 1;
const centre = h => h.x + h.w / 2;
const hazardAt = (st, row) => st.hazards.find(h => h.y === row);
// Step the sim and hand back the hazard we are watching, matched by its row.
function step(row, dt) {
  Sim.update(dt);
  return hazardAt(Sim.getState(), row);
}
// The frog starts on the LAST row (36 of 37) and the board runs upward, so
// reaching a hazard means hopping toward DECREASING y.
// Walking up the board means crossing live traffic, and three lives are not
// enough: traced, the frog reached row 20 of a target 18, died twice and ended
// the RUN (lives 0) at iteration 73. Respawn tolerance cannot fix that - the run
// itself is over. So retry across FRESH runs: each startRun re-randomises the
// board, and the frog got within two rows on its first attempt, so a handful of
// boards is plenty. This drives real input through the real sim rather than
// building a traffic-dodging bot to test a snake.
function reachGrassHazard(attempts) {
  for (let a = 0; a < (attempts || 40); a++) {
    Sim.startRun({ stage: 5, practice: true });
    const s0 = Sim.getState();
    const target = s0.hazards
      .filter(h => h.kind !== 'gator')
      .sort((x, y) => Math.abs(x.y - s0.frog.y) - Math.abs(y.y - s0.frog.y))[0];
    if (!target) continue;
    const row = target.y;
    for (let guard = 0; guard < 4000; guard++) {
      const s = Sim.getState();
      // Need a life in hand: if he arrives on his last one the kill ends the
      // RUN, and the loop below breaks on !gameRunning before it ever sees
      // lives drop (measured flake: "lives 1 -> 0").
      if (s.frog.y === row) { if (s.lives > 1) return row; break; }
      if (!s.gameRunning || s.lives <= 0) break;
      Sim.update(FRAME * 13);        // clear the 190ms hop gate
      Sim.moveFrog(0, -1);
    }
  }
  return -1;
}

Sim.resetData();
Sim.selectCampaign('ksto');

// --- 1. out of the frog's row: patrol, wall to wall -------------------------
test('out of row: paces a local beat and turns at both ends of it', () => {
  Sim.startRun({ stage: 5, practice: true });
  const st0 = Sim.getState();
  const h0 = st0.hazards.find(h => h.y !== st0.frog.y && h.kind !== 'gator');
  assert.ok(h0, 'need a grass hazard outside the frog row');
  const row = h0.y;
  const cols = Sim.getCols();
  let lo = Infinity, hi = -Infinity, hunted = false;
  for (let i = 0; i < 20000; i++) {
    const h = step(row, FRAME);
    if (!h) break;
    if (Sim.getState().frog.y === row) continue;   // ignore if the frog wanders in
    if (h.hunt) hunted = true;
    lo = Math.min(lo, h.x); hi = Math.max(hi, h.x);
  }
  // Gabriel 2026-09-12: wall-to-wall "moves left to right to much", so the idle
  // patrol now works a beat around the spawn point. This assertion INVERTED on
  // purpose - it used to demand both walls.
  assert.ok(!hunted, 'hazard must not hunt while the frog is in another row');
  assert.ok(lo >= h0.beatLo - 0.02,
    `should not wander left of its beat: min x ${lo.toFixed(2)} vs beatLo ${h0.beatLo}`);
  assert.ok(hi <= h0.beatHi + 0.02,
    `should not wander right of its beat: max x ${hi.toFixed(2)} vs beatHi ${h0.beatHi}`);
  assert.ok(hi - lo > 1.0,
    `should actually pace, not sit still: swept only ${(hi - lo).toFixed(2)}`);
});

// --- 2. frog in the row: the hazard closes ----------------------------------
test('in row: hazard closes the gap to the frog', () => {
  const row = reachGrassHazard();
  assert.ok(row >= 0, 'frog should have reached a grass hazard row on some board');
  const st = Sim.getState();
  const h1 = hazardAt(st, row);
  assert.ok(h1, 'hazard still in that row');
  const gap0 = Math.abs((st.frog.x + 0.5) - centre(h1));
  let gapMin = gap0, sawHunt = false;
  for (let i = 0; i < 2500; i++) {
    const h = step(row, FRAME);
    const s = Sim.getState();
    if (!h || s.frog.y !== row || !s.gameRunning) break;   // died or moved on
    if (h.hunt) sawHunt = true;
    gapMin = Math.min(gapMin, Math.abs((s.frog.x + 0.5) - centre(h)));
  }
  // A fixed 0.5 margin was wrong: when the frog lands already close (measured
  // flake: gap 0.92 -> 0.62) there is less than 0.5 of closing available before
  // the clamp parks the hazard on him. 0.92 -> 0.62 IS the feature working.
  // Closing to a fraction of the starting gap, or to contact range, is the real
  // claim. Contact is h.w/2 wide, so anything inside that counts as arrived.
  const closed = gapMin <= Math.max(0.35, gap0 * 0.55);
  assert.ok(closed,
    `should close on the frog: gap ${gap0.toFixed(2)} -> ${gapMin.toFixed(2)}`);
  assert.ok(sawHunt, 'hazard should report hunt while sharing the row');
});

// --- 3. the hunt actually costs a life --------------------------------------
// This replaces a "does not jitter at close range" test that was a FALSE GREEN:
// with hunting off the hazard never got close, so there were no flips to count
// and the assertion passed whether or not the feature existed (the invert run
// proved it). It was also untestable in principle - traced, the hazard closes
// 8.90 -> 0.426 over ~730 frames and then KILLS the frog, so "hovers nearby
// without jittering" never happens. Arrival IS death, which is the feature
// Gabriel asked for: "player gets attacked loses life".
test('in row: the hunt closes in and costs a life', () => {
  const row = reachGrassHazard();
  assert.ok(row >= 0, 'frog should have reached a grass hazard row on some board');
  const st = Sim.getState();
  const lives0 = st.lives;
  const h0 = hazardAt(st, row);
  assert.ok(h0, 'hazard still in that row');
  const gap0 = Math.abs((st.frog.x + 0.5) - centre(h0));
  let killed = false, sawHunt = false, gapMin = gap0;
  // Budget generously: closing ~9 columns took about 730 frames.
  for (let i = 0; i < 2500; i++) {
    const h = step(row, FRAME);
    const s = Sim.getState();
    if (!h) break;
    // Only sample the flag while he is actually standing in the row - otherwise
    // a frog knocked out of the row scores a spurious "never hunted".
    if (s.frog.y === row) {
      if (h.hunt) sawHunt = true;
      gapMin = Math.min(gapMin, Math.abs((s.frog.x + 0.5) - centre(h)));
    }
    if (s.lives < lives0) { killed = true; break; }   // it caught him
    if (!s.gameRunning) break;
  }
  assert.ok(sawHunt, 'hazard should report hunt while sharing the row');
  assert.ok(killed,
    `standing in the row should cost a life: gap ${gap0.toFixed(2)} -> ${gapMin.toFixed(2)}, lives ${lives0} -> ${Sim.getState().lives}`);
});

// --- 4. leaving the row must not teleport the hunter ------------------------
// Gabriel 2026-09-12: the hazard "reset in position" when he hopped out of its
// row. A hunt takes it off its beat on purpose; the beat clamp then SNAPPED it
// back. A teleport is visible as a single frame moving it further than one step.
test('ending a hunt lets it walk back, never snap back', () => {
  const row = reachGrassHazard();
  assert.ok(row >= 0, 'frog should have reached a grass hazard row on some board');
  // let it hunt for a while so it leaves its beat
  for (let i = 0; i < 600; i++) {
    const h = step(row, FRAME);
    const s = Sim.getState();
    if (!h || !s.gameRunning) break;
    if (s.frog.y !== row) break;
  }
  const h0 = hazardAt(Sim.getState(), row);
  if (!h0) return;                    // it killed him; covered by the other tests
  // now make sure the frog is NOT in that row, and watch for a jump
  let prev = h0.x, maxJump = 0;
  const stepSize = h0.speed ? h0.speed * 0.020 : 0.02;
  for (let i = 0; i < 400; i++) {
    Sim.update(FRAME);
    const s = Sim.getState();
    const h = s.hazards.find(x => x.y === row);
    if (!h || !s.gameRunning) break;
    if (s.frog.y === row) { prev = h.x; continue; }   // still hunting, not the case under test
    maxJump = Math.max(maxJump, Math.abs(h.x - prev));
    prev = h.x;
  }
  assert.ok(maxJump < 0.25,
    `hazard teleported ${maxJump.toFixed(3)} in one frame after the hunt ended`);
});

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
