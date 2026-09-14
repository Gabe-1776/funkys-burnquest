// Shades camera rig scale, per pointer class (needs a server on :8099).
//
// The shades rig offset is SHADES_HEIGHT 2.30 / SHADES_BACK 6.00, scaled by
// shadesRigScale(): 1.35 on coarse+portrait, 1 on coarse landscape, 1.25 on a
// fine pointer (desktop). Measured as the camera's offset from the frog in
// shades view - a rig that ignores the scale, or a matchMedia that misreads
// the pointer, shows up here directly.
//
// Assertions per context (measured, not derived):
//   desktop fine   1280x800  -> dz 7.50, dy 2.875  (rs 1.25)
//   coarse portrait 390x780  -> dz 8.10, dy 3.105  (rs 1.35)
//   coarse landscape 1024x640 -> dz 6.00, dy 2.30  (rs 1)
// Each context asserts a DIFFERENT pair, so a code path that ignores the
// pointer or the scale fails at least one row.
const { chromium } = require('playwright');
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

const CTX = [
  { name: 'desktop-fine',     w: 1280, h: 800, touch: false, dy: 2.875, dz: 7.50 },
  { name: 'coarse-portrait',  w: 390,  h: 780, touch: true,  dy: 3.105, dz: 8.10 },
  { name: 'coarse-landscape', w: 1024, h: 640, touch: true,  dy: 2.30,  dz: 6.00 },
];
const TOL = 0.08;

(async () => {
  const browser = await chromium.launch();
  let fail = false;
  const say = (ok, m) => { console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${m}`); if (!ok) fail = true; };

  for (const v of CTX) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h }, hasTouch: v.touch, isMobile: v.touch,
    });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForTimeout(4200);
    await p.locator('.campaign-btn').first().click({ force: true });
    await p.waitForTimeout(400);
    await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
    await p.waitForTimeout(2500);

    await p.evaluate(() => { window.__forceShades = true; });
    // __forceShades snaps the blend on its first frame; the wait is belt and
    // braces for a slow headless loop.
    await p.waitForFunction(() => window.__camBlend >= 0.995, null, { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(200);

    const m = await p.evaluate(() => {
      const THREE = window.THREE, cam = window.__renderCam, rig = window.__frogRig;
      rig.updateMatrixWorld(true);
      const f = new THREE.Vector3(); rig.getWorldPosition(f);
      return {
        coarse: window.matchMedia('(pointer: coarse)').matches,
        aspect: +cam.aspect.toFixed(3),
        blend: +window.__camBlend.toFixed(3),
        dy: +cam.position.y.toFixed(3),  // rig height is absolute, not frog-relative
        dz: +(cam.position.z - f.z).toFixed(3),
        frogNdcY: +f.project(cam).y.toFixed(3),   // solver target ~-0.92
      };
    });
    console.log(`${v.name}:`, JSON.stringify(m));
    say(Math.abs(m.dy - v.dy) < TOL && Math.abs(m.dz - v.dz) < TOL,
        `${v.name} rig offset dy ${m.dy} dz ${m.dz} (expect ~${v.dy}/${v.dz})`);
    say(m.blend >= 0.99, `${v.name} reached full shades blend (got ${m.blend})`);
    await ctx.close();
  }
  await browser.close();
  console.log(fail ? '\nFAIL' : '\nPASS: shades rig scale applies per pointer class');
  process.exit(fail ? 1 : 0);
})();
