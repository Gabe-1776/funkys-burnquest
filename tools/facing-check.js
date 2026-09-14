// Hops the frog in all 8 directions and reports the world direction its face
// ends up pointing, so a wrong characterFaceOffset is measurable rather than a
// judgement call from a screenshot.
const { chromium } = require('playwright');
const THEME = process.env.THEME || 'funkyverse';
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(`http://127.0.0.1:8099/index.html?render=3d&debug=1&theme=${THEME}`, { waitUntil: 'load' });
  await p.waitForTimeout(3500);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(2500);
  if (THEME !== 'funkyverse') {
    await p.evaluate(t => window.Render3D && window.Render3D.setTheme(t), THEME);
    await p.waitForTimeout(2500);      // the character model reloads
  }

  // Park on a MEDIAN row away from both edges: safe from traffic, no platform
  // drift to perturb the hop endpoints, and every one of the 8 headings legal.
  const park = async () => {
    for (let i = 0; i < 260; i++) {
      const done = await p.evaluate(() => {
        const S = window.Sim;
        if (!S.isRunning()) return 'dead';
        const st = S.getState();
        const y = Math.round(st.frog.y), x = Math.round(st.frog.x);
        const midX = Math.floor(S.getCols() / 2);
        const onMedian = S.rowClass(y) === 'median' && y > 1 && y < S.ROWS - 1;
        if (onMedian && x === midX) return true;
        if (!onMedian) { S.moveFrog(0, -1); return false; }
        S.moveFrog(x < midX ? 1 : -1, 0);
        return false;
      });
      if (done === 'dead') {
        await p.locator('#btn-play-run').click().catch(() => {});
        await p.waitForTimeout(1600);
        continue;
      }
      await p.waitForTimeout(95);
      if (done) break;
    }
    const at = await p.evaluate(() => {
      const S = window.Sim, st = S.getState();
      return { row: Math.round(st.frog.y), cls: S.rowClass(Math.round(st.frog.y)) };
    });
    return at;
  };

  let parked = await park();
  console.log(`  (parked on row ${parked.row}, ${parked.cls})`);
  if (parked.cls !== 'median') {
    console.log('\nFAIL: could not reach a safe square to test from');
    await b.close();
    process.exit(1);
  }

  await p.evaluate(f => { window.__LOCAL_FWD = f; },
    THEME === 'diorama' ? [0, 0, 1] : [-1, 0, 0]);

  // Reaching a safe square means crossing five road rows, and the frog dies
  // there sometimes. That is bad luck, not a facing defect, so a cycle that
  // cannot park is RETRIED rather than reported as a failure. A cycle that
  // does park and then measures a wrong heading still fails.

  const DIRS = [[0,-1,'up (goal)'],[0,1,'down'],[-1,0,'left'],[1,0,'right'],
                [-1,-1,'up-left'],[1,-1,'up-right'],[-1,1,'down-left'],[1,1,'down-right']];
  let fail = false;
  // Hop and WAIT FOR THE RENDERER. The rotation is applied on the frame after
  // the sim accepts the move, so a wall-clock wait reads the previous heading -
  // which reported "up" as facing down. Two animation frames guarantee the
  // renderer has run at least once since the hop.
  const settle = () => p.evaluate(() => new Promise(r =>
    requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(r, 30)))));

  const hop = async (dx, dy) => {
    for (let a = 0; a < 40; a++) {                 // hops are sim-clock gated
      const moved = await p.evaluate(([dx, dy]) => {
        const S = window.Sim;
        if (!S.isRunning()) return 'dead';
        const st = S.getState();
        const bx = Math.round(st.frog.x), by = Math.round(st.frog.y);
        S.moveFrog(dx, dy);
        const af = S.getState();
        const ax = Math.round(af.frog.x), ay = Math.round(af.frog.y);
        // The move must be EXACTLY the step we asked for. Merely "position
        // changed" also matches a death respawn, which teleports the frog to
        // the start row - that was read as a successful hop and then measured
        // a stale facing.
        if (ax === bx + dx && ay === by + dy) return true;
        if (ax !== bx || ay !== by) return 'moved-elsewhere';
        return false;
      }, [dx, dy]);
      if (moved === 'moved-elsewhere') return 'dead';   // respawned; caller re-parks
      if (moved === 'dead') return 'dead';
      if (moved) { await settle(); return true; }
      await p.waitForTimeout(60);
    }
    return false;
  };

  let sampled = 0;
  for (const [dx, dy, name] of DIRS) {
    let moved = await hop(dx, dy);
    // A finished run is not evidence about facing - restart, re-park and retry
    // this heading. Skipping it would let the gate PASS on partial evidence.
    // Every neighbour of the parking square is water or road, so most test hops
    // are fatal. Deaths are expected here; only an unsampled heading is a real
    // failure, so retry generously.
    for (let retry = 0; moved === 'dead' && retry < 10; retry++) {
      await p.locator('#btn-play-run').click().catch(() => {});
      await p.waitForTimeout(1800);
      const at = await park();
      if (at.cls !== 'median') break;
      moved = await hop(dx, dy);
    }
    if (moved === 'dead' || !moved) {
      console.log(`  FAIL  ${name.padEnd(11)} never sampled`);
      fail = true;
      continue;
    }
    sampled++;
    const out = await p.evaluate(([dx, dy]) => {
      const THREE = window.THREE, rig = window.__frogRig;
      if (!rig) return null;
      const holder = rig.parent || rig;
      holder.updateMatrixWorld(true);
      const F = window.__LOCAL_FWD || [-1, 0, 0];
      const fwd = new THREE.Vector3(F[0], F[1], F[2])
        .applyQuaternion(holder.getWorldQuaternion(new THREE.Quaternion()));
      const exp = new THREE.Vector3(dx, 0, dy).normalize();
      return { fx: +fwd.x.toFixed(2), fz: +fwd.z.toFixed(2),
               ex: +exp.x.toFixed(2), ez: +exp.z.toFixed(2),
               dot: +fwd.normalize().dot(exp).toFixed(2) };
    }, [dx, dy]);
    if (!out) { console.log(`  ${name.padEnd(11)} (no sample)`); fail = true; continue; }
    const ok = out.dot > 0.85;
    if (!ok) fail = true;
    console.log(`  ${ok ? 'ok   ' : 'FAIL '} ${name.padEnd(11)} face(${out.fx},${out.fz}) want(${out.ex},${out.ez}) dot ${out.dot}`);
    await hop(-dx, -dy);                            // back to the safe square
  }

  await b.close();
  const missing = DIRS.length - sampled;
  if (missing) fail = true;                   // missing evidence is a failure
  console.log(fail
    ? `\nFAIL: ${sampled}/${DIRS.length} headings sampled` +
      (missing ? ` (${missing} never sampled)` : ' but a heading was wrong')
    : '\nPASS: all 8 headings face the direction of travel');
  process.exit(fail ? 1 : 0);
})();
