// How many LINES are drawn on the road and the water?
//
// "Too many lines" was a visual complaint; this turns it into counts that can
// regress. Three separate sources had been stacking up:
//   1. one ground slab PER ROW, so the road texture's "dark edge where tarmac
//      meets grass" landed on every internal row boundary, not just where the
//      road actually meets grass;
//   2. that same per-row mapping repeated the two tyre-wear streaks once per
//      row - five road rows meant ten streaks;
//   3. dashed lane markings hardcoded to rows 7..10, which is BAND 0 ONLY, so
//      one band had markings and the other two had none.
// And the water carried pale lane dividers at every internal boundary - a road
// convention on a river.
//
// Usage: node tools/surface-lines-check.js
const { chromium } = require('playwright');

const debugURL = require('./lib/debug-url');
const URL = debugURL(process.env.URL || 'http://127.0.0.1:8099/index.html?render=3d&debug=1');

let passed = 0, failed = 0;
const test = (name, cond, detail) => {
  if (cond) { console.log(`  ok    ${name}`); passed++; }
  else { console.log(`  FAIL  ${name}${detail ? '\n        ' + detail : ''}`); failed++; }
};

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
  await p.goto(URL, { waitUntil: 'load' });
  await p.waitForTimeout(4200);
  await p.locator('.campaign-btn').first().click({ force: true });
  await p.waitForTimeout(400);
  await p.locator('#btn-play-run').click({ timeout: 90000, force: true });
  await p.waitForTimeout(2800);

  const m = await p.evaluate(() => {
    const S = window.Sim, scene = window.__scene;
    const st = S.getState();
    const roadRows = S.ROAD_LANES.map(l => l.row).sort((a, b) => a - b);
    const waterRows = S.WATER_LANES.map(l => l.row).sort((a, b) => a - b);
    const roadSet = new Set(roadRows), waterSet = new Set(waterRows);

    // Internal boundaries: a seam between two rows of the SAME kind.
    const internal = rows => rows.filter(r => new Set(rows).has(r + 1)).length;

    // Count the thin flat boxes sitting just above the ground - dashes and any
    // divider strips - and group them by the row boundary they sit on.
    const worldZ = gy => gy - (st.rows - 1) / 2;
    const byRow = {};
    let thinStrips = 0, fullWidthStrips = 0;
    scene.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.parameters) return;
      const g = o.geometry.parameters;
      if (g.height === undefined || g.height > 0.05) return;   // not a flat marking
      if (o.position.y < 0 || o.position.y > 0.2) return;
      thinStrips++;
      // A strip spanning the whole surface is a lane divider, not a dash.
      if (g.width && g.width > 10) fullWidthStrips++;
      for (let r = 0; r < st.rows; r++) {
        if (Math.abs(o.position.z - (worldZ(r) + 0.5)) < 0.01) {
          byRow[r] = (byRow[r] || 0) + 1; break;
        }
      }
    });

    const dashRows = Object.keys(byRow).map(Number).sort((a, b) => a - b);
    // Which ground slabs exist, and how deep are they?
    const slabs = [];
    scene.traverse(o => {
      if (!o.isMesh || !o.geometry || !o.geometry.parameters) return;
      const g = o.geometry.parameters;
      if (g.height !== 0.2 || !g.depth) return;
      slabs.push(g.depth);
    });

    return {
      roadRows, waterRows,
      internalRoadBoundaries: internal(roadRows),
      internalWaterBoundaries: internal(waterRows),
      dashRows, thinStrips, fullWidthStrips,
      slabDepths: slabs.sort((a, b) => b - a),
      waterStripsOnWaterRows: dashRows.filter(r => waterSet.has(r)).length,
      dashRowsAreRoad: dashRows.every(r => roadSet.has(r) && roadSet.has(r + 1)),
    };
  });

  console.log(`        road rows ${m.roadRows.join(',')}`);
  console.log(`        dash boundaries ${m.dashRows.join(',') || '(none)'}`);
  console.log(`        ground slabs (depths) ${m.slabDepths.join(',')}`);

  test('lane dashes sit only on INTERNAL road boundaries', m.dashRowsAreRoad,
       `dash rows ${m.dashRows.join(',')}`);
  test('every road band is marked, not just band 0',
       m.dashRows.length === m.internalRoadBoundaries,
       `${m.dashRows.length} marked boundaries, ${m.internalRoadBoundaries} internal road boundaries`);
  test('the water carries no lane dividers', m.waterStripsOnWaterRows === 0,
       `${m.waterStripsOnWaterRows} strip row(s) on water`);
  test('no full-width divider strips remain', m.fullWidthStrips === 0,
       `${m.fullWidthStrips} full-width strips`);
  // Bands, not rows: a 5-row road band must be ONE slab.
  test('ground is built from bands, not one slab per row',
       m.slabDepths.some(d => d >= 5),
       `deepest slab ${m.slabDepths[0]} (a 5-row road band should be one slab)`);

  await b.close();
  console.log(`\n${failed ? 'FAIL' : 'PASS'}: ${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
