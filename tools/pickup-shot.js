// Visual + behavioural check for pickup feedback: the floating "+points" text
// and the COMBO badge.
//
// It walks the frog along safe rows onto real sparks rather than injecting
// state, so what it photographs is what a player sees. It also counts the
// 'collect' events for a single hop - the pickup sound is one blip per event,
// so more than one event on one hop would be audible as a double beep.
//
// Usage: node tools/pickup-shot.js     (needs: python3 -m http.server 8099)
const { chromium } = require('playwright');
const fs = require('fs');

const debugURL = require('./lib/debug-url');
const URL = debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click();
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 });
  await p.waitForTimeout(2500);

  const cdp = await p.context().newCDPSession(p);
  const grab = async file => {
    const r = await cdp.send('Page.captureScreenshot',
                             { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  };

  // Count collect events per hop from inside the page: the orchestrator plays
  // one blip per event, so this is the real "how many beeps" measurement.
  await p.evaluate(() => {
    window.__collectRuns = [];
    const S = window.Sim;
    const orig = S.moveFrog;
    S.moveFrog = function (dx, dy) {
      const evts = orig.call(S, dx, dy);
      const n = evts.filter(e => e && e.type === 'collect').length;
      if (n) window.__collectRuns.push(n);
      return evts;
    };
  });

  // Walk a safe row and step onto sparks. Medians are safe; roads are not, so
  // only median rows are used for the walk.
  const step = async (dx, dy) => {
    await p.evaluate(([x, y]) => window.Sim.moveFrog(x, y), [dx, dy]);
    await p.waitForTimeout(260);
  };

  let best = 0, shots = 0;
  for (let i = 0; i < 240; i++) {
    const st = await p.evaluate(() => {
      const S = window.Sim;
      if (!S.isRunning()) return { dead: true };
      const s = S.getState();
      const medians = new Set(S.MEDIAN_ROWS || []);
      const row = Math.round(s.frog.y);
      const here = (s.sparks || []).filter(k => !k.collected && Math.round(k.y) === row);
      const near = here.sort((a, b) => Math.abs(a.x - s.frog.x) - Math.abs(b.x - s.frog.x))[0];
      return { dead: false, row, onMedian: medians.has(row), fx: s.frog.x,
               combo: s.combo, target: near ? near.x : null,
               anyMedianSpark: (s.sparks || []).some(k => !k.collected && medians.has(Math.round(k.y))) };
    });
    if (st.dead) break;

    if (st.combo > best) {
      best = st.combo;
      if (best >= 2 && shots < 2) {           // photograph a live combo
        await grab(`test-shots/pickup-combo-x${best}.png`);
        shots++;
      }
    }
    if (!st.onMedian) { await step(0, -1); continue; }        // get onto a median
    if (st.target === null) {
      // No spark left on this row: move up to the next median (two rows of
      // road lie between, so this is three hops through traffic).
      await step(0, -1);
      continue;
    }
    await step(st.target > st.fx ? 1 : -1, 0);
  }

  const runs = await p.evaluate(() => window.__collectRuns || []);
  await b.close();

  const worst = runs.length ? Math.max(...runs) : 0;
  const doubles = runs.filter(n => n > 1).length;
  console.log(`  collect events sampled  ${runs.length}`);
  console.log(`  events on a single hop  max ${worst}${runs.length ? '' : ' (none sampled)'}`);
  console.log(`  hops firing >1 collect  ${doubles}`);
  console.log(`  best combo reached      x${best}`);
  console.log(`  stills                  ${shots} written to test-shots/pickup-combo-x*.png`);

  const fails = [];
  if (!runs.length) fails.push('no pickups sampled - the walk never reached a spark');
  if (worst > 1) fails.push(`a single hop fired ${worst} collect events (${worst} blips)`);
  console.log(fails.length ? `\nFAIL: ${fails.join('; ')}` : '\nPASS: one collect event per hop');
  process.exit(fails.length ? 1 : 0);
})();
