// In-game close-up of Funky, for judging his colours under the GAME's lighting
// (Blender's workbench renders are not the game's hemi + sun + tone mapping).
// Saves a crop around his projected bounds at 2x device scale.
//
// Captured through CDP Page.captureScreenshot: page.screenshot() blocks
// indefinitely while the WebGL canvas composites under load. ONE browser only -
// two at once hard-reset Gabriel's MacBook (AGENTS.md "Traps").
//
// Usage: node tools/funky-shot.js [out.png] [--url URL]
const { chromium } = require('playwright');
const fs = require('fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const OUT = (process.argv[2] && !process.argv[2].startsWith('--')) ? process.argv[2] : 'test-shots/funky-ingame.png';
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForFunction(() => window.__frogRig && window.__frogRig.parent &&
                                window.__frogRig.parent.userData.model, null, { timeout: 90000 });
  // Wait out the spawn blink: while invincible the frog flickers, and a
  // capture on an off frame shows empty grass (it did, 2026-09-11).
  await p.waitForFunction(() => Sim.getState().invincible <= 0, null, { timeout: 30000 }).catch(() => {});
  await p.waitForTimeout(600);
  const box = await p.evaluate(() => {
    const m = window.__frogRig.parent.userData.model, cam = window.__frogCam;
    const bb = new (window.THREE.Box3)().setFromObject(m);
    const pts = [];
    for (const x of [bb.min.x, bb.max.x]) for (const y of [bb.min.y, bb.max.y]) for (const z of [bb.min.z, bb.max.z])
      pts.push(new (window.THREE.Vector3)(x, y, z).project(cam));
    const W = innerWidth, H = innerHeight;
    const xs = pts.map(v => (v.x + 1) / 2 * W), ys = pts.map(v => (1 - v.y) / 2 * H);
    const pad = 24;
    return { x: Math.max(0, Math.min(...xs) - pad), y: Math.max(0, Math.min(...ys) - pad),
             w: Math.max(...xs) - Math.min(...xs) + 2 * pad, h: Math.max(...ys) - Math.min(...ys) + 2 * pad };
  });
  const cdp = await ctx.newCDPSession(p);
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png', clip: { x: box.x, y: box.y, width: box.w, height: box.h, scale: 1 } });
  fs.writeFileSync(OUT, Buffer.from(shot.data, 'base64'));
  console.log(`wrote ${OUT} (${Math.round(box.w)}x${Math.round(box.h)} css px around Funky)`);
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
