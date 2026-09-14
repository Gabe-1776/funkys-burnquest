// Repro: frog.x goes fractional riding a platform, then the left wall is
// unreachable because moveFrog refuses nx < 0. Run: node tools/wall-reach-repro.js
// Randomized traffic means the climb can fail; retry runs until one lands.
const Sim = require(process.env.SIM_PATH || '../sim.js');

const HOP_MS = 200;
let t = 0;
const step = (n = 1) => { for (let i = 0; i < n; i++) { t += 1; Sim.update(1); } };
const hopWait = () => step(Math.ceil(HOP_MS / (1000 / 60)) + 1);

const st = () => Sim.getState();
const hop = (dx, dy) => {
    const b = st().frog;
    Sim.moveFrog(dx, dy);
    const a = st().frog;
    return a.x !== b.x || a.y !== b.y;
};

const road = () => new Set(st().cars.map(c => c.y));
const carDanger = row => st().cars.some(c => {
    if (c.y !== row) return false;
    const fc = st().frog.x + 0.5;
    for (const ahead of [0, 3, 6, 9, 14]) {
        const cx = c.x + c.dir * c.speed * 0.028 * ahead;
        if (fc > cx + 0.18 - 0.25 && fc < cx + c.w - 0.18 + 0.25) return true;
    }
    return false;
});
const plats = r => [...st().logs, ...st().turtles, ...st().lilypads].filter(q => q.y === r);
const platOk = row => plats(row).some(q => {
    const m = Math.min(0.15, q.w * 0.2), fc = st().frog.x + 0.5;
    return fc > q.x + m && fc < q.x + q.w - m;
});

function attempt() {
    Sim.startRun();
    let guard = 0;
    // Climb from start (36) through road 31-35 to median 30.
    while (Math.round(st().frog.y) > 30 && guard++ < 4000) {
        if (!st().gameRunning) return false;
        const fy = Math.round(st().frog.y), up = fy - 1;
        const onRoad = road().has(fy);
        const upSafe = st().medianRows.includes(up) || (!road().has(up) ? false : !carDanger(up))
                       || st().medianRows.includes(up);
        const canUp = st().medianRows.includes(up) || (road().has(up) && !carDanger(up))
                      || platOk(up);
        if (canUp) {
            hopWait(); hop(0, -1); step(1); continue;
        }
        if (onRoad && carDanger(fy)) {
            // sidestep to dodge while waiting
            hopWait();
            const dir = carDanger(fy) ? (Math.random() < 0.5 ? -1 : 1) : 0;
            if (dir) hop(dir, 0);
            step(4); continue;
        }
        step(3);
    }
    if (Math.round(st().frog.y) !== 30 || !st().gameRunning) return false;

    // Hop onto water row 29 (log drifting left) when a log covers the landing.
    guard = 0;
    while (Math.round(st().frog.y) !== 29 && guard++ < 4000) {
        if (!st().gameRunning) return false;
        hopWait();
        if (platOk(29)) hop(0, -1);
        step(1);
    }
    if (!st().gameRunning) return false;
    return true;
}

let ok = false;
for (let a = 0; a < 60 && !ok; a++) ok = attempt();
if (!ok) { console.log('never made the water row'); process.exit(2); }

console.log('on water 29 at', JSON.stringify(st().frog));

// Ride the log for ~2s so x drifts fractional.
step(120);
console.log('after riding:', st().frog.x.toFixed(3));

// Hop back DOWN onto median 30 (safe, no platform needed).
hopWait();
hop(0, 1);
console.log('landed on median at x =', st().frog.x.toFixed(3));

// Now spam left hops - where does x stop?
let stopped = null;
for (let i = 0; i < 40; i++) {
    hopWait();
    const before = st().frog.x;
    hop(-1, 0);
    step(2);
    if (st().frog.x === before) { stopped = before; break; }
}
const fx = st().frog.x;
console.log('left wall reach result: x =', fx.toFixed(3));
if (fx > 0.01) {
    console.log(`BUG: wall unreachable, frog stuck at x=${fx.toFixed(3)}`);
    process.exit(1);
}
console.log('PASS: frog reaches x=0');
process.exit(0);
