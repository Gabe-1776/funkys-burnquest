/**
 * Funky's BurnQuest
 * 2D canvas renderer - the original draw path, moved unchanged in behaviour
 * out of game.js. Reads a Sim.getState() snapshot; never touches sim state.
 *
 * Interface (shared with render3d.js): init(canvas), draw(state), resize(w,h)
 */
(function (root) {
    'use strict';

    let canvas, ctx;
    let W = 0, H = 0, dpr = 1;
    let cols = 15, rows = 13;
    let tile = 0, boardW = 0, boardH = 0, offX = 0, offY = 0;

    const images = {};
    const imageList = [
        'funky', 'car-red-v2', 'car-yellow-v2',
        'truck-green-v2', 'truck-blue-v2', 'truck-semi-v2',
        'log', 'turtle', 'lilypad2', 'portal', 'spark'
    ];

    const ASSET_VERSION = '2';   // bump when the sprite set changes


    function loadImages() {
        imageList.forEach(name => {
            const img = new Image();
            // Fixed version tag, NOT Date.now(). A timestamp made every URL unique,
            // so the browser cache was defeated and the entire sprite set was
            // re-downloaded on every page load. Bump ASSET_VERSION to bust it.
            img.src = 'assets/images/' + name + '.png?v=' + ASSET_VERSION;
            img.onload = () => images[name] = img;
        });
    }

    function computeLayout() {
        // Tiles must be SQUARE. Stretching a 15x13 grid across the whole
        // viewport made a tile 26 wide by 65 tall on a 390x844 phone and the
        // frog rendered at 22px -- the "zoomed out on mobile" complaint.
        tile = Math.min(W / cols, H / rows);
        boardW = cols * tile;
        boardH = rows * tile;
        offX = (W - boardW) / 2;
        offY = (H - boardH) / 2;

        if (canvas) {
            // Back the canvas with real device pixels; 1:1 was half
            // resolution on every retina display.
            dpr = Math.min(window.devicePixelRatio || 1, 2);
            canvas.width = Math.round(W * dpr);
            canvas.height = Math.round(H * dpr);
            canvas.style.width = W + 'px';
            canvas.style.height = H + 'px';
        }
    }

    function init(c) {
        canvas = c;
        ctx = canvas.getContext('2d');
        loadImages();
        W = window.innerWidth;
        H = window.innerHeight;
        computeLayout();
    }

    function resize(w, h) {
        W = w;
        H = h;
        computeLayout();
    }

    function goalColOf(state) {
        return (typeof state.goalCol === 'number') ? state.goalCol : Math.floor(cols / 2);
    }

    function draw(state) {
        if (!ctx) return;

        if (state.cols !== cols || state.rows !== rows) {
            cols = state.cols;
            rows = state.rows;
            computeLayout();
        }

        const tw = tile;
        const th = tile;

        const shake = state.shake || 0;
        const sx = shake > 0 ? (Math.random() - 0.5) * shake : 0;
        const sy = shake > 0 ? (Math.random() - 0.5) * shake : 0;

        // Letterbox behind the board, then draw the board in its own space so
        // every tw/th-based draw call below stays in board-local coordinates.
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        ctx.fillStyle = '#05070f';
        ctx.fillRect(0, 0, W, H);

        ctx.save();
        ctx.translate(offX + sx, offY + sy);

        // Terrain comes from the sim's descriptor, never from row literals.
        // This used to read `y <= 5 ? water : (y === 6 || y === 12) ? median`,
        // which described the original 13-row board; on the 37-row board that
        // painted two thirds of the water as tarmac.
        const TERRAIN = { goal: '#1b4332', water: '#0077b6', median: '#2d6a4f', road: '#2b2b2b' };
        const S = root.Sim;
        const classOf = (S && S.rowClass) ? S.rowClass : function () { return 'road'; };
        for (let y = 0; y < rows; y++) {
            ctx.fillStyle = TERRAIN[classOf(y)] || TERRAIN.road;
            ctx.fillRect(0, y * th, boardW, th);
        }

        // A dashed divider down the middle of every road band, not one line
        // hardcoded at row 9.
        ctx.strokeStyle = '#f4d35e';
        ctx.setLineDash([10, 12]);
        for (let y = 0; y < rows; y++) {
            if (classOf(y) !== 'road') continue;
            const prevRoad = y > 0 && classOf(y - 1) === 'road';
            const nextRoad = y < rows - 1 && classOf(y + 1) === 'road';
            if (!prevRoad || !nextRoad) continue;          // skip band edges
            if (classOf(y - 2) !== 'road' || classOf(y + 2) !== 'road') continue;
            ctx.beginPath();
            ctx.moveTo(0, y * th + th / 2);
            ctx.lineTo(boardW, y * th + th / 2);
            ctx.stroke();
        }
        ctx.setLineDash([]);

        const goalCol = goalColOf(state);

        if (images.portal?.complete) {
            ctx.drawImage(images.portal, goalCol * tw, th * 0.08, tw * 1.1, tw * 0.85);
        }

        state.logs.forEach(l => {
            if (images.log?.complete) {
                ctx.drawImage(images.log, l.x * tw, l.y * th + th * 0.22, l.w * tw, th * 0.55);
            }
        });

        // Turtles travel as rafts of 3. Each sprite fills one tile, so the
        // rendered raft spans the sim's complete 3-tile platform hitbox.
        // 2D fallback only; render3d draws the GLB raft.
        state.turtles.forEach(t => {
            if (!images.turtle?.complete) return;
            const s = tw;
            for (let i = 0; i < 3; i++) {
                ctx.drawImage(images.turtle, (t.x + i) * tw,
                              t.y * th + (th - s) / 2, s, s);
            }
        });

        state.lilypads.forEach(p => {
            if (images.lilypad2?.complete) {
                const s = tw * p.w * 0.95;
                ctx.drawImage(images.lilypad2, p.x * tw, p.y * th + (th - s) / 2, s, s);
            }
        });

        // Width comes from c.w, the same number the collision test uses, and
        // the sprite is flipped to face its actual direction of travel.
        state.cars.forEach(c => {
            const img = images[c.imgKey];
            if (!img?.complete) return;
            const cw = c.w * tw;
            const ch = th * 0.7;
            const dy = c.y * th + (th - ch) / 2;
            ctx.save();
            if (c.dir > 0) {
                ctx.translate(c.x * tw + cw, dy);
                ctx.scale(-1, 1);
                ctx.drawImage(img, 0, 0, cw, ch);
            } else {
                ctx.drawImage(img, c.x * tw, dy, cw, ch);
            }
            ctx.restore();
        });

        // HAZARDS (snakes, birds, gators). The 3D build has models; here they
        // are drawn in code, because a 2D player must still SEE what killed
        // them - an invisible attacker reads as a broken game.
        (state.hazards || []).forEach(h => {
            const x = h.x * tw, w = h.w * tw, y = h.y * th, mid = y + th / 2;
            ctx.save();
            if (h.kind === 'snake') {
                ctx.fillStyle = '#2f7d32';
                for (let i = 0; i < 6; i++) {
                    const sx = x + (w / 6) * i;
                    ctx.fillRect(sx, mid - th * 0.12 + Math.sin(i * 1.1) * th * 0.06, w / 6 + 1, th * 0.22);
                }
                ctx.fillStyle = '#9ccf5e';
                ctx.fillRect(x + w - w / 6, mid - th * 0.14, w / 6, th * 0.26);
            } else if (h.kind === 'bird') {
                ctx.fillStyle = '#9a6fb5';
                ctx.beginPath();
                ctx.ellipse(x + w / 2, mid, w * 0.42, th * 0.22, 0, 0, Math.PI * 2);
                ctx.fill();
                ctx.fillStyle = '#3b2b4a';
                ctx.fillRect(x + w * 0.25, mid - th * 0.30, w * 0.5, th * 0.10);
                ctx.fillStyle = '#ffb347';
                const bx = h.dir > 0 ? x + w : x;
                ctx.fillRect(bx - (h.dir > 0 ? w * 0.12 : 0), mid - th * 0.05, w * 0.12, th * 0.10);
            } else {
                ctx.fillStyle = '#2b5d34';
                ctx.fillRect(x, mid - th * 0.16, w, th * 0.32);
                ctx.fillStyle = '#1c3f24';
                for (let i = 0; i < 4; i++) ctx.fillRect(x + w * (0.18 + i * 0.18), mid - th * 0.26, w * 0.08, th * 0.12);
                ctx.fillStyle = '#2b5d34';
                const sx = h.dir > 0 ? x + w : x - w * 0.25;
                ctx.fillRect(sx, mid - th * 0.10, w * 0.25, th * 0.20);
            }
            ctx.restore();
        });

        state.sparks.forEach(s => {
            if (s.collected) return;
            if (images.spark?.complete) {
                const s2 = tw * 0.4;
                ctx.drawImage(images.spark, s.x * tw + (tw - s2) / 2,
                              s.y * th + (th - s2) / 2, s2, s2);
            }
        });

        if (images.funky?.complete) {
            const s = tw * 0.85;
            if (state.invincible > 0) ctx.globalAlpha = 0.55;
            ctx.drawImage(images.funky, state.frog.x * tw + (tw - s) / 2, state.frog.y * th + (th - s) / 2, s, s);
            ctx.globalAlpha = 1;
        }

        state.floatingTexts.forEach(t => {
            ctx.fillStyle = t.color;
            ctx.font = 'bold 22px Inter, Arial';
            ctx.textAlign = 'center';
            ctx.globalAlpha = t.life / 40;
            ctx.fillText(t.text, t.x * tw + tw / 2, t.y * th);
            ctx.globalAlpha = 1;
        });

        if (state.combo > 1) {
            ctx.fillStyle = '#f1c40f';
            ctx.font = 'bold 18px Inter, Arial';
            ctx.textAlign = 'left';
            ctx.fillText(`COMBO x${state.combo}`, 8, boardH - 12);
        }

        ctx.restore();
    }

    root.Render2D = { init, draw, resize };
}(typeof window !== 'undefined' ? window : this));
