// Mobile input is a swipe. This drives real pointer gestures on the canvas and
// checks the frog moves the way the gesture pointed.
//
// It replaces tools/layout-toggle-check.js and tools/stick-4way-check.js, which
// tested a control dock, a row/overlay toggle, a D-pad and a joystick - four
// mechanisms that existed only to stop buttons covering the character. A swipe
// has no buttons, so all of it is gone and so are those gates.
//
// Usage: node tools/swipe-check.js [--url URL]
const { chromium } = require('playwright');

const arg = (k, d) => { const i = process.argv.indexOf(k); return i > -1 ? process.argv[i + 1] : d; };
const debugURL = require('./lib/debug-url');
const URL = debugURL(arg('--url', 'http://127.0.0.1:8099/index.html?render=3d&debug=1'));
const V = { w: 393, h: 852 };

let passed = 0, failed = 0;
const test = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failed++; }
};

(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: V.w, height: V.h },
                                   hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(2600);

  // Nothing may be drawn over the board any more.
  const leftovers = await p.evaluate(() => ['mobile-pad', 'mobile-stick', 'mobile-controls',
    'btn-move-mode', 'btn-layout', 'control-dock']
    .filter(id => !!document.getElementById(id)));
  test('no movement buttons remain in the DOM', leftovers.length === 0, leftovers.join(', '));

  const canvasFull = await p.evaluate(() => {
    const c = document.getElementById('game-canvas').getBoundingClientRect();
    return Math.round(c.height);
  });
  test('the board uses the whole window', canvasFull >= V.h - 2,
       `canvas ${canvasFull} of ${V.h}`);

  // A swipe should ask the sim to move the way it pointed. The REQUEST is what
  // this gate is about; whether the hop survives is the sim's business.
  //
  // Reading the frog's position instead does not work here: row 35 is a road
  // row, so a hop up from the start line frequently dies and respawns to the
  // exact same row - which reads as "no movement" and failed a correct
  // implementation twice.
  await p.evaluate(() => {
    window.__moves = [];
    const S = window.Sim, orig = S.moveFrog;
    S.moveFrog = function (dx, dy) { window.__moves.push([dx, dy]); return orig.call(S, dx, dy); };
  });

  const gesture = async (dx, dy, tap) => {
    await p.evaluate(() => { window.__moves = []; });
    const cx = V.w / 2, cy = V.h * 0.45;
    if (tap) {
      await p.mouse.click(cx, cy);
    } else {
      await p.mouse.move(cx, cy);
      await p.mouse.down();
      await p.mouse.move(cx + dx, cy + dy, { steps: 6 });
      await p.mouse.up();
    }
    await p.waitForTimeout(260);
    return p.evaluate(() => window.__moves);
  };

  const one = m => m.length === 1 ? m[0] : null;

  const up = one(await gesture(0, -90));
  test('swipe up asks for a forward hop', !!up && up[0] === 0 && up[1] === -1, JSON.stringify(up));
  const right = one(await gesture(90, 0));
  test('swipe right asks for a right hop', !!right && right[0] === 1 && right[1] === 0, JSON.stringify(right));
  const left = one(await gesture(-90, 0));
  test('swipe left asks for a left hop', !!left && left[0] === -1 && left[1] === 0, JSON.stringify(left));
  const down = one(await gesture(0, 90));
  test('swipe down asks for a backward hop', !!down && down[0] === 0 && down[1] === 1, JSON.stringify(down));

  const diag = one(await gesture(70, -40));
  test('a diagonal swipe resolves to ONE axis',
       !!diag && (diag[0] === 0) !== (diag[1] === 0), JSON.stringify(diag));

  // A tap must do NOTHING. It used to hop forward - the endless-hopper
  // convention - and Gabriel had it removed: on a board where one wrong hop is
  // fatal, every incidental touch became a move.
  const tap = await gesture(0, 0, true);
  test('a tap moves nothing', tap.length === 0, JSON.stringify(tap));

  const tiny = await gesture(6, 4);
  test('a tiny drag asks for nothing', tiny.length === 0, JSON.stringify(tiny));

  // --- 4-way vs 8-way -------------------------------------------------------
  const dirsBtn = await p.evaluate(() => {
    const b = document.getElementById('btn-swipe-dirs');
    return b ? { hidden: b.hidden, pressed: b.getAttribute('aria-pressed') } : null;
  });
  test('the swipe-direction toggle is offered on touch',
       !!dirsBtn && !dirsBtn.hidden, JSON.stringify(dirsBtn));
  test('it defaults to 4-way', !!dirsBtn && dirsBtn.pressed === 'false',
       JSON.stringify(dirsBtn));

  // In 4-way, a 45-degree swipe must still resolve to a cardinal.
  const fourDiag = one(await gesture(70, -70));
  test('4-way: a 45-degree swipe stays cardinal',
       !!fourDiag && (fourDiag[0] === 0) !== (fourDiag[1] === 0), JSON.stringify(fourDiag));

  await p.locator('#btn-swipe-dirs').click({ force: true });
  await p.waitForTimeout(300);
  const nowOn = await p.evaluate(() =>
    document.getElementById('btn-swipe-dirs').getAttribute('aria-pressed'));
  test('tapping switches to 8-way', nowOn === 'true', String(nowOn));

  const eightDiag = one(await gesture(70, -70));
  test('8-way: a 45-degree swipe gives a diagonal',
       !!eightDiag && Math.abs(eightDiag[0]) === 1 && Math.abs(eightDiag[1]) === 1,
       JSON.stringify(eightDiag));
  const eightUp = one(await gesture(0, -90));
  test('8-way: a straight swipe is still cardinal',
       !!eightUp && eightUp[0] === 0 && eightUp[1] === -1, JSON.stringify(eightUp));

  // The choice must survive a reload.
  await p.reload({ waitUntil: 'load' });
  await p.waitForTimeout(4000);
  const persisted = await p.evaluate(() =>
    document.getElementById('btn-swipe-dirs').getAttribute('aria-pressed'));
  test('the 8-way choice survives a reload', persisted === 'true', String(persisted));

  await b.close();
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
