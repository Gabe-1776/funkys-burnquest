// Does the rigged Funky actually move his limbs in the game?
//
// Gabriel (2026-09-11): "he needs better movement lol like his legs moving and
// arms". tools/rig_funky.py gives him a skeleton, bone weights and idle / hop /
// dance clips; render3d plays idle at rest and scrubs the hop clip through each
// hop. This asserts that chain in the real page, not in Blender:
//   - the rigged GLB loaded (not the static fallback), with all three clips
//   - it is a real SkinnedMesh with the 14-bone skeleton
//   - the render loop drives the mixer on every rendered frame
//   - during a REAL hop the left hand rises in model space (arms go up)
//   - he is actually drawn on screen (shown-vs-hidden pixel difference)
//
// ONE browser, foreground, and never alongside another browser gate: two at
// once hard-reset Gabriel's MacBook (AGENTS.md "Traps").
//
// Usage: node tools/rig-check.js [--url URL]
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
  const errors = [];
  p.on('pageerror', e => errors.push('pageerror: ' + e.message));
  p.on('console', m => { if (/rigged character failed/.test(m.text())) errors.push(m.text()); });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });

  const loaded = await p.waitForFunction(
    () => !!(window.__frogRig && window.__frogRig.parent && window.__frogRig.parent.userData.anim),
    null, { timeout: 90000 }).then(() => true).catch(() => false);
  test('the rigged Funky loaded (not the static fallback)', loaded,
       errors.join(' | ') || 'no userData.anim on the character after 90s');
  if (!loaded) { await b.close(); done(); return; }

  const info = await p.evaluate(() => {
    const an = window.__frogRig.parent.userData.anim;
    let skinned = 0, bones = 0;
    window.__frogRig.parent.userData.model.traverse(o => {
      if (o.isSkinnedMesh) { skinned++; bones = Math.max(bones, o.skeleton.bones.length); }
    });
    return { clips: Object.keys(an.act).sort(), skinned, bones, probe: !!an.probe };
  });
  console.log(`        clips ${info.clips.join(',')}; ${info.skinned} skinned mesh, ${info.bones} bones`);
  test('idle, hop and dance clips are all present',
       ['dance', 'hop', 'idle'].every(n => info.clips.includes(n)), `clips: ${info.clips}`);
  test('it is a real skinned mesh with the 14-bone skeleton',
       info.skinned >= 1 && info.bones === 14, `${info.skinned} skinned, ${info.bones} bones`);
  test('the hand bone is there to measure', info.probe);

  await p.evaluate(() => {
    window.__animTrace = [];
    window.__animFrame0 = window.__renderer.info.render.frame;
  });
  // Sideways along the start row: safe ground, so no death resets the pose.
  for (const key of ['ArrowLeft', 'ArrowLeft', 'ArrowRight']) {
    await p.keyboard.press(key);
    await p.waitForTimeout(450);
  }
  const res = await p.evaluate(() => {
    const tr = window.__animTrace; window.__animTrace = null;
    return { tr, frames: window.__renderer.info.render.frame - window.__animFrame0 };
  });
  const tr = res.tr || [];
  const idle = tr.filter(r => r[0] === 'idle').map(r => r[2]).sort((a, c) => a - c);
  const restY = idle.length ? idle[Math.floor(idle.length / 2)] : NaN;
  const hop = tr.filter(r => r[0] === 'hop');
  const lift = hop.length ? Math.max(...hop.map(r => r[2] - restY)) : 0;
  const idleSpan = idle.length ? idle[idle.length - 1] - idle[0] : 0;
  console.log(`        rendered ${res.frames}, traced ${tr.length}; ${hop.length} mid-hop frames; ` +
              `hand rest y ${restY.toFixed(3)}, highest lift ${lift.toFixed(3)}, idle sway ${idleSpan.toFixed(3)}`);
  test('the loop drives the animation every rendered frame',
       res.frames > 4 && tr.length >= res.frames * 0.9, `${tr.length} traced of ${res.frames} rendered`);
  test('a real hop plays the hop clip', hop.length >= 2, `${hop.length} hop frames`);
  test('his hand rises during the hop (the arms move)', lift > 0.08,
       `highest hand lift ${lift.toFixed(3)} above rest`);
  test('idle is alive but calm', idleSpan > 0.001 && idleSpan < lift,
       `idle sway ${idleSpan.toFixed(3)} vs hop lift ${lift.toFixed(3)}`);
  // ---- is he actually ON SCREEN? ------------------------------------------
  // Everything above proves the bones move; none of it proves a player can SEE
  // him. Render the same frame twice - Funky shown, Funky hidden - and count
  // the pixels that change around his screen position. That works whatever
  // the lighting does to his colours: the first version counted "hat purple"
  // and "neon" pixels and found ZERO for a model known to be visible, because
  // the sunset light and tone mapping turn the hat magenta. He is forced
  // visible for the probe - the respawn blink is gameplay, not a render fault
  // (it is also what emptied an earlier in-game close-up).
  const shot = await p.evaluate(() => {
    const r = window.__renderer, sc = window.__scene, cam = window.__frogCam;
    const g = window.__frogRig.parent, m = g.userData.model;
    const wasG = g.visible, wasM = m.visible;
    const c = r.domElement, H = c.height;
    const v = g.getWorldPosition(new THREE.Vector3()).project(cam);
    const px = (v.x + 1) / 2 * c.width, py = (1 - v.y) / 2 * H;
    const w = Math.round(H * 0.16), h = Math.round(H * 0.24);
    const grab = () => {
      r.render(sc, cam);                       // read back in the SAME task
      const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
      const ctx = cv.getContext('2d');
      ctx.drawImage(c, px - w / 2, py - h * 0.85, w, h, 0, 0, w, h);
      return ctx.getImageData(0, 0, w, h).data;
    };
    g.visible = true; m.visible = true;
    const shown = grab();
    m.visible = false;
    const hidden = grab();
    g.visible = wasG; m.visible = wasM;
    let changed = 0;
    for (let i = 0; i < shown.length; i += 4) {
      if (Math.abs(shown[i] - hidden[i]) + Math.abs(shown[i + 1] - hidden[i + 1]) +
          Math.abs(shown[i + 2] - hidden[i + 2]) > 30) changed++;
    }
    return { changed, area: w * h };
  });
  console.log(`        on screen: ${shot.changed} of ${shot.area} px around him change when he is hidden ` +
              `(${(100 * shot.changed / shot.area).toFixed(1)}%)`);
  test('he is drawn on screen (hiding him changes the picture)',
       shot.changed > shot.area * 0.05,
       `only ${shot.changed} px changed - the model is not being drawn where he stands`);

  test('no page errors and no fallback', errors.length === 0, errors.join(' | '));

  await b.close();
  done();
})().catch(e => { console.error(e); process.exit(1); });

function done() {
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
}
