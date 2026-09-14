// Fairness check for the water lanes. Run: node tools/lane-check.js
// Asserts every lane guarantees a landing spot within MAX_WAIT seconds, so the
// board is always crossable. Keep this green when retuning WATER_LANES.
//
// Pulls WATER_LANES and PLATFORM_RATE straight from sim.js (not a hand-copied
// duplicate) so this gate cannot silently drift from what the game actually
// runs. Landscape (COLS=15) is the default sim column count and the one
// this fairness budget was tuned against; portrait (9 cols) narrows lane
// spacing further in the player's favour, not against it.
const Sim = require('../sim.js');
const COLS = Sim.getCols(), RATE = Sim.PLATFORM_RATE, FPS = 60, MAX_WAIT = 4.0;
const LANES = Sim.WATER_LANES;
const count = (w,c) => Math.max(2, Math.round((COLS*c)/w));
let worst = 0, fail = false;
console.log('row  type      n   gap   cover   maxWait');
for (const l of LANES) {
  const n = count(l.w, l.coverage), gap = COLS/n;
  const cover = Math.min(1, l.w/gap);
  const tilesPerSec = l.speed * RATE * FPS;
  const wait = Math.max(0, gap - l.w) / tilesPerSec;
  worst = Math.max(worst, wait);
  if (wait > MAX_WAIT || cover < 0.25) fail = true;
  console.log(` ${l.row}   ${l.type.padEnd(8)} ${n}  ${gap.toFixed(2)}  ${(cover*100).toFixed(0).padStart(3)}%   ${wait.toFixed(2)}s`);
}
console.log(`\nworst lane wait ${worst.toFixed(2)}s (limit ${MAX_WAIT}s)`);
console.log(`worst full crossing ~${(worst*5).toFixed(1)}s, typical ~${(worst*2.5).toFixed(1)}s`);
if (fail) { console.error('\nFAIL: a lane is unfair'); process.exit(1); }
console.log('PASS: every lane is crossable');
