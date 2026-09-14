// What does the game ACTUALLY look like on a phone?
//
// Measures rather than eyeballs, at real device viewports, portrait AND
// landscape: how far back the camera sits, how big one grid tile is in screen
// pixels, whether the frog is even in frame, and whether HUD/controls collide.
// Screenshots go through CDP because page.screenshot() blocks while the WebGL
// canvas composites.
//
// PIXELS PER TILE is the number that decides mobile legibility. Two earlier
// versions of that measurement were wrong, both by assuming instead of reading:
//   1. projecting the frog's bounding-box corners - a corner near the camera's
//      near plane projects to a huge magnitude, reporting a 189x287px frog on a
//      desktop where it is plainly about 40x60;
//   2. rebuilding the renderer's worldZ as (rows-1)/2 - row, when the real one
//      is row - (rows-1)/2 - the mirror image, so every sample landed at the
//      wrong depth and even the desktop frog read as off-screen.
// The frog rig knows where it is in world space; ask it.
//
// Usage: node tools/mobile-probe.js [--url URL]
const { chromium } = require('playwright');
const fs = require('fs');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));

const VIEWPORTS = [
  { name: 'iphone-se-portrait',  w: 375,  h: 667,  touch: true },
  { name: 'iphone14-portrait',   w: 393,  h: 852,  touch: true },
  { name: 'pixel7-portrait',     w: 412,  h: 915,  touch: true },
  { name: 'iphone14-landscape',  w: 852,  h: 393,  touch: true },
  { name: 'ipad-portrait',       w: 820,  h: 1180, touch: true },
  { name: 'desktop',             w: 1280, h: 800,  touch: false },
];

// Desktop is the reference: whatever it measures is what "right" looks like.
const MIN_PX_PER_TILE = 26;

const MEASURE = () => {
  const S = window.Sim, THREE = window.THREE;
  const st = S.getState();
  const cam = window.__renderCam || null;
  const dbg = window.__camDebug ? window.__camDebug() : {};
  const rig = window.__frogRig;

  let pxPerTile = null, frogOnScreen = null, frogAt = null;
  if (cam && rig) {
    rig.updateMatrixWorld(true);
    const origin = new THREE.Vector3();
    rig.getWorldPosition(origin);
    // NDC -> VIEWPORT pixels, via the CANVAS box. The canvas is not the window
    // in portrait any more - it is a flex child above the control dock - so
    // scaling by innerWidth/innerHeight put the frog hundreds of pixels below
    // where it really is and reported it colliding with the D-pad when it was
    // nowhere near it.
    const cbox = document.getElementById('game-canvas').getBoundingClientRect();
    const toPx = v3 => {
      const v = v3.clone().project(cam);
      return { x: cbox.left + (v.x * 0.5 + 0.5) * cbox.width,
               y: cbox.top + (-v.y * 0.5 + 0.5) * cbox.height, z: v.z };
    };
    const a = toPx(origin);
    const b = toPx(origin.clone().add(new THREE.Vector3(1, 0, 0)));
    pxPerTile = +Math.hypot(b.x - a.x, b.y - a.y).toFixed(1);
    frogAt = { x: Math.round(a.x), y: Math.round(a.y) };
    frogOnScreen = a.z > -1 && a.z < 1 &&
                   a.x >= cbox.left && a.x <= cbox.right &&
                   a.y >= cbox.top && a.y <= cbox.bottom;
  }

  const rect = el => {
    if (!el) return null;
    const b = el.getBoundingClientRect();
    if (!b.width || !b.height) return null;
    return { x: Math.round(b.x), y: Math.round(b.y), w: Math.round(b.width),
             h: Math.round(b.height), bottom: Math.round(b.bottom), right: Math.round(b.right) };
  };
  const r = id => rect(document.getElementById(id));
  const q = sel => rect(document.querySelector(sel));
  const hit = (a, b) => !!(a && b) &&
    !(a.x >= b.right || a.right <= b.x || a.y >= b.bottom || a.bottom <= b.y);

  const pod = r('hud-pod'), score = q('.score-box'), combo = r('combo-hud');

  // The movement buttons are gone - mobile input is a swipe - so the only
  // things that can sit over the board are the HUD readouts themselves.
  return {
    vw: window.innerWidth, vh: window.innerHeight,
    cols: st.cols, camDist: dbg.camDist ? +dbg.camDist.toFixed(2) : null,
    viewCols: dbg.VIEW_COLS, aspect: cam ? +cam.aspect.toFixed(3) : null,
    pxPerTile, frogOnScreen, frogAt,
    // Where the frog sits down the screen, 0 = top, 1 = bottom. This is what
    // the camera look-ahead actually controls, so it is what to tune against.
    // Fraction down the CANVAS (what the camera framed), not the window.
    frogYPct: (frogAt && cam) ? +((frogAt.y - document.getElementById('game-canvas')
                 .getBoundingClientRect().top) /
                 document.getElementById('game-canvas').getBoundingClientRect().height).toFixed(3) : null,
    shadesActive: !!window.__shadesOn, camBlend: window.__camBlend != null ? +window.__camBlend.toFixed(2) : null,
    problems: [
      hit(pod, score) && 'pod overlaps score',
      pod && pod.right > window.innerWidth && 'pod off right edge',
      combo && combo.bottom > window.innerHeight && 'combo off bottom',
      !frogOnScreen && 'frog not in frame',
    ].filter(Boolean),
  };
};

