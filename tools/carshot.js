const path = require('path');
const { chromium } = require('playwright');
const debugURL = require('./lib/debug-url');
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1'), { waitUntil: 'load' });
  await p.waitForTimeout(4000);
  await p.locator('.campaign-btn').first().click(); await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000 }); await p.waitForTimeout(3000);
  // sit on the median just below the road band so all 5 lanes are in frame
  for (let i = 0; i < 10; i++) {
    const r = await p.evaluate(() => {
      if (!window.Sim.isRunning()) return 'dead';
      const s = window.Sim.getState();
      if (s.frog.y <= 30) return 'there';
      window.Sim.moveFrog(0, -1); return false;
    });
    if (r) { console.log('walk:', r); break; }
    await p.waitForTimeout(230);
  }
  await p.waitForTimeout(1500);
  await p.screenshot({ path: path.resolve(__dirname, '..', 'test-shots', 'cars-closeup.png') });
  const cols = await p.evaluate(() => {
    // sample the rendered canvas for the dominant saturated colours actually on screen
    const c = document.getElementById('game-canvas');
    const g = document.createElement('canvas'); g.width = c.width; g.height = c.height;
    g.getContext('2d').drawImage(c, 0, 0);
    const d = g.getContext('2d').getImageData(0, 0, g.width, g.height).data;
    const buckets = {};
    for (let i = 0; i < d.length; i += 4 * 53) {
      const r = d[i]/255, gg = d[i+1]/255, bb = d[i+2]/255;
      const mx = Math.max(r,gg,bb), mn = Math.min(r,gg,bb);
      const s = mx ? (mx-mn)/mx : 0;
      if (s < 0.45 || mx < 0.35) continue;
      let h = 0;
      if (mx===r) h=((gg-bb)/(mx-mn))%6; else if (mx===gg) h=(bb-r)/(mx-mn)+2; else h=(r-gg)/(mx-mn)+4;
      h = ((h*60)+360)%360;
      const k = Math.round(h/20)*20;
      buckets[k] = buckets[k] || {n:0,r:0,g:0,b:0};
      buckets[k].n++; buckets[k].r+=r; buckets[k].g+=gg; buckets[k].b+=bb;
    }
    return Object.entries(buckets).sort((a,b)=>b[1].n-a[1].n).slice(0,6).map(([h,v]) =>
      `hue ${h}: #${[v.r,v.g,v.b].map(x=>Math.round(x/v.n*255).toString(16).padStart(2,'0')).join('')} (${v.n}px)`);
  });
  console.log('dominant on-screen colours:'); cols.forEach(c => console.log('  ' + c));
  await b.close();
})();
