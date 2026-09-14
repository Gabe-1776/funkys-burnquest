// Three things that should move and did not: car wheels, the gateway swirl,
// and the frog being drawn into the portal.
//
// Each had a different cause, so each is asserted separately:
//   wheels - every vehicle GLB is ONE welded mesh (nodes=1, meshes=1), so there
//            was no wheel object to turn. wheel-split.js carves them out of the
//            template at load.
//   swirl  - the spin code was live but fv's portal-vortex.json does not exist,
//            so portalVortex stayed null and only diorama ever swirled.
//   enter  - new: the celebration now hands the frog to the gate.
//
// Usage: node tools/motion-check.js [--url URL]
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
  // WAIT for the vehicles, do not assume. The funkyverse set is ~41MB of GLBs
  // and a car only gets userData.kind once its instance lands, so a fixed delay
  // reported "0 cars" on a loaded machine and failed a working build.
  await p.waitForFunction(() => {
    let n = 0;
    window.__scene.traverse(o => { if (o.userData && o.userData.kind === 'car') n++; });
    return n > 0;
  }, null, { timeout: 90000 }).catch(() => {});
  await p.waitForTimeout(1500);

  // ---- wheels -------------------------------------------------------------
  const wheels = await p.evaluate(() => {
    const out = { cars: 0, withWheels: 0, wheelCounts: [] };
    window.__scene.traverse(o => {
      if (!o.userData || o.userData.kind !== 'car') return;
      out.cars++;
      let n = 0;
      o.traverse(c => { if (c.userData && c.userData.isWheel) n++; });
      if (n) { out.withWheels++; out.wheelCounts.push(n); }
    });
    return out;
  });
  console.log(`        ${wheels.withWheels} of ${wheels.cars} cars carry split wheels ` +
              `(counts: ${[...new Set(wheels.wheelCounts)].join(',') || '-'})`);
  // The split is DISABLED (glb-assets.js WHEELED). It shipped damage: body
  // triangles that fell inside a wheel's radius were re-origined onto the wheel
  // and then rotated with it, smearing wedges out of the trucks and cars. The
  // assertion is inverted while it is off, so re-enabling it without tightening
  // the selection trips this gate instead of reaching players.
  const splitOn = wheels.withWheels > 0;
  test('wheel split is off until its selection is tightened', !splitOn,
       splitOn ? 'split is live again - verify no body triangles are captured' : '');

  // (Wheel rotation is not asserted while the split is off - there is nothing
  // to turn. Restore that check together with the split.)

  // ---- gateway swirl ------------------------------------------------------
  const swirl = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const get = () => window.__portalVortex || null;
    const v = get();
    if (!v) return { missing: true };
    const a = v.rotation.z;
    await sleep(600);
    return { before: a, after: get().rotation.z, procedural: !!v.userData.procedural };
  });
  test('the gateway has a vortex at all', !!swirl && !swirl.missing, JSON.stringify(swirl));
  test('the gateway swirls', !!swirl && !swirl.missing &&
       Math.abs(swirl.after - swirl.before) > 0.05, JSON.stringify(swirl));

  // ---- drawn into the portal ---------------------------------------------
  const enter = await p.evaluate(async () => {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const rig = window.__frogRig;
    if (!rig) return { noRig: true };
    // SAMPLE, do not time. updateDance advances on a FIXED 1/60 step per frame,
    // so wall-clock waits measure frame rate, not animation progress - a fixed
    // 1.5s wait on a loaded machine never reached the draw-in phase at all and
    // read the dance's squash-and-stretch as "no shrink".
    const before = rig.scale.x;
    window.Render3D.startCelebration();
    let min = before;
    for (let i = 0; i < 60; i++) {          // up to ~9s of real time
      await sleep(150);
      min = Math.min(min, rig.scale.x);
      if (min < 0.2) break;
    }
    window.Render3D.stopCelebration();
    await sleep(200);
    return { before, min, restored: rig.scale.x };
  });
  test('the frog shrinks away as the gate takes it',
       !!enter && enter.min < 0.25, JSON.stringify(enter));
  // Not exactly 1: the idle/hop animation scales the rig slightly every frame.
  test('the frog is restored to full size afterwards',
       !!enter && enter.restored > 0.8, JSON.stringify(enter));

  await b.close();
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
