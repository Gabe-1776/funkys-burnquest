# Funky's BurnQuest

Frogger-style arcade game wrapped in a token-burn campaign system. Pick one of
9 communities, play runs, earn points — 1 point ≈ 1 token "scheduled for burn".

**Owner:** Mimi  
**Branch:** `v1.2`  
**Live test:** https://funkyburnquest.project-testing.xyz/  
**Production (do not deploy from this repo):** `ksto.world/games/funkys-burnquest/`

## Play locally

No build step:

```bash
python3 -m http.server 8099
# open http://localhost:8099
```

## For AI agents

Start at [`llms.txt`](./llms.txt), then [`AGENTS.md`](./AGENTS.md).

## Features

- **3D and 2D renderers** — Three.js 3D by default, canvas 2D via `?render=2d`
- **5 stages** — per-stage boards, hazards, and time limits
- **3 playable characters** — Funkyverse (rigged), Toy (diorama), Classic
- **Hunter hazards** — snakes, birds, alligators
- **Campaign coins** — community-specific tokens
- **Desktop and mobile** — touch controls, portrait/landscape

## Tech

- Vanilla JS, no bundler, no runtime dependencies
- Three.js r0.160 UMD (self-hosted)
- Headless simulation in `sim.js` (Node-requireable)
- Asset pipeline scripts in `tools/` (dev only; not deployed)

## Tests

```bash
node tools/sim-contract-test.js
node tools/lane-check.js
node tools/stage-layout-check.js
```

Browser gates (local server, one at a time):

```bash
node tools/align-check.js
node tools/char-motion-check.js
```
