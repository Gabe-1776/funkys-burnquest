// Freeze the camera and inspect the board's LEFT EDGE row by row.
// Gabriel: "left wall issues start on grass 3" (stage 1: grass 3 = row 18).
// __freezeCam parks the follow rig; we place the camera at frog-eye height
// over each median's left edge and screenshot.
const { chromium } = require('playwright');
const fs = require('fs');
const URL = 'http://127.0.0.1:8099/index.html?render=3d&debug=1';

(async () => {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const p = await ctx.newPage();
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(2500);
  const cdp = await ctx.newCDPSession(p);

  // Park the camera looking at the left wall region of a given row, from
  // slightly right of the board centre so the edge is in frame.
  const look = async (row, name) => {
    await p.evaluate(r => {
      window.__freezeCam = true;
      const cam = window.__renderCam, st = window.Sim.getState();
      const wz = r - (st.rows - 1) / 2, wx = 0 - st.cols / 2;   // left wall x
      cam.position.set(wx + 6, 3.0, wz + 6);
      cam.lookAt(wx - 2, 0.4, wz);
      cam.updateMatrixWorld(true);
    }, row);
    await p.waitForTimeout(120);
    const r = await cdp.send('Page.captureScreenshot',
      { format: 'png', fromSurface: true, captureBeyondViewport: false });
    fs.writeFileSync(`test-shots/${name}.png`, Buffer.from(r.data, 'base64'));
    console.log('shot', name);
  };

  // grass rows (from start up): 30, 24, 18, 12, 6 — look at 30 (grass1), 18 (grass3), 6 (grass5)
  await look(30, 'wall-grass1-row30');
  await look(24, 'wall-grass2-row24');
  await look(18, 'wall-grass3-row18');
  await look(12, 'wall-grass4-row12');
  await look(6,  'wall-grass5-row6');
  await browser.close();
})();
