/**
 * Funky's BurnQuest
 * Simulation core - grid state, lane conveyors, collision, scoring, lives,
 * campaign shell. ZERO rendering, ZERO DOM, ZERO three.js. Runs headless
 * under Node (required by tools/lane-check.js) as well as in the browser.
 *
 * Extracted unchanged (in behaviour) from game.js on the 3d-prototype
 * branch so the renderer split cannot drift the provably-fair lane math.
 *
 * Public surface used by game.js / render2d.js / render3d.js / lane-check.js:
 *   Sim.CAMPAIGNS, Sim.LEVEL_GOALS, Sim.ROWS, Sim.PLATFORM_RATE, Sim.CAR_RATE,
 *   Sim.WATER_LANES, Sim.ROAD_LANES
 *   Sim.getCols() / Sim.setCols(n)
 *   Sim.loadData() / Sim.saveData() / Sim.resetData()
 *   Sim.getCampaigns() / Sim.getCampaignData(id)
 *   Sim.selectCampaign(id) / Sim.getCurrentCampaign()
 *   Sim.startRun()
 *   Sim.moveFrog(dx, dy)  -> events[]
 *   Sim.update(dt)        -> events[]   (dt in 60fps-frame units)
 *   Sim.getState()        -> read-only snapshot for renderers
 *   Sim.isRunning() / Sim.pause()
 *
 * Events emitted (consumed by game.js to drive audio/DOM, never by renderers):
 *   { type: 'collect', points, combo, x, y }
 *   { type: 'hit', livesLeft }
 *   { type: 'gameover' }
 *   { type: 'stage', stage, name, isFinal, score, lives }   - board cleared,
 *                                       run continues on the next STAGES row
 *   { type: 'finish', points, pct, campaignName }
 */