const ONLY = arg('--only', null);          // substring filter while iterating

(async () => {
  const browser = await chromium.launch();
  const rows = [];

  for (const v of VIEWPORTS.filter(v => !ONLY || v.name.includes(ONLY))) {
    const ctx = await browser.newContext({
      viewport: { width: v.w, height: v.h },
      hasTouch: v.touch, isMobile: v.touch, deviceScaleFactor: 2,
    });
    const p = await ctx.newPage();
    await p.goto(URL, { waitUntil: 'load' });
    await p.waitForTimeout(4200);
    await p.locator('.campaign-btn').first().click({ force: true });
    await p.waitForTimeout(400);
    await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
    await p.waitForTimeout(3000);

    const cdp = await ctx.newCDPSession(p);
    // A fresh CDP session does NOT inherit the context's viewport emulation:
    // captures came back at CDP's own 800x600 default, cropping a
    // desktop-width layout down to phone width so the HUD looked cut off and
    // the control dock looked empty. State it explicitly.
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: v.w, height: v.h, deviceScaleFactor: 2, mobile: !!v.touch,
    });
    // An explicit clip is required: without it CDP captures at its own default
    // 800x600 regardless of the emulated viewport, which silently cropped the
    // control dock out of every portrait shot.
    const grab = async name => {
      // No clip, captureBeyondViewport false: this captures the emulated
      // viewport exactly as the device sees it. Adding an explicit clip made
      // CDP re-lay-out the page at its natural width and then crop a
      // desktop-width layout down to phone width - the HUD came out cut off
      // and the control dock read as empty.
      const r = await cdp.send('Page.captureScreenshot',
                               { format: 'png', fromSurface: true, captureBeyondViewport: false });
      fs.writeFileSync(`test-shots/mobile-${name}.png`, Buffer.from(r.data, 'base64'));
    };

    const normal = await p.evaluate(MEASURE);
    await grab(`${v.name}-normal`);

    // SHADES VIEW. Forced through the renderer's __forceShades debug handle.
    // Walking the frog onto a real pair of sunglasses was tried first and is
    // not viable here: which pickups are reachable depends on where the lanes
    // happen to be, so it succeeded on one viewport out of six and burned
    // minutes failing on the rest. The camera rig under test is identical
    // either way - shadesOn is a boolean the rig blends on.
    await p.evaluate(() => { window.__forceShades = true; });
    // WAIT FOR THE BLEND, do not guess at it. camBlend eases 0.075 per frame,
    // and headless Chrome under load runs far below 60fps - a fixed 2.6s wait
    // measured the camera mid-transition and made a correct fix look like a
    // regression (desktop appeared to move from 0.97 to 1.42).
    await p.waitForFunction(() => window.__camBlend >= 0.995, null,
                            { timeout: 30000 }).catch(() => {});
    await p.waitForTimeout(200);
    const shades = await p.evaluate(MEASURE);
    await grab(`${v.name}-shades`);
    await p.evaluate(() => { window.__forceShades = false; });

    rows.push({ v: v.name, normal, shades });
    await ctx.close();
  }
  await browser.close();

  const line = (label, m) => {
    if (!m) return `${label.padEnd(28)}  (not reached)`;
    return `${label.padEnd(28)} ${String(m.vw).padStart(4)}x${String(m.vh).padEnd(5)} ` +
           `${String(m.cols).padStart(3)} ${String(m.camDist).padStart(7)} ` +
           `${String(m.aspect).padStart(6)} ${String(m.pxPerTile).padStart(8)}  ` +
           `${String(m.frogOnScreen).padEnd(6)} ${String(m.frogYPct).padStart(7)} ` +
           `${String(m.camBlend).padStart(5)}`;
  };
  console.log('view                          vw x vh    cols camDist aspect  px/tile  frogSeen frogY%  blend');
  for (const r of rows) console.log(line(r.v, r.normal));
  console.log('\nshades view:');
  for (const r of rows) console.log(line(r.v + ' [shades]', r.shades));

  console.log('\nlayout problems:');
  let bad = 0;
  for (const r of rows) {
    const all = [...(r.normal.problems || []), ...((r.shades && r.shades.problems) || [])];
    const uniq = [...new Set(all)];
    if (uniq.length) bad++;
    console.log(`  ${r.v.padEnd(21)} ${uniq.length ? uniq.join(', ') : 'clean'}`);
  }

  const ref = rows.find(r => r.v === 'desktop');
  // (reference row absent when --only filters it out)
  console.log(`\nreference (desktop): ${ref ? ref.normal.pxPerTile : '?'} px/tile`);
  const small = rows.filter(r => r.normal.pxPerTile !== null && r.normal.pxPerTile < MIN_PX_PER_TILE);
  for (const r of small) console.log(`  TOO SMALL  ${r.v.padEnd(21)} ${r.normal.pxPerTile} px/tile (min ${MIN_PX_PER_TILE})`);

  fs.writeFileSync('/tmp/claude-501/mobile-probe.json', JSON.stringify(rows, null, 1));
  const fails = small.length + bad;
  console.log(fails ? `\nFAIL: ${small.length} viewport(s) below ${MIN_PX_PER_TILE} px/tile, ${bad} with layout problems`
                    : '\nPASS: every viewport legible and clean');
  process.exit(fails ? 1 : 0);
})();
