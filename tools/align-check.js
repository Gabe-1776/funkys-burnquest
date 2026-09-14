// Does the frog's body actually rest on the platform it is riding?
//
// INDEPENDENCE MATTERS HERE. An earlier version of this gate compared the
// renderer's own rideY against its own rideTop - two placement values from the
// same code path - so it could only ever confirm that the renderer agreed with
// itself. It also printed "no rides captured" and exited 0, which it really did
// mid-session, reporting success while measuring nothing. Vulcan's structure
// audit flagged both; see ~/knowledge/game-dev/GAME-STRUCTURE-RULES.md rule 10.
//
// This version measures GEOMETRY on both sides:
//   feet = world Box3 of the frog's actual meshes, with the flat shadow ring
//          excluded (it sits below the body and inflates the bounds)
//   deck = world Box3 of the platform group the sim says the frog is riding,
//          located by the sim's own platform list, not by guessing at distance
// and it FAILS - non-zero exit - on a violated tolerance OR on missing samples.
//
// Usage: node tools/align-check.js [--url URL] [--tol 0.02]
const { chromium } = require('playwright');

const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));
const TOL = parseFloat(arg('--tol', '0.02'));
const KINDS = ['log', 'turtle', 'lilypad'];

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 });
  await p.waitForTimeout(2500);

  const seen = {};
  // Budget generously. Which platform kinds get ridden depends on where the
  // conveyor lanes happen to be when the frog arrives, so a tight budget makes
  // this gate fail intermittently on "NO SAMPLE" - indistinguishable from a
  // real defect, and a flaky gate gets ignored.
  for (let step = 0; step < 700 && Object.keys(seen).length < KINDS.length; step++) {
    const r = await p.evaluate(() => {
      const S = window.Sim;
      if (!S.isRunning()) return { dead: true };
      const st = S.getState();
      const THREE = window.THREE;
      const frog = window.__frogRig;
      if (!frog || !window.__scene) return { skip: true };

      const row = Math.round(st.frog.y);
      const water = new Set((S.WATER_LANES || []).map(l => l.row));
      if (!water.has(row)) return { row, riding: false, why: 'not a water row' };

      // Which platform does the SIM say we are on? Ask it, do not guess.
      const fx = st.frog.x + 0.5;
      const kindOf = { log: st.logs, turtle: st.turtles, lilypad: st.lilypads };
      let kind = null, plat = null;
      for (const k of Object.keys(kindOf)) {
        const hit = (kindOf[k] || []).find(
          pl => Math.round(pl.y) === row && fx >= pl.x && fx <= pl.x + pl.w);
        if (hit) { kind = k; plat = hit; break; }
      }
      if (!kind) return { row, riding: false, why: 'sim says no platform under frog' };

      // FEET: real geometry. The shadow ring is a flat disc parented to the
      // frog that sits below the body; including it reads ~0.19 too low.
      const ring = frog.userData && frog.userData.ring;
      const feetBox = new THREE.Box3();
      let any = false;
      frog.updateMatrixWorld(true);
      frog.traverse(o => {
        if (!o.isMesh || !o.visible || o === ring) return;
        let q = o, isRing = false;
        while (q) { if (q === ring) { isRing = true; break; } q = q.parent; }
        if (isRing) return;
        feetBox.expandByObject(o);
        any = true;
      });
      if (!any || !isFinite(feetBox.min.y)) return { row, riding: false, why: 'no frog meshes' };

      // DECK: real geometry of the matching platform group in the scene.
      // The frog is parented to a Group, not the scene, so frog.position is
      // LOCAL (z = 0) while platform bounds are WORLD (z = -17). Comparing the
      // two matched nothing and the gate reported NO SAMPLE. Take the world
      // position explicitly rather than assuming a parent.
      const fwp = new THREE.Vector3();
      frog.getWorldPosition(fwp);
      let deck = null, best = 1e9;
      window.__scene.traverse(o => {
        if (!o.userData || o.userData.kind !== kind || !o.visible) return;
        // Measure the REAL model mesh where the loader recorded one. Measuring
        // the group walks its hidden placeholder primitives too, which reported
        // the log's deck 0.188 too high - and because the renderer made the same
        // mistake, this gate agreed with it and reported no gap.
        const target = (o.userData && o.userData.model) || o;
        target.updateMatrixWorld(true);
        const bx = new THREE.Box3().setFromObject(target);
        if (!isFinite(bx.max.y)) return;
        const c = bx.getCenter(new THREE.Vector3());
        const dz = Math.abs(c.z - fwp.z);
        if (dz > 0.6) return;                       // must be this row
        const dx = Math.abs(c.x - fwp.x);
        if (dx < best) { best = dx; deck = bx.max.y; }
      });
      if (deck === null) return { row, kind, riding: false, why: 'no scene group with kind ' + kind };
      return { row, kind, riding: true, feet: feetBox.min.y, deck };
    });

    if (r.dead) {
      const btn = await p.$('#btn-play-run');
      if (btn) { await btn.click().catch(() => {}); await p.waitForTimeout(1800); }
      continue;
    }
    if (process.env.TRACE) console.log('  trace', JSON.stringify(r));
    if (r.riding && !seen[r.kind]) seen[r.kind] = r;

    // Only hop forward when the next row is safe; walking blindly drowns the
    // frog on the first water row and no ride is ever sampled.
    const hopped = await p.evaluate(() => {
      const S = window.Sim, st = S.getState();
      const row = Math.round(st.frog.y), next = row - 1;
      const water = new Set((S.WATER_LANES || []).map(l => l.row));
      if (water.has(next)) {
        const fx = st.frog.x + 0.5;
        const on = [...st.logs, ...st.turtles, ...st.lilypads].some(
          pl => Math.round(pl.y) === next && fx >= pl.x && fx <= pl.x + pl.w);
        if (!on) return false;
      }
      S.moveFrog(0, -1);
      return true;
    });
    await p.waitForTimeout(hopped ? 340 : 90);
  }
  await b.close();

  let failed = false;
  for (const k of KINDS) {
    const r = seen[k];
    if (!r) {
      console.log(`  ${k.padEnd(8)} NO SAMPLE`);
      failed = true;                     // missing evidence is a failure
      continue;
    }
    const gap = r.feet - r.deck;
    const bad = Math.abs(gap) > TOL;
    if (bad) failed = true;
    console.log(`  ${k.padEnd(8)} feet ${r.feet.toFixed(3)}  deck ${r.deck.toFixed(3)}` +
                `  gap ${gap >= 0 ? '+' : ''}${gap.toFixed(3)}  ${bad ? 'FAIL' : 'ok'}`);
  }
  console.log(failed
    ? `\nFAIL: gap outside +/-${TOL} or platform kind never sampled`
    : `\nPASS: every platform kind sampled, all gaps within +/-${TOL}`);
  process.exit(failed ? 1 : 0);
})();
