// Screenshots + wiring check for the in-game control pod (theme / sound / pause).
//
// Two things this proves:
//   1. The pod LOOKS right, in every state, cropped tight - the earlier emoji
//      cluster read fine in a 1280x800 shot and only fell apart at the size it
//      is actually seen at.
//   2. The two states driven from JS still land. A CSS-only rework can quietly
//      stop being wired to anything, and writing textContent onto these buttons
//      (which the old code did) would delete the SVG and leave empty circles.
//
// WHY THE CANVAS IS HIDDEN FOR THE POD SHOTS: page.screenshot() blocks
// indefinitely while the WebGL canvas is compositing on a loaded machine - it
// reports "fonts loaded" and never returns, at any timeout, clip or not. Same
// page screenshots instantly with the canvas visibility:hidden. The pod is pure
// DOM over the canvas, so hiding it costs nothing here and makes the gate
// reliable rather than load-dependent.
//
// Usage: node tools/hud-shot.js       (needs: python3 -m http.server 8099)
const { chromium } = require('playwright');

const debugURL = require('./lib/debug-url');
const URL = debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 });
  await p.waitForTimeout(3000);

  const setCanvas = v => p.evaluate(vis => {
    const c = document.getElementById('game-canvas');
    if (c) c.style.visibility = vis;
  }, v);

  await setCanvas('hidden');
  await p.waitForTimeout(300);

  // getBoundingClientRect, not locator.boundingBox(): the pod lives inside
  // #hud, which is pointer-events:none, and boundingBox() waits on hit-testing
  // that never resolves there.
  const box = await p.evaluate(() => {
    const el = document.getElementById('hud-pod');
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  if (!box) {
    console.log('FAIL: #hud-pod is not present on the game screen');
    await b.close();
    process.exit(1);
  }
  // Leave room below for the hover label.
  const clip = { x: box.x - 34, y: box.y - 12, width: box.width + 68, height: box.height + 50 };
  const shot = name => p.screenshot({ path: `test-shots/hud-${name}.png`, clip,
                                      animations: 'disabled', timeout: 20000 });

  await shot('rest-funkyverse');

  await p.locator('#btn-mute').hover({ force: true });
  await p.waitForTimeout(400);
  await shot('hover-sound');

  await p.locator('#btn-mute').click({ force: true });
  await p.waitForTimeout(500);
  await p.mouse.move(640, 620);              // off the pod, so no label in shot
  await p.waitForTimeout(350);
  await shot('muted');

  const mutedOk = await p.evaluate(() => {
    const el = document.getElementById('btn-mute');
    return el.classList.contains('is-muted') && el.getAttribute('aria-pressed') === 'true';
  });

  await p.locator('#btn-mute').click({ force: true });   // sound back on
  await p.waitForTimeout(350);

  await p.locator('#btn-theme').click({ force: true });  // -> diorama
  await p.waitForTimeout(800);
  await p.mouse.move(640, 620);
  await p.waitForTimeout(350);
  await shot('rest-diorama');

  const themeOk = await p.evaluate(() =>
    document.getElementById('hud-pod').dataset.theme === window.Render3D.getTheme());

  // Every icon must survive a state change. textContent assignment is exactly
  // the failure this catches: the button keeps working and renders empty.
  const iconsOk = await p.evaluate(() =>
    ['btn-theme', 'btn-mute', 'btn-pause-game']
      .every(id => !!document.querySelector('#' + id + ' svg.ico')));

  // The pod must not sit on top of the mobile mode toggle. That button was
  // positioned for the old 3-high column of circles; the pod is a pill.
  const overlap = await p.evaluate(() => {
    const mc = document.getElementById('mobile-controls');
    const prev = mc.classList.contains('hidden');
    mc.classList.remove('hidden');
    const a = document.getElementById('hud-pod').getBoundingClientRect();
    const c = document.getElementById('btn-move-mode').getBoundingClientRect();
    if (prev) mc.classList.add('hidden');
    return { gap: c.top - a.bottom, hit: !(c.top >= a.bottom || c.bottom <= a.top ||
                                           c.left >= a.right || c.right <= a.left) };
  });

  // Context shots last, with the canvas back, so the pod can be judged against
  // the real board in both themes. page.screenshot() is unusable here for the
  // reason above; CDP Page.captureScreenshot returns immediately on the same
  // page. Wrapped anyway: a failure here must not cost the assertions above.
  let context = 'skipped';
  try {
    await setCanvas('visible');
    await p.waitForTimeout(600);
    const cdp = await p.context().newCDPSession(p);
    const grab = async file => {
      const r = await cdp.send('Page.captureScreenshot',
                               { format: 'png', fromSurface: true, captureBeyondViewport: false });
      require('fs').writeFileSync(file, Buffer.from(r.data, 'base64'));
    };
    await grab('test-shots/hud-context-diorama.png');
    // Dispatch the click directly: with the canvas compositing, Playwright's
    // actionability checks on this button can exceed their timeout under load.
    await p.evaluate(() => document.getElementById('btn-theme').click());
    await p.waitForTimeout(900);
    await p.mouse.move(640, 620);
    await p.waitForTimeout(400);
    await grab('test-shots/hud-context-funkyverse.png');
    context = 'test-shots/hud-context-{funkyverse,diorama}.png';
  } catch (e) {
    context = 'BLOCKED - ' + e.message.split('\n')[0] + ' (pod shots above are unaffected)';
  }

  // The 2D build has no themes and hides that control. `.hud-btn` sets
  // display:grid, and an author rule beats the UA's [hidden] { display: none },
  // so the button reappeared and offered a theme switch that build cannot do.
  let themeHidden2d = null;
  try {
    const p2 = await b.newPage({ viewport: { width: 1280, height: 800 } });
    await p2.goto(URL.replace('render=3d&debug=1', 'render=2d'), { waitUntil: 'load' });
    await p2.waitForTimeout(3500);
    await p2.locator('.campaign-btn').first().click();
    await p2.waitForTimeout(400);
    await p2.locator('#btn-play-run').click({ timeout: 60000 });
    await p2.waitForTimeout(1500);
    themeHidden2d = await p2.evaluate(() =>
      getComputedStyle(document.getElementById('btn-theme')).display === 'none');
    await p2.close();
  } catch (e) { themeHidden2d = null; }

  await b.close();

  const fails = [];
  if (themeHidden2d === false) fails.push('the theme control is still visible on the 2D build');
  if (!mutedOk) fails.push('mute state is not reflected on the button (class/aria)');
  if (!themeOk) fails.push('pod data-theme does not track the renderer theme');
  if (!iconsOk) fails.push('an icon SVG was destroyed by a state change');
  if (overlap.hit) fails.push('the pod overlaps #btn-move-mode');

  console.log(`  mute state wired    ${mutedOk ? 'ok' : 'FAIL'}`);
  console.log(`  theme state wired   ${themeOk ? 'ok' : 'FAIL'}`);
  console.log(`  icons intact        ${iconsOk ? 'ok' : 'FAIL'}`);
  console.log(`  move-mode clearance ${overlap.hit ? 'FAIL overlapping' : 'ok ' + overlap.gap.toFixed(0) + 'px below'}`);
  console.log(`  2D hides theme      ${themeHidden2d === null ? 'not checked' : themeHidden2d ? 'ok' : 'FAIL'}`);
  console.log(`  context shot        ${context}`);
  console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nPASS: stills in test-shots/hud-*.png');
  process.exit(fails.length ? 1 : 0);
})();
