// A/B Funky's body green IN THE GAME, against the real board and lighting.
// Recolours only the vertices that carry his lime (hat, glasses, chain and
// cross untouched) on the live model, then captures the gameplay view around
// him. No Blender rebuild per variant - pick one, then bake it into
// tools/make_funky.py.
//
// ONE browser (two at once hard-reset Gabriel's MacBook); captured through CDP
// because page.screenshot() blocks on the WebGL canvas under load.
//
// Usage: node tools/funky-green-ab.js [outdir]
const { chromium } = require('playwright');
const fs = require('fs');
const OUTDIR = process.argv[2] || 'test-shots/voxel/green-ab';
const URL = 'http://127.0.0.1:8099/index.html?render=3d&debug=1';
const BASE = [0.51, 0.78, 0.23];                 // the lime make_funky.py ships
const VARIANTS = {
  'A-current':     BASE,
  'B-vivid-lime':  [0.35, 0.90, 0.06],
  'C-neon':        [0.20, 1.00, 0.10],
  'D-yellow-lime': [0.62, 0.95, 0.05],
};

(async () => {
  fs.mkdirSync(OUTDIR, { recursive: true });
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForFunction(() => window.__frogRig && window.__frogRig.parent &&
                                window.__frogRig.parent.userData.anim, null, { timeout: 90000 });
  await p.waitForTimeout(1500);
  // Remember which vertices are his lime, once, from the untouched model.
  const n = await p.evaluate(base => {
    const idx = [];
    window.__frogRig.parent.userData.model.traverse(o => {
      if (!o.isMesh || !o.geometry.attributes.color) return;
      const c = o.geometry.attributes.color;
      for (let i = 0; i < c.count; i++) {
        if (Math.abs(c.getX(i) - base[0]) < 0.02 && Math.abs(c.getY(i) - base[1]) < 0.02 &&
            Math.abs(c.getZ(i) - base[2]) < 0.02) idx.push(i);
      }
      window.__greenIdx = { attr: c, idx };
    });
    return idx.length;
  }, BASE);
  console.log(`${n} lime vertices found`);
  const cdp = await ctx.newCDPSession(p);
  const box = await p.evaluate(() => {
    const g = window.__frogRig.parent, cam = window.__frogCam;
    const v = g.getWorldPosition(new window.THREE.Vector3()).project(cam);
    const cx = (v.x + 1) / 2 * innerWidth, cy = (1 - v.y) / 2 * innerHeight;
    const w = 300, h = 240;                     // wide: show him against the board
    return { x: Math.max(0, cx - w / 2), y: Math.max(0, cy - h * 0.62), width: w, height: h, scale: 1 };
  });
  for (const [name, rgb] of Object.entries(VARIANTS)) {
    await p.evaluate(rgb => {
      const { attr, idx } = window.__greenIdx;
      for (const i of idx) attr.setXYZ(i, rgb[0], rgb[1], rgb[2]);
      attr.needsUpdate = true;
    }, rgb);
    await p.waitForTimeout(700);
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', clip: box });
    fs.writeFileSync(`${OUTDIR}/${name}.png`, Buffer.from(shot.data, 'base64'));
    console.log(`captured ${name}`);
  }
  await b.close();
})().catch(e => { console.error(e); process.exit(1); });
