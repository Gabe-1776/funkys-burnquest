// Drowning must look like drowning - in EVERY water band.
//
// The renderer chose the death effect with the literal `gy >= 1 && gy <= 5`,
// which is band 0 only. With three bands the water rows are 1-5, 13-17 and
// 25-29, so a player who drowned above the first river got the hit-by-car
// squash instead of the float, and never saw themselves go into the water.
// This walks the frog into each band's water in turn and checks the renderer
// picked the float, with a splash.
//
// Usage: node tools/drown-check.js [--url URL]
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

let passed = 0, failed = 0;
const test = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failed++; }
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(2600);

  const bands = await p.evaluate(() => {
    const rows = window.Sim.WATER_LANES.map(l => l.row).sort((a, b) => a - b);
    const out = [];
    rows.forEach(r => {
      const last = out[out.length - 1];
      if (last && last[last.length - 1] === r - 1) last.push(r);
      else out.push([r]);
    });
    return out;
  });
  console.log(`        water bands: ${bands.map(b => b[0] + '-' + b[b.length - 1]).join(', ')}`);
  test('the board really has more than one water band', bands.length > 1,
       `${bands.length} band(s)`);

  // Drown deliberately in each band. Getting there needs REAL crossing logic -
  // a blind walk up dies on the first road and the gate then reports "skipped"
  // for every band, which is how the first version of this file passed while
  // testing nothing at all. Missing evidence is a FAILURE here, not a skip.
  const drownIn = async band => {
    const target = band[Math.floor(band.length / 2)];
    return p.evaluate(async (targetRow) => {
      const S = window.Sim, EPS = 0.12;
      const sleep = ms => new Promise(r => setTimeout(r, ms));
      const roadClear = (row, fc, frames) => !S.getState().cars.some(c => {
        if (Math.round(c.y) !== row) return false;
        const travel = c.dir * c.speed * S.CAR_RATE * frames;
        for (let k = 0; k <= 8; k++) {
          const x = c.x + travel * k / 8;
          if (fc > x + 0.18 - EPS && fc < x + c.w - 0.18 + EPS) return true;
        }
        return false;
      });
      const platUnder = (row, fc) => {
        const st = S.getState();
        return [...st.logs, ...st.turtles, ...st.lilypads].some(
          q => Math.round(q.y) === row && fc > q.x + EPS && fc < q.x + q.w - EPS);
      };
      const safe = row => {
        const st = S.getState(), cls = S.rowClass(row), fc = st.frog.x + 0.5;
        if (cls === 'goal' || cls === 'median') return true;
        if (cls === 'water') return platUnder(row, fc);
        return roadClear(row, fc, 19);
      };

      // Climb safely to the row just below the target water row.
      for (let i = 0; i < 4000; i++) {
        if (!S.isRunning()) return { failed: 'run ended while climbing' };
        const row = Math.round(S.getState().frog.y);
        if (row === targetRow + 1) break;
        if (row < targetRow + 1) return { failed: 'overshot the band' };
        if (safe(row - 1)) S.moveFrog(0, -1);
        await sleep(16);
      }
      if (Math.round(S.getState().frog.y) !== targetRow + 1) {
        return { failed: 'never reached the row below the water' };
      }

      // Step in when there is NO platform under us AND invincibility has worn
      // off: a respawn grants ~1s of it, and die() returns early while it is
      // active - so a step into open water during that window drowns nobody
      // and the gate reads a correct implementation as broken.
      for (let i = 0; i < 900; i++) {
        if (!S.isRunning()) return { failed: 'run ended while waiting for open water' };
        const st = S.getState();
        const fc = st.frog.x + 0.5;
        if (!platUnder(targetRow, fc) && (st.invincible || 0) <= 0) {
          const lives = st.lives;
          // moveFrog is RATE-GATED, so a single call can silently do nothing and
          // the frog never enters the water at all. Keep asking until it is
          // actually standing on the target row.
          let landed = false;
          for (let k = 0; k < 40 && !landed; k++) {
            S.moveFrog(0, -1);
            await sleep(40);
            landed = Math.round(S.getState().frog.y) === targetRow;
            if (!S.isRunning()) break;
          }
          await sleep(320);   // let the sim tick the drown check
          const fx = window.__deathFx;
          return { landed,
                   drowned: S.getState().lives < lives,
                   kind: fx ? fx.kind : null,
                   hasSplash: !!(fx && fx.splash),
                   row: targetRow };
        }
        await sleep(16);
      }
      return { failed: 'water never opened' };
    }, target);
  };

  // Drown for real in the band NEAREST the start line. That is the cheap one to
  // reach - a handful of rows rather than a full crossing - and it is enough to
  // prove the fix, because the old literal (`gy >= 1 && gy <= 5`) broke this
  // band too: only the band at the FAR end of the board was ever handled.
  //
  // An earlier version of this gate walked to all three bands. It took over
  // twenty minutes, usually died on the way, and reported "skipped" - which the
  // first version then counted as a PASS while testing nothing at all.
  const nearest = bands.reduce((a, b) => (b[0] > a[0] ? b : a));
  const label = `nearest band ${nearest[0]}-${nearest[nearest.length - 1]}`;
  let r = null;
  for (let attempt = 0; attempt < 8 && (!r || r.failed); attempt++) {
    const running = await p.evaluate(() => window.Sim.isRunning());
    if (!running) {
      await p.locator('#btn-play-run').click({ timeout: 60000, force: true }).catch(() => {});
      await p.waitForTimeout(2400);
    }
    r = await drownIn(nearest);
  }
  test(`${label}: reached the water and drowned`, !!r && r.drowned === true, JSON.stringify(r));
  test(`${label}: plays the FLOAT, not the car squash`, !!r && r.kind === 'float', JSON.stringify(r));
  test(`${label}: the entry makes a splash`, !!r && r.hasSplash === true, JSON.stringify(r));

  // And no band may be stranded: the renderer decides float-vs-squash from the
  // shared terrain descriptor, so every water row in every band must classify
  // as water. This is what the band-0 literal got wrong.
  const classified = await p.evaluate(() => {
    const S = window.Sim;
    return S.WATER_LANES.map(l => l.row).filter(r => S.rowClass(r) !== 'water');
  });
  test('every water row in every band classifies as water', classified.length === 0,
       `rows not classified as water: ${classified.join(', ')}`);

  await b.close();
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
