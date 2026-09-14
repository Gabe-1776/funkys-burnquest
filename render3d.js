/**
 * Funky's BurnQuest
 * three.js renderer (r0.160.0 UMD, self-hosted as three.min.js - see
 * index.html). Reads a Sim.getState() snapshot; never touches sim state.
 * Placeholder primitive meshes only - real art drops in later through the
 * MANIFEST below without touching this file's render logic.
 *
 * Interface (shared with render2d.js): init(canvas), draw(state), resize(w,h)
 *
 * Known black-screen root causes this file guards against (see
 * ~/.claude/skills/game-development/references/threejs-macos-safari-black-screen.md):
 *   1. outputColorSpace setter can throw on older builds -> guarded with 'in'.
 *   2. Safari WebGL compositing -> premultipliedAlpha:false, preserveDrawingBuffer:true, alpha:false.
 *   3. Canvas-backed textures start white -> N/A here, no CanvasTexture is used.
 *   4. ctx.fillStyle needs a CSS string -> N/A here, no 2D canvas drawing.
 *   5. One render call per frame -> draw() is the only place render() is called.
 */
(function (root) {
    'use strict';

    // Debug-exposure gate: the live scene/renderer/camera are only exposed to
    // scripts on the page when ?debug=1 is in the URL, so a shipped page does
    // not hand a compromised script the three.js handles. Browser gates set
    // ?debug=1 themselves (tools/lib/debug-url.js).
    const DEBUG = !!(root && root.location && root.location.search &&
                     new URLSearchParams(root.location.search).get('debug') === '1');

    // Placeholder-art manifest. Real meshes/textures drop in here later by
    // filling these fields in; renderMesh() below never needs to change to
    // pick them up (it always asks the manifest first, primitive second).
    const MANIFEST = {
        frog: null,
        car: null,
        truck: null,
        log: null,
        turtle: null,
        lilypad: null,
        portal: null,
        spark: null
    };

    // Live palette. Mutated by applyTheme() rather than replaced, so every
    // reference below stays valid and a theme swap does not touch geometry.
    // The live palette. Themes MERGE into it, so any key a theme omits used to
    // keep whatever the previously loaded theme left there - and on a cold start
    // kept nothing at all. Measured: diorama shipped 9 keys and inherited the
    // other 18 from funkyverse, so a fresh diorama load drew the ground and
    // water with undefined colours while a toggle away and back "fixed" them.
    // BASE_COLORS guarantees every key exists; applyPalette() makes the swap
    // atomic so the result never depends on load order.
    const COLORS = {};
    const BASE_COLORS = {
        goal: 0x7fa348, water: 0x2c9c98, median: 0x7fa348, road: 0x37303f,
        roadLine: 0xf0ead8, rail: 0xff2fd0, railGlow: 0xff2fd0,
        log: 0x7a4f2a, logEnd: 0x9a6a3e,
        turtle: 0x6fa83f, turtleShell: 0x4d7a2c,
        lilypad: 0xa89a5c, lilyFlower: 0xf05fa0,
        frog: 0x5cff8f, frogLeg: 0x2a9c4c, frogEye: 0xffffff,
        spark: 0xffd54a, portal: 0xd63bff,
        car: 0xff7a2f, carAlt: 0xf5c518, truck: 0x7b3fb5, truckAlt: 0x2fa8a0,
        tyre: 0x1a1a1a, glass: 0x9fd8ff,
        ember: 0xff9a3c, headlight: 0xfff4d6, taillight: 0xff3b30
    };
    function applyPalette(t) {
        Object.keys(COLORS).forEach(k => { delete COLORS[k]; });
        Object.assign(COLORS, BASE_COLORS, t.colors || {});
    }
    // debug handle for tools/palette-probe.js
    if (DEBUG && typeof window !== 'undefined') window.__COLORS = COLORS;

    // Two themes, per Gabriel 2026-09-05:
    //   funkyverse - concept-grok-fv-1: synthwave desert sunset, neon grid,
    //                flamed muscle cars, bulb-lit portal. Uses Grok's hatted
    //                Funky (purple top hat, swirl glasses, chain).
    //   diorama    - concept-d-toy-diorama: glossy plastic on a tabletop,
    //                matte felt grass, resin water, warm studio key light.
    //                Uses the simpler modelled frog.
    // One five-vehicle sequence per theme, indexed by the lane's offset WITHIN
    // its road section (sim ROAD_LANES[].off), so it follows the roads wherever
    // a stage's layout puts them. It used to be keyed by absolute row (7-11,
    // 19-23, 31-35), which stopped matching the moment stage 2 added a river:
    // every vehicle would have fallen back to the generic car.
    function carFamily(seq) { return { family: seq }; }
    function carSpecFor(row) {
        const fam = theme.carsByRow && theme.carsByRow.family;
        if (!fam) return null;
        const lanes = (root.Sim && root.Sim.ROAD_LANES) || [];
        const lane = lanes.find(l => l.row === row);
        return lane ? fam[lane.off] : null;
    }

    const THEMES = {
        funkyverse: {
            assetDir: 'fv',
            scenery: { palm: true },
            portalVortexY: 0.63,           // TRELLIS arcade cabinet swirl centre
            carsByRow: carFamily([
                { model: 'truck-purple', color: 0x6b3cff },
                { model: 'taxi',         color: 0xffd428 },
                { model: 'truck-teal',   color: 0x2fa8a0 },
                { model: 'coupe-red',    color: 0xe23a2e },
                { model: 'muscle-flame', color: 0xff7a2f }
            ]),
            character: 'funky',
            // Rigged in Blender (tools/rig_funky.py): a real skeleton with idle,
            // hop and dance clips. Falls back to the static model on any failure.
            riggedCharacter: 'funky-rigged',
            // MEASURED, not assumed. Rendered unlit from +Z (tools/zoom-render.js)
            // the Meshy Funky shows a clean PROFILE facing screen-left, i.e. -X,
            // not -Z. Toward the goal is -Z (worldZ puts row 0 at negative z),
            // and rotation 0 must mean "facing the goal", so -X has to be turned
            // a quarter turn onto -Z. It was 0, which left him walking sideways
            // in every direction. The atan2 already handles all 8 headings; only
            // this constant was wrong.
            characterFaceOffset: -Math.PI / 2,
            cameraTilt: 0.86,              // lower: the character is upright and tall
            background: 0x3a1f33,
            fog: { color: 0x5c2b3d, near: 22, far: 60 },
            hemi: { sky: 0xffc9a0, ground: 0x5a3550, intensity: 0.75 },
            sun:  { color: 0xffd9a0, intensity: 1.7, pos: [7, 13, 6] },
            rim:  { color: 0xff5fbf, intensity: 0.55 },
            // Polish pass (Vulcan 2026-09-06): per-theme tone/shadow/water.
            // Sunset keeps a slightly lower exposure so the warm sky does not
            // crush the baked albedo; crisp toy-scale shadows.
            tone:   { exposure: 1.10 },
            shadow: { radius: 2 },
            water:  { opacity: 0.95, roughness: 0.14, metalness: 0.06 },
            embers: 300,
            // Shades-mode atmosphere: sunset desert, per concept-grok-fv-1.
            // Shown only while the camera is down in shades view (fades with
            // camBlend), so the normal top-down view stays faithful to the still.
            atmosphere: {
                skyTop: 0x2a1330, skyHorizon: 0xe89050, skyBottom: 0x3a1f33,
                sun: { color: 0xffd9a0, size: 9, glow: 18, pos: [7, 16, -30] },
                clouds: { color: 0xffe9d8, n: 6, spread: 40, y: 26 }
            },
            colors: {
                goal: 0x7fa348, water: 0x2c9c98, median: 0x7fa348, road: 0x37303f,
                roadLine: 0xf0ead8, rail: 0xff2fd0, railGlow: 0xff2fd0,
                log: 0x7a4f2a, logEnd: 0x9a6a3e,
                turtle: 0x6fa83f, turtleShell: 0x4d7a2c,
                lilypad: 0xa89a5c, lilyFlower: 0xf05fa0,
                frog: 0x5cff8f, frogLeg: 0x2a9c4c, frogEye: 0xffffff,
                spark: 0xffd54a, portal: 0xd63bff,
                car: 0xff7a2f, carAlt: 0xf5c518, truck: 0x7b3fb5, truckAlt: 0x2fa8a0,
                tyre: 0x14121a, glass: 0x9fd8ff,
                ember: 0xff9a3c, headlight: 0xfff4d6, taillight: 0xff3b30
            }
        },
        diorama: {
            assetDir: 'diorama',
            portalVortexY: 0.66,           // raised: the toy ring is bigger now
            character: 'funky',
            // The ORIGINAL rounded frog (Gabriel's pick over the blueprint's cube
            // one). Modelled facing -Y, which becomes +Z, so it needs a half
            // turn to face the goal. NOTE: the cube frog was modelled facing the
            // other way and inherited this offset unchanged - it was rendering
            // backwards the whole time it was in.
            characterFaceOffset: Math.PI,
            // The still is a toy photographed from BEHIND the frog at roughly
            // 55 degrees. Steeper than this and the board reads as a floorplan.
            cameraTilt: 0.80,
            // Warm beige tabletop, not a black studio void.
            background: 0xc9a57a,
            // The still has no atmospheric fog at all - push it far enough away
            // that it never tints the board.
            fog: { color: 0xc9a57a, near: 90, far: 260 },
            hemi: { sky: 0xffe9d0, ground: 0x8a6a48, intensity: 0.75 },
            sun:  { color: 0xfff4e2, intensity: 1.9, pos: [-7, 12, 7] },  // key from camera-left
            rim:  { color: 0xffd9b0, intensity: 0.25 },
            // Polish pass: bright studio look, softer toy shadows, resin water.
            tone:   { exposure: 1.22 },
            shadow: { radius: 4 },
            water: { opacity: 0.62, roughness: 0.10, metalness: 0.0 },
            embers: 0,
            // Shades-mode atmosphere: warm studio tabletop "daylight" - soft
            // cream sky, no sunset. Kept subtle so it never fights the still.
            atmosphere: {
                skyTop: 0xd8bfa5, skyHorizon: 0xf3e6d2, skyBottom: 0xc9a57a,
                sun: { color: 0xfff4e2, size: 6, glow: 12, pos: [-7, 14, -30] },
                clouds: { color: 0xfffbf4, n: 4, spread: 36, y: 24 }
            },
            // Three moulds, then colour - the still has a box truck, a
            // wagon/SUV and a compact, not one sedan in five palettes.
            carsByRow: carFamily([
                { model: 'truck-blue', color: 0x4a7ec8 },
                // 'compact' was never modelled - no compact.glb exists anywhere,
                // so this slot fell through glbInstance to buildModelMesh, which
                // ignores textures and paints flat grey: one untextured car in a
                // lane of textured ones. Theme 1 owns three moulds; reuse one.
                { model: 'wagon-lime', color: 0x7cb342 },
                { model: 'truck-blue', color: 0xe23a2e },
                { model: 'wagon-red',  color: 0xe23a2e },
                { model: 'wagon-lime', color: 0x8ed12a }
            ]),
            skirt: 0x6b4a2e,               // cardboard/wood board sides
            railKind: 'wood',
            // A COMPLETE palette. It used to define only the nine vehicle keys
            // and silently borrow funkyverse's neon greens and magenta rail for
            // everything else - which only worked if funkyverse had been loaded
            // first. These are the toy-diorama values: matte felt grass, resin
            // water, painted plastic tarmac.
            colors: {
                goal: 0x9ac46f, water: 0x63b9c4, median: 0x9ac46f, road: 0x6f6b74,
                roadLine: 0xf2efe6, rail: 0xc2c7d0, railGlow: 0xdfe4ec,
                log: 0xa97a4c, logEnd: 0xc2946a,
                turtle: 0x8fb84e, turtleShell: 0x6d8f38,
                lilypad: 0x7fbf5a, lilyFlower: 0xf58fc0,
                frog: 0x7ad46a, frogLeg: 0x4aa050, frogEye: 0xffffff,
                spark: 0xffd54a, portal: 0x9b6cff,
                car: 0xff5252, carAlt: 0xffd54a, truck: 0x4aa3ff, truckAlt: 0x66d19e,
                tyre: 0x1a1a1a, glass: 0x9fd8ff,
                ember: 0xff9a3c, headlight: 0xfff4d6, taillight: 0xff3b30
            }
        }
    };

    function pickTheme() {
        try {
            // explicit ?theme= wins, then whatever the player last chose in-game
            const t = (new URLSearchParams(location.search).get('theme') || '').toLowerCase();
            if (THEMES[t]) return t;
            const saved = localStorage.getItem('burnquest_theme');
            if (saved && THEMES[saved]) return saved;
        } catch (e) { /* no window / storage blocked */ }
        return 'funkyverse';
    }

    let themeName = pickTheme();
    let theme = THEMES[themeName];
    applyPalette(theme);

    // 140ms was ~8 frames at 60Hz - the squash/stretch was real but flashed past
    // too fast to read. 200ms still feels snappy for an arcade hop.
    const HOP_DURATION_MS = 200;
    const HOP_HEIGHT = 0.55;

    let THREE_ = null;
    let renderer = null;
    let scene = null;
    let camera = null;
    // WebGL context-loss state: while contextLost is true, draw() skips the
    // dead GL context. On loss the sim is paused so the player is not killed
    // behind a frozen frame; on restore the existing renderer is KEPT (three.js
    // rebuilt its GL state on the same context) and the sim resumes only if it
    // was running when the context was lost. wasRunningAtLoss records that;
    // ctxHandlersBound guards against duplicate listeners if init() were ever
    // called twice.
    let contextLost = false;
    let wasRunningAtLoss = false;
    let ctxHandlersBound = false;
    let boardGroup = null;
    // Translucent walls marking the edges of the PLAYABLE grid. The frog has
    // always been clamped to the columns, but nothing showed why it stopped -
    // the hop was simply refused, which reads as the controls dropping an input.
    let barrierL = null, barrierR = null;
    const BARRIER_H = 1.5;          // world units; tall enough to read at any tilt
    const BARRIER_FADE = 3;         // boxes from the edge where it starts to show
    const BARRIER_MAX = 0.40;       // never fully opaque - the board stays visible
    let entityGroup = null;
    let frogMesh = null;
    let portalMesh = null;

    let W = 0, H = 0;
    let cols = 15, rows = 13;
    // Rendered road half-width (see buildBoard). Wider than `cols` so the roads
    // run off-screen on any aspect ratio.
    let SURFACE_HALF = cols * 2;

    // Per-run mesh pools, rebuilt whenever the source array's length changes
    // (a fresh run, possibly with a different column count / lane counts).
    let carMeshes = [];
    let logMeshes = [];
    let turtleMeshes = []; // each entry is an array of 3 meshes (raft)
    let lilypadMeshes = [];
    let sparkMeshes = [];
    let bugMeshes = [];
    let shadesMeshes = [];
    let lifePickupMeshes = [];
    let hazardMeshes = [];
    let hazardKinds = '';
    let selectedCharacter = null;   // null = theme default, 'funkyverse'/'diorama'/'classic' = override
    let effectiveFaceOffset = null; // set by upgradeFrogToModel, read by installRiggedCharacter

    // Discrete-hop tween state. Sim moves the frog instantly (keeps the
    // "one tile per keypress" contract); this renderer interpolates the
    // visual position over a short arc so the hop reads as a jump, not a
    // teleport. Small fractional drift while riding a platform is NOT a
    // hop - it just tracks the sim value directly.
    let sunLight = null, hemiLight = null, rimLight = null;
    let portalFrame = null, portalVortex = null, portalToken = 0;

    // The ABSOLUTE world Y of each platform type's deck - the height the frog's
    // feet sit at while riding it. Measured from the real loaded meshes rather
    // than hardcoded, because the two themes have very different props: a fat
    // voxel log and a slim varnished one do not have the same deck height.
    // Defaults cover the primitive fallbacks and are absolute, not offsets.
    // The rig lifts its contents: upgradeFrogToModel() adds the character at
    // y = -RIG_FOOT_OFFSET inside the rig, so the rig's origin sits that far
    // ABOVE the character's feet. Any surface height must have it added back.
    // Dropping it looked correct against a gate that compared the renderer's
    // own rideY to its own rideTop, but sank the frog 0.205 into every log,
    // turtle and lilypad. tools/align-check.js now measures real foot geometry
    // against real platform bounds and would catch it.
    const RIG_FOOT_OFFSET = 0.2;
    const GROUND_Y = 0;                   // grass/median/road surface sits at y=0
    const rideTop = { log: 0.50, turtle: 0.46, lilypad: 0.32 };

    // Pass the REAL model mesh, never its group. Box3.setFromObject walks every
    // descendant regardless of .visible, so a group still holding its hidden
    // placeholder primitives reports THEIR height: the log's placeholder is
    // taller than the Meshy log, measured 0.385 against the model's true 0.197,
    // and the frog was placed 0.188 above the surface you can actually see. It
    // showed up as a clear gap in the low shades camera while the turtle and
    // lilypad, whose placeholders are shorter, looked fine.
    function recordRideTop(kind, obj) {
        // Box3.setFromObject also walks world matrices, and an object added this
        // frame still carries a stale one - that separately left the frog 0.068
        // above the log. Force the update before reading the bounds.
        obj.updateMatrixWorld(true);
        const box = new THREE_.Box3().setFromObject(obj);
        // frogMesh is parented to the scene, so a world-space top is directly
        // comparable to the frog's own Y - no conversion needed.
        if (isFinite(box.max.y)) rideTop[kind] = Math.max(0, box.max.y);
    }

    // Row -> platform type, straight from the sim's own lane table so the two
    // can never disagree about which row is water and what is in it.
    const rowKind = {};
    const rowClass = {};    // 'goal' | 'water' | 'road' | 'median'
    let layoutKey = null;
    // Re-run whenever the sim's layout changes: from stage 2 the board gains a
    // river, and a table filled once at load would keep drawing stage 1's rows.
    function buildRowTables() {
        Object.keys(rowKind).forEach(k => { delete rowKind[k]; });
        Object.keys(rowClass).forEach(k => { delete rowClass[k]; });
        const S = root.Sim || {};
        (S.WATER_LANES || []).forEach(l => { rowKind[l.row] = l.type; rowClass[l.row] = 'water'; });
        (S.ROAD_LANES  || []).forEach(l => { rowClass[l.row] = 'road'; });
        (S.MEDIAN_ROWS || []).forEach(r => { rowClass[r] = 'median'; });
        rowClass[0] = 'goal';
    }
    buildRowTables();
    // Fade each wall in as the frog approaches its side, so the boundary
    // announces itself a couple of hops before it blocks anything.
    function updateBarriers() {
        if (!barrierL || !barrierR) return;
        const opacityFor = (boxesAway) => {
            const t = 1 - Math.max(0, boxesAway) / BARRIER_FADE;
            return Math.max(0, Math.min(1, t)) * BARRIER_MAX;
        };
        const left = opacityFor(renderFrog.x);
        const right = opacityFor((cols - 1) - renderFrog.x);
        barrierL.material.opacity = left;
        barrierR.material.opacity = right;
        barrierL.visible = left > 0.01;
        barrierR.visible = right > 0.01;
    }

    function rideHeightAt(gridY) {
        const k = rowKind[Math.round(gridY)];
        return k ? (rideTop[k] || 0) : 0;
    }
    let renderFrog = { x: 7, y: 12 };
    let rideY = 0, lastRideRow = -1;
    let camDist = 12, camFocusZ = 0, camFocusX = 0, camBlend = 0;
    let shadesOn = false;
    let forcedShadesWas = false;   // debug-only: see __forceShades below
    let danceT = -1;          // >=0 while the goal celebration is playing

    let enterFrom = null;     // where the dance ended, so the draw-in is seamless
    let waterMeshes = [];
    // Polish pass (Vulcan 2026-09-06): onBeforeCompile captures ticked per
    // frame, plus generated surface textures that must die with the board
    // (disposeMaterial does not dispose maps).
    let waterShaders = [], procTextures = [];
    let sceneryGroup = null;
    // Shades-mode atmosphere: sky dome, sun, clouds. Built once per theme,
    // faded in/out with camBlend so it only shows in the low camera view.
    let skyMesh = null, sunMesh = null, sunGlow = null, cloudGroup = null;
    let atmosphereGroup = null;   // set by buildAtmosphere(); added to scene
    // Old combo text, restored from Mimi's original 2D build (2026-09-07):
    // floating "+points" sprites keyed text|x|color, plus the bottom-left
    // COMBO xN HUD. The sim owns the texts (life 40, alpha = life/40); these
    // are visual-only mirrors, so no sim edits and no wall-clock state.
    let textSprites = new Map();
    let comboHudEl = null;
    let comboShown = 0;         // last multiplier written, so the pop replays once
    // Real baked cloud meshes (Meshy bakeoff asset), swapped in for the flat
    // sprite puffs once loaded. keyed "meshy" | "blender" | "img2".
    let cloudMeshPool = null;
    const cloudModelCache = {};

    // Death effects. The sim respawns instantly (its behaviour is gated by
    // tools/lane-check.js and must not change), so the CORPSE is a separate
    // short-lived visual played by the renderer while the real frog blinks back
    // at the start row.
    let deathFx = null;
    let prevLives = null;
    let lastAlive = { x: 7, y: 12 };
    let lastGridX = 7, lastGridY = 12;
    let hopAnim = null;

    // Maps a grid POINT (not a cell index) to world X. Everything must pass the
    // point it actually means: a cell's centre is index + 0.5, a platform's
    // centre is x + w/2. The old version folded a +0.5 in here AND callers added
    // their own, so the frog sat half a tile left of every pickup it stood on.
    function worldX(gridPoint) { return gridPoint - cols / 2; }
    // Grid row 0 (the goal) maps to NEGATIVE z and the start row to positive z,
    // so the camera can sit at +z looking toward -z. That is three.js's default
    // camera orientation, which is what makes world +x land on SCREEN RIGHT.
    // With the camera on the -z side instead, it looked along +z - rotated 180
    // degrees - and +x rendered on screen LEFT, so the left and right arrow keys
    // moved the frog the wrong way.
    function worldZ(gridY) { return gridY - (rows - 1) / 2; }

    function makeRenderer(canvas) {
        const opts = {
            canvas,
            antialias: true,
            alpha: false,
            // Safari/macOS compositing fix: without these two the canvas can
            // composite as transparent/white even though WebGL rendered fine.
            premultipliedAlpha: false,
            preserveDrawingBuffer: true,
            powerPreference: 'high-performance'
        };
        const r = new THREE_.WebGLRenderer(opts);
        r.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
        r.setClearColor(0x05070f, 1);
        // outputColorSpace does not exist on every three.js build; setting it
        // unconditionally can throw and silently abort renderer setup.
        if ('outputColorSpace' in r && THREE_.SRGBColorSpace) {
            r.outputColorSpace = THREE_.SRGBColorSpace;
        }
        return r;
    }

    // Polish pass: generated surface textures (grass / road), drawn on a
    // canvas at build time - no image files, per the brief. Low-contrast
    // speckle keeps slab seams invisible; the road gets tyre-wear streaks and
    // a dark tarmac edge where it meets the grass. Registered in procTextures
    // so a board rebuild frees them.
    function surfaceTexture(kind) {
        const c = document.createElement('canvas');
        c.width = kind === 'road' ? 256 : 512;
        c.height = kind === 'road' ? 128 : 256;
        const g = c.getContext('2d');
        const srgb = new THREE_.Color(kind === 'road' ? COLORS.road : COLORS.median).convertLinearToSRGB();
        const css = (f) => 'rgb(' + Math.min(255, Math.round(srgb.r * 255 * f)) + ','
            + Math.min(255, Math.round(srgb.g * 255 * f)) + ',' + Math.min(255, Math.round(srgb.b * 255 * f)) + ')';
        g.fillStyle = css(1);
        g.fillRect(0, 0, c.width, c.height);
        // speckle, wrapped so the texture tiles without visible slab seams
        const specks = kind === 'road' ? 900 : 2600;
        for (let i = 0; i < specks; i++) {
            const f = 0.94 + Math.random() * 0.12;
            g.fillStyle = css(f);
            const w = 1 + Math.random() * 2, h = 1 + Math.random() * 2;
            const x = Math.random() * c.width, y = Math.random() * c.height;
            g.fillRect(x, y, w, h);
            if (x + w > c.width) g.fillRect(x - c.width, y, w, h);
            if (y + h > c.height) g.fillRect(x, y - c.height, w, h);
        }
        if (kind === 'road') {
            // traffic streaks along the lane direction
            for (let i = 0; i < 90; i++) {
                g.fillStyle = css(Math.random() < 0.5 ? 0.90 : 1.06);
                g.globalAlpha = 0.05 + Math.random() * 0.05;
                g.fillRect(Math.random() * c.width, Math.random() * c.height,
                    40 + Math.random() * 160, 1 + Math.random() * 2);
            }
            g.globalAlpha = 1;
            // two soft tyre-wear bands where wheels habitually run
            [0.36, 0.64].forEach(v => {
                const gr = g.createLinearGradient(0, (v - 0.05) * c.height, 0, (v + 0.05) * c.height);
                gr.addColorStop(0, 'rgba(0,0,0,0)');
                gr.addColorStop(0.5, 'rgba(0,0,0,0.16)');
                gr.addColorStop(1, 'rgba(0,0,0,0)');
                g.fillStyle = gr;
                g.fillRect(0, (v - 0.05) * c.height, c.width, 0.10 * c.height);
            });
            // dark edge where tarmac meets the grass
            const edge = g.createLinearGradient(0, 0, 0, c.height);
            edge.addColorStop(0, 'rgba(0,0,0,0.28)');
            edge.addColorStop(0.09, 'rgba(0,0,0,0)');
            edge.addColorStop(0.91, 'rgba(0,0,0,0)');
            edge.addColorStop(1, 'rgba(0,0,0,0.28)');
            g.fillStyle = edge;
            g.fillRect(0, 0, c.width, c.height);
        } else {
            // subtle mow band, centred so it stripes every grass row
            const band = g.createLinearGradient(0, c.height * 0.25, 0, c.height * 0.75);
            band.addColorStop(0, 'rgba(255,255,255,0)');
            band.addColorStop(0.5, 'rgba(255,255,255,0.06)');
            band.addColorStop(1, 'rgba(255,255,255,0)');
            g.fillStyle = band;
            g.fillRect(0, c.height * 0.25, c.width, c.height * 0.5);
        }
        const tex = new THREE_.CanvasTexture(c);
        if ('colorSpace' in tex && THREE_.SRGBColorSpace) tex.colorSpace = THREE_.SRGBColorSpace;
        tex.wrapS = tex.wrapT = THREE_.RepeatWrapping;
        tex.anisotropy = 4;
        procTextures.push(tex);
        return tex;
    }

    // Per-theme exposure (polish pass): sunset keeps a lower exposure, the
    // studio diorama a brighter one; the shades-mode lens darkening keys off
    // the same base so it stays relative.
    function themeExposure() {
        return (theme.tone && theme.tone.exposure) || 1.15;
    }

    function themeShadowRadius() {
        return (theme.shadow && theme.shadow.radius) || 2;
    }

    function buildBoard() {
        if (boardGroup) {
            scene.remove(boardGroup);
            boardGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); disposeMaterial(o.material); });
            procTextures.forEach(t => { if (t && t.dispose) t.dispose(); });
        }
        procTextures = []; waterShaders = [];
        boardGroup = new THREE_.Group();

        // SURFACE_HALF: the rendered road/ground/water half-width. The gameplay
        // grid stays `cols` (entities are placed on it); this far-wider surface
        // is what makes the roads run off BOTH screen edges instead of floating
        // in a letterbox on a wide monitor. The camera fits by DEPTH (VISIBLE_ROWS),
        // so at any landscape aspect the surface needs to reach past the frustum
        // horizontally - 2x cols clears even a 21:9 monitor.
        SURFACE_HALF = cols * 2;

        // One slab per ROW, not one box per tile. Per-tile boxes were 0.98 wide
        // with a 0.02 gap, and those gaps were the visible grid. Full-width row
        // slabs butt together exactly, so the ground reads as continuous.
        const midX = worldX(cols / 2);
        // Polish pass: flat slab colours read as felt/board. Each row keeps
        // its own slab, but the material is now a shared generated texture
        // (canvas, no image files): grass gets speckle + a subtle mow band,
        // road gets asphalt speckle, tyre-wear streaks and a dark tarmac
        // edge where it meets the grass. goal == median in BOTH shipped
        // themes, so one grass texture serves both classes.
        const grassTex = surfaceTexture('grass');
        grassTex.repeat.set(SURFACE_HALF, 1);
        const roadTex = surfaceTexture('road');
        roadTex.repeat.set(SURFACE_HALF, 1);
        const grassMat = new THREE_.MeshStandardMaterial({ map: grassTex, color: 0xffffff, roughness: 0.95 });
        const roadMat = new THREE_.MeshStandardMaterial({ map: roadTex, color: 0xffffff, roughness: 0.88 });
        // ONE SLAB PER CONTIGUOUS BAND, not per row - the same shape the water
        // already uses. Per-row slabs mapped the whole texture across every
        // single row, so the road's "dark edge where tarmac meets grass" was
        // drawn at EVERY row boundary instead of only where the road actually
        // meets grass, and its two tyre-wear streaks repeated per row: five
        // road rows produced ten streaks plus four internal seams. That is what
        // read as too many lines. Across a band the edge lands only on the real
        // grass boundary and the wear tracks read as two tracks.
        const surfaceBands = [];
        for (let y = 0; y < rows; y++) {
            if (rowClass[y] === 'water') continue;   // water is its own animated surface
            const cls = rowClass[y] || (y === rows - 1 ? 'median' : 'road');
            // goal and median share one texture, so treat them as one run -
            // otherwise the goal row seams against the median below it.
            const key = cls === 'road' ? 'road' : 'grass';
            const last = surfaceBands[surfaceBands.length - 1];
            if (last && last.key === key && last.end === y - 1) last.end = y;
            else surfaceBands.push({ key, start: y, end: y });
        }
        // The board simply STOPS at the start row, and the camera keeps the frog
        // partway up the frame, so everything below it was empty background - a
        // dead plum band across the bottom of the screen, worst in portrait
        // where the canvas is tall. The bottom band is extended past the last
        // row so the player sees ground there instead of nothing. It is only
        // scenery: no row is added, so nothing about the sim or the camera
        // clamp moves.
        const APRON = 8;
        surfaceBands.forEach(band => {
            const extra = band.end === rows - 1 ? APRON : 0;
            const depth = band.end - band.start + 1 + extra;
            const geo = new THREE_.BoxGeometry(SURFACE_HALF * 2, 0.2, depth);
            const mesh = new THREE_.Mesh(geo, band.key === 'road' ? roadMat : grassMat);
            // Grow downward only: keep the top edge where the band really ends.
            mesh.position.set(midX, -0.1,
                (worldZ(band.start) + worldZ(band.end)) / 2 + extra / 2);
            mesh.receiveShadow = true;
            boardGroup.add(mesh);
        });
        // ---- living water. One animated plane per contiguous water band.
        const waterBands = [];
        for (let y = 0; y < rows; y++) {
            if (rowClass[y] !== 'water') continue;
            const last = waterBands[waterBands.length - 1];
            if (last && last.end === y - 1) last.end = y;
            else waterBands.push({ start: y, end: y });
        }
        waterMeshes = [];
        waterBands.forEach(band => buildWaterBand(band.start, band.end, midX));

        // ---- grass blades REMOVED at Gabriel's call (2026-09-07): the
        // generated ground texture carries the grass read on its own now.

        // ---- scenery palms (funkyverse). Placed BEYOND the playable columns,
        // out on the extended ground, so they dress the sides without ever
        // blocking a lane or being mistaken for a platform. Only themes that
        // declare a palm get them.
        if (theme.scenery && theme.scenery.palm) {
            const grassRowsForPalms = [];
            for (let y = 0; y < rows; y++) {
                const c = rowClass[y];
                if (c === 'median' || c === 'goal' || y === rows - 1) grassRowsForPalms.push(y);
            }
            sceneryGroup = new THREE_.Group();
            boardGroup.add(sceneryGroup);
            const slots = [];
            grassRowsForPalms.forEach((row, i) => {
                if (i % 2) return;                        // every other grass row
                // Palms are scaled up to ~10 units tall with fronds reaching ~6.4
                // units wide (dx 9.76 * max scale 1.3 / 2). Clearance must keep
                // the fronds outside the playable columns (cols/2) so they frame
                // the board without overhanging the lanes or blocking the player.
                const outer = cols / 2 + 7.0;
                [-1, 1].forEach(side => {
                    slots.push({
                        x: worldX(cols / 2) + side * (outer + Math.random() * Math.max(1, (SURFACE_HALF - outer - 2))),
                        z: worldZ(row) + (Math.random() - 0.5) * 0.6,
                        s: 0.85 + Math.random() * 0.45,
                        r: Math.random() * Math.PI * 2
                    });
                });
            });
            const palmP = glbInstance('palm') || loadModel('palm').then(data => data ? buildModelMesh(data) : null);
            palmP.then(proto => {
                if (!proto || !sceneryGroup) return;
                slots.forEach(sl => {
                    const m = proto.clone(true);
                    m.position.set(sl.x, 0, sl.z);
                    m.scale.setScalar(sl.s);
                    m.rotation.y = sl.r;
                    m.castShadow = true;
                    sceneryGroup.add(m);
                });
            });
        }

        // Neon side rails - the signature edge-glow from the concept art.
        // Diorama has NO neon edge - the still shows plain wood/cardboard sides.
        const wood = theme.railKind === 'wood';
        const railMat = new THREE_.MeshStandardMaterial({
            color: COLORS.rail,
            emissive: wood ? 0x000000 : COLORS.railGlow,
            emissiveIntensity: wood ? 0 : 0.9,
            roughness: wood ? 0.85 : 0.4
        });
        const railGeo = new THREE_.BoxGeometry(wood ? 0.16 : 0.22, wood ? 0.5 : 0.34, rows);
        for (const sx of [-1, 1]) {
            const r = new THREE_.Mesh(railGeo, railMat);
            // Rails sit at the OUTER surface edge, past the frustum, so the
            // neon edge-glow frames a screen-wide road rather than cutting
            // across the middle of it.
            r.position.set(midX + sx * (SURFACE_HALF + 0.11), 0.06, 0);
            r.castShadow = true;
            boardGroup.add(r);
        }

        // Skirt: gives the board physical thickness instead of a floating plane.
        const skirt = new THREE_.Mesh(
            new THREE_.BoxGeometry(SURFACE_HALF * 2 + 0.44, 0.5, rows),
            new THREE_.MeshStandardMaterial({ color: theme.skirt != null ? theme.skirt : 0x0b0b12,
                                              roughness: 0.95 }));
        skirt.position.set(midX, -0.44, 0);
        boardGroup.add(skirt);

        // The playable columns are 0..cols-1, so the walls sit on the outer
        // faces of those end columns: worldX(0) and worldX(cols).
        const barrierGeo = new THREE_.BoxGeometry(0.16, BARRIER_H, rows);
        const makeBarrierMat = () => new THREE_.MeshStandardMaterial({
            color: 0xb9bcc8, transparent: true, opacity: 0, roughness: 0.55,
            // depthWrite off so the board and traffic stay visible THROUGH it;
            // a solid wall here would hide the very lane you are judging.
            depthWrite: false, side: THREE_.DoubleSide,
            polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1,
        });
        barrierL = new THREE_.Mesh(barrierGeo, makeBarrierMat());
        barrierL.position.set(worldX(0), BARRIER_H / 2 + 0.03, 0);  // lift off ground: depthWrite-off + y=0 z-fought the deck
        barrierR = new THREE_.Mesh(barrierGeo.clone(), makeBarrierMat());
        barrierR.position.set(worldX(cols), BARRIER_H / 2 + 0.03, 0);
        barrierL.visible = barrierR.visible = false;
        boardGroup.add(barrierL, barrierR);

        // Dashed lane markings down the road rows.
        const lineMat = new THREE_.MeshStandardMaterial({
            color: 0x9a9aa8, emissive: 0x9a9aa8, emissiveIntensity: 0.05, roughness: 0.9
        });
        // Dividers BETWEEN lanes only, and only on the INTERNAL boundaries of a
        // road band - never on the outside edge, where the road meets grass and
        // a lane marking makes no sense.
        //
        // Two bugs here, both now gone. The rows were the literal 7..10, which
        // is band 0 only: with three bands at rows 7-11, 19-23 and 31-35, two
        // thirds of the road had no markings at all while the first band had
        // them. And a dash every other cell across five lanes, stacked on the
        // per-row texture seams, is what made the road read as a grid. Dashes
        // are now sparser (every third cell) and derived from the sim's own
        // ROAD_LANES, so all three bands match and a board reshuffle cannot
        // strand them again.
        const dashGeo = new THREE_.BoxGeometry(0.40, 0.02, 0.045);
        // rowClass is the renderer's own copy of the sim's terrain descriptor,
        // already built from ROAD_LANES/WATER_LANES/MEDIAN_ROWS above.
        for (let row = 0; row < rows; row++) {
            // A boundary is internal only when BOTH sides are road.
            if (rowClass[row] !== 'road' || rowClass[row + 1] !== 'road') continue;
            // Dashes span the rendered surface, not just the gameplay grid, so
            // the road markings read continuously to the screen edge.
            for (let d = -SURFACE_HALF; d < SURFACE_HALF; d += 3) {
                const dash = new THREE_.Mesh(dashGeo, lineMat);
                dash.position.set(worldX(d + 0.5), 0.005, worldZ(row) + 0.5);
                boardGroup.add(dash);
            }
        }

        scene.add(boardGroup);

        // Size the shadow camera to the board, or shadows silently vanish
        // outside a default frustum that is far too small for a 15x13 grid.
        if (sunLight) {
            const c = sunLight.shadow.camera;
            // Cover the rendered surface width so shadows do not clip at the
            // screen edges on a wide monitor; depth still tracks the window.
            const halfW = Math.max(SURFACE_HALF, cols * 0.75), halfD = VISIBLE_ROWS * 0.9;
            c.left = -halfW; c.right = halfW;
            c.top = halfD; c.bottom = -halfD;
            c.near = 0.5; c.far = 60;
            c.updateProjectionMatrix();
        }

        // Portal marker at the goal row, centre column.
        if (portalMesh) {
            boardGroup.remove(portalMesh);
        }
        // The portal lives on the SCENE, not in boardGroup, so clearing the board
        // does not remove it. buildBoard() runs again on a column change or a
        // theme swap, and every run added another gate - two portals stacked at
        // the goal. Retire the previous one explicitly before making a new one.
        if (portalMesh) { scene.remove(portalMesh); disposeMesh(portalMesh); portalMesh = null; }
        if (portalFrame) { scene.remove(portalFrame); portalFrame = null; portalVortex = null; }

        const portalGeo = new THREE_.TorusGeometry(0.4, 0.12, 12, 24);
        const portalMat = new THREE_.MeshStandardMaterial({ color: COLORS.portal, emissive: COLORS.portal, emissiveIntensity: 0.4 });
        portalMesh = new THREE_.Mesh(portalGeo, portalMat);
        portalMesh.rotation.x = Math.PI / 2;
        portalMat.emissiveIntensity = 1.4;   // the goal should read as a beacon
        portalMesh.position.set(worldX(cols / 2), 0.5, worldZ(0));
        scene.add(portalMesh);
        // The torus is the failure path: hidden while the authored gate
        // loads, revealed only if that load fails.
        portalMesh.visible = false;

        // Frame and vortex are SEPARATE assets. Baked as one mesh, spinning it
        // rotated the whole portal about its base origin and swung it into the
        // ground - the vortex needs its own origin at its own centre.
        const token = ++portalToken;
        const frameP = glbInstance('portal-frame') || loadModel('portal-frame').then(data => data ? buildModelMesh(data) : null);
        Promise.all([frameP, loadModel('portal-vortex')])
            .then(([frameData, vortexData]) => {
                // A rebuild may have happened while this fetch was in flight;
                // token mismatch means this result belongs to a dead board.
                if (token !== portalToken) return;
                if (!frameData || !portalMesh) { if (portalMesh) portalMesh.visible = true; return; }
                portalMesh.visible = false;
                portalFrame = new THREE_.Group();
                portalFrame.add(frameData);
                portalFrame.position.set(worldX(cols / 2), 0, worldZ(0));
                scene.add(portalFrame);

                // A vortex ASSET exists for diorama only. funkyverse's was
                // removed, and because the spin only runs when portalVortex is
                // non-null, its gateway simply never swirled - the code was
                // live, the thing to spin was missing. Build one in code when
                // there is no asset: a spiral is cheaper drawn than baked (the
                // diorama asset is 547KB) and it can never 404.
                portalVortex = vortexData ? buildModelMesh(vortexData) : makeVortex();
                // Ring-centre height differs a lot between themes (a 2.2-wide
                // arcade gate vs a 0.95 mounted prop), so it comes from the theme.
                portalVortex.position.set(0, theme.portalVortexY || 0.98, 0.02);
                portalFrame.add(portalVortex);
                // debug handle for tools/motion-check.js
                if (DEBUG && typeof window !== 'undefined') window.__portalVortex = portalVortex;
            });
    }

    // A drawn vortex: four tapered spiral arms on a transparent disc, in the
    // theme's portal colour. Additive so it reads as light rather than a solid
    // plate, and depthWrite off so the arms never z-fight each other.
    function makeVortex() {
        const g = new THREE_.Group();
        const col = new THREE_.Color(COLORS.portal || 0xc026d3);
        const ARMS = 4, SEGS = 26, TURNS = 1.15, R0 = 0.10, R1 = 0.46;
        for (let a = 0; a < ARMS; a++) {
            const pts = [];
            for (let i = 0; i <= SEGS; i++) {
                const t = i / SEGS;
                const ang = (a / ARMS) * Math.PI * 2 + t * TURNS * Math.PI * 2;
                const r = R0 + (R1 - R0) * t;
                pts.push(new THREE_.Vector3(Math.cos(ang) * r, Math.sin(ang) * r, 0));
            }
            const curve = new THREE_.CatmullRomCurve3(pts);
            // Taper: thick at the centre, thin at the rim, so it reads as drawn
            // into the middle rather than as a flat pinwheel.
            const geo = new THREE_.TubeGeometry(curve, SEGS, 0.030, 6, false);
            const p = geo.attributes.position;
            for (let i = 0; i < p.count; i++) {
                const k = i / p.count;                 // along the tube
                const s = 1 - 0.75 * k;
                p.setXYZ(i, p.getX(i), p.getY(i), p.getZ(i) * s);
            }
            const mat = new THREE_.MeshBasicMaterial({
                color: col, transparent: true, opacity: 0.85,
                blending: THREE_.AdditiveBlending, depthWrite: false });
            g.add(new THREE_.Mesh(geo, mat));
        }
        // A soft core so the middle is not a hole.
        const core = new THREE_.Mesh(
            new THREE_.CircleGeometry(0.14, 20),
            new THREE_.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.5,
                                           blending: THREE_.AdditiveBlending, depthWrite: false }));
        g.add(core);
        g.userData.procedural = true;
        return g;
    }

    function disposeMaterial(mat) {
        if (!mat) return;
        if (Array.isArray(mat)) mat.forEach(x => x && x.dispose && x.dispose());
        else if (mat.dispose) mat.dispose();
    }

    function disposeMesh(m) {
        if (Array.isArray(m)) { m.forEach(disposeMesh); return; }
        if (!m) return;
        entityGroup.remove(m);
        if (m.geometry) m.geometry.dispose();
        disposeMaterial(m.material);
    }

    function makeCarMesh(w, imgKey, row) {
        // One-box stand-in: only ever drawn if the GLB fails outright - an
        // invisible car would be an unfair death. Deliberately minimal; the
        // real mesh is the GLB.
        const group = new THREE_.Group();
        const isTruck = /truck/.test(imgKey || '');
        const color = isTruck
            ? (imgKey.includes('blue') ? COLORS.truck : imgKey.includes('green') ? COLORS.truckAlt : COLORS.truck)
            : (imgKey && imgKey.includes('yellow') ? COLORS.carAlt : COLORS.car);
        const body = new THREE_.Mesh(
            new THREE_.BoxGeometry(w * 0.92, 0.5, 0.62),
            new THREE_.MeshStandardMaterial({ color, roughness: 0.6 }));
        body.position.y = 0.28;
        body.castShadow = true;
        group.add(body);

        entityGroup.add(group);

        // Upgrade to the Blender car once it arrives. Same async-with-fallback
        // pattern as the frog: blocks are visible immediately, the model swaps in.
        // Which mould and colour this lane uses comes from the theme, so the
        // two themes can have completely different vehicle families.
        const spec = carSpecFor(row) || { model: 'car', color: color };
        // Textured-GLB upgrade. GLB assets carry the original Meshy paint the
        // JSON bake flattens; on load error the JSON car stays visible and the
        // failure surfaces via console (plus a debug counter under ?debug=1).
        // Cloned instances SHARE geometry/materials with a module-cached template
        // (one parse + one texture upload per asset), and disposeMesh only
        // touches top-level groups, so shared resources are never torn down
        // per car.
        const glbCar = glbInstance(spec.model);
        if (glbCar) {
            deferPlaceholder(group.children.slice(), glbCar);
            glbCar.then(inst => {
                // glbInstance resolves NULL when an asset fails - by design, so
                // the JSON car stays. This was the one caller that did not guard
                // it: every car whose GLB 404'd threw "reading 'scale'" of null.
                if (!inst || !group.parent) return; // failed, or lane retired
                inst.scale.multiplyScalar(w * 0.92); // same lane sizing as the JSON path
                inst.updateMatrixWorld(true);
                const b = new THREE_.Box3().setFromObject(inst);
                if (isFinite(b.min.y)) inst.position.y -= b.min.y;
                group.children.forEach(c => { c.visible = false; });
                group.add(inst);
                group.userData.model = inst;
                group.userData.kind = 'car';     // lets tools/ measure cars specifically
            });
            return group;
        }
        loadModel(spec.model).then(data => {
            if (!data) return;
            const m = buildModelMesh(data, { CarBody: spec.color, DioCarBody: spec.color });
            m.scale.setScalar(w * 0.92);
            // Sit the TYRES on the deck. Model origins are not reliably at the
            // base and the mesh is scaled by lane width, so the drop is measured
            // from the scaled bounds rather than guessed - cars were floating at
            // a hardcoded 0.25 and sank to -0.27 when that was simply removed.
            m.updateMatrixWorld(true);
            const box = new THREE_.Box3().setFromObject(m);
            if (isFinite(box.min.y)) m.position.y = -box.min.y;
            group.children.forEach(c => { c.visible = false; });
            group.add(m);
            group.userData.model = m;
            group.userData.kind = 'car';     // lets tools/ measure cars specifically
        });

        return group;
    }

    function makeLogMesh(w) {
        const group = new THREE_.Group();
        const body = new THREE_.Mesh(new THREE_.CylinderGeometry(0.28, 0.28, w * 0.92, 12),
            new THREE_.MeshStandardMaterial({ color: COLORS.log, roughness: 0.95 }));
        body.rotation.z = Math.PI / 2;
        body.castShadow = true;
        group.add(body);
        group.position.y = 0.1;
        entityGroup.add(group);

        const logP = glbInstance('log') || loadModel('log').then(data => data ? buildModelMesh(data) : null);
        deferPlaceholder(group.children.slice(), logP);
        logP.then(m => {
            if (!m) return;
            // Visual width must equal the COLLISION width. At 0.96 there was a
            // sliver of invisible platform at each end that you could stand on,
            // which reads as landing on nothing.
            m.scale.x = w;
            group.children.forEach(c => { c.visible = false; });
            group.add(m);
            group.userData.model = m;
            recordRideTop('log', m);
            group.userData.kind = 'log';
        });

        return group;
    }

    function makeTurtleRaftMesh() {
        // A raft of 3, matching the 2.7-tile collision width the same way
        // render2d draws 3 sprites for one turtle platform object.
        const raft = [];
        const shellMat = new THREE_.MeshStandardMaterial({ color: COLORS.turtleShell, roughness: 0.8 });
        for (let i = 0; i < 3; i++) {
            const g = new THREE_.Group();
            const shell = new THREE_.Mesh(new THREE_.SphereGeometry(0.34, 12, 8, 0, Math.PI * 2, 0, Math.PI / 2), shellMat);
            shell.scale.y = 0.55;
            shell.castShadow = true;
            g.add(shell);
            g.position.y = 0.08;
            entityGroup.add(g);
            const turtleP = glbInstance('turtle') || loadModel('turtle').then(data => data ? buildModelMesh(data) : null);
            deferPlaceholder(g.children.slice(), turtleP);
            turtleP.then(m => {
                if (!m) return;
                g.add(m);
                g.userData.model = m;          // lets tools measure the real mesh
                recordRideTop('turtle', m);
                g.userData.kind = 'turtle';
            });
            raft.push(g);
        }
        return raft;
    }

    function makeLilypadMesh(w) {
        const group = new THREE_.Group();
        const mat = new THREE_.MeshStandardMaterial({ color: COLORS.lilypad, roughness: 0.75 });
        // Leave a wedge open so it reads as a lily pad rather than a disc.
        const pad = new THREE_.Mesh(
            new THREE_.CylinderGeometry(0.42 * w, 0.42 * w, 0.1, 18, 1, false, 0.35, Math.PI * 2 - 0.7), mat);
        pad.castShadow = true;
        pad.receiveShadow = true;
        group.add(pad);
        group.position.y = 0.08;
        entityGroup.add(group);

        const lilyP = glbInstance('lilypad') || loadModel('lilypad').then(data => data ? buildModelMesh(data) : null);
        deferPlaceholder(group.children.slice(), lilyP);
        lilyP.then(m => {
            if (!m) return;
            m.scale.setScalar(w);        // match collision width exactly
            group.children.forEach(c => { c.visible = false; });
            group.add(m);
            group.userData.model = m;      // lets tools measure the real mesh
            recordRideTop('lilypad', m);
            group.userData.kind = 'lilypad';
        });

        return group;
    }

    // Sparks spin and glow so the eye is drawn to them as pickups.
    // Drifting embers. The game is about BURNING tokens, so warm motes rising
    // through the scene are the signature detail from the concept art. Points
    // rather than meshes: a few hundred cost effectively nothing.
    let emberPts = null, emberVel = null;

    function makeEmbers(count) {
        const pos = new Float32Array(count * 3);
        emberVel = new Float32Array(count);
        for (let i = 0; i < count; i++) {
            pos[i*3]     = worldX(cols / 2) + (Math.random() - 0.5) * (SURFACE_HALF * 2 + 6);
            pos[i*3 + 1] = Math.random() * 7;
            pos[i*3 + 2] = (Math.random() - 0.5) * (rows + 4);
            emberVel[i]  = 0.004 + Math.random() * 0.012;
        }
        const g = new THREE_.BufferGeometry();
        g.setAttribute('position', new THREE_.BufferAttribute(pos, 3));
        const m = new THREE_.PointsMaterial({
            color: COLORS.ember, size: 0.085, transparent: true, opacity: 0.85,
            depthWrite: false, sizeAttenuation: true
        });
        emberPts = new THREE_.Points(g, m);
        scene.add(emberPts);
    }

    // A soft radial puff used for clouds and the sun's glow. Drawn once to a
    // small canvas and reused as a sprite texture - cheaper than many blurred
    // sphere meshes, and it reads as a fluffy cloud at game scale.
    function makePuffTexture(r, g, b, a) {
        const s = 128, cv = document.createElement('canvas');
        cv.width = cv.height = s;
        const c = cv.getContext('2d');
        const grd = c.createRadialGradient(s/2, s/2, 4, s/2, s/2, s/2);
        grd.addColorStop(0, `rgba(${r},${g},${b},${a})`);
        grd.addColorStop(0.55, `rgba(${r},${g},${b},${a*0.55})`);
        grd.addColorStop(1, `rgba(${r},${g},${b},0)`);
        c.fillStyle = grd;
        c.fillRect(0, 0, s, s);
        const t = new THREE_.CanvasTexture(cv);
        t.colorSpace = THREE_.SRGBColorSpace || '';
        return t;
    }

    // SHADES-MODE atmosphere: a sky + sun + clouds so the low camera reads as a
    // real world instead of a fogged void. Built once per theme; faded by
    // updateAtmosphere(). The dome is vertex-coloured top->horizon->bottom.
    function buildAtmosphere() {
        if (atmosphereGroup) { scene.remove(atmosphereGroup); atmosphereGroup = null; }
        const cfg = theme.atmosphere;
        if (!cfg) return;
        atmosphereGroup = new THREE_.Group();

        // Sky dome: a big open sphere, vertex-coloured as a vertical gradient
        // so we get horizon glow without a shader. BackSide so we see the inside.
        const domeGeo = new THREE_.SphereGeometry(120, 24, 16);
        const pos = domeGeo.attributes.position;
        const colors = new Float32Array(pos.count * 3);
        const top = new THREE_.Color(cfg.skyTop);
        const horizon = new THREE_.Color(cfg.skyHorizon);
        const bottom = new THREE_.Color(cfg.skyBottom);
        const tmp = new THREE_.Color();
        for (let i = 0; i < pos.count; i++) {
            // y in [-120, 120]; normalise to [0,1] with horizon at ~0.5.
            const t = THREE_.MathUtils.clamp(pos.getY(i) / 120 * 0.5 + 0.5, 0, 1);
            if (t > 0.5) tmp.copy(horizon).lerp(top, (t - 0.5) * 2);
            else         tmp.copy(bottom).lerp(horizon, t * 2);
            colors[i*3] = tmp.r; colors[i*3+1] = tmp.g; colors[i*3+2] = tmp.b;
        }
        domeGeo.setAttribute('color', new THREE_.BufferAttribute(colors, 3));
        skyMesh = new THREE_.Mesh(domeGeo,
            new THREE_.MeshBasicMaterial({ vertexColors: true, side: THREE_.BackSide,
                                           depthWrite: false, fog: false }));
        skyMesh.position.set(0, 0, -20);
        atmosphereGroup.add(skyMesh);

        // Sun: a bright disc + a soft additive glow sprite behind it.
        const s = cfg.sun;
        const sunTex = makePuffTexture(255, 240, 210, 0.9);
        sunGlow = new THREE_.Sprite(new THREE_.SpriteMaterial({
            map: sunTex, color: s.color, transparent: true, opacity: 0.85,
            blending: THREE_.AdditiveBlending, depthWrite: false, fog: false }));
        sunGlow.scale.set(s.glow, s.glow, 1);
        sunGlow.position.set(s.pos[0], s.pos[1], s.pos[2]);
        atmosphereGroup.add(sunGlow);

        sunMesh = new THREE_.Mesh(
            new THREE_.CircleGeometry(s.size / 2, 24),
            new THREE_.MeshBasicMaterial({ color: s.color, fog: false,
                                           transparent: true, opacity: 0.95 }));
        sunMesh.position.set(s.pos[0], s.pos[1], s.pos[2]);
        sunMesh.lookAt(0, 0, 40);      // face the general camera area
        atmosphereGroup.add(sunMesh);

        // Clouds: a handful of puffed billboards scattered across the sky. When
        // the real baked cloud (Meshy bakeoff asset) has loaded, it swaps in as
        // the visible cloud body - the sprites are the fallback while loading.
        cloudGroup = new THREE_.Group();
        const cl = cfg.clouds;
        const cloudTex = makePuffTexture(255, 255, 255, 0.8);
        for (let i = 0; i < cl.n; i++) {
            const puff = new THREE_.Sprite(new THREE_.SpriteMaterial({
                map: cloudTex, color: cl.color, transparent: true, opacity: 0.75,
                depthWrite: false, fog: false }));
            const px = (Math.random() - 0.5) * cl.spread;
            const py = cl.y + (Math.random() - 0.5) * cl.spread * 0.4;
            const pz = -34 - Math.random() * 30;
            puff.position.set(px, py, pz);
            puff.scale.set(14 + Math.random() * 12, 5 + Math.random() * 4, 1);
            cloudGroup.add(puff);
        }
        atmosphereGroup.add(cloudGroup);

        // Swap in the real baked cloud mesh once it is loaded (procedural
        // texture -> real low-poly asset), replacing the flat sprites.
        loadCloudMesh('meshy', cfg.clouds).then(cloud => {
            if (!cloud || !cloudGroup) return;
            cloudGroup.visible = false;         // hide sprite puffs
            const holder = buildCloudInstance(cloud, cl);
            atmosphereGroup.add(holder);
            cloudGroup.userData.realCloud = holder;
        });

        // Fade in with the shades camera; the whole group starts invisible.
        atmosphereGroup.visible = false;
        scene.add(atmosphereGroup);
    }

    // Load a baked cloud JSON asset (blender/meshy/img2 bakeoff) and cache it.
    // Returns a compound-of-meshes THREE group, or null on any failure.
    function loadCloudMesh(kind, cloudsCfg) {
        if (cloudModelCache[kind]) return cloudModelCache[kind];
        cloudModelCache[kind] = fetch('assets/models/bakeoff/cloud_' + kind + '.json?v=131')
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .then(data => {
                const g = new THREE_.Group();
                const geo = new THREE_.BufferGeometry();
                geo.setAttribute('position', new THREE_.Float32BufferAttribute(data.positions, 3));
                geo.setAttribute('normal', new THREE_.Float32BufferAttribute(data.normals, 3));
                geo.setIndex(data.indices);
                (data.groups || []).forEach(gr => geo.addGroup(gr.start, gr.count, gr.materialIndex));
                const fallback = () => {
                    const m = new THREE_.MeshStandardMaterial({
                        color: 0xf5edde, roughness: 0.9,
                        emissive: 0xf5edde, emissiveIntensity: 0.35 });   // lift so it never reads black against the sky
                    return m;
                };
                const mats = (data.materials && data.materials.length)
                    ? data.materials.map(m => {
                        const mat = new THREE_.MeshStandardMaterial({
                            color: new THREE_.Color(m.color[0], m.color[1], m.color[2]),
                            roughness: m.roughness != null ? m.roughness : 0.9 });
                        mat.emissive = mat.color.clone();
                        mat.emissiveIntensity = 0.35;
                        return mat;
                    })
                    : [fallback()];
                const mesh = new THREE_.Mesh(geo, mats);
                mesh.castShadow = false;
                g.add(mesh);
                return g;
            })
            .catch(() => null);
        return cloudModelCache[kind];
    }

    // Scale/orient a loaded cloud mesh and scatter a few instances across the sky.
    function buildCloudInstance(cloud, cl) {
        const holder = new THREE_.Group();
        const box = new THREE_.Box3().setFromObject(cloud);
        const size = box.getSize(new THREE.Vector3());
        // Distant clouds: a few units tall/wide, off past the horizon. The base
        // cloud mesh is roughly 1 unit, so scale to a ~5-7 unit footprint.
        const targetW = 6.0;
        const s = targetW / Math.max(size.x, size.z, size.y, 0.001);
        for (let i = 0; i < cl.n; i++) {
            const inst = cloud.clone();
            inst.scale.setScalar(s * (0.8 + Math.random() * 0.6));
            inst.position.set((Math.random() - 0.5) * cl.spread * 0.8,
                              cl.y * 0.6 + (Math.random() - 0.5) * 4,
                              -46 - Math.random() * 22);   // well past the portal, near the sky
            holder.add(inst);
        }
        return holder;
    }

    // Drive atmosphere opacity from the shades camera blend (0 = normal view,
    // 1 = shades). Only the sky/sun/clouds move - the board is untouched.
    function updateAtmosphere() {
        if (!atmosphereGroup) return;
        const on = shadesOn && camBlend > 0.25;
        atmosphereGroup.visible = on;
        if (!on) return;
        const a = camBlend;   // 0..1
        if (sunGlow) sunGlow.material.opacity = 0.85 * a;
        if (sunMesh) sunMesh.material.opacity = 0.95 * a;
        if (cloudGroup) cloudGroup.traverse(o => { if (o.material) o.material.opacity = 0.75 * a; });
    }

    // Sum of three sines at different angles/speeds - cheap, and avoids the
    // obvious single-direction corduroy look a lone wave gives.
    // One animated water plane per band, plus its solid bed and lane dividers.
    function buildWaterBand(startRow, endRow, midX) {
        const n = endRow - startRow + 1;
        const zTop = worldZ(startRow) - 0.5;
        const zBot = worldZ(endRow) + 0.5;
        const midZ = (zTop + zBot) / 2;

        const geo = new THREE_.PlaneGeometry(SURFACE_HALF * 2, n, Math.min(96, SURFACE_HALF * 6), n * 6);
        const wcfg = theme.water || {};
        // Polish pass: the whole wave moved into the vertex shader (same
        // three-sine sum the CPU loop used, with its analytic normals), plus
        // fragment work the old flat surface could not do: a depth tint from
        // bank to centre, an alpha fade where the water meets the bank, and a
        // micro-normal glint that sparkles under each theme's key light.
        // Purely visual, so uTime is wall clock (brief trap 5).
        const mat = new THREE_.MeshStandardMaterial({
            color: 0xffffff,
            roughness: wcfg.roughness != null ? wcfg.roughness : 0.22,
            metalness: wcfg.metalness != null ? wcfg.metalness : 0.15,
            transparent: true,
            opacity: wcfg.opacity != null ? wcfg.opacity : 0.95
        });
        const deep = new THREE_.Color(COLORS.water).multiplyScalar(0.78);
        const shallow = new THREE_.Color(COLORS.water).lerp(new THREE_.Color(0xffffff), 0.30);
        mat.onBeforeCompile = shader => {
            shader.uniforms.uTime = { value: 0 };
            shader.uniforms.uDeep = { value: deep };
            shader.uniforms.uShallow = { value: shallow };
            shader.vertexShader = 'uniform float uTime;\nvarying vec2 vWuv;\nvarying vec2 vWxy;\n' + shader.vertexShader
                .replace('#include <beginnormal_vertex>', [
                    // Same three-sine sum (and frequencies) as the old CPU loop.
                    'float wA = position.x * 1.7 + uTime * 1.3;',
                    'float wB = position.y * 2.3 - uTime * 0.9;',
                    'float wC = (position.x + position.y) * 1.1 + uTime * 1.9;',
                    'float wDx = cos(wA) * 0.045 * 1.7 + cos(wC) * 0.025 * 1.1;',
                    'float wDy = cos(wB) * 0.035 * 2.3 + cos(wC) * 0.025 * 1.1;',
                    'vec3 objectNormal = normalize(vec3(-wDx, -wDy, 1.0));'
                ].join('\n'))
                .replace('#include <begin_vertex>', [
                    'float wH = sin(wA) * 0.045 + sin(wB) * 0.035 + sin(wC) * 0.025;',
                    'vWuv = uv;',
                    'vWxy = position.xy;',
                    'vec3 transformed = vec3(position.x, position.y, wH);'
                ].join('\n'));
            shader.fragmentShader = 'uniform float uTime;\nuniform vec3 uDeep;\nuniform vec3 uShallow;\nvarying vec2 vWuv;\nvarying vec2 vWxy;\n' + shader.fragmentShader
                .replace('#include <color_fragment>', [
                    '#include <color_fragment>',
                    'float wEdge = min(vWuv.y, 1.0 - vWuv.y);',
                    'float wShal = smoothstep(0.0, 0.18, wEdge);',
                    'diffuseColor.rgb = mix(uShallow, uDeep, wShal);',
                    'diffuseColor.a *= mix(0.30, 1.0, smoothstep(0.0, 0.09, wEdge));',
                    'float wCrest = sin(vWxy.x * 27.0 + uTime * 2.2) * sin(vWxy.y * 19.0 - uTime * 1.8);',
                    'diffuseColor.rgb += vec3(0.5, 0.5, 0.5) * wCrest * 0.03 * (1.0 - wShal);'
                ].join('\n'))
                .replace('#include <normal_fragment_begin>', [
                    '#include <normal_fragment_begin>',
                    'float wG1 = sin(vWxy.x * 21.0 + uTime * 2.6) * sin(vWxy.y * 17.0 - uTime * 2.1);',
                    'float wG2 = sin(vWxy.x * 13.0 - uTime * 1.7 + vWxy.y * 19.0);',
                    'normal = normalize(normal + vec3(wG1, wG2, 0.0) * 0.045);'
                ].join('\n'));
            waterShaders.push(shader);
        };
        const mesh = new THREE_.Mesh(geo, mat);
        mesh.rotation.x = -Math.PI / 2;
        mesh.position.set(midX, 0.015, midZ);
        mesh.receiveShadow = true;
        boardGroup.add(mesh);
        waterMeshes.push(mesh);

        // Something UNDER the water, or you look straight through the board
        // into the sky. Both themes are translucent now, so the bed is
        // unconditional - at the bank edge the surface alpha fades and the
        // dark bed reads as shallows.
        const bed = new THREE_.Mesh(
            new THREE_.BoxGeometry(SURFACE_HALF * 2, 0.34, n),
            new THREE_.MeshStandardMaterial({
                color: new THREE_.Color(COLORS.water).multiplyScalar(0.45), roughness: 0.8 }));
        bed.position.set(midX, -0.17, midZ);
        bed.receiveShadow = true;
        boardGroup.add(bed);
        // No lane dividers on the water. There used to be a pale strip at every
        // internal row boundary - a road convention on a river, and Gabriel's
        // call to remove them. The moving logs, turtles and pads already show
        // where the lanes are; the strips only striped the surface.
    }

    // Polish pass: the CPU wave loop is gone (water animates in the shader
    // now); this only ticks the captured shader uniforms once per frame.
    function tickSurfaceShaders() {
        const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
        for (let i = 0; i < waterShaders.length; i++) waterShaders[i].uniforms.uTime.value = t;
    }

    function updateEmbers() {
        if (!emberPts) return;
        const p = emberPts.geometry.attributes.position;
        const a = p.array;
        for (let i = 0; i < emberVel.length; i++) {
            a[i*3 + 1] += emberVel[i];
            a[i*3]     += Math.sin((a[i*3 + 1] + i) * 0.7) * 0.0016;   // lazy drift
            if (a[i*3 + 1] > 7.5) {
                a[i*3 + 1] = -0.2;
                a[i*3 + 2] = (Math.random() - 0.5) * (rows + 4);
            }
        }
        p.needsUpdate = true;
    }

    // HAZARDS: snakes and birds patrolling the grass, an alligator per river.
    // Placeholders until Gabriel's assets land - each kind asks for a GLB of
    // its own name first (`snake` / `bird` / `gator`), so dropping the model in
    // with its glb-dims entry swaps it without touching gameplay.
    // Gabriel 2026-09-11: "snake is too small you just need to make him wider
    // the tube". prepare() fit-scales UNIFORMLY - the tightest of dx/dy/dz wins,
    // and for the snake that is dx (measured: world 0.73 across, exactly dx, while
    // dy/dz overshoot) - so fattening him through glb-dims would drag him out to
    // gator length. Scale the CROSS-SECTION instead. [x, y] only; length is left
    // alone, which also keeps the sim hitbox (w) honest.
    // MEASURED in game: at [1.35, 2.0] the snake was 1.164 across, and a row is
    // exactly 1.0 deep (worldZ(y) = y - (rows - 1) / 2), so he overhung the grass
    // into both neighbours - Gabriel: "goes off the grass row". 1.10 puts him at
    // ~0.95 across: still a third fatter than the 0.73 he started at, but inside
    // his own row. Height keeps the 2.0 - that is what reads as a tube.
    // [across, up, along]. Gabriel 2026-09-12: "its curves are to wide in its
    // bends, we have to stretch the snake out to get less wider bends". The 0.862
    // measured across a 1.0-deep row is mostly SLITHER AMPLITUDE, not tube
    // thickness - the tube is only ~0.35 across - so trimming width was treating
    // the symptom. Stretching him along the lane makes the same S-curve span a
    // longer body (gentler bends) and 0.80 across shrinks the swing itself.
    // Height keeps the 2.0 that makes him read as a tube rather than a ribbon.
    // Bird at +40% over its 0.651 fit scale: girth is an ABSOLUTE scale.set,
    // not a multiplier - the raw bird is ~1.04x1.43x1.54, so 0.91 lands it at
    // ~0.95x1.3x1.4 world. At 0.68 wide it read tiny next to the 1.6 snake and
    // 2.4 gator - Gabriel: level-3's bird was the right size, the rest looked
    // small (distance shrink on later verges).
    const HAZARD_GIRTH = { snake: [0.80, 2.0, 0.975],
                           bird:  [0.91, 0.91, 0.91] };   // along: 1.30 -25% (Gabriel)
    const HAZARD_ANIM_WEIGHT = { snake: 0.65 };          // sway -35% (Gabriel)

    function makeHazardMesh(kind) {
        const g = new THREE_.Group();
        // One box per kind as the failure path: hidden while the GLB is in
        // flight, shown only if the load fails - an invisible hazard would be
        // an invisible death. Roughly the real model's footprint.
        const dims = { snake: [1.3, 0.16, 0.5], bird: [1.0, 0.7, 1.4],
                       gator: [2.2, 0.24, 0.55] }[kind] || [0.8, 0.3, 0.6];
        const standin = new THREE_.Mesh(
            new THREE_.BoxGeometry(dims[0], dims[1], dims[2]),
            new THREE_.MeshStandardMaterial({ color: 0x3d4a3d, roughness: 0.8 }));
        standin.position.y = dims[1] / 2 + 0.02;
        standin.castShadow = true;
        g.add(standin);
        const parts = [standin];
        g.userData.placeholder = parts;
        g.userData.kind = kind;
        const glb = glbInstance(kind);
        if (glb) {
            deferPlaceholder(parts, glb);
            glb.then(m => {
                if (!m) return;
                parts.forEach(p => { p.visible = false; });
                // Grok Build's models face +Z (the glTF forward); hazards travel
                // along X and the placeholders were built pointing +X, so turn
                // the model a quarter and the draw loop's dir flip still works.
                m.rotation.y = Math.PI / 2;
                const girth = HAZARD_GIRTH[kind];
                if (girth) {
                    // The model faces +Z, so local x/y ARE the tube and local z
                    // is its length.
                    m.scale.set(girth[0], girth[1], girth[2] || 1);
                    m.updateMatrixWorld(true);
                    // prepare() grounds with position.y, not geometry, so a
                    // taller tube sinks half of itself into the deck. Re-ground
                    // while m is still parentless: this box is in g-space.
                    const bb = new THREE_.Box3().setFromObject(m);
                    if (isFinite(bb.min.y)) m.position.y -= bb.min.y;
                }
                g.add(m);
                g.userData.model = m;
                // Rigged (tools/rig_hazards.py): slither / flap / swim. One
                // mixer PER INSTANCE, offset by a random phase - a shared clock
                // would have every snake on the board flexing in lockstep.
                const clips = m.userData.animations || [];
                if (clips.length && THREE_.AnimationMixer) {
                    const mixer = new THREE_.AnimationMixer(m);
                    const action = mixer.clipAction(clips[0]);
                    // Gabriel 2026-09-12: "stop its swayin from the head by 35%".
                    // The sway IS the clip, so damp the clip - three.js blends an
                    // action of weight < 1 toward the bind pose. Scaling the across
                    // axis would damp it too, but by flattening the tube back into
                    // the ribbon he did not want.
                    const w = HAZARD_ANIM_WEIGHT[kind];
                    if (w !== undefined) action.setEffectiveWeight(w);
                    action.play();
                    mixer.setTime(Math.random() * clips[0].duration);
                    g.userData.mixer = mixer;
                }
            });
        }
        entityGroup.add(g);
        return g;
    }

    // Purple speed bug pickup: the scripted Blender "burn hoverfly"
    // (tools/make_fly.py). No procedural stand-in - the pink placeholder read
    // as the wrong bug and only ever flashed before the real one arrived.
    function makeBugMesh() {
        const g = new THREE_.Group();
        entityGroup.add(g);
        const flyP = glbInstance('fly');
        if (flyP) {
            flyP.then(m => {
                if (!m) return;
                m.userData.kind = 'fly';
                g.add(m);
                g.userData.model = m;
            });
        }
        return g;
    }

    // Sunglasses pickup. Deliberately the SAME design as the pair Funky wears
    // on his face in the funkyverse theme - black round frames with rainbow
    // swirl lenses - so picking them up reads as "put on Funky's glasses"
    // rather than as some unrelated item.
    const SWIRL = [0xf22124, 0xfd8c15, 0xfae62a, 0x29d14d, 0x2273f2, 0x9e38e6];

    function makeShadesMesh() {
        const g = new THREE_.Group();
        const frameMat = new THREE_.MeshStandardMaterial({
            color: 0x0b0b0e, roughness: 0.35, metalness: 0.2 });

        for (const sx of [-1, 1]) {
            // round rim
            const rim = new THREE_.Mesh(
                new THREE_.TorusGeometry(0.155, 0.032, 8, 18), frameMat);
            rim.position.set(sx * 0.17, 0, 0);
            g.add(rim);

            // concentric rainbow rings = the swirl, same trick as on his face
            SWIRL.forEach((col, i) => {
                const r = 0.142 - i * 0.0225;
                const disc = new THREE_.Mesh(
                    new THREE_.CylinderGeometry(r, r, 0.012, 14),
                    new THREE_.MeshStandardMaterial({
                        color: col, emissive: col, emissiveIntensity: 0.75, roughness: 0.3 }));
                disc.rotation.x = Math.PI / 2;
                disc.position.set(sx * 0.17, 0, 0.006 + i * 0.004);
                g.add(disc);
            });

            // dark pupil at the centre of the swirl
            const core = new THREE_.Mesh(
                new THREE_.CylinderGeometry(0.026, 0.026, 0.012, 10), frameMat);
            core.rotation.x = Math.PI / 2;
            core.position.set(sx * 0.17, 0, 0.032);
            g.add(core);

            // arm folding back
            const arm = new THREE_.Mesh(new THREE_.BoxGeometry(0.035, 0.03, 0.26), frameMat);
            arm.position.set(sx * 0.30, 0.01, -0.14);
            g.add(arm);
        }

        const bridge = new THREE_.Mesh(new THREE_.BoxGeometry(0.10, 0.032, 0.04), frameMat);
        g.add(bridge);

        g.userData.kind = 'shades';   // lets tools/ find it without guessing
        entityGroup.add(g);
        return g;
    }
    // Extra-life pickup: uses the Meshy life GLB (frog face, from funky.png).
    // Starts as a green octahedron placeholder and async-upgrades to the GLB.
    function makeLifePickupMesh() {
        const geo = new THREE_.OctahedronGeometry(0.20, 0);
        const mat = new THREE_.MeshStandardMaterial({
            color: 0x18c964, emissive: 0x18c964, emissiveIntensity: 0.6 });
        const mesh = new THREE_.Mesh(geo, mat);
        mesh.position.y = 0.45;
        entityGroup.add(mesh);
        // Async-upgrade to the life GLB (Meshy high-quality frog face).
        var glbP = (typeof glbInstance === 'function') ? glbInstance('life') : null;
        mesh.userData.awaitingCoin = true;
        function swapToCoin(inst) {
            if (!inst) { mesh.userData.awaitingCoin = false; return; }
            if (!mesh.parent) return;
            inst.userData.isLifePickup = true;
            inst.position.copy(mesh.position);
            inst.rotation.copy(mesh.rotation);
            var idx = mesh.parent.children.indexOf(mesh);
            if (idx >= 0) mesh.parent.children[idx] = inst;
            inst.parent = mesh.parent;
            var si = lifePickupMeshes.indexOf(mesh);
            if (si >= 0) lifePickupMeshes[si] = inst;
            mesh.parent.remove(mesh);
            mesh.geometry.dispose();
            mesh.material.dispose();
        }
        if (glbP) {
            glbP.then(swapToCoin).catch(function () {
                mesh.userData.awaitingCoin = false;
            });
        } else {
            mesh.userData.awaitingCoin = false;
        }
        return mesh;
    }
    // Campaign coins: per-campaign collectible that REPLACES the yellow spark
    // octahedron. Coin art is keyed by campaign id; the baked JSON lives under
    // assets/models/shared/coin-<id>.json (shared across themes). Loads async;
    // the spark octahedron stays until the coin arrives, and forever if the
    // fetch fails. Gabriel 2026-09-12: each campaign gets its own coin.
    const COIN_BY_CAMPAIGN = { ksto: 'coin-ksto' };
    const coinCache = {};
    function loadCoin(id) {
        const slug = COIN_BY_CAMPAIGN[id] || 'coin-ksto';
        const key = 'shared/' + slug;
        if (coinCache[key]) return coinCache[key];
        // Match the asset pipeline's current version (?v=131). Bump again when
        // coin assets change.
        coinCache[key] = fetch('assets/models/' + key + '.json?v=131')
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .catch(() => null);
        return coinCache[key];
    }
    function currentCoinId() {
        try {
            const c = Sim.getCurrentCampaign && Sim.getCurrentCampaign();
            return (c && c.id) || 'ksto';
        } catch (e) { return 'ksto'; }
    }
    function makeSparkMesh() {
        // Placeholder until the campaign coin arrives (or forever on failure).
        const geo = new THREE_.OctahedronGeometry(0.18, 0);
        const mat = new THREE_.MeshStandardMaterial({ color: COLORS.spark, emissive: COLORS.spark, emissiveIntensity: 0.6 });
        const mesh = new THREE_.Mesh(geo, mat);
        mesh.position.y = 0.4;
        mesh.userData.isSparkPlaceholder = true;
        entityGroup.add(mesh);
        // Async upgrade: load the selected campaign's own textured coin.
        // Missing campaign GLBs fall back to that campaign's JSON/placeholder;
        // never show KSTO artwork for a different community.
        var coinId = currentCoinId();
        var glbP = (typeof glbInstance === 'function') ? glbInstance('coin-' + coinId) : null;
        // The octahedron is the failure path too: the draw loop owns
        // mesh.visible, so awaitingCoin keeps it hidden while a real coin
        // (GLB, then JSON) is in flight instead of flashing it first.
        mesh.userData.awaitingCoin = true;
        function swapToCoin(data) {
            if (!data) { mesh.userData.awaitingCoin = false; return; }
            if (!mesh.parent) return;
            var coin = buildModelMesh(data);
            finishSwap(coin);
        }
        function finishSwap(coin) {
            coin.userData.isCoin = true;
            coin.userData.campaignCoinId = coinId;
            coin.position.copy(mesh.position);
            coin.rotation.copy(mesh.rotation);
            // GLBs retain glbInstance's registered fit scale; JSON fallbacks
            // are already baked to game units.
            var idx = mesh.parent.children.indexOf(mesh);
            if (idx >= 0) mesh.parent.children[idx] = coin;
            coin.parent = mesh.parent;
            mesh.userData.upgraded = coin;
            // Re-point the sparkMeshes slot so the update loop drives the coin.
            var si = sparkMeshes.indexOf(mesh);
            if (si >= 0) sparkMeshes[si] = coin;
            mesh.parent.remove(mesh);
            if (DEBUG && typeof window !== 'undefined') window.__coinSwapped = (window.__coinSwapped || 0) + 1;
        }
        if (glbP) {
            glbP.then(function (inst) {
                if (DEBUG && typeof window !== 'undefined') window.__coinUpgraded = (window.__coinUpgraded || 0) + 1;
                if (!inst) { loadCoin(coinId).then(swapToCoin).catch(function (err) { if (DEBUG && typeof window !== 'undefined') window.__coinErr = String((err && err.message) || err).slice(0, 200); }); return; }
                if (!mesh.parent) return;
                finishSwap(inst);
            }).catch(function (err) {
                if (DEBUG && typeof window !== 'undefined') window.__coinErr = String((err && err.message) || err).slice(0, 200);
                mesh.userData.awaitingCoin = false;
            });
        } else {
            loadCoin(coinId).then(swapToCoin).catch(function (err) {
                if (DEBUG && typeof window !== 'undefined') window.__coinErr = String((err && err.message) || err).slice(0, 200);
                mesh.userData.awaitingCoin = false;
            });
        }
        return mesh;
    }
    // The Blender-authored frog is baked to compact JSON (positions/normals/
    // indices + per-material groups) rather than shipped as .glb, because
    // three.js r0.160's UMD build has no GLTFLoader and the examples/js loaders
    // were removed after r0.147. An importmap would work but the house
    // black-screen notes warn it is fragile in Safari. This keeps the project a
    // plain <script> with no build step.
    // Loaded model JSON, keyed by "<themeDir>/<slug>". Each theme has its OWN
    // asset set - the two concepts call for genuinely different geometry (hard
    // voxel vs rounded glossy plastic), not one mesh in two palettes. A theme
    // missing an asset resolves to null and the primitive fallback stays.
    const modelCache = {};
    function loadModel(slug) { return loadModelFrom(theme.assetDir, slug); }
    function loadModelFrom(dir, slug) {
        const key = dir + '/' + slug;
        if (modelCache[key]) return modelCache[key];
        modelCache[key] = fetch('assets/models/' + key + '.json?v=131')
            .then(r => r.ok ? r.json() : Promise.reject(r.status))
            .catch(() => null);
        return modelCache[key];
    }

    // Textured-GLB instance for a slug, or null when this theme has no GLB
    // for it (caller keeps its JSON path). Failures resolve to null so every
    // callsite degrades to the JSON asset instead of losing the prop. Clones
    // share geometry/materials with a module-cached template - one texture
    // upload per asset regardless of how many instances spawn.
    function glbInstance(slug) {
        if (!(root.BurnQuestGLBAssets && root.BurnQuestGLBAssets.has(theme.assetDir, slug))) return null;
        return root.BurnQuestGLBAssets.instance(theme.assetDir, slug).catch(err => {
            console.error('GLB asset failed for ' + slug + ', using JSON:', err);
            if (DEBUG) root.__glbAssetError = String((err && err.message) || err);
            return null;
        });
    }

    // Placeholder geometry is the failure path now: it stays hidden while a
    // real asset is in flight so the old stand-in never flashes on screen
    // before the upgrade lands, and reappears only if the load fails - an
    // invisible car or platform would be an unfair death.
    function deferPlaceholder(parts, p) {
        if (!p) return;
        parts.forEach(c => { c.visible = false; });
        Promise.resolve(p).then(m => {
            if (!m) parts.forEach(c => { c.visible = true; });
        }, () => {
            parts.forEach(c => { c.visible = true; });
        });
    }

    // tint: { materialName: 0xRRGGBB } - materials are cloned per instance so
    // one baked car mesh can serve all five lane colours.
    function buildModelMesh(data, tint) {
        const g = new THREE_.BufferGeometry();
        g.setAttribute('position', new THREE_.Float32BufferAttribute(data.positions, 3));
        g.setAttribute('normal', new THREE_.Float32BufferAttribute(data.normals, 3));
        const hasVC = !!(data.colors && data.colors.length);
        if (hasVC) {
            g.setAttribute('color', new THREE_.Float32BufferAttribute(data.colors, 3));
        }
        g.setIndex(data.indices);
        data.groups.forEach(gr => g.addGroup(gr.start, gr.count, gr.materialIndex));
        const mats = data.materials.map(m => {
            const over = tint && tint[m.name];
            // three.js MULTIPLIES material colour by vertex colour. Every Meshy
            // bake carries Blender's default grey (0.8, 0.8, 0.8), so the whole
            // asset set was rendering 20% dark - the taxi came out brass
            // (#9e8129) instead of the reference's bright yellow. When vertex
            // colours carry the albedo, the material must be WHITE unless an
            // explicit tint is asked for.
            const baseColor = over !== undefined
                ? new THREE_.Color(over)
                : (hasVC ? new THREE_.Color(1, 1, 1)
                         : new THREE_.Color(m.color[0], m.color[1], m.color[2]));
            const mat = new THREE_.MeshStandardMaterial({
                color: baseColor,
                roughness: m.roughness != null ? m.roughness : 0.6,
                // TRELLIS bakes keep albedo in vertex colours. White material
                // colour shows them as-is; CarBody tint multiplies luminance.
                vertexColors: hasVC
            });
            // headlights / tail lights glow rather than just being pale boxes
            if (/head/i.test(m.name)) { mat.emissive = mat.color.clone(); mat.emissiveIntensity = 1.5; }
            if (/tail/i.test(m.name)) { mat.emissive = mat.color.clone(); mat.emissiveIntensity = 1.1; }
            return mat;
        });
        const mesh = new THREE_.Mesh(g, mats);
        mesh.castShadow = true;
        return mesh;
    }

    // Async upgrade: the procedural frog renders instantly, the modelled one
    // swaps in when it arrives. No loading gate, and a failed fetch just leaves
    // the placeholder in place.
    function upgradeFrogToModel() {
        // The box placeholder only appears if EVERY model path fails - it is
        // hidden while the rigged GLB (then the static bake) is in flight, so
        // the old frog never flashes in front of the real one.
        const ph = (frogMesh && frogMesh.userData.placeholder) || [];
        ph.forEach(pp => { pp.visible = false; });
        const reveal = () => ph.forEach(pp => { pp.visible = true; });
        const G = root.BurnQuestGLBAssets;
        // Determine rigged character and asset dir based on selection.
        // 'diorama' and 'classic' skip the rigged path (no rig / different model).
        var riggedSlug = theme.riggedCharacter;
        var riggedDir = theme.assetDir;
        effectiveFaceOffset = theme.characterFaceOffset || 0;
        if (selectedCharacter === 'funkyverse') {
            riggedSlug = 'funky-rigged';
            riggedDir = 'fv';
            effectiveFaceOffset = -Math.PI / 2;
        } else if (selectedCharacter === 'diorama' || selectedCharacter === 'classic') {
            riggedSlug = null;
            if (selectedCharacter === 'diorama') effectiveFaceOffset = Math.PI;
            else effectiveFaceOffset = Math.PI;  // Meshy models face +Z (toward viewer)
            if (selectedCharacter === 'classic') {
                riggedSlug = 'funky-classic-rigged';
                riggedDir = 'fv';
            }
        }
        if (riggedSlug && G && G.loadGLTF) {
            G.loadGLTF(riggedDir, riggedSlug)
                .then(gltf => {
                    if (!(gltf && gltf.scene)) { upgradeFrogToStaticModel(reveal); return; }
                    installRiggedCharacter(gltf);
                })
                .catch(err => {
                    console.error('rigged character failed, using the static model:', err);
                    upgradeFrogToStaticModel(reveal);
                });
            return;
        }
        upgradeFrogToStaticModel(reveal);
    }

    // Funky with a real skeleton. The static bake could only be squashed; this
    // one swings his legs and arms. One Funky on screen, so the loaded scene is
    // used as-is - a SkinnedMesh cannot be cloned like the props.
    function installRiggedCharacter(gltf) {
        const rig = frogMesh && frogMesh.userData.rig;
        if (!rig || !gltf || !gltf.scene) return;
        const m = gltf.scene;
        m.traverse(o => {
            if (!o.isMesh) return;
            o.castShadow = true;
            // Skinned bounds are the REST pose; arms thrown up mid-hop would
            // leave them and the whole character would be culled.
            o.frustumCulled = false;
        });
        (frogMesh.userData.placeholder || []).forEach(p => { p.visible = false; });
        m.position.set(0, -RIG_FOOT_OFFSET, 0);
        rig.add(m);
        frogMesh.userData.model = m;
        frogMesh.userData.faceOffset = effectiveFaceOffset;
        const mixer = new THREE_.AnimationMixer(m);
        const act = {};
        (gltf.animations || []).forEach(clip => {
            const a = mixer.clipAction(clip);
            a.play();
            a.setEffectiveWeight(clip.name === 'idle' ? 1 : 0);
            act[clip.name] = a;
        });
        // The hop clip is SCRUBBED by hop progress, never played on its own.
        if (act.hop) act.hop.paused = true;
        frogMesh.userData.anim = {
            mixer, act, hopDur: act.hop ? act.hop.getClip().duration : 0,
            // three.js strips '.' from node names, so Blender's hand.L is handL.
            probe: m.getObjectByName('handL') || null, v: new THREE_.Vector3()
        };
    }

    // One clip at full weight, the rest at zero. For 'hop', t (0..1) picks the
    // frame: 0 is the push-off crouch, 0.5 the tucked apex, 1 the landing.
    function driveCharacterAnim(mode, t, dt) {
        const an = frogMesh && frogMesh.userData.anim;
        if (!an) return;
        for (const name in an.act) an.act[name].setEffectiveWeight(name === mode ? 1 : 0);
        if (mode === 'hop' && an.act.hop) an.act.hop.time = Math.min(Math.max(t, 0), 0.999) * an.hopDur;
        an.mixer.update(dt);
        // Opt-in trace for tools/rig-check.js, recorded by the loop itself:
        // samplers outside it are throttled in headless chromium. The hand is
        // read in MODEL space, so the hop's own travel and turn do not count.
        // Gated behind DEBUG: production never reads the tool-set __animTrace
        // handle.
        if (DEBUG) {
            const tr = root.__animTrace;
            if (tr && tr.length < 600 && an.probe) {
                an.probe.getWorldPosition(an.v);
                frogMesh.userData.model.worldToLocal(an.v);
                tr.push([mode, t, an.v.y, an.v.x]);
            }
        }
    }

    function upgradeFrogToStaticModel(onFail) {
        var charSlug, charDir, charFaceOff;
        if (selectedCharacter === 'funkyverse') {
            charSlug = 'funky'; charDir = 'fv'; charFaceOff = -Math.PI / 2;
        } else if (selectedCharacter === 'diorama') {
            charSlug = 'funky'; charDir = 'diorama'; charFaceOff = Math.PI;
        } else if (selectedCharacter === 'classic') {
            charSlug = 'funky-classic'; charDir = 'fv'; charFaceOff = Math.PI;
        } else {
            charSlug = theme.character; charDir = theme.assetDir; charFaceOff = theme.characterFaceOffset || 0;
        }
        const frogP = glbInstance(charSlug) || loadModelFrom(charDir, charSlug).then(data => data ? buildModelMesh(data) : null);
        frogP.then(m => {
            if (!m) { if (onFail) onFail(); return; }
            const rig = frogMesh && frogMesh.userData.rig;
            if (!rig) return;
            (frogMesh.userData.placeholder || []).forEach(p => { p.visible = false; });
            m.position.y -= RIG_FOOT_OFFSET;
            m.traverse(function (o) {
                if (!o.isMesh) return;
                o.castShadow = true;
                o.frustumCulled = false;
            });
            rig.add(m);
            frogMesh.userData.model = m;
            frogMesh.userData.faceOffset = charFaceOff;
            // The bake has no skeleton, so the life comes from a height-weighted
            // vertex deform instead of joints. See char-motion.js.
            const cm = root.BurnQuestCharMotion;
            if (cm && cm.attach(m)) {
                cm.setFaceOffset(frogMesh.userData.faceOffset);
                frogMesh.userData.motion = true;
            }
        });
    }

    function makeFrogMesh() {
        // Two nested groups on purpose:
        //   group  - world position + facing. Never scaled.
        //   rig    - squash/stretch and pitch. Scaling this leaves position alone.
        // Squashing the outer group would drag the frog through the ground.
        const group = new THREE_.Group();
        const rig = new THREE_.Group();
        group.add(rig);

        // Faint self-illumination so the player can always find the frog,
        // whatever it is standing on. At 0.6 units in a 1-unit tile it is small
        // next to a 2-tile truck, so it needs to win on value, not size alone.
        // One box as the last-resort stand-in - hidden while the rigged GLB
        // (then the static bake) is in flight, shown only if every load fails.
        const bodyMat = new THREE_.MeshStandardMaterial({
            color: COLORS.frog, emissive: COLORS.frog, emissiveIntensity: 0.35, roughness: 0.6
        });
        const body = new THREE_.Mesh(new THREE_.BoxGeometry(0.68, 0.44, 0.68), bodyMat);
        body.position.y = 0.2;
        body.castShadow = true;
        rig.add(body);

        // Contact marker: a flat ring on the ground under the frog. Mid-hop the
        // body is off the deck, and this is what tells you which cell you are
        // actually on - the thing you need when timing the next hop.
        const ring = new THREE_.Mesh(
            new THREE_.RingGeometry(0.30, 0.40, 20),
            new THREE_.MeshBasicMaterial({ color: COLORS.frog, transparent: true, opacity: 0.45,
                                           side: THREE_.DoubleSide, depthWrite: false }));
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = -RIG_FOOT_OFFSET + 0.012;
        group.add(ring);
        group.userData.ring = ring;

        group.userData.placeholder = [body];
        group.userData.faceOffset = 0;   // placeholder box faces -Z, which is now 'toward the goal'
        group.userData.rig = rig;
        if (DEBUG && typeof window !== 'undefined') window.__frogRig = rig;   // debug handle for tools/
        return group;
    }

    function ensurePools(state) {
        if (carMeshes.length !== state.cars.length) {
            carMeshes.forEach(disposeMesh);
            carMeshes = state.cars.map(c => makeCarMesh(c.w, c.imgKey, Math.round(c.y)));
        }
        if (logMeshes.length !== state.logs.length) {
            logMeshes.forEach(disposeMesh);
            logMeshes = state.logs.map(l => makeLogMesh(l.w));
        }
        if (turtleMeshes.length !== state.turtles.length) {
            turtleMeshes.forEach(disposeMesh);
            turtleMeshes = state.turtles.map(() => makeTurtleRaftMesh());
        }
        if (lilypadMeshes.length !== state.lilypads.length) {
            lilypadMeshes.forEach(disposeMesh);
            lilypadMeshes = state.lilypads.map(p => makeLilypadMesh(p.w));
        }
        if (sparkMeshes.length !== state.sparks.length) {
            sparkMeshes.forEach(disposeMesh);
            sparkMeshes = state.sparks.map(() => makeSparkMesh());
        }
        const bugCount = (state.bugs || []).length;
        if (bugMeshes.length !== bugCount) {
            bugMeshes.forEach(disposeMesh);
            bugMeshes = (state.bugs || []).map(() => makeBugMesh());
        }
        const shadesCount = (state.shades || []).length;
        if (shadesMeshes.length !== shadesCount) {
            shadesMeshes.forEach(disposeMesh);
            shadesMeshes = (state.shades || []).map(() => makeShadesMesh());
        }
        const lifeCount = (state.lifePickups || []).length;
        if (lifePickupMeshes.length !== lifeCount) {
            lifePickupMeshes.forEach(disposeMesh);
            lifePickupMeshes = (state.lifePickups || []).map(() => makeLifePickupMesh());
        }
        // Hazards are pooled by KIND as well as count: a stage change swaps a
        // snake for a gator at the same index, and a count-only check would
        // leave the old shape cruising the river.
        const hz = state.hazards || [];
        const kinds = hz.map(h => h.kind).join(',');
        if (hazardMeshes.length !== hz.length || hazardKinds !== kinds) {
            hazardMeshes.forEach(disposeMesh);
            hazardMeshes = hz.map(h => makeHazardMesh(h.kind));
            hazardKinds = kinds;
        }
    }

    function init(canvas) {
        THREE_ = root.THREE;
        if (!THREE_) {
            throw new Error('render3d: THREE global not found - check the three.js <script> tag in index.html');
        }

        renderer = makeRenderer(canvas);
        // WebGL context-loss recovery. A lost GPU context (mobile driver
        // crash, dual-GPU laptop switch, too many contexts) freezes the canvas
        // while the sim could keep running. preventDefault on loss so the canvas
        // can be restored, pause the sim so the player is not killed behind a
        // frozen frame, and skip draw() while contextLost is true. On restore,
        // KEEP the existing renderer: three.js WebGLRenderer registered its own
        // context-restored listener BEFORE this one and rebuilds internal GL
        // state on the SAME restored context (it re-uploads scene/camera buffers
        // on the next render()), so disposing + makeRenderer(canvas) here would
        // throw away a context three.js already recovered. ctxHandlersBound
        // attaches the listeners only once - no duplicate listeners or loops;
        // game.js's single rAF loop keeps running, only draw() is gated.
        if (!ctxHandlersBound) {
            ctxHandlersBound = true;
            canvas.addEventListener('webglcontextlost', function (e) {
                e.preventDefault();
                contextLost = true;
                wasRunningAtLoss = !!(root.Sim && root.Sim.isRunning && root.Sim.isRunning());
                if (root.Sim && typeof root.Sim.pause === 'function') root.Sim.pause();
            }, false);
            canvas.addEventListener('webglcontextrestored', function () {
                contextLost = false;
                if (wasRunningAtLoss && root.Sim && typeof root.Sim.resume === 'function') {
                    root.Sim.resume();
                }
                wasRunningAtLoss = false;
            }, false);
        }
        renderer.shadowMap.enabled = true;
        if (THREE_.PCFSoftShadowMap !== undefined) {
            renderer.shadowMap.type = THREE_.PCFSoftShadowMap;
        }
        // ACES gives a filmic falloff instead of colours clipping to white.
        // Polish pass: exposure is per-theme (sunset vs bright studio).
        if ('toneMapping' in renderer && THREE_.ACESFilmicToneMapping !== undefined) {
            renderer.toneMapping = THREE_.ACESFilmicToneMapping;
            renderer.toneMappingExposure = themeExposure();
        }
        scene = new THREE_.Scene();
        scene.background = new THREE_.Color(theme.background);
        // Debug handles gated behind ?debug=1: a shipped page does not expose
        // the live three.js scene/renderer to scripts.
        if (DEBUG) {
            if (typeof window !== 'undefined') window.__scene = scene;
            if (typeof window !== 'undefined') window.__renderer = renderer;
        }

        // Low-FOV perspective for a slight Crossy Road tilt rather than a
        // flat orthographic top-down - it reads the board depth (water/road
        // lanes) much more clearly than a true top-down ortho view would.
        camera = new THREE_.PerspectiveCamera(38, 1, 0.1, 200);
        // Debug handles gated behind ?debug=1.
        if (DEBUG) {
            if (typeof window !== 'undefined') window.__renderCam = camera;
            if (typeof window !== 'undefined') window.__frogCam = camera;
        }

        // Lighting is what makes low-poly read as designed rather than as
        // placeholder geometry. A hemisphere light (warm sky / cool ground)
        // instead of flat ambient gives every face a different value, and a
        // shadow-casting key light grounds objects to the board.
        hemiLight = new THREE_.HemisphereLight(theme.hemi.sky, theme.hemi.ground, theme.hemi.intensity);
        const hemi = hemiLight;

        sunLight = new THREE_.DirectionalLight(theme.sun.color, theme.sun.intensity);
        sunLight.position.set(theme.sun.pos[0], theme.sun.pos[1], theme.sun.pos[2]);
        sunLight.castShadow = true;
        sunLight.shadow.mapSize.set(1024, 1024);
        sunLight.shadow.bias = -0.0012;
        sunLight.shadow.normalBias = 0.02;
        sunLight.shadow.radius = themeShadowRadius();   // polish: soft toy vs crisp
        // Rim light from behind picks the silhouettes off the dark background.
        rimLight = new THREE_.DirectionalLight(theme.rim.color, theme.rim.intensity);
        const rim = rimLight;
        rim.position.set(-5, 6, -8);

        scene.add(hemi, sunLight, rim);
        scene.add(sunLight.target);   // required for .target to be respected

        // Fog fades the far rows so the board has depth instead of reading flat.
        scene.fog = new THREE_.Fog(theme.fog.color, theme.fog.near, theme.fog.far);

        entityGroup = new THREE_.Group();
        scene.add(entityGroup);

        // Warm the template cache up front: every slug this theme will ask
        // for starts downloading now, so upgrades resolve before the entities
        // that need them spawn (hazards land at stage 2) instead of popping
        // in mid-run.
        const preloadSlugs = ['log', 'turtle', 'lilypad', 'portal-frame', 'fly',
                              'snake', 'bird', 'gator', 'coin-' + currentCoinId()];
        if (theme.scenery && theme.scenery.palm) preloadSlugs.push('palm');
        ((theme.carsByRow && theme.carsByRow.family) || []).forEach(s => preloadSlugs.push(s.model));
        preloadSlugs.forEach(s => { const p = glbInstance(s); if (p) p.catch(() => {}); });
        if (theme.riggedCharacter && root.BurnQuestGLBAssets && root.BurnQuestGLBAssets.loadGLTF) {
            var preloadDir = theme.assetDir;
            var preloadSlug = theme.riggedCharacter;
            if (selectedCharacter === 'funkyverse') { preloadDir = 'fv'; preloadSlug = 'funky-rigged'; }
            else if (selectedCharacter === 'diorama') { preloadSlug = null; }
            else if (selectedCharacter === 'classic') { preloadDir = 'fv'; preloadSlug = 'funky-classic-rigged'; }
            if (preloadSlug) root.BurnQuestGLBAssets.loadGLTF(preloadDir, preloadSlug).catch(() => {});
        }
        loadCoin(currentCoinId());
        loadModel('portal-vortex');

        buildBoard();
        if (theme.embers > 0) makeEmbers(theme.embers);
        buildAtmosphere();               // shades-mode sky/sun/clouds
        frogMesh = makeFrogMesh();
        scene.add(frogMesh);
        upgradeFrogToModel();

        W = window.innerWidth;
        H = window.innerHeight;
        resize(W, H);
    }

    // Radians above the horizon. Larger = more top-down.
    // Theme-driven: an UPRIGHT character (funkyverse's hatted Funky) reads as a
    // hat brim from a steep angle, so that theme sits lower. The squat diorama
    // frog reads fine from further above. Going much below ~0.85 starts pushing
    // the camera back far enough that the board shrinks, since the fit solve has
    // to cover more projected depth.
    const CAMERA_TILT = theme.cameraTilt || 1.0;

    // How many rows are kept in frame. The board is 37 rows now, so fitting all
    // of it would make everything a speck - the camera follows instead, showing
    // a window around the frog. Small margin so the board FILLS the screen
    // rather than floating in a letterbox.
    const VISIBLE_ROWS = 13;

    // How many rows of DEPTH the camera fits. On a wide window the limit is
    // depth, not width: measured on an iPhone 14 in landscape, fitting 13 rows
    // into a 393px-tall window set camDist to 16.04 - the same distance as a
    // 1280x800 desktop - so each tile got 40.9px against the desktop's 83.2.
    // Rotating the phone made the board wider but left it just as far away.
    //
    // A short window cannot hold 13 rows at a playable size, so it fits fewer
    // and the camera comes in. This is the depth-axis twin of viewCols().
    //
    // NOTE: only the camera FIT uses this. Culling and the ground-surface
    // extent stay on the constant, deliberately - they must cover the widest
    // case, and trimming them to the fitted depth would pop props in and out at
    // the edge of frame.
    function visibleRows() {
        const a = (camera && camera.aspect) || 1.6;
        if (a >= 1.90) return 9;     // phone in landscape: short and wide
        return VISIBLE_ROWS;
    }
    // How many columns the camera frames at once. The board may be wider; the
    // view pans to follow the frog rather than zooming out to contain it.
    const VIEW_COLS = 15;

    // ORIENTATION-AWARE FRAMING.
    //
    // The camera fits its subject by BOTH depth and width and takes whichever
    // needs more distance. On a narrow portrait phone the horizontal FOV is
    // tiny, so fitting 15 columns wide dominated completely and shoved the
    // camera 2.6x further back than on a desktop - measured 41.7 vs 16.0, which
    // rendered a grid tile at 21px against the desktop's 85 and made the frog a
    // speck. A phone simply cannot show a monitor's worth of columns at a
    // playable size, so in portrait it frames FEWER and pans more. Panning
    // already exists and keeps the frog centred, so nothing is lost but width
    // the player could not read anyway.
    //
    // Thresholds are on aspect, not on a width in pixels: what matters is the
    // shape of the window, and a phone rotated to landscape should get the
    // landscape framing immediately.
    function viewCols() {
        const a = (camera && camera.aspect) || 1.6;
        if (a < 0.70) return 8;      // portrait phone
        if (a < 1.10) return 11;     // portrait tablet / square-ish
        return VIEW_COLS;            // landscape phone, tablet, desktop
    }

    // WHERE THE FROG SITS IN FRAME.
    //
    // The camera looks up the board past the frog; how far past is what decides
    // the frog's height on screen. This used to be a flat VISIBLE_ROWS * 0.22
    // (2.86 rows) for every window shape, and measured on a fresh run at
    // 1280x800 it put the camera at world z 18.08 with the frog at z 18.0 -
    // directly overhead - projecting the frog to NDC y -2.47, clean off the
    // bottom of the screen. You could not see your own frog at spawn.
    //
    // A fixed number of rows cannot work across devices: measured at 3.2 rows,
    // the frog landed 1.02 screen-heights down on an iPhone 14 and 2.15 on an
    // iPhone SE. The rows-to-screen-position relationship depends on camDist
    // and aspect, so the row count is SOLVED for the screen position we want
    // rather than guessed.
    //
    // Cheap: it depends only on camera geometry, not on where the frog is, so
    // it is solved once per resize and cached - never per frame.
    let lookAheadCache = 0;

    // 0 = top of the CANVAS, 1 = bottom. Portrait used to hold the frog at 0.66
    // to keep it clear of the D-pad, which sat on the board. The D-pad now has
    // its own dock below the canvas, so nothing overlays the play area and the
    // frog can sit lower - which matters because everything below the frog at
    // the start row is off-board void, and 0.66 spent a third of a now-shorter
    // canvas rendering it. Lower frog = less void, more road ahead.
    function frogScreenTarget() {
        const a = (camera && camera.aspect) || 1.6;
        // Nothing is drawn on the board any more, so there is no control to
        // dodge and the character can sit low, showing the most road ahead.
        // A PHONE in landscape needs that as much as portrait does: at the
        // closer landscape zoom, 0.72 left the bottom ~40% of the screen as
        // empty ground apron. Desktop keeps 0.72 - it is further back, so the
        // apron never dominates there.
        if (isPhoneLandscape()) return 0.82;
        return a >= 1.10 ? 0.72 : 0.82;
    }

    function solveLookAhead() {
        if (!camera) return 1.6;
        const target = frogScreenTarget();
        const targetNdcY = 1 - 2 * target;
        const probe = new THREE_.PerspectiveCamera(camera.fov, camera.aspect,
                                                   camera.near, camera.far);
        const fy = RIG_FOOT_OFFSET;          // sight the frog's body, not the floor
        let lo = 0, hi = 10;
        for (let i = 0; i < 26; i++) {
            const mid = (lo + hi) / 2;
            const focusZ = -mid;             // reference frog at z = 0
            probe.position.set(0, camDist * Math.sin(CAMERA_TILT),
                               focusZ + camDist * Math.cos(CAMERA_TILT));
            probe.lookAt(0, 0, focusZ);
            probe.updateMatrixWorld(true);
            probe.updateProjectionMatrix();
            const ndcY = new THREE_.Vector3(0, fy, 0).project(probe).y;
            // More look-ahead pushes the frog DOWN the screen (ndcY falls).
            if (ndcY > targetNdcY) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    function lookAheadRows() { return lookAheadCache; }

    // CONTROLS ON THE BOARD (portrait overlay layout). One switch, because the
    // two adjustments it makes are the same idea: when the buttons sit on the
    // play area, the view pulls back AND the character rides higher, so the
    // thumb is never on top of it. With the controls docked below the board
    // neither applies - nothing is in the way there.
    // setControlsOverlay is retained as a NO-OP: mobile input is a swipe now, so
    // nothing is ever drawn on the board and there is no overlay to compensate
    // for. Kept so an older cached game.js calling it cannot throw.
    function setControlsOverlay() { /* no controls overlay the board any more */ }

    // A phone in LANDSCAPE gets a closer view than the geometry alone would
    // give. Fitting 9 rows of depth into a short window already brought the
    // camera in, but on a physically small screen the board still read too far
    // away - Gabriel's call, 1.3x closer. Desktop is untouched: this keys off a
    // COARSE POINTER, not merely a wide aspect, so a wide monitor is unaffected.
    // 1.3 -> 1.56 (a further 1.2x), Gabriel 2026-09-09 after playing it.
    // 1.56 -> 1.248 (zoomed back OUT 1.25x), Gabriel 2026-09-11.
    const LANDSCAPE_PHONE_ZOOM_IN = 1.56 / 1.25;

    // "Phone" = a coarse pointer on a physically SMALL screen. A touchscreen
    // laptop reports (pointer: coarse) too, and without the size test a wide
    // desktop window was classed as a phone in landscape: the regular view got
    // the 1.25x zoom-IN and, under the old shadesRigScale, no shades pull-back
    // at all. Phones' short side is ~375-500 CSS px; iPads start at 744 and
    // laptops at ~768, so 640 splits them cleanly.
    function isCoarsePhone() {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        if (!window.matchMedia('(pointer: coarse)').matches) return false;
        const s = window.screen || { width: 0, height: 0 };
        return Math.min(s.width, s.height) < 640;
    }

    function isPhoneLandscape() {
        if (typeof window === 'undefined' || !window.matchMedia) return false;
        const a = (camera && camera.aspect) || 1.6;
        return a >= 1.6 && isCoarsePhone();
    }

    function viewZoomOut() {
        return isPhoneLandscape() ? 1 / LANDSCAPE_PHONE_ZOOM_IN : 1;
    }

    function positionCamera() {
        const margin = 1.02;
        const vFov = camera.fov * Math.PI / 180;
        const hFov = 2 * Math.atan(Math.tan(vFov / 2) * (camera.aspect || 1));

        // Frame VIEW_COLS, not the whole board. Fitting the full width meant
        // widening the grid to 23 columns pushed the camera back and zoomed the
        // whole game out. The playable field is wide; the VIEW stays where it
        // was and pans sideways instead - see applyCameraFollow().
        const boardW = Math.min(cols, viewCols()) * margin;
        // Depth is foreshortened by the tilt once projected onto the screen.
        const boardD = visibleRows() * margin * Math.sin(CAMERA_TILT) + 1.0;

        const dist = Math.max(
            (boardD / 2) / Math.tan(vFov / 2),
            (boardW / 2) / Math.tan(hFov / 2)
        );

        // POSITIVE z: the start row now sits at +(rows-1)/2, so the camera is
        // behind it here and looks along -z, matching three.js's default
        // orientation. Both facts matter: it keeps the goal at the horizon AND
        // keeps +x on screen right.
        // viewZoomOut pulls the camera back without changing what it frames -
        // used when the touch controls sit ON the board (portrait overlay) so
        // the character is not under a button.
        camDist = dist * viewZoomOut();
        lookAheadCache = solveLookAhead();
        shadesLookAheadCache = solveShadesLookAhead();
        applyCameraFollow(true);
    }

    // SHADES MODE: put the camera down near the deck, right behind the frog.
    // Same game, completely different read - you stop seeing the board as a
    // diagram and start seeing it from frog height.
    // Direct placement rather than a tilt/distance formula - easier to tune and
    // to reason about. Gabriel: closer to the frog, a little higher, angled DOWN
    // so you can read incoming traffic instead of staring along the deck.
    // Framed so Funky's WHOLE body is visible with his feet close to the bottom
    // edge - far enough back to see him, not so far that the view goes back to
    // being a board diagram. Pulled back and raised from 2.55/3.10, and the
    // look point pushed further up the board so he sits low in frame.
    // Tuned by MEASURING where the frog lands in clip space, not by eye: these
    // put his feet at NDC y -0.93, i.e. right on the bottom edge, with the whole
    // body visible and nothing wasted below him. Raising the look point pushes
    // him DOWN out of frame; lowering the camera lifts him UP - both the
    // opposite of what intuition suggests, which is why this was swept.
    const SHADES_HEIGHT     = 2.30;   // above the frog
    const SHADES_BACK       = 6.00;   // behind the frog
    const SHADES_LOOK_AHEAD = 20.0;   // look well up the board, past him
    const SHADES_LOOK_Y     = 0.30;   // aim onto the deck

    // ...and the same tuning does not survive a phone. Those constants frame
    // the frog's feet right on the bottom edge at desktop proportions, which is
    // deliberate - but measured on phones the whole frog fell off the bottom:
    // 1.01 screen-heights down on an iPhone 14, 1.16 on an SE, 1.14 in
    // landscape. A shades view where you cannot see the frog is not a view.
    //
    // So the look-ahead is SOLVED for a target screen position, exactly as the
    // normal camera's is. The target keeps the wide-screen framing as tuned
    // (feet on the bottom edge) and lifts the frog into frame on narrower
    // windows, where there is no room to spare below him.
    let shadesLookAheadCache = SHADES_LOOK_AHEAD;

    function shadesScreenTarget() {
        if (SHADES_TARGET_OVERRIDE) return SHADES_TARGET_OVERRIDE;
        const a = (camera && camera.aspect) || 1.6;
        // A phone in LANDSCAPE tilts down onto the deck: the frog rides ~20%
        // higher in frame so the lanes around him show instead of empty sky.
        if (isPhoneLandscape()) return 0.80;
        return a < 1.10 ? 0.86 : 0.96;
    }

    // Shades view sits the camera a fixed distance behind and above the frog,
    // so on a narrow portrait phone it framed far less of the board than it
    // does on a monitor and read as being right on top of the character.
    // Gabriel: pull it back 1.35x there. The rig offset is scaled rather than
    // the look-ahead, so the ANGLE of the view is unchanged - only the
    // distance - and the solved look-ahead keeps the frog at the same height
    // in frame either way.
            const SHADES_PORTRAIT_ZOOM_OUT = 2.0;   // pushed back, but 2.55 was too far
    // Gabriel 2026-09-12: ALL sunglasses views pull back — desktop, mobile
    // portrait (up/down), and mobile landscape. 1.3 still framed him too
    // close to read the lanes around him; ~1.25x further out.
    // Landscape then came back IN 1.5x (1.6/1.5): once the view tilts down
    // onto the deck the pull-back is no longer needed to show the lanes.
    const SHADES_MOBILE_ZOOM_OUT = 1.6 / 1.5;
    const SHADES_DESKTOP_ZOOM_OUT = 1.9;

    // Tuning override for the pull-back: ?shadeszoom=2.4 multiplies whichever
    // constant applies, so a framing can be chosen from a live URL instead of
    // a deploy per guess. Clamped to a sane band; absent = 1 (no override).
    const SHADES_ZOOM_OVERRIDE = (() => {
        try {
            const v = parseFloat(new URLSearchParams(window.location.search)
                                 .get('shadeszoom'));
            return isFinite(v) && v > 0.2 && v < 6 ? v : 1;
        } catch (e) { return 1; }
    })();
    // Same idea for the frog's height in frame (the tilt): ?shadestarget=0.8
    // where 0 = top of canvas, 1 = bottom. Lower = pitched further down.
    const SHADES_TARGET_OVERRIDE = (() => {
        try {
            const v = parseFloat(new URLSearchParams(window.location.search)
                                 .get('shadestarget'));
            return isFinite(v) && v > 0.4 && v < 0.99 ? v : 0;
        } catch (e) { return 0; }
    })();
    // And for the camera's height above the deck: ?shadesheight=0.7.
    const SHADES_HEIGHT_OVERRIDE = (() => {
        try {
            const v = parseFloat(new URLSearchParams(window.location.search)
                                 .get('shadesheight'));
            return isFinite(v) && v > 0.2 && v < 3 ? v : 0;
        } catch (e) { return 0; }
    })();

    // The DESKTOP rig rides 20% lower - a driver's-eye height rather than a
    // different tilt (Gabriel: "lower the camera", not "tilt it down").
    // Phones keep full height; their screens need the clearance.
    function shadesHeightScale() {
        if (SHADES_HEIGHT_OVERRIDE) return SHADES_HEIGHT_OVERRIDE;
        return isCoarsePhone() ? 1 : 0.8;
    }

    function shadesRigScale() {
        const a = (camera && camera.aspect) || 1.6;
        let s;
        if (!isCoarsePhone()) s = SHADES_DESKTOP_ZOOM_OUT;   // desktop incl. touch laptops
        else if (a < 1.10) s = SHADES_PORTRAIT_ZOOM_OUT;       // mobile portrait
        else s = SHADES_MOBILE_ZOOM_OUT;                       // mobile landscape
        return s * SHADES_ZOOM_OVERRIDE;
    }

    function solveShadesLookAhead() {
        if (!camera) return SHADES_LOOK_AHEAD;
        const targetNdcY = 1 - 2 * shadesScreenTarget();
        const probe = new THREE_.PerspectiveCamera(camera.fov, camera.aspect,
                                                   camera.near, camera.far);
        // Reference frog at the origin; only the rig's relative geometry matters.
        let lo = 2, hi = 60;
        for (let i = 0; i < 26; i++) {
            const mid = (lo + hi) / 2;
            const rs = shadesRigScale();

            probe.position.set(0, SHADES_HEIGHT * rs * shadesHeightScale(),
                               SHADES_BACK * rs);
            probe.lookAt(0, SHADES_LOOK_Y, -mid);
            probe.updateMatrixWorld(true);
            probe.updateProjectionMatrix();
            const ndcY = new THREE_.Vector3(0, RIG_FOOT_OFFSET, 0).project(probe).y;
            // Looking further up-board pushes the frog DOWN the screen.
            if (ndcY > targetNdcY) lo = mid; else hi = mid;
        }
        return (lo + hi) / 2;
    }

    // Track the frog up the board. Biased ahead of it so you can read the lanes
    // you are about to cross rather than the ones behind you.
    function applyCameraFollow(snap) {
        if (!camera) return;
        // Debug hook for tools/: lets a script park the camera to inspect an
        // asset without the follow rig snatching it back on the next frame.
        // Gated behind DEBUG so production ignores it.
        if (DEBUG && typeof window !== 'undefined' && window.__freezeCam) return;
        const cx = worldX(cols / 2);

        // ease between the two camera rigs rather than cutting
        const want = shadesOn ? 1 : 0;
        camBlend = snap ? want : camBlend + (want - camBlend) * 0.075;

        const targetZ = worldZ(renderFrog.y) - lookAheadRows();
        const clamped = Math.max(worldZ(0) - 1.0,
                        Math.min(worldZ(rows - 1) + 1.0, targetZ));
        camFocusZ = snap ? clamped : camFocusZ + (clamped - camFocusZ) * 0.10;

        // Pan sideways with the frog on a board wider than the view, and stop
        // panning at the point where the board edge reaches the edge of frame -
        // so you never see past the barrier into empty space. On a board no
        // wider than the view this collapses to the old board-centred camera.
        // How wide the camera ACTUALLY sees at the board, in world units - not
        // how wide it was ASKED to frame. positionCamera fits the larger of the
        // width and depth requirements, and the zoom multipliers scale the
        // result, so the real view is routinely narrower than viewCols(). Using
        // viewCols()/2 here stopped the pan short and let the frog walk off the
        // side of the screen near the barrier: measured NDC -1.12 in portrait
        // and -1.58 in landscape, both outside the frame.
        // MEASURE the visible width instead of deriving it. camDist * tan(hFov/2)
        // is the half-extent at the camera's focus point, but the board is
        // tilted and the frog sits at a different depth, so that estimate is
        // wrong in exactly the direction that matters. Projecting two world
        // points one unit apart AT THE FROG'S DEPTH gives NDC-per-world-unit
        // directly, from whatever the camera is actually doing this frame.
        const fzNow = worldZ(renderFrog.y);
        const probeA = new THREE_.Vector3(cx + camFocusX, RIG_FOOT_OFFSET, fzNow).project(camera);
        const probeB = new THREE_.Vector3(cx + camFocusX + 1, RIG_FOOT_OFFSET, fzNow).project(camera);
        const ndcPerUnit = Math.abs(probeB.x - probeA.x);
        const halfView = ndcPerUnit > 1e-6 ? Math.min(cols / 2, 1 / ndcPerUnit) : cols / 2;
        const limit = Math.max(0, cols / 2 - halfView);
        const wantRaw = worldX(renderFrog.x + 0.5);
        let wantX = Math.max(-limit, Math.min(limit, wantRaw));
        // THE FROG WINS. If holding the board edge at the frame edge would push
        // the character out of shot - which it did, at NDC -1.12 in portrait -
        // the camera follows it past the edge instead. Seeing a sliver beyond
        // the barrier is far cheaper than losing the thing you are steering.
        const maxOff = (ndcPerUnit > 1e-6 ? 1 / ndcPerUnit : cols / 2) * 0.80;
        wantX = Math.max(wantX, wantRaw - maxOff);
        wantX = Math.min(wantX, wantRaw + maxOff);
        camFocusX = snap ? wantX : camFocusX + (wantX - camFocusX) * 0.10;

        // normal rig: follows the frog horizontally, high, looking down the window
        const nx = cx + camFocusX, nz = camFocusZ;
        const ny = camDist * Math.sin(CAMERA_TILT);
        const nzOff = camDist * Math.cos(CAMERA_TILT);

        // shades rig: close behind the frog and above it, looking down-board
        const fx = worldX(renderFrog.x + 0.5), fz = worldZ(renderFrog.y);
        const rs = shadesRigScale();
        const sy = SHADES_HEIGHT * rs * shadesHeightScale();
        const szOff = SHADES_BACK * rs;

        const b = camBlend;
        if (DEBUG && typeof window !== 'undefined') {
            window.__camBlend = b; window.__shadesOn = shadesOn;
            // debug handle for tools/align-check.js and tools/ride-probe.js
            window.__rideDebug = () => ({ rowKind, rideTop, rideY, lastRideRow });
            // debug handle for tools/camera-check.js: camDist is what sets the
            // zoom, and it must NOT change when the board gets wider.
            window.__camDebug = () => ({ camDist, camFocusX, camFocusZ,
                                        VIEW_COLS: viewCols(), cols,
                                        lookAhead: lookAheadRows() });
        }
        const px = nx + (fx - nx) * b;
        const py = ny + (sy - ny) * b;
        const pz = (nz + nzOff) + ((fz + szOff) - (nz + nzOff)) * b;
        camera.position.set(px, py, pz);

        // Look where the camera actually IS horizontally, not at board centre -
        // otherwise a panned camera stares back across the board at an angle.
        const nlx = cx + camFocusX;
        const lx = nlx + (fx - nlx) * b;
        const ly = 0 + (SHADES_LOOK_Y - 0) * b;
        const lz = nz + ((fz - shadesLookAheadCache) - nz) * b;   // past him, up the board
        camera.lookAt(lx, ly, lz);

        // a touch darker and cooler through the lenses
        if (renderer && 'toneMappingExposure' in renderer) {
            renderer.toneMappingExposure = themeExposure() - b * 0.28;
        }

        // A directional light's shadow frustum is anchored to the light, so it
        // has to travel with the window or shadows vanish once you move up the
        // board.
        if (sunLight) {
            sunLight.position.set(cx + theme.sun.pos[0], theme.sun.pos[1],
                                  camFocusZ + theme.sun.pos[2]);
            sunLight.target.position.set(cx, 0, camFocusZ);
            sunLight.target.updateMatrixWorld();
        }
    }

    function resize(w, h) {
        W = w;
        H = h;
        if (!renderer) return;
        // updateStyle FALSE. With it true three.js writes an inline
        // width/height onto the canvas element, which then OVERRIDES the CSS
        // that is supposed to lay it out - so switching the portrait controls
        // from the dock back to the overlay left the canvas pinned at its
        // docked height, and the next measurement read that pinned box back and
        // kept it there. CSS owns the element's size; the renderer owns only
        // the drawing buffer.
        renderer.setSize(W, H, false);
        camera.aspect = W / H;
        camera.updateProjectionMatrix();
        positionCamera();
    }

    function spawnDeathFx(state) {
        const src = frogMesh && (frogMesh.userData.model || frogMesh.userData.rig);
        if (!src) return;
        const corpse = src.clone(true);
        // buildModelMesh gives a mesh an ARRAY of materials (one per material
        // group), so a bare .clone() throws. Handle both shapes.
        corpse.traverse(o => {
            if (!o.isMesh) return;
            o.material = Array.isArray(o.material)
                ? o.material.map(m => m.clone())
                : o.material.clone();
            o.castShadow = true;
        });

        const gx = lastAlive.x, gy = Math.round(lastAlive.y);
        // BAND-CORRECT. This was the literal `gy >= 1 && gy <= 5`, which is
        // band 0 only: with three bands the water rows are 1-5, 13-17 AND
        // 25-29, so drowning anywhere above the first river played the
        // hit-by-car squash instead of the float - and the player never saw
        // themselves go into the water. rowClass is the renderer's copy of the
        // sim's terrain descriptor and covers every band.
        const inWater = rowClass[gy] === 'water';
        const holder = new THREE_.Group();
        holder.add(corpse);
        holder.position.set(worldX(gx + 0.5), 0.2, worldZ(gy));
        scene.add(holder);

        if (inWater) {
            // Belly-up float: rolls onto its back, bobs on the surface, sinks.
            deathFx = { kind: 'float', holder, corpse, t: 0, x: gx, y: gy,
                        splash: makeSplash(worldX(gx + 0.5), worldZ(gy)) };
            if (DEBUG && typeof window !== 'undefined') window.__deathFx = deathFx;   // debug handle
        } else {
            // Squashed onto the grille of whatever hit it, and carried off.
            let hit = null, best = 1e9;
            state.cars.forEach(c => {
                if (Math.round(c.y) !== gy) return;
                const d = Math.abs((c.x + c.w / 2) - (gx + 0.5));
                if (d < best) { best = d; hit = c; }
            });
            deathFx = { kind: 'splat', holder, corpse, t: 0, x: gx, y: gy,
                        carDir: (hit && hit.dir) || 1,
                        // getState() does not expose car speed, so hit.speed is
                        // undefined and would poison f.x into NaN - the corpse
                        // then vanished because worldX(NaN) is NaN.
                        carSpeed: (hit && typeof hit.speed === 'number') ? hit.speed : 0.52,
                        offset: hit ? (gx + 0.5) - (hit.x + hit.w / 2) : 0 };
            if (DEBUG && typeof window !== 'undefined') window.__deathFx = deathFx;   // debug handle
        }
    }

    function fadeCorpse(corpse, opacity) {
        corpse.traverse(o => {
            if (!o.isMesh) return;
            const list = Array.isArray(o.material) ? o.material : [o.material];
            list.forEach(m => { m.transparent = true; m.opacity = opacity; });
        });
    }

    // A ring that expands and fades, plus a handful of droplets that arc and
    // fall back. Without it the frog simply appeared belly-up: there was no
    // moment of ENTRY, which is what Gabriel noticed was missing.
    function makeSplash(wx, wz) {
        const g = new THREE_.Group();
        const ringMat = new THREE_.MeshBasicMaterial({
            color: 0xdff3ff, transparent: true, opacity: 0.85,
            side: THREE_.DoubleSide, depthWrite: false });
        const ring = new THREE_.Mesh(new THREE_.RingGeometry(0.18, 0.30, 20), ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.04;
        g.add(ring);

        const drops = [];
        const dropGeo = new THREE_.SphereGeometry(0.045, 6, 5);
        for (let i = 0; i < 7; i++) {
            const m = new THREE_.Mesh(dropGeo, new THREE_.MeshBasicMaterial({
                color: 0xeaf7ff, transparent: true, opacity: 0.95, depthWrite: false }));
            const a = (i / 7) * Math.PI * 2 + Math.random() * 0.5;
            const sp = 0.9 + Math.random() * 0.7;
            m.position.y = 0.06;
            g.add(m);
            drops.push({ m, vx: Math.cos(a) * sp * 0.35, vz: Math.sin(a) * sp * 0.35,
                         vy: 1.5 + Math.random() * 1.2 });
        }
        g.position.set(wx, 0, wz);
        scene.add(g);
        return { g, ring, drops };
    }

    function updateSplash(s, t, dt) {
        if (!s) return;
        const k = Math.min(1, t / 0.55);
        s.ring.scale.setScalar(1 + k * 3.4);
        s.ring.material.opacity = 0.85 * (1 - k);
        s.drops.forEach(d => {
            d.vy -= 6.5 * dt;                    // gravity
            d.m.position.x += d.vx * dt;
            d.m.position.z += d.vz * dt;
            d.m.position.y += d.vy * dt;
            d.m.material.opacity = Math.max(0, 0.95 * (1 - t / 0.7));
            if (d.m.position.y < 0.02) d.m.position.y = 0.02;
        });
        if (t > 0.75 && s.g.parent) { scene.remove(s.g); disposeMesh(s.g); s.g.parent = null; }
    }

    function updateDeathFx(dt) {
        if (!deathFx) return;
        const f = deathFx;
        f.t += dt;

        if (f.kind === 'splat') {
            // flatten hard on impact, then ride along with the car
            const sq = Math.min(1, f.t / 0.12);
            f.corpse.scale.set(1 + sq * 0.55, Math.max(0.12, 1 - sq * 0.88), 1 + sq * 0.35);
            f.corpse.rotation.z = sq * 0.5;
            // CAR_RATE lives in the sim, not here - read it from there so the
            // corpse is carried at exactly the speed of the car that hit it.
            const rate = (root.Sim && root.Sim.CAR_RATE) || 0.028;
            f.x += f.carDir * f.carSpeed * rate * 60 * dt;
            f.holder.position.set(worldX(f.x + 0.5), 0.34, worldZ(f.y));
            fadeCorpse(f.corpse, Math.max(0, 1 - Math.max(0, f.t - 0.9) / 0.5));
            if (f.t > 1.45) { scene.remove(f.holder); deathFx = null; }
        } else {
            updateSplash(f.splash, f.t, dt);
            // roll belly-up, bob with the surface, then sink out of sight
            const roll = Math.min(1, f.t / 0.45);
            f.corpse.rotation.x = roll * Math.PI;
            const sink = Math.max(0, f.t - 1.1) * 0.5;
            f.holder.position.y = 0.06 + Math.sin(f.t * 3.4) * 0.05 - sink;
            f.holder.rotation.y = Math.sin(f.t * 1.6) * 0.35;
            fadeCorpse(f.corpse, Math.max(0, 1 - Math.max(0, f.t - 1.1) / 0.7));
            if (f.t > 1.9) { scene.remove(f.holder); deathFx = null; }
        }
    }

    // Goal dance. Two-step bounce with a hip swing and a spin on the beat -
    // the frog is a rigid mesh, so the character has to come from TIMING rather
    // than from limbs.
    // Two phases inside the same 2.6s window the orchestrator already holds the
    // scene open for: a short celebration, then the portal takes the frog.
    const DANCE_SECS = 1.05;   // celebrate
    const ENTER_SECS = 1.25;   // get drawn in

    // Roll the wheels at the speed the car is actually travelling.
    //
    // The wheel meshes are found by FLAG, not by a cached list: a cloned
    // Object3D copies userData by reference, so a `userData.wheels` array on the
    // template would hand every car the TEMPLATE's wheels and only one car's
    // would ever turn. The flag lives on each mesh and survives cloning, so the
    // lookup is per instance. Cached on first use so the traverse happens once.
    function spinWheels(mesh, car) {
        let wheels = mesh.userData.wheelMeshes;
        // Only a NON-EMPTY result is cached. A car starts life as the JSON
        // placeholder and the split GLB swaps in asynchronously, so the first
        // call finds no wheels - caching that empty answer left every car with
        // dead wheels forever, which is exactly what it did.
        if (!wheels || !wheels.length) {
            wheels = [];
            mesh.traverse(o => { if (o.userData && o.userData.isWheel) wheels.push(o); });
            if (wheels.length) mesh.userData.wheelMeshes = wheels;
            // Radius decides how fast a wheel turns for a given distance. Take
            // it from the geometry rather than guessing.
            let r = 0.14;
            if (wheels.length) {
                const b = new THREE_.Box3().setFromObject(wheels[0]);
                r = Math.max(0.04, (b.max.y - b.min.y) / 2);
            }
            if (wheels.length) mesh.userData.wheelRadius = r;
        }
        if (!wheels.length) return;
        // Distance this frame, in world units, from the sim's own car rate.
        const rate = (root.Sim && root.Sim.CAR_RATE) || 0.028;
        // The renderer ticks its effects on a fixed 1/60 step (see the
        // updateDance / updateDeathFx callers), so distance per frame is
        // simply the sim's per-frame car step.
        // Wheel roll is scenery too, so it uses the same real-time step as the
        // other effects rather than assuming 60fps.
        const dist = car.speed * rate * (lastFrameDt * 60);
        const spin = dist / mesh.userData.wheelRadius;
        // The body yaws 180 for a car travelling +x, which flips the wheels'
        // local axis with it - so the sign is constant here and the direction
        // still comes out right on screen.
        for (let i = 0; i < wheels.length; i++) wheels[i].rotation.x -= spin;
    }

    // REAL elapsed seconds for presentation effects.
    //
    // These used to advance on a fixed 1/60 per frame, but the orchestrator
    // holds the goal scene open for 2600ms of WALL CLOCK. On a machine that
    // renders at 15fps that is only ~39 frames - 0.65s of animation - so the
    // frog never finished being drawn into the portal before the modal covered
    // it. Gameplay stays on the sim clock; this is scenery, and scenery has to
    // finish in the window the player is actually given.
    let lastEffectMs = 0;
    let lastFrameDt = 1 / 60;

    // Called ONCE per draw. It used to be called once per consumer, and the
    // second call in the same frame measured ~0ms - which zeroed lastFrameDt
    // and left every wheel motionless while the cars drove on.
    function tickEffectClock() {
        const now = (typeof performance !== 'undefined' && performance.now)
            ? performance.now() : Date.now();
        const dt = lastEffectMs ? (now - lastEffectMs) / 1000 : 1 / 60;
        lastEffectMs = now;
        // Clamp: a backgrounded tab must not teleport an animation on return.
        lastFrameDt = Math.min(0.1, Math.max(1 / 240, dt));
        return lastFrameDt;
    }

    function updateDance(dt) {
        if (danceT < 0 || !frogMesh) return;
        danceT += dt;
        // Rigged Funky dances at the gate, then is pulled in holding the hop's
        // tucked, arms-up apex pose while he spirals and shrinks.
        driveCharacterAnim(danceT < DANCE_SECS ? 'dance' : 'hop', 0.5, dt);
        const rig = frogMesh.userData.rig;

        if (danceT < DANCE_SECS) {
            const beat = danceT * 4.2;                 // ~4 steps/sec
            const bounce = Math.abs(Math.sin(beat));

            frogMesh.position.y = 0.2 + bounce * 0.42;
            frogMesh.rotation.y = Math.sin(danceT * 2.1) * 0.9 + danceT * 1.4;
            if (rig) {
                // squash on each landing, stretch at the top of the bounce
                rig.scale.set(1 + (1 - bounce) * 0.22 - bounce * 0.10,
                              1 - (1 - bounce) * 0.26 + bounce * 0.18,
                              1 + (1 - bounce) * 0.22 - bounce * 0.10);
                rig.rotation.z = Math.sin(beat) * 0.22;   // hip swing
                rig.rotation.x = Math.sin(beat * 0.5) * 0.12;
            }
            // Remember where the celebration left him, so the draw-in starts
            // from exactly there rather than snapping.
            enterFrom = { x: frogMesh.position.x, y: frogMesh.position.y,
                          z: frogMesh.position.z };
            if (portalVortex) portalVortex.rotation.z += dt * 6;
        } else {
            // DRAWN IN: spiral toward the gate's centre, shrinking and spinning
            // up as it goes. Eased so it creeps, then goes suddenly.
            const k = Math.min(1, (danceT - DANCE_SECS) / ENTER_SECS);
            const e = k * k * k;                       // slow start, fast finish
            const tx = worldX(cols / 2), tz = worldZ(0);
            const ty = (theme.portalVortexY || 0.98);
            const f = enterFrom || { x: tx, y: 0.2, z: tz };
            // A shrinking orbit around the axis, on top of the approach.
            const orbit = (1 - e) * 0.30;
            const ang = k * Math.PI * 4;
            frogMesh.position.set(
                f.x + (tx - f.x) * e + Math.cos(ang) * orbit,
                f.y + (ty - f.y) * e,
                f.z + (tz - f.z) * e + Math.sin(ang) * orbit);
            frogMesh.rotation.y += dt * (6 + 26 * k);  // spins up as it is pulled
            if (rig) {
                const sc = Math.max(0.001, 1 - e);
                rig.scale.set(sc, sc, sc);
                rig.rotation.set(0, 0, 0);
            }
            // The gate reacts: faster swirl and a brighter core as it swallows.
            if (portalVortex) {
                portalVortex.rotation.z += dt * (6 + 40 * k);
                const s = 1 + 0.25 * Math.sin(k * Math.PI);
                portalVortex.scale.set(s, s, 1);
            }
        }
    }

    function startCelebration() {
        danceT = 0;
        enterFrom = null;
    }
    function stopCelebration() {
        danceT = -1;
        enterFrom = null;
        if (frogMesh && frogMesh.userData.rig) {
            frogMesh.userData.rig.rotation.set(0, 0, 0);
            frogMesh.userData.rig.scale.set(1, 1, 1);   // undo the shrink
        }
        // The gate was pulsed while it swallowed; put it back.
        if (portalVortex) portalVortex.scale.set(1, 1, 1);
    }
    function isCelebrating() { return danceT >= 0; }

    function updateHop(state) {
        const now = (typeof performance !== 'undefined') ? performance.now() : Date.now();
        // The celebration owns the frog AND the camera while it plays. On a
        // stage clear the sim has already rebuilt the board and put the frog
        // back on the start row, so running the hop logic here saw a 36-row
        // "teleport" and cut the camera to the start - the frog was drawn into
        // the portal off-screen, which is why the shrink never showed. Hold
        // everything; the first frame after stopCelebration() takes the cut.
        if (danceT >= 0) {
            if (frogMesh && frogMesh.userData.motion && root.BurnQuestCharMotion) {
                root.BurnQuestCharMotion.update(now, 1, false);
            }
            return;
        }
        const gx = Math.round(state.frog.x);
        const gy = Math.round(state.frog.y);
        const bigJumpX = Math.abs(state.frog.x - renderFrog.x) > 0.4;

        // TELEPORT, NOT A HOP. A new run, a new stage and a respawn all put the
        // frog back at the start row from wherever it was - up to 36 rows away.
        // The camera eases at 0.10 per frame, so it then GLIDED the length of
        // the board to catch up: measured on a fresh run, camFocusZ was still
        // short of its target after 6 seconds, with the frog parked off the
        // bottom edge for the first few of them. A jump this size is a cut, not
        // a move, so the camera cuts with it.
        const teleported = Math.abs(state.frog.y - renderFrog.y) > 2.5 ||
                           Math.abs(state.frog.x - renderFrog.x) > 2.5;
        // ...but NOT on a death respawn. A new run or a new stage is a cut; a
        // death is not. Snapping there yanked the camera to the start line the
        // instant the frog drowned, so the float, the sink and the splash all
        // played somewhere the player was no longer looking - which is why
        // drowning "didn't show" even after the band fix. Let the camera ease
        // back instead, and the death is watched rather than missed.
        if (teleported && !deathFx) {
            renderFrog.x = state.frog.x;
            renderFrog.y = state.frog.y;
            hopAnim = null;
            lastGridX = gx;
            lastGridY = gy;
            applyCameraFollow(true);       // snap, do not glide
            return;
        }

        if (gy !== lastGridY || (gx !== lastGridX && bigJumpX)) {
            hopAnim = {
                fromX: renderFrog.x, fromY: renderFrog.y,
                toX: state.frog.x, toY: state.frog.y,
                start: now
            };
            lastGridX = gx;
            lastGridY = gy;
        } else if (!hopAnim) {
            // Platform drift or resting: track the sim value directly.
            renderFrog.x = state.frog.x;
            renderFrog.y = state.frog.y;
            lastGridX = gx;
            lastGridY = gy;
        }

        let hopArc = 0;
        let t = 1;            // 1 == resting
        if (hopAnim) {
            t = Math.min(1, (now - hopAnim.start) / HOP_DURATION_MS);
            renderFrog.x = hopAnim.fromX + (hopAnim.toX - hopAnim.fromX) * t;
            renderFrog.y = hopAnim.fromY + (hopAnim.toY - hopAnim.fromY) * t;
            hopArc = Math.sin(t * Math.PI) * HOP_HEIGHT;

            // Face the direction of travel. Screen-up (toward the goal) is -y in
            // grid space, which is +z in world space, so that is rotation 0.
            const dx = hopAnim.toX - hopAnim.fromX;
            const dy = hopAnim.toY - hopAnim.fromY;
            if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
                const off = frogMesh.userData.faceOffset || 0;
                frogMesh.rotation.y = Math.atan2(-dx, -dy) + off;
            }
            if (t >= 1) hopAnim = null;
        }

        // The rigged Funky: idle at rest, the hop clip scrubbed through a hop.
        driveCharacterAnim(t < 1 ? 'hop' : 'idle', t, lastFrameDt || 1 / 60);

        // Secondary motion on the modelled character. The placeholder keeps its
        // own leg tuck below; this drives the bake, which has nothing else.
        if (frogMesh.userData.motion && root.BurnQuestCharMotion) {
            root.BurnQuestCharMotion.update(now, t, danceT < 0 && !deathFx);
        }

        const rig = frogMesh.userData.rig;
        const legs = frogMesh.userData.legs || [];
        if (rig) {
            if (t < 1) {
                // Classic squash and stretch: compress on the ground at both ends
                // of the hop, extend through the middle. Cheap, and it is exactly
                // what Crossy Road does with a static low-poly mesh.
                const air = Math.sin(t * Math.PI);          // 0 -> 1 -> 0
                const ground = 1 - air;                     // 1 -> 0 -> 1
                const launch = Math.max(0, 1 - t * 4);      // brief crouch at start
                const land = Math.max(0, (t - 0.75) * 4);   // brief squash at end
                const squash = Math.max(launch, land);

                rig.scale.set(
                    1 + squash * 0.30 - air * 0.14,
                    1 - squash * 0.34 + air * 0.26,
                    1 + squash * 0.30 - air * 0.14
                );
                rig.rotation.x = -air * 0.42;               // nose up over the arc
                if (!frogMesh.userData.model) {
                    legs.forEach(l => {
                        l.scale.z = 1 - air * 0.45;         // tuck in flight
                        l.position.y = 0.08 + air * 0.05;
                    });
                }
            } else {
                // Idle: a slow breathing bob so it never looks frozen.
                const breathe = Math.sin(now / 380) * 0.03;
                rig.scale.set(1 - breathe * 0.5, 1 + breathe, 1 - breathe * 0.5);
                rig.rotation.x = 0;
                if (!frogMesh.userData.model) {
                    legs.forEach(l => { l.scale.z = 1; l.position.y = 0.08; });
                }
            }
        }

        // Stand on TOP of whatever is being ridden. The frog used to sit at a
        // fixed 0.2 regardless, so it clipped through logs and turtles instead
        // of standing on them. Eased so a hop onto a log settles rather than
        // snapping.
        if (danceT >= 0) return;       // the dance owns the frog while it plays
        // Snap on a ROW CHANGE, ease only within a row. Easing across a hop
        // meant ~10 frames of the frog interpenetrating the log it had just
        // landed on - measured at 0.045 units sunk in. Within a row the target
        // barely moves, so the ease still smooths platform-to-platform drift.
        // rideTop is an absolute deck height, so it REPLACES the ground height
        // rather than stacking on it. Adding the two was why the frog hovered
        // over the log; a row with no platform simply rides the ground.
        const deck = rideHeightAt(renderFrog.y);
        const targetRide = (deck > 0 ? deck : GROUND_Y) + RIG_FOOT_OFFSET;
        const rideRow = Math.round(renderFrog.y);
        if (rideRow !== lastRideRow) { rideY = targetRide; lastRideRow = rideRow; }
        else { rideY += (targetRide - rideY) * 0.35; }
        frogMesh.position.set(worldX(renderFrog.x + 0.5), rideY + hopArc, worldZ(renderFrog.y));
        // Ring stays pinned to the ground while the body arcs above it.
        const ring = frogMesh.userData.ring;
        if (ring) {
            ring.position.y = -hopArc - RIG_FOOT_OFFSET + 0.012;
            ring.material.opacity = 0.30 + 0.35 * (hopArc / 0.55);
        }
    }

    // ---- old combo text (restored from Mimi's 2D build, 2026-09-07) ----
    // One sprite per (text, x, color): the sim drifts y, so text|x|color is
    // the stable key. Sprites are billboards; the canvas texture carries the
    // original styling (bold 22px Inter, centred).
    // Orbitron is a webfont: canvas text drawn before it arrives silently falls
    // back to Arial and the texture is then baked wrong for the life of the
    // sprite. Ask once, and only switch fonts when the browser confirms it.
    let scoreFontReady = false;
    if (typeof document !== 'undefined' && document.fonts && document.fonts.load) {
        document.fonts.load('900 64px Orbitron').then(() => { scoreFontReady = true; })
            .catch(() => {});
    }

    function makeTextSprite(text, color) {
        // 4x the old canvas. The original was 256x80 with 22px type scaled to
        // 2.2 world units - soft at any real screen size, and the reason the
        // pickup text read as a smudge rather than a number.
        const cv = document.createElement('canvas');
        cv.width = 512; cv.height = 192;
        const c2 = cv.getContext('2d');
        const cx = 256, cy = 96;
        c2.font = (scoreFontReady ? '900 62px Orbitron, ' : 'bold 66px ') +
                  'Inter, Arial, sans-serif';
        c2.textAlign = 'center';
        c2.textBaseline = 'middle';

        // Glow, then a heavy dark outline, then a vertical gradient fill: the
        // text has to hold up over a bright green median AND a dark road.
        c2.save();
        c2.shadowColor = color;
        c2.shadowBlur = 26;
        c2.lineJoin = 'round';
        c2.lineWidth = 14;
        c2.strokeStyle = 'rgba(0,0,0,0.82)';
        c2.strokeText(text, cx, cy);
        c2.strokeText(text, cx, cy);          // twice: one pass reads thin
        c2.restore();

        c2.lineJoin = 'round';
        c2.lineWidth = 9;
        c2.strokeStyle = 'rgba(0,0,0,0.9)';
        c2.strokeText(text, cx, cy);

        const grad = c2.createLinearGradient(0, cy - 34, 0, cy + 34);
        grad.addColorStop(0, '#ffffff');
        grad.addColorStop(0.42, color);
        grad.addColorStop(1, shadeHex(color, -0.28));
        c2.fillStyle = grad;
        c2.fillText(text, cx, cy);

        const tex = new THREE_.CanvasTexture(cv);
        tex.anisotropy = 4;
        const mat = new THREE_.SpriteMaterial({
            map: tex, transparent: true, depthWrite: false,
            // Never let a truck swallow the score you just earned.
            depthTest: false
        });
        const sp = new THREE_.Sprite(mat);
        sp.renderOrder = 1000;
        sp.scale.set(3.9, 1.46, 1);
        return sp;
    }

    // #rrggbb -> darker/lighter #rrggbb. Only used for the gradient's low stop.
    function shadeHex(hex, amt) {
        const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '#ffffff'));
        if (!m) return '#888888';
        const n = parseInt(m[1], 16);
        const ch = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => {
            const out = amt < 0 ? v * (1 + amt) : v + (255 - v) * amt;
            return Math.max(0, Math.min(255, Math.round(out)));
        });
        return '#' + ch.map(v => v.toString(16).padStart(2, '0')).join('');
    }

    // Mirror state.floatingTexts (life 40 -> 0) into billboards. Position and
    // alpha come from the sim values each frame; a text absent from the state
    // this frame is swept. Purely visual: nothing here feeds back into the sim.
    function updateFloatingTexts(state) {
        const seen = new Set();
        (state.floatingTexts || []).forEach(t => {
            const key = t.text + '|' + t.x + '|' + t.color;
            seen.add(key);
            let e = textSprites.get(key);
            if (!e) {
                if (typeof document === 'undefined') return;
                const sp = makeTextSprite(t.text, t.color);
                scene.add(sp);
                e = { sp };
                textSprites.set(key, e);
            }
            // Higher start and a faster climb: the sprite is now ~2x the old
            // size, so the old 1.15 baseline sat it on top of the frog.
            e.sp.position.set(worldX(t.x + 0.5), 1.65 + (40 - t.life) * 0.020, worldZ(t.y));
            e.sp.material.opacity = Math.max(0, Math.min(1, t.life / 40));
        });
        textSprites.forEach((e, key) => {
            if (seen.has(key)) return;
            scene.remove(e.sp);
            e.sp.material.map.dispose();
            e.sp.material.dispose();
            textSprites.delete(key);
        });
    }

    // Bottom-left COMBO xN - the original drew it on the 2D canvas; the 3D
    // build gets a DOM overlay so the WebGL scene stays text-free.
    function updateComboHud(state) {
        if (typeof document === 'undefined') return;
        if (!comboHudEl) comboHudEl = document.getElementById('combo-hud');
        if (!comboHudEl) return;
        if (state.combo > 1) {
            // Split so the multiplier can be typeset much larger than the word.
            // Rebuild only when the number actually changes: writing innerHTML
            // every frame would restart the pop animation 60 times a second and
            // it would never be seen.
            if (comboShown !== state.combo) {
                comboHudEl.innerHTML =
                    '<span class="combo-word">COMBO</span>' +
                    '<span class="combo-x">x' + state.combo + '</span>';
                comboHudEl.classList.remove('pop');
                void comboHudEl.offsetWidth;            // restart the animation
                comboHudEl.classList.add('pop');
                comboShown = state.combo;
            }
            // Deeper streaks get hotter, so a big combo is visible at a glance.
            comboHudEl.dataset.tier = state.combo >= 8 ? 'hot'
                                    : state.combo >= 4 ? 'warm' : 'base';
            comboHudEl.style.display = 'flex';
        } else {
            comboHudEl.style.display = 'none';
            comboShown = 0;
        }
    }

    function draw(state) {
        if (!renderer || contextLost) return;

        if (state.cols !== cols || state.rows !== rows || state.layoutKey !== layoutKey) {
            // Row 0 tops every layout, but worldZ is centred on the board, so a
            // taller board moves the goal by half the extra rows. A stage clear
            // rebuilds the board in the SAME tick the frog touches the gate, i.e.
            // mid-celebration, while the dancing frog sits in world space: carry
            // him, his draw-in start and the camera with the goal, or on stage 2
            // he dances three rows below the rebuilt portal and the camera glides.
            const dz = -(state.rows - rows) / 2;
            if (danceT >= 0 && dz && frogMesh) {
                frogMesh.position.z += dz;
                if (enterFrom) enterFrom.z += dz;
                camFocusZ += dz;
            }
            cols = state.cols;
            rows = state.rows;
            layoutKey = state.layoutKey;
            buildRowTables();          // a stage can change the board's layout
            buildBoard();
            positionCamera();
        }

        ensurePools(state);

        // Anything far outside the camera window is hidden - with 37 rows most
        // of the board is off screen at any moment.
        const cull = VISIBLE_ROWS * 0.85;
        const inWindow = (gy) => Math.abs(worldZ(gy) - camFocusZ) < cull;

        state.cars.forEach((c, i) => {
            const m = carMeshes[i];
            if (!m) return;
            m.visible = inWindow(c.y);
            if (!m.visible) return;
            // Lamps are modelled on the -x end, so a car travelling +x turns
            // around - otherwise it drives with its tail lights leading.
            m.rotation.y = c.dir > 0 ? Math.PI : 0;
            m.position.set(worldX(c.x + c.w / 2), 0.0, worldZ(c.y));   // tyres on the deck
            spinWheels(m, c);
        });

        state.logs.forEach((l, i) => {
            const m = logMeshes[i];
            if (!m) return;
            m.visible = inWindow(l.y);
            if (!m.visible) return;
            m.position.set(worldX(l.x + l.w / 2), 0.1, worldZ(l.y));
        });

        state.turtles.forEach((t, i) => {
            const raft = turtleMeshes[i];
            if (!raft) return;
            const vis = inWindow(t.y);
            raft.forEach(r => { r.visible = vis; });
            if (!vis) return;
            for (let k = 0; k < 3; k++) {
                raft[k].position.set(worldX(t.x + k * 0.9 + 0.45), 0.08, worldZ(t.y));
            }
        });

        state.lilypads.forEach((p, i) => {
            const m = lilypadMeshes[i];
            if (!m) return;
            m.visible = inWindow(p.y);
            if (!m.visible) return;
            m.position.set(worldX(p.x + p.w / 2), 0.08, worldZ(p.y));
        });

        state.sparks.forEach((s, i) => {
            const m = sparkMeshes[i];
            if (!m) return;
            m.visible = !s.collected && inWindow(s.y) && !m.userData.awaitingCoin;
            // The campaign coin stays upright and front-facing; only its
            // vertical bob communicates collectibility. Keep the old spin and
            // wobble solely for the fallback octahedron placeholder.
            const tms = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // Coin GLB is a flat disc (face in XZ plane, facing +Y).
            // YXZ order: Y spins left-to-right FIRST, then X stands it upright.
            m.rotation.order = 'YXZ';
            m.rotation.y = m.userData.isCoin ? tms / 800 : tms / 600;
            m.rotation.x = m.userData.isCoin
                ? Math.PI / 2
                : Math.sin(tms / 900) * 0.4;
            m.position.set(worldX(s.x + 0.5), 0.42 + Math.sin(tms / 500 + i) * 0.07, worldZ(s.y));
        });

        (state.bugs || []).forEach((bu, i) => {
            const m = bugMeshes[i];
            if (!m) return;
            m.visible = !bu.collected && inWindow(bu.y);
            if (!m.visible) return;
            const tms = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // The scripted GLB fly hovers like an insect; the procedural
            // placeholder still spins (its sphere reads fine either way).
            if (!(m.userData && m.userData.model)) m.rotation.y = tms / 420 + i;
            else m.rotation.y = Math.sin(tms / 900 + i) * 0.35;
            m.position.set(worldX(bu.x + 0.5),
                           0.54 + Math.sin(tms / 320 + i * 1.7) * 0.09,
                           worldZ(bu.y));
        });

        (state.shades || []).forEach((sg, i) => {
            const m = shadesMeshes[i];
            if (!m) return;
            m.visible = !sg.collected && inWindow(sg.y);
            if (!m.visible) return;
            const tms = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            m.rotation.y = tms / 700 + i;
            m.rotation.z = Math.sin(tms / 600 + i) * 0.18;
            m.position.set(worldX(sg.x + 0.5),
                           0.50 + Math.sin(tms / 420 + i * 2.1) * 0.09,
                           worldZ(sg.y));
        });

        (state.lifePickups || []).forEach((lp, i) => {
            const m = lifePickupMeshes[i];
            if (!m) return;
            m.visible = !lp.collected && inWindow(lp.y);
            if (!m.visible) return;
            const tms = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            m.rotation.y = tms / 650 + i;
            m.position.set(worldX(lp.x + 0.5),
                           0.45 + Math.sin(tms / 400 + i * 2.1) * 0.08,
                           worldZ(lp.y));
        });

        // Hazards: they face the way they are heading, birds hover and flap,
        // gators ride low in the water.
        (state.hazards || []).forEach((h, i) => {
            const m = hazardMeshes[i];
            if (!m) return;
            m.visible = inWindow(h.y);
            if (!m.visible) return;
            const tms = (typeof performance !== 'undefined' ? performance.now() : Date.now());
            // A gator rides AT the water surface, like a log (0.1) - at -0.04 it
            // swam under the nearly opaque water and was invisible, which is
            // why Gabriel saw only snakes. Birds hover above the grass.
            // The loader grounds a model (feet at y=0), so a bird with its wings
            // spread would stand on the grass: fly it. Gators ride at the water
            // surface, level with a log; snakes lie on the ground.
            // Gabriel 2026-09-11: the bird was sitting half under the ground -
            // fly it "2x above the character player". The character is 1.1 tall,
            // so 2.2 puts it a clear body-height of air above his head.
            const flying = h.kind === 'bird' ? 2.2 : 0;
            const hover = h.kind === 'bird' ? flying + Math.sin(tms / 260 + i) * 0.05
                        // Gabriel 2026-09-12: "alligator can be maybe 1.2x lower in
                        // the water ... a realer alligator in the water kreeping". A log
                        // rides at 0.10, so 0.10 floated him ON the surface. 0.02 sinks
                        // the body under the waterline and leaves the eyes and back
                        // ridges (~0.22 in model space) clear. NOT lower: at -0.04 he
                        // vanished under the opaque water entirely, which is why only
                        // snakes were visible earlier.
                        : h.kind === 'gator' ? 0.02 : 0.0;
            m.rotation.y = h.dir > 0 ? 0 : Math.PI;
            // The roll tips the tube sideways, and a FATTER tube pays more width
            // for the same angle: Blender says the slither peaks at 0.872 across at
            // girth 1.10, but the live scene measured 1.164 at girth 1.35 where the
            // same method predicts 1.071 - about 9% wider than the animation alone
            // accounts for. Gabriel: "his body still goes out of its row". A row is
            // 1.0 deep, so cut the roll rather than give back the girth he likes.
            if (h.kind === 'snake') m.rotation.z = Math.sin(tms / 300 + i) * 0.02;
            if (m.userData.wings && !m.userData.model) {
                const flap = Math.sin(tms / 90 + i) * 0.7;
                m.userData.wings[0].rotation.x = flap;
                m.userData.wings[1].rotation.x = -flap;
            }
            // A locked-on hazard animates hotter: the tell that it has seen you.
            if (m.userData.mixer) m.userData.mixer.update((lastFrameDt || 1 / 60) * (h.hunt ? 1.6 : 1));
            m.position.set(worldX(h.x + h.w / 2), hover, worldZ(h.y));
        });

        if (portalFrame) {
            // Spin ONLY the vortex. children[0] is the whole frame mesh - turning
            // that orbited the entire portal around its base and buried it.
            const t = (typeof performance !== 'undefined' ? performance.now() : Date.now()) / 1000;
            if (portalVortex) portalVortex.rotation.z = t * 0.9;
        } else if (portalMesh) {
            portalMesh.rotation.y += 0.02;
        }

        // A life lost = play the corpse where the frog last actually was. The
        // sim has already teleported it back to the start row by now, which is
        // why lastAlive is tracked separately.
        if (prevLives === null) prevLives = state.lives;
        if (state.lives < prevLives) spawnDeathFx(state);
        prevLives = state.lives;

        updateHop(state);
        updateBarriers();          // after the hop, so it tracks the live position
        const fxDt = tickEffectClock();
        updateDance(fxDt);
        if (state.invincible <= 0) lastAlive = { x: state.frog.x, y: state.frog.y };
        updateDeathFx(fxDt);
        frogMesh.visible = state.invincible <= 0 || Math.floor(state.invincible / 4) % 2 === 0;

        // Single render call per frame - no other code path renders this scene.
        shadesOn = (state.shadesLeft || 0) > 0;
        // Debug-only override: a headless probe cannot walk the frog onto
        // sunglasses, so tools/ may force the shades view via window.__forceShades.
        // Gated behind DEBUG so production ignores it.
        if (DEBUG && typeof window !== 'undefined' && window.__forceShades) {
            shadesOn = true;
            // Snap the blend on the frame it is switched on. The blend eases
            // 0.075 per frame and approaches 1 asymptotically; a probe that
            // waits a fixed time measures the camera mid-transition, which made
            // a correct fix read as a regression.
            if (!forcedShadesWas) { applyCameraFollow(true); forcedShadesWas = true; }
        } else {
            forcedShadesWas = false;
        }
        applyCameraFollow(false);
        updateAtmosphere();
        tickSurfaceShaders();
        updateFloatingTexts(state);
        updateComboHud(state);
        updateEmbers();
        renderer.render(scene, camera);
    }

    // Swap theme WITHOUT reloading, so an in-progress run survives it.
    // Materials, lights, fog, background and the character change; the board
    // geometry is rebuilt from the same sim dimensions and nothing about the
    // simulation is touched.
    function setTheme(name) {
        if (!THEMES[name] || name === themeName) return themeName;
        themeName = name;
        theme = THEMES[name];
        applyPalette(theme);

        scene.background = new THREE_.Color(theme.background);
        scene.fog = new THREE_.Fog(theme.fog.color, theme.fog.near, theme.fog.far);

        if (hemiLight) {
            hemiLight.color.setHex(theme.hemi.sky);
            hemiLight.groundColor.setHex(theme.hemi.ground);
            hemiLight.intensity = theme.hemi.intensity;
        }
        if (sunLight) {
            sunLight.color.setHex(theme.sun.color);
            sunLight.intensity = theme.sun.intensity;
            sunLight.position.set(theme.sun.pos[0], theme.sun.pos[1], theme.sun.pos[2]);
        }
        if (rimLight) {
            rimLight.color.setHex(theme.rim.color);
            rimLight.intensity = theme.rim.intensity;
        }
        // Polish pass: keep tone and shadow softness in sync with the theme.
        if (renderer && 'toneMappingExposure' in renderer) renderer.toneMappingExposure = themeExposure();
        if (sunLight) sunLight.shadow.radius = themeShadowRadius();

        // embers belong to one theme only
        if (emberPts) { scene.remove(emberPts); emberPts.geometry.dispose();
                        disposeMaterial(emberPts.material); emberPts = null; emberVel = null; }
        if (theme.embers > 0) makeEmbers(theme.embers);
        buildAtmosphere();

        if (portalFrame) { scene.remove(portalFrame); portalFrame = null; portalVortex = null; }
        // No manual disposal here. buildBoard() is the single owner of board
        // GPU resources - it removes boardGroup, traverses EVERY child
        // (waterMeshes and sceneryGroup are both added to boardGroup) disposing
        // geometry/material, and disposes procTextures. A separate traversal
        // here double-disposed and could tear down the shared cached palm GLB
        // geometry/materials cloned into sceneryGroup. Only drop the references
        // so a pending async palm load does not add to a stale group; buildBoard()
        // rebuilds both.
        waterMeshes = []; sceneryGroup = null;
        if (deathFx) {
            if (deathFx.splash && deathFx.splash.g.parent) scene.remove(deathFx.splash.g);
            scene.remove(deathFx.holder);
            deathFx = null;
        }
        buildBoard();

        // force every entity pool to rebuild with the new palette
        carMeshes.forEach(disposeMesh);     carMeshes = [];
        logMeshes.forEach(disposeMesh);     logMeshes = [];
        turtleMeshes.forEach(disposeMesh);  turtleMeshes = [];
        lilypadMeshes.forEach(disposeMesh); lilypadMeshes = [];
        sparkMeshes.forEach(disposeMesh);   sparkMeshes = [];
        bugMeshes.forEach(disposeMesh);     bugMeshes = [];
        shadesMeshes.forEach(disposeMesh);  shadesMeshes = [];
        lifePickupMeshes.forEach(disposeMesh);  lifePickupMeshes = [];
        hazardMeshes.forEach(disposeMesh);  hazardMeshes = []; hazardKinds = '';

        // rebuild the character for this theme
        if (frogMesh) { scene.remove(frogMesh); frogMesh = null; }
        frogMesh = makeFrogMesh();
        scene.add(frogMesh);
        upgradeFrogToModel();

        positionCamera();
        try { localStorage.setItem('burnquest_theme', name); } catch (e) {}
        return themeName;
    }

    function getTheme() { return themeName; }
    function themeNames() { return Object.keys(THEMES); }
    function setCharacter(id) { selectedCharacter = id || null; }
    function rebuildCharacter() {
        if (!frogMesh) return;
        scene.remove(frogMesh);
        const model = frogMesh.userData.model;
        if (model) {
            if (model.userData.motion && root.BurnQuestCharMotion && root.BurnQuestCharMotion.detach)
                root.BurnQuestCharMotion.detach(model);
            disposeMesh(model);
        }
        frogMesh = makeFrogMesh();
        scene.add(frogMesh);
        upgradeFrogToModel();
    }
    // Exposed for browser verification of the context-loss gate (#11).
    function isContextLost() { return contextLost; }

    root.Render3D = { init, draw, resize, MANIFEST, setTheme, getTheme, themeNames,
                      setControlsOverlay, isContextLost, setCharacter, rebuildCharacter,

                      startCelebration, stopCelebration, isCelebrating };
}(typeof window !== 'undefined' ? window : this));
