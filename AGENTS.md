# funkys-burnquest — AGENTS.md

Frogger-style arcade game wrapped in a token-burn campaign system: pick one
of 9 communities, play runs, earn points, 1 point ≈ 1 token "scheduled for burn".

**Owner: Mimi.** Small, readable, reviewable patches — not a rewrite.

Also see root `llms.txt` (short do/don't for automated agents).

## Quick start

No build step, no dependencies. Open `index.html` in a browser, or serve locally:

```bash
python3 -m http.server 8099
# open http://localhost:8099
```

Useful query params: `?render=3d` (default), `?render=2d`, `?theme=funkyverse|diorama`,
`?stage=N` (practice board, no points).

Three.js **r0.160** UMD is self-hosted as `three.min.js`. Do not swap for a
newer release — newer versions dropped the UMD build this project relies on.

**Live test site:** https://funkyburnquest.project-testing.xyz/  
**Never deploy to** `ksto.world/games/funkys-burnquest/` (Mimi production).

## File structure

```
index.html          Screens (dashboard, game, results, modals)
style.css           All styling
sim.js              Headless simulation: grid, lanes, collision, scoring, lives
render3d.js         Three.js renderer (default)
render2d.js         Canvas 2D renderer (?render=2d)
game.js             Orchestrator: DOM, audio, input, render-loop glue
audio.js            Sound effects and music
char-motion.js      Procedural vertex deform for unrigged character meshes
glb-assets.js       GLB loading, theme/shared-asset routing
glb-dims.js/json    Asset bounding-box dimensions (keep in sync)
glb-loader.js       Vendored Three r0.160 GLTFLoader (UMD)
wheel-split.js      Car wheel separation (disabled)
skeleton-clone.js   Skeleton cloning helper
three.min.js        Three.js r0.160 UMD (self-hosted)
deploy.sh           Manual allowlist rsync (requires explicit host+path)
manifest.webmanifest  PWA manifest
assets/             Runtime assets (models, images, audio, coins)
tools/              Dev-only: gates + Blender/Meshy pipeline (not deployed)
llms.txt            Short agent entrypoint
```

`tools/` is large on purpose (asset pipeline + browser gates). Agents should
treat it as optional — run the gates below; do not invent new Meshy jobs
unless asked.

## The grid

`COLS` x `ROWS` = **15 x 37** on stage 1. `BANDS = 3` repeats of
(5 water | median | 5 road | median). Row 0 = goal, last row = start.

Never hardcode a row range. Derive from `Sim.WATER_LANES` / `ROAD_LANES` /
`MEDIAN_ROWS` / `ROW_CLASS` / `BANDS` — live getters that change when the
board rebuilds for a new stage.

## Stages

The board is per-stage. `STAGES[]` in `sim.js` is the ONLY place a stage's
difficulty lives. Reaching the gateway on a non-final stage rebuilds the board
from the next row — score and lives carry, the clock keeps running.

| Stage | Rows | Hazards | Time |
|-------|------|---------|------|
| 1     | 37   | None (teaching board) | Untimed |
| 2     | 49   | Hand-placed snakes/birds + gator | 150s |
| 3     | 49   | Inherits 2, swaps some to birds + snake | 150s |
| 4     | 61   | Inherits 3, adds gators | 150s |
| 5     | 61   | Inherits 4, fills remaining spots | 150s |

Hazard speed ramps 0.10x per stage from stage 2: stage 2 = 1.0x, 3 = 1.1x,
4 = 1.2x, 5 = 1.3x. Grass hazards patrol the full row (left wall to right wall);
the gator roams its whole river. Both hunt the frog when it enters their row.

`?stage=N` starts a practice run on that board. Practice runs bank no points.

## Characters

Three playable characters, selectable in-game via the CHAR button in the HUD:

- **FUNKY** (`funkyverse`) — rigged voxel frog, 14-bone skeleton, idle/hop/dance.
  Default on the funkyverse theme.
- **TOY** (`diorama`) — unrigged toy frog from `diorama/funky.json`. Motion via
  `char-motion.js`. Default on the diorama theme.
- **CLASSIC** (`classic`) — Meshy model, rigged via `tools/rig_classic.py`.
  Faces +Z; face offset is `Math.PI`.

Selection persists in `localStorage` (`burnquest_character`).

## Pickups

- **Coins** — campaign-specific textured GLBs, upright, spin on Y (YXZ Euler).
- **Sunglasses** — collectible on certain stages.
- **Life pickup** — frog-head GLB; stages 3 and 5.
- **Fly/bug** — speed power-up; shared from `fv/` for all themes
  (`SHARED_FROM` in `glb-assets.js`).

## Rendering / assets

Default renderer is 3D (`render3d.js`). `?render=2d` uses `render2d.js`.
Both expose the same `init/draw/resize` interface.

GLB loading goes through `glb-assets.js` + `glb-loader.js`. Fit dims live in
`glb-dims.json` / `glb-dims.js`. After rebuilding a model, update both dim
files and bump `GLB_ASSET_VERSION` in `glb-assets.js` (and `glb-assets.js?v=`
in `index.html`).

Meshy atlases are capped at **512px** via `tools/optimize-glb-textures.py`.
`glb-loader.js` forces Three `TextureLoader` (not `ImageBitmapLoader`) so
desktop Chrome keeps baseColor maps — Safari already used that path.

## Gates — run before shipping

| Gate | Covers |
|------|--------|
| `node tools/sim-contract-test.js` | Progression, pause/resume, save, death cause |
| `node tools/lane-check.js` | Every lane crossable within 4s |
| `node tools/stage-layout-check.js` | Per-stage layouts, clock, practice runs |
| `node tools/burn-bank-check.js` | Points bank correctly across levels/deaths |

Browser gates (need `python3 -m http.server 8099`, run one at a time):

| Gate | Covers |
|------|--------|
| `node tools/align-check.js` | Frog feet on platform decks |
| `node tools/char-motion-check.js` | Character deform driven every frame |
| `node tools/pause-resume-check.js` | Pause is a real pause through the UI |
| `node tools/terrain-parity-check.js` | Terrain painted in all 3 bands |
| `node tools/rig-check.js` | Rigged character animates and is drawn |

Run browser gates one at a time — headless Chromium WebGL can lock a
fanless machine if parallelized.

## Key traps

- **Never cache `Sim.ROWS` / `WATER_LANES` / `ROAD_LANES` / `MEDIAN_ROWS` /
  `BANDS` across a stage.** They rebuild with the board.
- **No in-stage speed ramp.** Pace lives in `STAGES` only.
- **Each lane is a conveyor.** One speed per lane, even spacing, opposite
  neighbours. Difficulty is phase, not random gaps.
- **Line endings are MIXED.** Edit bytes in place — do not normalize.
- **The diorama frog has no skeleton.** Motion is `char-motion.js` only.
- **Deploy is manual and allowlisted.** `./deploy.sh user@host /path` — never
  invent a host. Never touch Mimi's Hostinger production URL.

## Known limitations

- **Points are `localStorage` only** (`burnquest_campaigns`). No backend yet.
- **Level progression is incomplete.** `LEVEL_GOALS` / `#level-complete` exist
  but goals are not enforced.
- **Economy is ~100x off.** A perfect run is ~970 points; level 1 needs
  250,000.
