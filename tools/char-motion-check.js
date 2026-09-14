// Funky is a single unrigged bake - no skeleton, no glTF animation clips - so
// the only thing that could ever have moved him was the rig group's uniform
// squash. char-motion.js adds a height-weighted vertex deform on top.
//
// This gate does NOT eyeball a screenshot. It checks three separable things:
//   1. the deform reached the COMPILED program (the uniform is in the shader
//      source three.js actually built, not just in our patch string),
//   2. the driver uniforms MOVE while the character hops,
//   3. the deform is height-weighted - the crown displaces and the feet do not,
//      evaluated against the same formula the shader runs.
//
// Run against the pre-fix build and step 1 fails: window.BurnQuestCharMotion
// does not exist.
//
// Usage: node tools/char-motion-check.js [--url URL]
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
// Diorama: since 2026-09-11 the funkyverse Funky is RIGGED (tools/rig_funky.py,
// checked by tools/rig-check.js) and no longer uses the vertex deform. The
// diorama frog still does, so this gate tests it there.
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=diorama'));

let passed = 0, failed = 0;
const test = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failed++; }
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  // Page errors FAIL the gate. They used to be printed and ignored: on
  // 2026-09-11 this gate reported PASS 11/11 over a stream of
  // "Cannot read properties of null (reading 'scale')" in the diorama theme.
  const pageErrors = [];
  p.on('pageerror', e => { pageErrors.push(e.message); console.log('        pageerror: ' + e.message); });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });

  // Wait for the MODEL, not a fixed delay. The placeholder renders instantly
  // and the bake swaps in whenever the fetch lands; on a loaded machine that is
  // seconds later, and asserting early would fail a working build.
  const arrived = await p.waitForFunction(
    () => !!(window.__frogRig && window.__frogRig.parent &&
             window.__frogRig.parent.userData.model),
    null, { timeout: 90000 }
  ).then(() => true).catch(() => false);
  test('the modelled character loads', arrived,
       'no userData.model on the frog group - nothing to deform');
  if (!arrived) { await b.close(); done(); return; }

  // ---- 1. the deform is in the compiled program ---------------------------
  const compiled = await p.evaluate(() => {
    const out = { module: !!window.BurnQuestCharMotion, flagged: false,
                  materials: 0, patched: 0, depthPatched: 0 };
    const grp = window.__frogRig.parent;
    out.flagged = !!grp.userData.motion;
    const m = grp.userData.model;
    if (!m) return out;
    m.traverse(n => {
      if (!n.isMesh) return;
      const mats = Array.isArray(n.material) ? n.material : [n.material];
      // The shader object is the one three.js handed to onBeforeCompile, and
      // it only does that while BUILDING the program. Its presence is proof
      // the hook ran; `material.program` is not - three.js stopped exposing
      // that in r112 and reading it silently measured nothing.
      const built = mat => {
        const sh = mat && mat.userData && mat.userData.__cmShader;
        return !!(sh && sh.vertexShader.indexOf('uTwist') > -1);
      };
      mats.forEach(mat => { out.materials++; if (built(mat)) out.patched++; });
      if (built(n.customDepthMaterial)) out.depthPatched++;
    });
    return out;
  });
  console.log(`        module=${compiled.module} flagged=${compiled.flagged} ` +
              `materials=${compiled.materials} patched=${compiled.patched} ` +
              `depth=${compiled.depthPatched}`);
  test('char-motion.js is loaded', compiled.module);
  test('the character was attached', compiled.flagged);
  test('every character material compiled WITH the deform',
       compiled.materials > 0 && compiled.patched === compiled.materials,
       `${compiled.patched}/${compiled.materials} carry uTwist in the compiled program`);
  test('the shadow depth material carries it too', compiled.depthPatched > 0,
       'the cast shadow would show the undeformed silhouette');

  // ---- 2. the driver uniforms move during a hop ---------------------------
  // Sampled across a real hop, driven by a real key press - not by poking the
  // uniforms, which would prove nothing about the render loop.
  // The render loop records its own trace (char-motion.js, opt-in via
  // window.__cmTrace). Every sampler run from OUTSIDE the loop was throttled:
  // rAF delivered 18 of 90 frames, setTimeout 5 of 60, and Node-side polling
  // missed every 200ms hop and read pure idle. The loop cannot miss itself.
  const startPos = await p.evaluate(() => {
    window.__cmTrace = [];
    // A build without the hook reports -1 and FAILS the frame check below,
    // rather than throwing here and ending the gate with a stack trace.
    window.__cmFrame0 = window.__renderer ? window.__renderer.info.render.frame : null;
    const g = window.__frogRig.parent;
    return [g.position.x, g.position.z];
  });
  // Real key presses, spaced wider than the 190ms sim rate gate and the 70ms
  // diagonal window, so no press is swallowed by the one before it. SIDEWAYS
  // along the start row, which is safe ground: pressing Up lands on road row
  // 35, a car hit respawns the frog at the start, and the net movement reads
  // 0.00 on a run where input worked fine.
  for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowLeft']) {
    await p.keyboard.press(key);
    await p.waitForTimeout(450);
  }
  const res = await p.evaluate(() => {
    const g = window.__frogRig.parent;
    const tr = window.__cmTrace; window.__cmTrace = null;
    return { tr, end: [g.position.x, g.position.z],
             frames: window.__cmFrame0 === null ? -1
                   : window.__renderer.info.render.frame - window.__cmFrame0 };
  });
  const tr = res.tr || [];
  const hopFrames = tr.filter(r => r[0] < 1);
  const amp = await p.evaluate(() => window.BurnQuestCharMotion && window.BurnQuestCharMotion.AMP);
  const travelled = Math.hypot(res.end[0] - startPos[0], res.end[1] - startPos[1]);
  console.log(`        rendered ${res.frames} frames, traced ${tr.length}`);

  // Each trace row is [hopT, whip, twist, tuck] exactly as the render loop set
  // them. Asserting a PEAK here was aliasing: at ~9fps a 200ms hop gets about
  // one frame at a random phase, so the same code read spans of 0.133, 0.218
  // and 0.242 on three runs. Checking every frame against the curve AT THE
  // PHASE THE LOOP PASSED IN is exact at any frame rate.
  let worst = 0, peak = 0;
  if (amp) {
    hopFrames.forEach(([t, whip, twist, tuck]) => {
      const s2 = Math.sin(t * Math.PI * 2), s1 = Math.sin(t * Math.PI);
      worst = Math.max(worst,
        Math.abs(whip - s2 * amp.whip),
        Math.abs(twist + s2 * amp.twist),
        Math.abs(tuck - s1 * amp.tuck));
      peak = Math.max(peak, Math.abs(whip), Math.abs(twist), tuck);
    });
  }
  console.log(`        ${hopFrames.length} mid-hop frames; worst deviation from the curve ` +
              `${worst.toExponential(1)}; largest live value ${peak.toFixed(3)}; ` +
              `moved ${travelled.toFixed(2)} units`);
  test('the render loop drives the deform every frame',
       res.frames > 4 && tr.length >= res.frames * 0.9,
       `${tr.length} traced of ${res.frames} rendered`);
  // This check exists to prove a hop HAPPENED, so the deform numbers below are
  // readings of a real hop and not of idle. One landed column proves that.
  // Presses landed is reported rather than asserted: at ~9fps one of three has
  // been seen to drop, on a diff that never touches input, and the next run
  // landed all three.
  console.log(`        ${Math.round(travelled)} of 3 presses landed`);
  test('the key presses actually moved the character', travelled > 0.9,
       `moved ${travelled.toFixed(2)} units - no hop landed, input did not reach the sim`);
  test('every mid-hop frame follows the hop curve', !!amp && hopFrames.length >= 2 && worst < 1e-3,
       amp ? `${hopFrames.length} hop frames, worst deviation ${worst.toFixed(4)}`
           : 'no BurnQuestCharMotion.AMP - the module is not loaded');
  // Guards the one thing the curve check cannot: a curve followed perfectly at
  // zero amplitude. Any real hop frame carries at least one visible term.
  test('the character visibly deforms mid-hop', peak > 0.03,
       `largest live deform value ${peak.toFixed(3)}`);

  // ---- 3. height weighting: crown moves, feet stay ------------------------
  // Read from the COMPILED shader, not recomputed here. The first version of
  // this check re-ran the weight formula inside the gate, so it passed on the
  // pre-fix build that had no deform at all - a check that cannot fail.
  const weighted = await p.evaluate(() => {
    const grp = window.__frogRig.parent;
    let out = null;
    grp.userData.model.traverse(n => {
      if (out || !n.isMesh) return;
      n.geometry.computeBoundingBox();
      const bb = n.geometry.boundingBox;
      const m = Array.isArray(n.material) ? n.material[0] : n.material;
      const sh = m && m.userData && m.userData.__cmShader;
      out = { y0: bb.min.y, y1: bb.max.y,
              uY0: sh ? sh.uniforms.uY0.value : null,
              uYH: sh ? sh.uniforms.uYH.value : null,
              squared: !!(sh && /float w = h \* h;/.test(sh.vertexShader)) };
    });
    return out;
  });
  const hasU = weighted && weighted.uY0 !== null;
  if (hasU) {
    console.log(`        mesh y ${weighted.y0.toFixed(3)}..${weighted.y1.toFixed(3)}; ` +
                `shader uY0 ${weighted.uY0.toFixed(3)}, top ${(weighted.uY0 + weighted.uYH).toFixed(3)}`);
  }
  // uY0 at the mesh's lowest vertex means h = 0 there, so the feet get zero
  // weight and cannot slide. The top at the highest vertex puts h = 1 on the
  // crown. Squared weighting keeps the mid-body at a quarter.
  test('the feet stay planted',
       hasU && Math.abs(weighted.uY0 - weighted.y0) < 1e-4,
       hasU ? `shader base ${weighted.uY0} vs mesh base ${weighted.y0}` : 'no compiled deform to read');
  test('the upper body carries the motion',
       hasU && Math.abs(weighted.uY0 + weighted.uYH - weighted.y1) < 1e-4 && weighted.squared,
       hasU ? 'the weight span or the squared curve does not match the mesh' : 'no compiled deform to read');

  test('no page errors', pageErrors.length === 0,
       `${pageErrors.length} page errors, first: ${pageErrors[0] || ''}`);

  // No page.screenshot() here: it blocks indefinitely while the WebGL canvas
  // composites under load. tools/ has CDP-based capture if a still is wanted.
  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });

function done() {
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