(function (root, factory) {
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = factory();
    } else {
        root.Sim = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    // coin: the REAL token artwork, so the campaign picker shows the community's
    // own logos instead of stand-in emoji. Sourced 2026-09-07 from the SimpleDEX
    // launch indexer (indexer.protonnz.com/api/tokens -> imageUrl on IPFS) except
    // KSTO, which predates SimpleDEX and comes from ksto.world's own site.
    // Downloaded, type-checked and resized to 128px into assets/coins/ - never
    // hotlinked, so the picker does not depend on IPFS gateways being up.
    // icon stays as the fallback if an image ever fails to load.
    const CAMPAIGNS = [
        { id: 'ksto', name: 'KSTO', icon: '🟣', color: '#c026d3', coin: 'assets/coins/ksto.png' },
        { id: 'heal', name: 'HEAL', icon: '💚', color: '#18c964', coin: 'assets/coins/heal.png' },
        { id: 'pbr', name: 'PBR', icon: '🧱', color: '#a020f0', coin: 'assets/coins/pbr.png' },
        { id: 'snippy', name: 'SNIPPY', icon: '✂️', color: '#00d4ff', coin: 'assets/coins/snippy.png' },
        { id: 'snipling', name: 'SNIPLING', icon: '🐣', color: '#ffaa00', coin: 'assets/coins/snipling.png' },
        { id: 'lbug', name: 'LBUG', icon: '🐞', color: '#ff3366', coin: 'assets/coins/lbug.png' },
        { id: 'love', name: 'LOVE', icon: '❤️', color: '#ff66aa', coin: 'assets/coins/love.png' },
        { id: 'bender', name: 'BENDER', icon: '🤖', color: '#33ffcc', coin: 'assets/coins/bender.png' },
        { id: 'yen', name: 'YEN', icon: '💴', color: '#ffd700', coin: 'assets/coins/yen.png' }
    ];

    const LEVEL_GOALS = [250000, 500000, 1000000, 2500000, 5000000, 10000000];

    // STAGES - the per-board difficulty table, and the ONLY place a stage's
    // difficulty is expressed. Reaching the gateway on a stage that is not the
    // last rebuilds the board from the next row of this table and play
    // continues in the same run: score and lives carry, the clock keeps
    // running, no trip to the dashboard.
    //
    // Stage 1 IS the shipped board by definition - every multiplier is 1, so
    // nothing about the existing game moves when a stage is added. Tuning a
    // stage means editing one row here, never hunting through spawnEntities().
    //
    //   carSpeed      x road vehicle speed
    //   platformSpeed x log / turtle / lilypad speed
    //   traffic       x how many vehicles per road lane
    //   coverage      x how much of a water lane is covered by platforms
    //                   (BELOW 1 = wider gaps = harder)
    //   grassHazards  snakes/birds per GRASS row (0.5 = every other row)
    //   gators        alligators per river section
    //   hazardCounts  exact totals instead, e.g. { snake: 1, bird: 1, gator: 1 }
    //                 - stage 1 shows ONE of each so they can be seen and felt
    //                 (Gabriel 2026-09-11: "just load one of each animal in
    //                 first level ... later we figure out which levels to drop
    //                 them in")
    //   sparks        sparks spawned per band
    //   layout        the board's sections top to bottom (see buildLayout)
    //   timeLimit     seconds to clear the stage, 0 = untimed. Run out and it
    //                 is game over (Gabriel 2026-09-11: 2 minutes from stage 2)
    //
    // NOTE: a stage is not a burn level. The burn level is the campaign's
    // points milestone (LEVEL_GOALS) and is unaffected by any of this.
    // FIVE stages. Gabriel 2026-09-09: "no need to make them more difficult yet,
    // ill tell you when the time comes" - so 3, 4 and 5 deliberately carry
    // stage 2's numbers rather than an invented ramp. Nothing here escalates
    // beyond what was already approved; the rows exist so tuning one is a
    // one-line edit when he calls it.
    // Board layouts: sections under the goal row, top to bottom, each five
    // lanes plus the median below it; the last median is the start row.
    // Gabriel 2026-09-11: another river crossing from stage 2, one more again
    // at 4-5 - and "the game levels should be road river road the whole way",
    // so EVERY extra river brings its own road and the alternation never
    // breaks. From the start row up it always reads road, river, road, river.
    //   stage 1:   3 rivers + 3 roads   37 rows (the original board, unchanged)
    //   stage 2-3: 4 rivers + 4 roads   49 rows
    //   stage 4-5: 5 rivers + 5 roads   61 rows
    const alternating = n => Array.from({ length: n * 2 }, (_, i) => (i % 2 ? 'road' : 'water'));
    const LAYOUT_1 = alternating(3);
    const LAYOUT_2 = alternating(4);
    const LAYOUT_4 = alternating(5);
    const STAGE_TIME = 150;       // seconds, stages 2+ (2:30, Gabriel 2026-09-11)

    const STAGE_TUNED = { carSpeed: 1.30, platformSpeed: 1.15,
                          traffic: 1.20, coverage: 0.86, sparks: 7,
                          grassHazards: 1, gators: 1 };
    const STAGE_FLAT  = { carSpeed: 1.00, platformSpeed: 1.00,
                          traffic: 1.00, coverage: 1.00, sparks: 8,
                          grassHazards: 1, gators: 1 };
    // Stage 2 is its own set; 3 swaps those three verges to birds and adds a
    // snake; 4 inherits 3 and adds two gators; 5 inherits 4 and fills whatever is
    // STILL empty - "no all snakes for all grasses just for the empty ones".
    // Computed rather than listed, so moving a spot cannot leave a stale copy.
    const SPOTS_2 = [{ kind: 'snake', grass: 2 }, { kind: 'snake', grass: 3 },
                     { kind: 'snake', grass: 7 }];
    const SPOTS_3 = [{ kind: 'bird', grass: 2 }, { kind: 'bird', grass: 3 },
                     { kind: 'bird', grass: 7 }, { kind: 'snake', grass: 5 }];
    const SPOTS_4 = SPOTS_3.concat([{ kind: 'gator', river: 2 },
                                    { kind: 'gator', river: 5 }]);
    function fillEmpty(spots, verges, riverCount) {
        const g = new Set(spots.filter(s => s.grass).map(s => s.grass));
        const r = new Set(spots.filter(s => s.river).map(s => s.river));
        const out = spots.slice();
        for (let i = 1; i <= verges; i++) if (!g.has(i)) out.push({ kind: 'snake', grass: i });
        for (let i = 1; i <= riverCount; i++) if (!r.has(i)) out.push({ kind: 'gator', river: i });
        return out;
    }
    const SPOTS_5 = fillEmpty(SPOTS_4, 9, 5);   // 61-row board: 9 verges, 5 rivers

    const STAGES = [
        // Gabriel 2026-09-12: "stage 1 should have no hazards, this stage the user
        // gets used to the gameplay, then as he plays on he gets suprised by all the
        // other creatures". The teaching board: traffic and water only. An empty
        // hazardSpots states that deliberately - absent keys would read as an
        // oversight, and the density rule would then quietly fill it.
        { n: 1, name: 'STAGE 1', carSpeed: 1.00, platformSpeed: 1.00,
          traffic: 1.00, coverage: 1.00, sparks: 8, layout: LAYOUT_1, timeLimit: 0,
          grassHazards: 0, gators: 0, hazardSpots: [] },
        // HAND-PLACED (Gabriel 2026-09-12), and CUMULATIVE - "stage 4 will keep
        // all of stage 3, and stage 5 will keep all of stage 3 and 4, we are just
        // adding on". grass N and river N count from the START going up, so grass 1
        // is the first verge you reach and river 1 the first water. Both resolve
        // against the LIVE layout, never hardcoded rows, so a board change cannot
        // silently move them. These override the density rule, so the stages must
        // not inherit it.
        Object.assign({ n: 2, name: 'STAGE 2', layout: LAYOUT_2, timeLimit: STAGE_TIME },
                      STAGE_FLAT, { grassHazards: 0, gators: 0, hazardSpots: SPOTS_2 }),
        Object.assign({ n: 3, name: 'STAGE 3', layout: LAYOUT_2, timeLimit: STAGE_TIME },
                      STAGE_FLAT, { grassHazards: 0, gators: 0, hazardSpots: SPOTS_3 }),
        Object.assign({ n: 4, name: 'STAGE 4', layout: LAYOUT_4, timeLimit: STAGE_TIME },
                      STAGE_FLAT, { grassHazards: 0, gators: 0, hazardSpots: SPOTS_4 }),
        Object.assign({ n: 5, name: 'STAGE 5', layout: LAYOUT_4, timeLimit: STAGE_TIME },
                      STAGE_FLAT, { grassHazards: 0, gators: 0, hazardSpots: SPOTS_5 })
    ];

    function stageCfg(n) {
        const i = Math.min(Math.max(1, n || stage), STAGES.length) - 1;
        return STAGES[i];
    }
    function stageLimitMs() { return (stageCfg(stage).timeLimit || 0) * 1000; }

    let campaignData = {};
    let runActive = false;        // a run exists (paused counts); see pause()
    let currentCampaignId = null;
    let score = 0;
    let lives = 3;
    let gameRunning = false;
    let invincible = 0;
    let combo = 0;
    let comboTimer = 0;
    // How long a streak survives between pickups. MEASURED, not guessed:
    // sparks land 3.6 hops apart on average and up to 8, and the hop gate
    // (HOP_MS) allows about 8 hops in 1.5s - so the old 90-frame window only
    // ever chained two, and only when two sparks happened to sit together.
    // Gabriel 2026-09-11: "combo points logic it only work for 2 pickups".
    // 4 seconds covers the average gap twice over, with traffic waits.
    const COMBO_WINDOW = 240;
    let stageStartMs = 0;         // simTimeMs when the current board began
    let stage = 1;                // which board of STAGES is being played
    let shake = 0;
    let floatingTexts = [];
    let currentPlatform = null; // tracks the platform Funky is currently riding

    // COLS is chosen from viewport orientation by the caller (a DOM concern);
    // the sim just holds whatever it is told via setCols(). ROWS follows the
    // stage's layout (buildLayout); read it live, never cache it across stages.
    // 1.5x the original 15 for more room to dodge sideways. Odd so there is a
    // true centre column for the goal gate.
    let COLS = 23;
    // Row 0 is the goal, the last row is the start; the rows between are the
    // stage's layout (STAGES[].layout), rebuilt by buildLayout() per board.
    // BANDS counts ROAD sections - the unit sparks and bugs scale by - and is
    // 3 on every layout, so an extra river adds crossing, not pickups.
    let BANDS = 3;
    let ROWS = 37;

    const PLATFORM_RATE = 0.024;   // one shared rate: frog and platforms must agree
    const CAR_RATE = 0.028;
    // Hazards STALK rather than race: slower than traffic, so a verge is a
    // place you time rather than a place you cannot stand. Gabriel 2026-09-11:
    // "in the grass areas there should be the assets we make going back and
    // forth ... their job is to attack the player ... bird snake in grass
    // sections and an alligator in the river".
    const HAZARD_RATE = 0.020;
    const HUNT_MULT = 1.7;   // lock-on speed vs the idle patrol
    const BEAT_HALF_WIDTH = 3.5;   // columns either side of the spawn point
    // Gabriel 2026-09-12: "alligator is a good hunter, but we should give it more
    // access to swim around the whole water rows not just one water row". It roams
    // its OWN river - rivers are separated by road sections, and a gator crossing
    // tarmac would look absurd - and hunts the frog anywhere in that river.
    const SWIM_SPEED = 0.013;      // rows per frame (~0.8 rows a second)
    const SWIM_SETTLE = 0.06;      // close enough to a target row to pick a new one
    const HAZARD_KIND = {
        // w follows the RENDERED body. render3d scales the snake 0.975 along the
        // lane (1.634 -> ~1.59) after Gabriel cut the stretch by 25%; a hitbox left
        // at 2.1 would kill a third of a body-length beyond where he can be seen.
        snake: { w: 1.6, speed: 0.24 },
        // w follows the RENDERED body. The bird model fit-scales then takes
        // the 0.91 girth to a ~1.1 visual wingspan, so the kill box matches
        // that (was 1.2, which killed slightly before the wing reached the
        // frog). Re-measure live if it ever feels cheap again.
        bird:  { w: 1.1, speed: 0.34 },
        gator: { w: 2.4, speed: 0.30 }
    };

    // Lane layout. Every platform in a lane shares ONE speed and is evenly
    // spaced, and neighbouring lanes run in opposite directions. That is what
    // makes the board solvable: gaps stay uniform and lanes drift back into
    // alignment on a fixed cycle, so crossing is a timing problem you can
    // learn. Previously each object got its own random x AND its own random
    // speed, so a lane could open a gap wider than the board and a hop upward
    // could land on open water.
    // One band's worth of lane shapes, repeated per band. Coverage/speed are
    // tuned so every water lane offers a landing spot within ~2.5-3.5s worst
    // case (see tools/lane-check.js); the middle lane is deliberately the hard
    // one - sparse, fast lilypads between two forgiving rows.
    const WATER_SHAPE = [
        // WIDTHS ARE WHOLE GRID BOXES. The board is a grid the frog hops
        // between, so a platform that is 2.6 boxes wide never lines up with it:
        // its ends land mid-box and "am I on it" depends on a fraction the
        // player cannot see. A log is 3 boxes, a turtle raft is 3 boxes (one
        // turtle per box), a lilypad is 1.
        { off: 0, type: 'log',     dir: -1, speed: 0.30, w: 3, coverage: 0.65 },
        // The turtle lanes are the slowest, so on the wider 23-column board their
        // gaps became the longest wait (4.27s against a 4s fairness limit).
        // Density rises to keep the wait where it was; tools/lane-check.js is
        // the gate that caught it.
        { off: 1, type: 'turtle',  dir:  1, speed: 0.26, w: 3, coverage: 0.74 },
        { off: 2, type: 'lilypad', dir: -1, speed: 0.40, w: 1, coverage: 0.35 },
        { off: 3, type: 'turtle',  dir:  1, speed: 0.28, w: 3, coverage: 0.72 },
        { off: 4, type: 'log',     dir: -1, speed: 0.32, w: 3, coverage: 0.65 }
    ];

    // Alternating traffic direction is most of what makes a road lane readable.
    // fast:true lanes run 1.5x - one per band, and further up the board each
    // time, so the run gets meaner the closer you get to the goal.
    const ROAD_SHAPE = [
        // Reverted to pre-box-grid sizing at Gabriel's call (2026-09-07):
        // trucks 2.0, cars 1.6 (whole-box 3/2 made vehicles dominate the lane).
        { off: 0, dir:  1, speed: 0.46, w: 2.0, imgKey: 'truck-semi-v2'  },
        { off: 1, dir: -1, speed: 0.60, w: 1.6, imgKey: 'car-yellow-v2'  },
        { off: 2, dir:  1, speed: 0.40, w: 2.0, imgKey: 'truck-blue-v2'  },
        { off: 3, dir: -1, speed: 0.66, w: 1.6, imgKey: 'car-red-v2'     },
        { off: 4, dir:  1, speed: 0.44, w: 2.0, imgKey: 'truck-green-v2' }
    ];

    const FAST_MULT = 1.5;
    const FAST_OFFS = [3, 2, 1];      // middle lanes only; see buildLayout

    // ONE TERRAIN DESCRIPTOR for every consumer - both renderers, validators
    // and tools. Copied range checks per file are why the 2D build still
    // painted water through row 5 and medians at 6/12 long after the board grew
    // to 37 rows across 3 bands. Anything that needs to know what a row IS asks
    // here; nothing re-derives it from literals.
    // Classes: 'goal' | 'water' | 'road' | 'median'.
    // Rebuilt by buildLayout() for every board, so they are `let`: read them
    // live (or through the Sim.* getters), never keep a copy across a stage.
    let WATER_LANES = [];
    let ROAD_LANES = [];
    let MEDIAN_ROWS = [];
    let MEDIAN_SET = new Set();
    let ROW_CLASS = [];
    let ROW_PLATFORM = {};
    // Every water row across ALL sections. The drown test used to be a literal
    // `y >= 1 && y <= 5`, which was band 0 only - so after the board went from
    // 13 rows to 37, two thirds of the water was harmless and you could walk
    // straight across it. Derived from the lane table so it can never drift.
    let WATER_ROW_SET = new Set();
    let layoutKey = '';

    // Section s occupies rows [1 + s*6 .. 6 + s*6]: five lanes at +0..+4 and
    // its median at +5. LAYOUT_1 reproduces the original 37-row board exactly
    // (water 1-5, road 7-11, water 13-17 ... start 36).
    function buildLayout(sections) {
        WATER_LANES = [];
        ROAD_LANES = [];
        MEDIAN_ROWS = [];
        let road = 0;
        sections.forEach((kind, s) => {
            const base = 1 + s * 6;
            if (kind === 'water') {
                WATER_SHAPE.forEach(l => WATER_LANES.push(Object.assign({}, l, { row: base + l.off })));
            } else {
                // one fast lane per road section, stepping through the lanes
                // section by section. Only the middle three offsets: offsets 0
                // and 4 are the rows directly off a median - and off the START
                // row, which made the very first hop land in the fastest
                // traffic on the board. (The old `(3 - r + 5) % 5` walked all
                // five, which was fine for three road sections but put a fast
                // lane against a median as soon as a stage had four.)
                const r = road++;
                ROAD_SHAPE.forEach(l => {
                    const fast = (l.off === FAST_OFFS[r % FAST_OFFS.length]);
                    ROAD_LANES.push(Object.assign({}, l, {
                        row: base + l.off,
                        speed: l.speed * (fast ? FAST_MULT : 1),
                        fast: fast
                    }));
                });
            }
            MEDIAN_ROWS.push(base + 5);
        });
        BANDS = road;
        ROWS = 1 + sections.length * 6;
        MEDIAN_SET = new Set(MEDIAN_ROWS);
        const t = new Array(ROWS).fill('median');
        ROAD_LANES.forEach(l => { t[l.row] = 'road'; });
        WATER_LANES.forEach(l => { t[l.row] = 'water'; });
        MEDIAN_ROWS.forEach(r => { t[r] = 'median'; });
        t[0] = 'goal';
        ROW_CLASS = t;
        // Water rows carry a platform type as well as a class.
        ROW_PLATFORM = {};
        WATER_LANES.forEach(l => { ROW_PLATFORM[l.row] = l.type; });
        WATER_ROW_SET = new Set(WATER_LANES.map(l => l.row));
        layoutKey = sections.map(k => k[0]).join('');
    }
    buildLayout(LAYOUT_1);

    function rowClass(row) { return ROW_CLASS[row] || 'median'; }
    function rowPlatform(row) { return ROW_PLATFORM[row] || null; }

    function goalCol() { return Math.floor(COLS / 2); }
    // Half the portal's drawn width (portal-frame dx 2.2), so every column the
    // arch covers clears the stage - not just the one it is centred on.
    const GATE_HALF_W = 1.1;

    let frog = { x: goalCol(), y: ROWS - 1 };
    let cars = [];
    let logs = [];
    let turtles = [];
    let lilypads = [];
    let sparks = [];
    let bugs = [];
    let shades = [];
    let lifePickups = [];
    let hazards = [];

    // Hop rate. Movement used to be uncapped, so holding a key machine-gunned
    // the frog across the board. HOP_MS is the normal gate; eating a purple bug
    // drops it to HOP_MS_FAST (the old feel) for BOOST_MS.
    // 2026-09-12: slowed to 266ms on Gabriel's ask, but that left a dead 66ms
    // after the 200ms hop animation landed and made movement feel like it was
    // sliding. Reverted to 190ms (matches the hop arc; no dead window).
    const HOP_MS = 190;
    const HOP_MS_FAST = 95;
    const BOOST_MS = 6000;
    const SHADES_MS = 20000;     // Gabriel: long enough to actually play in it
    let lastHopAt = 0;
    let boostUntil = 0;
    let shadesUntil = 0;

    // ONE GAMEPLAY CLOCK. These deadlines used to read performance.now() while
    // motion advanced on the supplied dt, so hop gating, the speed boost and the
    // shades timer all kept running while the game was paused or the tab was
    // hidden - you could lose a 20s pickup to a phone call. simTimeMs advances
    // ONLY inside update(), from the same dt that moves everything else, so
    // every gameplay duration is measured on the clock the simulation runs on.
    // Units: milliseconds of simulated time.
    let simTimeMs = 0;
    function nowMs() { return simTimeMs; }
    // Wall-clock is still the right answer for anything OUTSIDE the simulation
    // (measuring real elapsed time in tools, for example). Gameplay must not
    // use it.
    function wallMs() {
        return (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
    }
    function boostActive() { return nowMs() < boostUntil; }
    function shadesActive() { return nowMs() < shadesUntil; }
    function hopIntervalMs() { return boostActive() ? HOP_MS_FAST : HOP_MS; }

    function hasLocalStorage() {
        try {
            return typeof localStorage !== 'undefined' && localStorage !== null;
        } catch (e) {
            return false;
        }
    }

    const SAVE_VERSION = 1;

    // Parseable is not the same as valid. This used to JSON.parse and assign,
    // so a save of {points: "oops", level: 99} loaded intact and every consumer
    // downstream did arithmetic on a string. Validate each campaign, fill in
    // any that are missing, drop ids we no longer ship, and re-derive level
    // from points so a hand-edited level cannot unlock content.
    function sanitiseCampaign(raw) {
        const out = { points: 0, level: 1 };
        if (raw && typeof raw === 'object') {
            const p = Number(raw.points);
            if (Number.isFinite(p) && p >= 0) out.points = Math.floor(p);
        }
        applyProgression(out);         // level is derived, never trusted
        return out;
    }

    function migrate(parsed) {
        // v0 (unversioned) is the same shape; only the guarantees differ, so
        // sanitising IS the migration. Future versions branch here.
        const src = (parsed && typeof parsed === 'object' && parsed.campaigns)
            ? parsed.campaigns : parsed;
        const out = {};
        CAMPAIGNS.forEach(c => {
            out[c.id] = sanitiseCampaign(src && src[c.id]);
        });
        return out;
    }

    function loadData() {
        try {
            const saved = hasLocalStorage() ? localStorage.getItem('burnquest_campaigns') : null;
            if (!saved) { resetData(); return; }
            campaignData = migrate(JSON.parse(saved));
            saveData();                // rewrite in the current shape
        } catch (e) { resetData(); }
    }

    function resetData() {
        campaignData = {};
        CAMPAIGNS.forEach(c => campaignData[c.id] = { points: 0, level: 1 });
        saveData();
    }

    function saveData() {
        try {
            if (hasLocalStorage()) {
                localStorage.setItem('burnquest_campaigns',
                    JSON.stringify({ version: SAVE_VERSION, campaigns: campaignData }));
            }
        } catch (e) {}
    }

    function getCampaigns() { return CAMPAIGNS; }

    function getCampaignData(id) { return campaignData[id]; }

    function selectCampaign(id) {
        const c = CAMPAIGNS.find(c => c.id === id);
        if (!c) return null;
        currentCampaignId = id;
        return c;
    }

    function getCurrentCampaign() {
        return CAMPAIGNS.find(c => c.id === currentCampaignId) || null;
    }

    function getCols() { return COLS; }

    function setCols(n) {
        // Column count is only allowed to change between runs: entity x
        // positions are in tile units and would be invalid if the column
        // count moved mid-run.
        if (!gameRunning) COLS = n;
    }

    function laneCount(w, coverage) {
        return Math.max(2, Math.round((COLS * coverage) / w));
    }

    function spawnEntities() {
        const cfg = stageCfg(stage);

        WATER_LANES.forEach(lane => {
            const n = laneCount(lane.w, lane.coverage * cfg.coverage);
            const gap = COLS / n;
            const phase = Math.random() * gap;   // whole lane shares one offset
            for (let k = 0; k < n; k++) {
                const p = { x: phase + k * gap, y: lane.row, dir: lane.dir,
                            speed: lane.speed * cfg.platformSpeed, w: lane.w };
                if (lane.type === 'log') logs.push(p);
                else if (lane.type === 'turtle') turtles.push(p);
                else lilypads.push(p);
            }
        });

        ROAD_LANES.forEach(lane => {
            const n = Math.max(2, Math.round((COLS / 5) * cfg.traffic));
            const gap = COLS / n;
            const phase = Math.random() * gap;
            for (let k = 0; k < n; k++) {
                cars.push({ x: phase + k * gap, y: lane.row, dir: lane.dir,
                            speed: lane.speed * cfg.carSpeed, w: lane.w,
                            imgKey: lane.imgKey,
                            fast: !!lane.fast });
            }
        });

        // Pickups scatter freely across ALL non-water rows (not locked to
        // 6-row blocks). The old block system put half the pickups on the
        // same median row every run because those blocks had only one
        // non-water row. Nothing spawns on open water: nothing to stand on.
        const allRows = [];
        for (let r = 1; r < ROWS - 1; r++) {
            if (ROW_CLASS[r] !== 'water') allRows.push(r);
        }

        const used = new Set();
        const placed = [];
        const MIN_COL_GAP = 3;
        function free(x, y) {
            if (used.has(x + ':' + y)) return false;
            return !placed.some(p => p.y === y && Math.abs(p.x - x) < MIN_COL_GAP);
        }
        function tryPlace(rows, put) {
            if (!rows.length) return;
            let x = 0, y = rows[0], tries = 0;
            do {
                x = Math.floor(Math.random() * COLS);
                y = rows[Math.floor(Math.random() * rows.length)];
            } while (!free(x, y) && ++tries < 40);
            if (!free(x, y)) {
                let ok = false;
                for (const ry of rows) {
                    for (let rx = 0; rx < COLS; rx++) {
                        if (free(rx, ry)) { x = rx; y = ry; ok = true; break; }
                    }
                    if (ok) break;
                }
                if (!ok) return;
            }
            used.add(x + ':' + y);
            placed.push({ x, y });
            put(x, y);
        }
        // Scatter N pickups randomly across all non-water rows. Each run
        // lands on different rows AND columns.
        function scatter(total, put) {
            for (let i = 0; i < total; i++) tryPlace(allRows, put);
        }

        scatter(cfg.sparks * BANDS,
               (x, y) => sparks.push({ x, y, collected: false }));

        // Sunglasses: 2 per board, one in each HALF so they are spread out
        // across different sections. Halves are split from the available
        // rows so a taller board still divides correctly.
        {
            const mid = Math.floor(allRows.length / 2);
            tryPlace(allRows.slice(0, mid),
                     (x, y) => shades.push({ x, y, collected: false }));
            tryPlace(allRows.slice(mid),
                     (x, y) => shades.push({ x, y, collected: false }));
        }

        // Extra life: 1 pickup, only on stage 3 and 5. Uses the heal coin GLB
        // (green heart) as the pickup visual. Collecting gives +1 life.
        if (stage === 3 || stage === 5) {
            tryPlace(allRows,
                     (x, y) => lifePickups.push({ x, y, collected: false }));
        }

        // Purple bugs: the speed power-up. Scattered across all rows.
        scatter(BANDS, (x, y) => bugs.push({ x, y, collected: false }));

        spawnHazards(cfg);
    }

    // Snakes and birds patrol the grass; an alligator cruises each river.
    // Touching one costs a life (see update()).
    function spawnHazards(cfg) {
        // NEVER the start row: standing still at spawn has to be safe. The goal
        // row is a median too and is left clear for the same reason.
        const grassRows = MEDIAN_ROWS.filter(r => r !== ROWS - 1);
        // One lane per river, a turtle lane (off 1 or 3) rather than the sparse
        // lilypad lane in the middle, which is punishing enough already.
        const rivers = {};
        WATER_LANES.forEach(l => {
            const s = Math.floor((l.row - 1) / 6);
            (rivers[s] = rivers[s] || []).push(l);
        });
        const riverLanes = Object.keys(rivers).map((key, s) => {
            const lanes = rivers[key];
            return lanes[(s % 2) ? 3 : 1] || lanes[0];
        });

        function add(kind, row, dir) {
            const spec = HAZARD_KIND[kind];
            const x = Math.random() * Math.max(1, COLS - spec.w);
            // Gabriel: hazards "walk back and forth the whole time" from the
            // left wall to the right wall until the character lands in their
            // section. So the beat is the FULL row width, not a patch around
            // the spawn point. Hunting still ignores the beat (it has to be
            // able to cross the whole row to reach the frog).
            const maxX = Math.max(0, COLS - spec.w);
            const swims = kind === 'gator';
            // A river is the contiguous run of water rows around this one.
            let lo = row, hi = row;
            if (swims) {
                while (WATER_ROW_SET.has(lo - 1)) lo--;
                while (WATER_ROW_SET.has(hi + 1)) hi++;
            }
            hazards.push({ kind, y: row, w: spec.w, speed: spec.speed, x,
                           // a beat is for PATROLLERS; a swimmer roams instead
                           beatLo: swims ? undefined : 0,
                           beatHi: swims ? undefined : maxX,
                           swimLo: swims ? lo : undefined,
                           swimHi: swims ? hi : undefined,
                           targetY: swims ? row : undefined,
                           dir: dir || (Math.random() < 0.5 ? -1 : 1),
                           patrol: kind !== 'gator' });
        }

        // HAND-PLACED SPOTS win over everything else. grass 1 / river 1 are the
        // first you meet walking up from the start row, and both lists come from
        // the live layout so the numbering survives a board change.
        if (cfg.hazardSpots && cfg.hazardSpots.length) {
            const verges = MEDIAN_ROWS.filter(r => r !== ROWS - 1).slice().sort((a, b) => b - a);
            const rivers = [];
            WATER_LANES.slice().sort((a, b) => b.row - a.row).forEach(l => {
                const last = rivers[rivers.length - 1];
                if (last && last.rows[last.rows.length - 1] - l.row === 1) last.rows.push(l.row);
                else rivers.push({ rows: [l.row], dir: l.dir });
            });
            cfg.hazardSpots.forEach(spot => {
                if (spot.river) {
                    const r = rivers[spot.river - 1];
                    if (r) add('gator', r.rows[Math.floor(r.rows.length / 2)], r.dir);
                } else {
                    const row = verges[spot.grass - 1];
                    if (row !== undefined) add(spot.kind, row);
                }
            });
            return;
        }

        // Exact totals win when a stage names them.
        if (cfg.hazardCounts) {
            const pool = grassRows.slice();
            ['snake', 'bird'].forEach(kind => {
                for (let k = 0; k < (cfg.hazardCounts[kind] || 0); k++) {
                    const row = pool.length
                        ? pool.splice(Math.floor(Math.random() * pool.length), 1)[0]
                        : grassRows[k % grassRows.length];
                    add(kind, row);
                }
            });
            for (let k = 0; k < (cfg.hazardCounts.gator || 0); k++) {
                const lane = riverLanes[k % riverLanes.length];
                if (lane) add('gator', lane.row, lane.dir);
            }
            return;
        }

        // Otherwise: a density per verge, and gators per river.
        const per = cfg.grassHazards || 0;
        let spawned = 0;
        grassRows.forEach((row, i) => {
            const base = Math.floor(per);
            const frac = per - base;
            const extra = frac > 0 && (i % Math.max(1, Math.round(1 / frac))) === 0 ? 1 : 0;
            for (let k = 0; k < base + extra; k++) {
                // Alternate per hazard SPAWNED, not per row index: keyed on the
                // row index, a stage using every OTHER verge only ever saw even
                // indices and spawned nothing but snakes.
                add(spawned++ % 2 ? 'bird' : 'snake', row);
            }
        });
        riverLanes.forEach(lane => {
            for (let k = 0; k < (cfg.gators || 0); k++) add('gator', lane.row, lane.dir);
        });
    }

    function addFloatingText(x, y, text, color) {
        floatingTexts.push({ x, y, text, color: color || '#fff', life: 40, vy: -1.5 });
    }

    // Everything a fresh BOARD needs, shared by startRun and advanceStage.
    // Deliberately does NOT touch score, lives or the run clock: those belong
    // to the run, not the board, and carrying them is what makes a stage a
    // continuation rather than a new game.
    function buildBoardState() {
        // The stage's own board shape first: ROWS, the lanes and the row
        // classes all come from it, and everything below reads them.
        buildLayout(stageCfg(stage).layout);
        stageStartMs = simTimeMs;     // the stage clock starts with the board
        invincible = 40;
        combo = 0;
        comboTimer = 0;
        shake = 0;
        floatingTexts = [];
        currentPlatform = null;
        frog = { x: goalCol(), y: ROWS - 1 };
        cars = [];
        logs = [];
        turtles = [];
        lilypads = [];
        sparks = [];
        bugs = [];
        shades = [];
        lifePickups = [];
        hazards = [];
        shadesUntil = 0;
        boostUntil = 0;
        lastHopAt = 0;
        spawnEntities();
    }

    // opts.stage starts a PRACTICE run on a later board (?stage=N in the game),
    // so a stage can be tried without playing the ones before it. It must never
    // pay out: a practice run banks nothing at the finish.
    let practice = false;
    // Gabriel 2026-09-11: "the points accumilated can go towards the burn after
    // they pass a level ... if they lose game before passing a level then that
    // level accumilated point wont count to the burn". So a level's points are
    // ESCROW: score is cumulative across stages for the HUD, and this marks how
    // much of it was already banked, so a commit only ever pays out the stage
    // the player actually finished.
    let bankedScore = 0;
    function startRun(opts) {
        gameRunning = false;      // let the caller re-pick COLS via setCols() first
        runActive = true;
        simTimeMs = 0;            // the run owns its own clock from zero
        score = 0;
        lives = 3;
        bankedScore = 0;
        const want = Math.floor((opts && opts.stage) || 1);
        stage = Math.min(Math.max(1, want), STAGES.length);
        // Starting on a later board is practice by default (that is what
        // ?stage=N is for). Tools that need a REAL run on one board - the gate
        // that checks the final stage banks points - pass practice: false.
        practice = (opts && opts.practice !== undefined) ? !!opts.practice : stage > 1;
        buildBoardState();
        gameRunning = true;
    }

    // Reaching the gateway on a non-final stage. The run continues: score and
    // lives carry, only the board is rebuilt - from the next row of STAGES, so
    // it comes back harder. Points are NOT banked here; a run banks once, at
    // finishRun.
    function advanceStage() {
        // PASSING the level is what pays. Bank the points earned on this board
        // before building the next one; a run that dies later keeps these.
        const banked = commitStagePoints();
        stage++;
        const cfg = stageCfg(stage);
        buildBoardState();
        const camp = getCurrentCampaign();
        const data = camp ? campaignData[camp.id] : null;
        return { type: 'stage', stage, name: cfg.name,
                 isFinal: stage >= STAGES.length,
                 banked, practice,
                 pct: data ? levelPct(data) : 0,
                 level: data ? data.level : 1,
                 levelsGained: banked > 0 ? lastLevelsGained : 0,
                 score, lives };
    }

    // The ONE place points move from a run into the campaign. Returns what it
    // paid out, and pays nothing on a practice run - otherwise ?stage=N would
    // be a points farm.
    let lastLevelsGained = 0;
    function commitStagePoints() {
        lastLevelsGained = 0;
        const pending = score - bankedScore;
        if (practice || pending <= 0) return 0;
        const camp = getCurrentCampaign();
        const data = camp ? campaignData[camp.id] : null;
        if (!data) return 0;
        data.points += pending;
        lastLevelsGained = applyProgression(data);
        saveData();
        bankedScore = score;
        return pending;
    }

    // Pause STOPS the clock; it does not end the run. resume() puts the same
    // run back exactly where it was. The control used to drop straight back to
    // the dashboard with no way in, so the only route onward was startRun(),
    // which reset the board - a pause button that silently abandoned the run.
    function pause() {
        if (!gameRunning) return false;
        gameRunning = false;
        return true;
    }

    function resume() {
        if (gameRunning || !runActive) return false;
        gameRunning = true;
        return true;
    }

    // A run exists (possibly paused) as opposed to merely not-running.
    function isPaused() { return runActive && !gameRunning; }
    function hasRun() { return runActive; }

    function abandonRun() {
        gameRunning = false;
        runActive = false;
    }

    function isRunning() { return gameRunning; }

    // Level is DERIVED from cumulative points, never incremented ad hoc.
    // Overflow policy: points are the running total of tokens scheduled for
    // burn, so they are cumulative and never reset or deducted - crossing a
    // goal raises the level and the surplus carries into the next one. Because
    // the level is a pure function of points, a save that disagrees is
    // corrected on load rather than trusted.
    // Returns how many levels were gained by this call.
    function applyProgression(data) {
        if (!data) return 0;
        const before = data.level;
        let lvl = 1;
        while (lvl < LEVEL_GOALS.length + 1 && data.points >= LEVEL_GOALS[lvl - 1]) lvl++;
        data.level = Math.min(lvl, LEVEL_GOALS.length + 1);
        return Math.max(0, data.level - before);
    }

    // Percent toward the CURRENT level's goal, counting only the points earned
    // since the previous goal - otherwise every level after the first opens at
    // an already-high percentage.
    function levelPct(data) {
        if (!data) return 0;
        const maxed = data.level > LEVEL_GOALS.length;
        if (maxed) return 100;
        const floorPts = data.level > 1 ? LEVEL_GOALS[data.level - 2] : 0;
        const goal = LEVEL_GOALS[data.level - 1];
        const span = Math.max(1, goal - floorPts);
        return Math.max(0, Math.min(100, Math.floor(((data.points - floorPts) / span) * 100)));
    }

    function finishRun() {
        // The public UI presents these numbers as a LOCAL, UNVERIFIED burn
        // estimate, not as authoritative burn accounting. The totals still live
        // in localStorage and sanitiseCampaign validates shape, not provenance -
        // devtools can still set any value. A REAL token burn must reconcile
        // against a server-authoritative score (signed run receipts or
        // server-scored runs); that backend is not built yet and is NOT faked
        // or signed client-side. The client is intentionally not the accounting
        // layer for anything with financial weight.
        gameRunning = false;
        runActive = false;

        // 150 is the CAMPAIGN completion bonus (one per finished run), not a
        // per-level one. The board just cleared is still in escrow, so pay that
        // and the bonus - never the whole cumulative score, or every stage
        // already committed would be paid twice.
        const points = 150 + Math.max(0, score - bankedScore);
        const camp = getCurrentCampaign();
        const data = camp ? campaignData[camp.id] : null;
        let pct = 0, levelsGained = 0, level = 1, maxed = false;
        if (data && practice) {
            pct = levelPct(data);             // report where the campaign stands,
            level = data.level;               // but bank nothing
        } else if (data) {
            data.points += points;
            levelsGained = applyProgression(data);
            saveData();
            pct = levelPct(data);
            level = data.level;
            maxed = data.level > LEVEL_GOALS.length;
        }

        return { type: 'finish', points: practice ? 0 : points, practice,
                 pct, level, levelsGained, maxed,
                 campaignName: camp ? camp.name : '' };
    }

    function moveFrog(dx, dy) {
        const events = [];
        // Swipes call this directly, not through the loop, so a paused run -
        // or one held while the frog is drawn into the portal - has to refuse
        // here or the frog hops about on a board nobody is playing.
        if (!gameRunning) return events;
        const t = nowMs();
        if (t - lastHopAt < hopIntervalMs()) return events;   // rate-gated
        const nx = frog.x + dx;
        const ny = frog.y + dy;
        // frog.x drifts fractionally while it rides a platform and never snaps
        // back on land, so `nx < 0` used to refuse a left hop from x=0.97 and
        // the wall stayed a whole cell out of reach on every row. Clamp the
        // landing to the edge column instead; a hop from the wall itself still
        // refuses (no move, no chirp), so pressing into it stays silent.
        if (ny < 0 || ny >= ROWS) return events;
        const lx = Math.max(0, Math.min(COLS - 1, nx));
        if (dx !== 0 && lx === frog.x) return events;
        lastHopAt = t;

        frog.x = lx;
        frog.y = ny;
        currentPlatform = null; // reset when player manually moves

        sparks.forEach(s => {
            if (!s.collected && Math.abs(s.x - frog.x) < 0.8 && Math.abs(s.y - frog.y) < 0.8) {
                s.collected = true;
                combo++;
                comboTimer = COMBO_WINDOW;
                const points = 50 + (combo - 1) * 15;
                score += points;
                addFloatingText(frog.x, frog.y, `+${points}`, combo > 2 ? '#f1c40f' : '#2ecc71');
                events.push({ type: 'collect', points, combo, x: frog.x, y: frog.y });
            }
        });

        bugs.forEach(b => {
            if (!b.collected && Math.abs(b.x - frog.x) < 0.8 && Math.abs(b.y - frog.y) < 0.8) {
                b.collected = true;
                boostUntil = nowMs() + BOOST_MS;
                score += 250;
                addFloatingText(frog.x, frog.y, 'SPEED!', '#c46bff');
                events.push({ type: 'boost', ms: BOOST_MS, x: frog.x, y: frog.y });
            }
        });

        shades.forEach(g => {
            if (!g.collected && Math.abs(g.x - frog.x) < 0.8 && Math.abs(g.y - frog.y) < 0.8) {
                g.collected = true;
                shadesUntil = nowMs() + SHADES_MS;
                score += 200;
                addFloatingText(frog.x, frog.y, 'SHADES!', '#4fd8ff');
                events.push({ type: 'shades', ms: SHADES_MS, x: frog.x, y: frog.y });
            }
        });

        lifePickups.forEach(lp => {
            if (!lp.collected && Math.abs(lp.x - frog.x) < 0.8 && Math.abs(lp.y - frog.y) < 0.8) {
                lp.collected = true;
                if (lives < 5) lives++;
                score += 100;
                addFloatingText(frog.x, frog.y, '+1 LIFE', '#18c964');
                events.push({ type: 'life', x: frog.x, y: frog.y });
            }
        });

        // TOUCHING THE TELEPORTER clears the stage - not merely reaching the
        // last row. Gabriel 2026-09-09: the player should be able to jump onto
        // the goal row and move along it, and the stage completes when they
        // actually touch the teleporter. Row 0 carries no hazard, so standing
        // there is safe; goalCol() is the column the portal is rendered on.
        // TOLERANCE, not equality. Riding a log or a turtle drifts frog.x by a
        // fraction of a tile and it never snaps back, so a frog that crossed
        // the water arrives on the goal row at x = 10.4676..., and a strict
        // `frog.x === goalCol()` could NEVER be true for it - the teleporter
        // would be permanently unreachable for exactly the players who did the
        // hard part. 0.6 is a little over half a tile, so the frog triggers it
        // when its cell overlaps the portal.
        // Gabriel 2026-09-12: "it might have 3 blocks wide and only the center
        // activates it, should be all 3". He is right, and the number was the
        // problem: portal-frame is dx 2.2 in glb-dims at 1 world unit per column,
        // so the arch spans goalCol +-1.1 while this accepted only +-0.6. The
        // outer thirds looked solid and did nothing. Take the tolerance FROM the
        // art so the two cannot drift apart again.
        if (frog.y <= 0 && Math.abs(frog.x - goalCol()) < GATE_HALF_W) {
            events.push(stage < STAGES.length ? advanceStage() : finishRun());
        }

        return events;
    }

    // cause: 'car' | 'water'. It is a historical fact about what happened and
    // belongs in the outcome. Consumers used to infer it from the frog's
    // position AFTER the respawn had already moved it back to the start row,
    // so the drown sound could play for a car hit and vice versa.
    // contactX/contactY are where it happened, for effects.
    // A game over reports the BURN split: what levels already passed paid in,
    // and what this unfinished level just cost. Both game-over screens drop
    // straight to the dashboard, so without this the player never learns which
    // half of the rule applied to them.
    function gameOverEvent(cause) {
        const camp = getCurrentCampaign();
        const data = camp ? campaignData[camp.id] : null;
        return { type: 'gameover', cause,
                 forfeited: practice ? 0 : Math.max(0, score - bankedScore),
                 bankedThisRun: practice ? 0 : bankedScore,
                 practice,
                 campaignPoints: data ? data.points : 0,
                 campaignName: camp ? camp.name : '' };
    }

    function die(cause) {
        const events = [];
        // Guard against a second kill-source overlapping the frog in the same
        // update() frame: without it, lives goes negative and duplicate
        // hit/gameover events fire.
        if (invincible > 0 || !gameRunning || lives <= 0) return events;

        shake = 10;
        lives--;
        combo = 0;
        currentPlatform = null;
        events.push({ type: 'hit', livesLeft: lives, cause: cause || 'unknown',
                      contactX: frog.x, contactY: frog.y });

        if (lives <= 0) {
            gameRunning = false;
            runActive = false;
            events.push(gameOverEvent('lives'));
        } else {
            frog = { x: goalCol(), y: ROWS - 1 };
            invincible = 60;
        }
        return events;
    }

    function update(dt) {
        if (!gameRunning) return [];

        // Clamp so a backgrounded tab does not teleport every entity on
        // return; dt is expressed in 60fps-frames.
        if (dt > 3) dt = 3;

        // Advance the ONE gameplay clock from the same dt that moves entities,
        // and from the clamped value - a hidden tab must not silently expire a
        // 20s pickup. dt is in 60fps-frames, so one frame is 1000/60 ms.
        simTimeMs += dt * (1000 / 60);

        // The stage clock. It runs on the one gameplay clock, so pause, the
        // portal celebration (which pauses the sim) and a hidden tab never eat
        // into it; deaths do not reset it - it is the time to get past the
        // LEVEL, not a per-life timer.
        const limit = stageLimitMs();
        if (limit && simTimeMs - stageStartMs >= limit) {
            gameRunning = false;
            runActive = false;
            return [gameOverEvent('time')];
        }

        const events = [];

        if (invincible > 0) invincible -= dt;
        if (comboTimer > 0) {
            comboTimer -= dt;
            if (comboTimer <= 0) combo = 0;
        }
        if (shake > 0) shake -= dt;

        // No in-stage speed ramp. It used to grow a speed multiplier by
        // 0.00008 a frame with no cap - traffic ran +29% after a minute, +58%
        // after two, 2.4x after five - and Gabriel noticed the cars creeping up
        // (2026-09-11). A stage's pace lives in STAGES and nowhere else.

        // Cars. The hitbox matches the drawn sprite: both span c.x .. c.x + c.w.
        // Contact kills once the box covers the frog's CENTRE - a plain point
        // test. The old 0.18 inset let a car swallow half his body before the
        // hit counted, which is why kills read as absorption, not contact.
        cars.forEach(c => {
            c.x += c.dir * c.speed * CAR_RATE * dt;
            if (c.dir > 0 && c.x > COLS) c.x = -c.w;
            if (c.dir < 0 && c.x < -c.w) c.x = COLS;

            if (invincible <= 0 && c.y === frog.y) {
                const fc = frog.x + 0.5;
                if (fc > c.x && fc < c.x + c.w) {
                    events.push.apply(events, die('car'));
                }
            }
        });

        // Hazards. Grass ones turn at the board edge (they patrol a row); the
        // river gator wraps like a platform. Both kill on contact, using the
        // same hitbox rule as traffic.
        // Gabriel: hazards first show on stage 2 at normal speed, then speed up
        // 0.10x per stage after that (stage 3 = 1.1x, 4 = 1.2x, 5 = 1.3x).
        const hazardMult = 1 + Math.max(0, stage - 2) * 0.10;
        hazards.forEach(h => {
            // Gabriel 2026-09-11: they go "back and forth ... until character
            // steps foot into their row ... then snake should go towards the
            // frog". So patrol is the DEFAULT and the hunt is a lock-on that
            // lasts exactly as long as the frog shares the row.
            // A swimmer hunts anywhere in its river; everyone else needs the
            // frog in their exact row.
            const swims = h.swimLo !== undefined;
            const inReach = swims ? (frog.y >= h.swimLo && frog.y <= h.swimHi)
                                  : h.y === frog.y;
            const hunting = invincible <= 0 && inReach;
            h.hunt = hunting;
            if (hunting) {
                const gap = (frog.x + 0.5) - (h.x + h.w / 2);
                const step = h.speed * HUNT_MULT * HAZARD_RATE * hazardMult * dt;
                h.dir = gap < 0 ? -1 : 1;
                // Clamp the last step to the gap. Stepping a fixed amount
                // every frame overshoots the frog and the hazard then sits on
                // him flipping dir - a jitter, not a chase.
                h.x += Math.abs(gap) <= step ? gap : h.dir * step;
            } else {
                h.x += h.dir * h.speed * HAZARD_RATE * hazardMult * dt;
            }
            if (swims) {
                // Hunting: swim to the frog's row. Idle: drift between rows of
                // the river so it works the whole water, not one lane.
                if (hunting) h.targetY = frog.y;
                else if (Math.abs(h.y - h.targetY) < SWIM_SETTLE) {
                    h.targetY = h.swimLo + Math.random() * (h.swimHi - h.swimLo);
                }
                const dy = h.targetY - h.y;
                const swimStep = SWIM_SPEED * (hunting ? HUNT_MULT : 1) * hazardMult * dt;
                h.y += Math.abs(dy) <= swimStep ? dy : (dy < 0 ? -swimStep : swimStep);
                if (h.y < h.swimLo) h.y = h.swimLo;
                if (h.y > h.swimHi) h.y = h.swimHi;
            }
            if (h.patrol && !hunting) {
                // The board edge still turns it around - with the snap gone the
                // beat was the ONLY thing doing that, so a hunt that ended past
                // maxX left it hanging off the edge (caught at x 21.8 on a
                // 23-column board once the snake's w went 1.6 -> 2.1).
                const edge = Math.max(0, COLS - h.w);
                if (h.x < 0) { h.x = 0; h.dir = 1; }
                else if (h.x > edge) { h.x = edge; h.dir = -1; }
                // Turn at the ends of the BEAT, not at the board walls.
                //
                // Gabriel 2026-09-12: "the hunters seem to reset in position
                // whenever i jump in their section and i jump off ... they should
                // just continue the path they where going". This used to SNAP
                // h.x back to the beat edge. A hunt deliberately takes the hazard
                // off its beat to chase him across the row, so the moment he left,
                // that snap teleported it back - the reset he saw. Turning it
                // around is enough: an ordinary patrol overshoots its edge by one
                // frame's step (~0.005), so the snap was only ever tidying a
                // rounding error, and off-beat it now WALKS home instead.
                const lo = Math.max(0, h.beatLo !== undefined ? h.beatLo : 0);
                const hi = Math.min(edge, h.beatHi !== undefined ? h.beatHi : edge);
                if (h.x <= lo) h.dir = 1;
                else if (h.x >= hi) h.dir = -1;
            } else if (h.patrol) {
                // Hunting: free to cross the row, but never off the board.
                const maxX = Math.max(0, COLS - h.w);
                if (h.x < 0) h.x = 0;
                else if (h.x > maxX) h.x = maxX;
            } else if (!hunting) {
                // A chasing gator must not wrap: it would vanish off one edge
                // and pop back in behind the frog mid-chase.
                if (h.dir > 0 && h.x > COLS) h.x = -h.w;
                if (h.dir < 0 && h.x < -h.w) h.x = COLS;
            }
            // A swimmer sits BETWEEN rows while crossing, so exact row equality
            // would let it glide straight through the frog.
            const sameRow = swims ? Math.abs(h.y - frog.y) < 0.5 : h.y === frog.y;
            if (invincible <= 0 && sameRow) {
                const fc = frog.x + 0.5;
                if (fc > h.x && fc < h.x + h.w) {
                    events.push.apply(events, die(h.kind));
                }
            }
        });

        let bestPlatform = null;
        let bestDist = 999;

        function checkPlatform(p) {
            if (p.y !== frog.y) return;
            const fc = frog.x + 0.5;
            if (fc <= p.x || fc >= p.x + p.w) return;
            const d = Math.abs(fc - (p.x + p.w / 2)) + (p === currentPlatform ? -0.3 : 0);
            if (d < bestDist) { bestDist = d; bestPlatform = p; }
        }

        function advance(p) {
            p.x += p.dir * p.speed * PLATFORM_RATE * dt;
            if (p.dir < 0 && p.x < -p.w) p.x = COLS;
            if (p.dir > 0 && p.x > COLS) p.x = -p.w;
            checkPlatform(p);
        }

        logs.forEach(advance);
        turtles.forEach(advance);
        lilypads.forEach(advance);

        if (bestPlatform) {
            currentPlatform = bestPlatform;
            // Ride at THIS platform's speed; hardcoding one rate for all
            // platform types is why frogs used to slide off and drown.
            frog.x += bestPlatform.dir * bestPlatform.speed * PLATFORM_RATE * dt;
        } else {
            currentPlatform = null;
            if (invincible <= 0 && WATER_ROW_SET.has(Math.round(frog.y))) {
                events.push.apply(events, die('water'));
            }
        }

        if (frog.x < 0) frog.x = 0;
        if (frog.x > COLS - 1) frog.x = COLS - 1;

        floatingTexts.forEach(t => {
            t.y += t.vy * 0.03 * dt;
            t.life -= dt;
        });
        floatingTexts = floatingTexts.filter(t => t.life > 0);

        return events;
    }

    function getState() {
        return {
            cols: COLS,
            rows: ROWS,
            layoutKey,
            goalCol: goalCol(),
            frog: { x: frog.x, y: frog.y },
            cars: cars.map(c => ({ x: c.x, y: c.y, dir: c.dir, w: c.w, imgKey: c.imgKey,
                                   speed: c.speed, fast: !!c.fast })),
            logs: logs.map(p => ({ x: p.x, y: p.y, dir: p.dir, w: p.w })),
            turtles: turtles.map(p => ({ x: p.x, y: p.y, dir: p.dir, w: p.w })),
            lilypads: lilypads.map(p => ({ x: p.x, y: p.y, dir: p.dir, w: p.w })),
            sparks: sparks.map(s => ({ x: s.x, y: s.y, collected: s.collected })),
            bugs: bugs.map(b => ({ x: b.x, y: b.y, collected: b.collected })),
            shades: shades.map(g => ({ x: g.x, y: g.y, collected: g.collected })),
            lifePickups: lifePickups.map(lp => ({ x: lp.x, y: lp.y, collected: lp.collected })),
            hazards: hazards.map(h => ({ x: h.x, y: h.y, w: h.w, dir: h.dir, kind: h.kind,
                                         hunt: !!h.hunt,
                                         beatLo: h.beatLo, beatHi: h.beatHi,
                                         swimLo: h.swimLo, swimHi: h.swimHi,
                                         targetY: h.targetY })),
            shadesLeft: Math.max(0, shadesUntil - nowMs()),
            boost: Math.max(0, boostUntil - nowMs()),
            medianRows: MEDIAN_ROWS,
            floatingTexts: floatingTexts.map(t => ({ x: t.x, y: t.y, text: t.text, color: t.color, life: t.life })),
            score,
            lives,
            combo,
            stage,
            stageName: stageCfg(stage).name,
            stageCount: STAGES.length,
            timeLimit: stageLimitMs() || null,
            timeLeft: stageLimitMs() ? Math.max(0, stageLimitMs() - (simTimeMs - stageStartMs)) : null,
            shake,
            invincible,
            gameRunning
        };
    }

    return {
        CAMPAIGNS,
        LEVEL_GOALS,
        STAGES,
        getStage: function () { return stage; },
        get ROWS() { return ROWS; },
        PLATFORM_RATE,
        CAR_RATE,
        get WATER_LANES() { return WATER_LANES; },
        get MEDIAN_ROWS() { return MEDIAN_ROWS; },
        get ROW_CLASS() { return ROW_CLASS; },
        rowClass,
        rowPlatform,
        get BANDS() { return BANDS; },
        get ROAD_LANES() { return ROAD_LANES; },

        getCols,
        setCols,

        loadData,
        saveData,
        resetData,
        getCampaigns,
        getCampaignData,
        selectCampaign,
        getCurrentCampaign,

        startRun,
        moveFrog,
        update,
        getState,
        isRunning,
        pause,
        resume,
        isPaused,
        hasRun,
        abandonRun,
        levelPct,
        finishRun,
        advanceStage
    };
}));
