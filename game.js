/**
 * Funky's BurnQuest
 * Orchestrator: DOM screens, audio, input, and the render-loop glue between
 * Sim (sim.js) and whichever renderer is selected (render2d.js / render3d.js
 * via ?render=2d|3d). No simulation logic lives here - see sim.js.
 */

(() => {
    'use strict';

    let canvas;
    let isMuted = false;
    let renderer = null; // Render2D or Render3D, picked by ?render=
    let selectedCharacter = null;  // null = default, 'classic' = funky.png Meshy

    const CHARACTERS = [
        { id: 'funkyverse', name: 'FUNKY', img: 'assets/images/portrait-funkyverse.png?v=1' },
        { id: 'diorama',    name: 'TOY',   img: 'assets/images/portrait-diorama.png?v=1' },
        { id: 'classic',    name: 'CLASSIC', img: 'assets/images/portrait-classic.png?v=1' }
    ];

    // Live sample slots. `gameover` is the only SFX sample (SFX_MAP routes the
    // rest to the synth in audio.js); `music` is the chiptune MP3 (the synth
    // bed is the fallback when it is null). collect/hit/success were removed:
    // they were never populated, only SFX_MAP was used.
    const sounds = { music: null, gameover: null };

    function pickRenderer() {
        const params = new URLSearchParams(window.location.search);
        // 3D is the game now. ?render=2d still serves Mimi's original canvas
        // build, driven by the same sim, as a fallback and for comparison.
        const which = (params.get('render') || '3d').toLowerCase();
        if (which === '3d' && window.Render3D) return window.Render3D;
        if (which !== '2d' && which !== '3d') {
            console.warn(`Unknown ?render=${which}, falling back to 2d`);
        }
        return window.Render2D;
    }

    function init() {
        canvas = document.getElementById('game-canvas');
        Sim.loadData();
        loadAudio();
        bindButtons();
        buildCampaignGrid();

        // A fallback is only a fallback if the primary failure is CAUGHT.
        // render3d throws outright when THREE is missing (a blocked or failed
        // CDN), and nothing caught it, so the loading screen sat there forever
        // with the 2D build one line away and never reached.
        renderer = null;
        const wanted = pickRenderer();
        // Read the saved character BEFORE init() so the right model loads the
        // first time. init() calls upgradeFrogToModel() which reads
        // selectedCharacter; without this, a returning visitor on the diorama
        // theme with FUNKY selected would see the TOY frog until a manual
        // rebuild.
        try {
            const saved = localStorage.getItem('burnquest_character') || null;
            if (wanted.setCharacter) wanted.setCharacter(saved);
        } catch (e) {}
        try {
            wanted.init(canvas);
            renderer = wanted;
        } catch (err) {
            console.error('[burnquest] primary renderer failed, falling back to 2D', err);
            if (wanted !== window.Render2D) {
                try {
                    window.Render2D.init(canvas);
                    renderer = window.Render2D;
                } catch (err2) {
                    console.error('[burnquest] 2D renderer also failed', err2);
                }
            }
        }
        if (!renderer) { showFatal('This game could not start in your browser.'); return; }
        // AFTER the renderer exists - bindButtons() runs earlier in init(), when
        // `renderer` is still null, which made the theme control hide itself.
        bindHudButtons();
        loadSelectedCharacter();
        applyViewportCols();
        window.addEventListener('resize', () => {
            applyViewportCols();
        });
        // Rotating a phone fires resize BEFORE the new layout is applied, so
        // the canvas box read there is the old one. Re-measure on the next
        // frame, and again on orientationchange, which some browsers fire
        // without a resize at all.
        const relayout = () => requestAnimationFrame(() => applyViewportCols());
        window.addEventListener('orientationchange', relayout);
        window.addEventListener('resize', relayout);

        // Auto-pause when the tab is hidden (phone call, app switch, tab
        // change). The sim clamps dt so entities don't teleport on return,
        // but without this the game keeps running in the background and the
        // player comes back to a dead frog. Does NOT auto-resume — the player
        // taps to continue, so they can re-orient first.
        document.addEventListener('visibilitychange', () => {
            if (document.hidden && Sim.isRunning() && !Sim.isPaused()) {
                Sim.pause();
                stopMusic();
            }
        });

        // Readiness means the renderer is up and the campaign screen is
        // reachable, not that 1200ms elapsed. The timer stays as a ceiling for
        // slow optional assets, but readiness no longer depends on it.
        ready();
    }

    function ready() {
        const loading = document.getElementById('loading-screen');
        if (loading && !loading.classList.contains('hidden')) {
            loading.classList.add('hidden');
            document.getElementById('campaign-select').classList.remove('hidden');
        }
    }

    // Required-load failure gets an actionable state instead of an empty screen.
    function showFatal(msg) {
        const loading = document.getElementById('loading-screen');
        if (!loading) return;
        loading.classList.remove('hidden');
        loading.innerHTML =
            '<div style="text-align:center;padding:24px;font-family:Orbitron,sans-serif;color:#fff">'
            + '<p style="font-size:1.1rem;margin-bottom:10px">' + msg + '</p>'
            + '<p style="opacity:.7;font-size:.85rem">Try reloading the page.</p>'
            + '</div>';
    }

    // Portrait drops to 9 columns so the board stays readable; landscape gets
    // the full 15. Only takes effect between runs (Sim.setCols() is a no-op
    // while a run is in progress) - entity x positions are in tile units and
    // would be invalid if the column count moved mid-run.
    // The renderer must be sized from the CANVAS, not the window: in portrait
    // the canvas is a flex child sitting above the control dock, so it is
    // shorter than the window. Sizing to the window stretched the board down
    // behind the dock and put the camera's idea of the frame out of step with
    // what the player could see.
    function canvasSize() {
        const c = document.getElementById('game-canvas');
        const r = c && c.getBoundingClientRect();
        // Before the game screen is shown the canvas has no box; fall back to
        // the window so the first resize is still sane.
        if (!r || r.width < 2 || r.height < 2) {
            return { w: window.innerWidth, h: window.innerHeight };
        }
        return { w: Math.round(r.width), h: Math.round(r.height) };
    }

    function applyViewportCols() {
        const w = window.innerWidth, h = window.innerHeight;
        // 1.5x the original widths (was 9 / 15). Both odd so the goal gate has
        // a true centre column. Orientation is judged on the WINDOW - that is
        // what "phone held sideways" means - while the render size comes from
        // the canvas.
        Sim.setCols(h > w ? 13 : 23);
        const c = canvasSize();
        renderer.resize(c.w, c.h);
    }

    function loadAudio() {
        try {
            // Original chiptune MP3 is the song (reverted from the synth bed).
            // The synth bed in audio.js stays as the fallback - it only fires
            // when sounds.music is null, which it no longer is. playbackRate
            // 1.0 = the track's native tempo. NOTE: the synth-bed tempo ramp
            // (speed-up-near-portal) does NOT apply to the MP3 - it plays at a
            // fixed rate, which is the original behaviour. Game-over sting
            // stays as mp3.
            sounds.music = new Audio('assets/audio/tatamusic-chiptune-video-game-games-music-552833.mp3');
            sounds.music.loop = true;
            sounds.music.playbackRate = 1.0;
            sounds.music.volume = 0.10;  // quiet bed under SFX
            sounds.gameover = new Audio('assets/audio/ribhavagrawal-sweet-game-over-sound-effect-230470.mp3');
        } catch (e) {}
    }

    // Named game events play their real sample when one exists; the synth
    // (GameAudio) is the fallback for the remaining events.
    //
    // 'collect' is deliberately NOT in this list. It was pointed at
    // make_more_sound-...-win-level-...mp3 - a 5.04s multi-note WIN JINGLE -
    // and every spark restarted it from the top, so a run of pickups sounded
    // like a stutter of beeps. Pickups now use the synth's single blip; the
    // jingle stays where it belongs, on 'success' (finishing a run).
    // 'success' and 'hit' came OFF the samples: a 5s win jingle on every
    // portal touch and a 4.3s lose jingle on every death were the "annoying"
    // sounds - those events now use the short synth voices (bell chime,
    // thud-squish). 'gameover' keeps its 2s sting; it plays once per run.
    const SFX_SAMPLES = ['gameover'];
    const SFX_MAP = { hop: 'hop', hit: 'splat', success: 'goal', bug: 'bug',
                      drown: 'drown', collect: 'collect' };

    function playSound(name, arg) {
        if (isMuted) return;
        if (SFX_SAMPLES.indexOf(name) !== -1 && sounds[name]) {
            try {
                sounds[name].currentTime = 0;
                sounds[name].play().catch(() => {});
            } catch (e) {}
            return;
        }
        const mapped = SFX_MAP[name];
        if (mapped && window.GameAudio) window.GameAudio.play(mapped, arg);
    }

    function startMusic() {
        if (isMuted) return;
        if (sounds.music) {
            try { sounds.music.play().catch(() => {}); } catch (e) {}
            return;
        }
        // No music file on this build: procedural adaptive bed instead.
        if (window.GameAudio) window.GameAudio.start();
    }

    function stopMusic() {
        if (sounds.music) { try { sounds.music.pause(); } catch (e) {} }
        if (window.GameAudio) window.GameAudio.stop();
    }

    // The sound control is an SVG that animates between states, so the UI is
    // driven by a class - not by swapping the button's text. Writing textContent
    // here would delete the icon markup and leave an empty circle.
    function paintMuteUi() {
        const btn = document.getElementById('btn-mute');
        if (!btn) return;
        btn.classList.toggle('is-muted', isMuted);
        btn.setAttribute('aria-pressed', String(isMuted));
        btn.setAttribute('aria-label', isMuted ? 'Sound off' : 'Sound on');
        btn.title = isMuted ? 'Sound off' : 'Sound on';
        btn.dataset.label = isMuted ? 'MUTED' : 'SOUND';
    }

    function toggleMute() {
        isMuted = !isMuted;
        paintMuteUi();
        if (window.GameAudio) window.GameAudio.setMuted(isMuted);
        if (isMuted) stopMusic();
        else if (Sim.isRunning()) startMusic();
    }

    function loadSelectedCharacter() {
        try {
            selectedCharacter = localStorage.getItem('burnquest_character') || null;
        } catch (e) { selectedCharacter = null; }
        if (renderer && renderer.setCharacter) renderer.setCharacter(selectedCharacter);
        // If the saved character differs from the theme default, the model
        // loaded during init() is wrong — rebuild with the saved selection.
        if (renderer && renderer.rebuildCharacter && selectedCharacter) {
            renderer.rebuildCharacter();
        }
    }

    function buildCharGrid() {
        const grid = document.getElementById('char-dropdown');
        if (!grid) return;
        grid.innerHTML = '';
        // Highlight the ACTIVE character — the selected one, or the theme's
        // default when nothing is picked (diorama theme defaults to 'diorama').
        const themeDefault = (renderer && renderer.getTheme && renderer.getTheme() === 'diorama')
            ? 'diorama' : 'funkyverse';
        const currentId = selectedCharacter || themeDefault;
        CHARACTERS.forEach(ch => {
            const btn = document.createElement('button');
            btn.className = 'char-portrait' + (ch.id === currentId ? ' selected' : '');
            const img = document.createElement('img');
            img.src = ch.img;
            img.alt = ch.name;
            img.onerror = () => { img.style.display = 'none'; };
            btn.appendChild(img);
            const label = document.createElement('div');
            label.className = 'char-label';
            label.textContent = ch.name;
            btn.appendChild(label);
            btn.onclick = () => {
                selectedCharacter = ch.id;
                try {
                    localStorage.setItem('burnquest_character', selectedCharacter);
                } catch (e) {}
                if (renderer && renderer.setCharacter) renderer.setCharacter(selectedCharacter);
                if (renderer && renderer.rebuildCharacter) renderer.rebuildCharacter();
                buildCharGrid();
                grid.classList.add('hidden');
            };
            grid.appendChild(btn);
        });
    }

    function buildCampaignGrid() {
        const grid = document.getElementById('campaign-grid');
        if (!grid) return;
        grid.innerHTML = '';
        Sim.getCampaigns().forEach(c => {
            const btn = document.createElement('button');
            btn.className = 'campaign-btn';
            // Real token art when we have it, the emoji as the fallback. Built
            // with createElement + addEventListener (not an inline onerror
            // string), so a quote or '<' in any future data source cannot
            // break out of the attribute into markup. c.name is appended as a
            // text node, not interpolated. onerror swaps back to the emoji so a
            // missing file degrades to what shipped before instead of a hole.
            if (c.coin) {
                const coin = document.createElement('span');
                coin.className = 'coin';
                const img = document.createElement('img');
                img.src = c.coin;
                img.alt = '';
                img.loading = 'lazy';
                img.addEventListener('error', () => {
                    coin.textContent = c.icon;
                    coin.classList.add('coin-fallback');
                });
                coin.appendChild(img);
                btn.appendChild(coin);
            } else {
                const icon = document.createElement('span');
                icon.className = 'icon';
                icon.textContent = c.icon;
                btn.appendChild(icon);
            }
            btn.appendChild(document.createTextNode(c.name));
            btn.style.borderColor = c.color + '66';
            btn.onclick = () => selectCampaign(c);
            grid.appendChild(btn);
        });
    }

    function selectCampaign(c) {
        Sim.selectCampaign(c.id);
        document.getElementById('campaign-select').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        updateDashboard();
    }

    function updateDashboard() {
        const campaign = Sim.getCurrentCampaign();
        if (!campaign) return;
        const data = Sim.getCampaignData(campaign.id);
        const maxed = data.level > Sim.LEVEL_GOALS.length;
        const goal = maxed ? data.points : Sim.LEVEL_GOALS[data.level - 1];
        // One owner for the progress maths. The dashboard used to compute its
        // own percentage against the raw cumulative total, so every level after
        // the first opened already near 100%.
        const pct = Sim.levelPct(data);

        // Dashboard header shows the same coin as the picker.
        const dashIcon = document.getElementById('dash-icon');
        if (campaign.coin) {
            dashIcon.innerHTML = '';
            const img = document.createElement('img');
            img.src = campaign.coin;
            img.alt = '';
            img.onerror = () => { dashIcon.textContent = campaign.icon; };
            dashIcon.appendChild(img);
        } else {
            dashIcon.textContent = campaign.icon;
        }
        document.getElementById('dash-name').textContent = campaign.name;
        document.getElementById('dash-level').textContent = data.level;
        document.getElementById('dash-current').textContent = data.points.toLocaleString();
        document.getElementById('dash-goal').textContent = goal.toLocaleString();
        document.getElementById('dash-burned').textContent = data.points.toLocaleString();
        document.getElementById('dash-progress').style.width = pct + '%';

        // A paused run is still a run: offer to go back into it rather than
        // silently replacing it when PLAY RUN is next pressed.
        const play = document.getElementById('btn-play-run');
        const abandon = document.getElementById('btn-abandon-run');
        const paused = Sim.isPaused();
        if (play) play.textContent = paused ? 'RESUME RUN' : 'PLAY RUN';
        if (abandon) abandon.hidden = !paused;
    }

    // HUD buttons live in index.html now, so they exist as soon as the game
    // screen does. They used to be created inside startRun(), which meant the
    // theme toggle could not appear until after the first PLAY RUN.
    function bindHudButtons() {
        const mute = document.getElementById('btn-mute');
        if (mute) mute.onclick = toggleMute;
        paintMuteUi();

        const theme = document.getElementById('btn-theme');
        if (!theme) return;
        // Only the 3D renderer has themes; hide the control on the 2D build.
        if (!renderer || !renderer.setTheme) { theme.hidden = true; return; }
        const pod = document.getElementById('hud-pod');
        const paint = () => {
            const t = renderer.getTheme();
            // The pod carries the theme so CSS can flip the half-disc icon and
            // retint the palette dot. Same reason as the mute button: the icon
            // is markup, so state goes on an attribute, never on textContent.
            if (pod) pod.dataset.theme = t;
            theme.setAttribute('aria-label', 'Theme: ' + t);
            theme.title = 'Theme: ' + t + ' (click to switch)';
            theme.dataset.label = t.toUpperCase();
        };
        theme.onclick = () => {
            const names = renderer.themeNames();
            renderer.setTheme(names[(names.indexOf(renderer.getTheme()) + 1) % names.length]);
            paint();
        };
        paint();
    }

    function bindButtons() {
        document.getElementById('btn-howto').onclick = () => document.getElementById('howto-modal').classList.remove('hidden');
        document.getElementById('btn-close-howto').onclick = () => document.getElementById('howto-modal').classList.add('hidden');
        document.getElementById('btn-back-arcade').onclick = () => window.location.href = '../../arcade.html';
        const charBtn = document.getElementById('btn-char-select');
        if (charBtn) charBtn.onclick = (e) => {
            e.stopPropagation();
            const dd = document.getElementById('char-dropdown');
            if (!dd) return;
            if (dd.classList.contains('hidden')) {
                buildCharGrid();
                dd.classList.remove('hidden');
            } else {
                dd.classList.add('hidden');
            }
        };
        // Click outside the dropdown closes it
        document.addEventListener('click', (e) => {
            const dd = document.getElementById('char-dropdown');
            if (!dd || dd.classList.contains('hidden')) return;
            if (!dd.contains(e.target) && e.target.id !== 'btn-char-select') {
                dd.classList.add('hidden');
            }
        });
        document.getElementById('btn-change-campaign').onclick = () => {
            document.getElementById('dashboard').classList.add('hidden');
            document.getElementById('campaign-select').classList.remove('hidden');
        };
        document.getElementById('btn-play-run').onclick = () => {
            // Resume the paused run if there is one; only start fresh otherwise.
            if (Sim.isPaused()) { resumeRun(); return; }
            startRun();
        };
        const abandonBtn = document.getElementById('btn-abandon-run');
        if (abandonBtn) abandonBtn.onclick = () => {
            Sim.abandonRun();
            updateDashboard();
        };
        document.getElementById('btn-pause-game').onclick = () => {
            if (!Sim.pause()) return;
            stopMusic();
            document.getElementById('game-screen').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            updateDashboard();
        };
        document.getElementById('btn-play-again').onclick = () => {
            document.getElementById('run-complete').classList.add('hidden');
            startRun();
        };
        document.getElementById('btn-back-dash').onclick = () => {
            document.getElementById('run-complete').classList.add('hidden');
            document.getElementById('game-screen').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            updateDashboard();
        };
        document.getElementById('btn-continue-campaign').onclick = () => {
            document.getElementById('level-complete').classList.add('hidden');
            document.getElementById('game-screen').classList.add('hidden');
            document.getElementById('dashboard').classList.remove('hidden');
            updateDashboard();
        };

        // DIAGONAL HOPS. Holding up + right sends the frog forward AND across in
        // one hop, which is how the original played and is genuinely useful for
        // threading traffic. Held keys are tracked so the pressed key can be
        // combined with whatever is already down, rather than each key firing
        // its own separate hop.
        const held = new Set();
        const tapped = new Set();
        keyHeld = held;
        keyTapped = tapped;
        const AXES = {
            ArrowUp: [0, -1], KeyW: [0, -1],
            ArrowDown: [0, 1], KeyS: [0, 1],
            ArrowLeft: [-1, 0], KeyA: [-1, 0],
            ArrowRight: [1, 0], KeyD: [1, 0]
        };

        // Input is POLLED from the loop, not fired on keydown. Moving on the
        // event cannot express a diagonal once hops are rate-gated: press right
        // then up 40ms later and the second press is simply rejected by the
        // gate. Polling lets both keys be read together as ONE diagonal hop.
        window.addEventListener('keydown', e => {
            const axis = AXES[e.code];
            if (!axis) return;
            e.preventDefault();               // stop the page scrolling
            held.add(e.code);
            if (!e.repeat) tapped.add(e.code);   // OS key-repeat is not a new hop
        });
        window.addEventListener('keyup', e => { held.delete(e.code); });
        window.addEventListener('blur', () => { held.clear(); tapped.clear(); });

        bindSwipe();
        bindSwipeDirs();
    }

    // Two mobile movement modes (touch devices only), toggled by #btn-move-mode.
    //   Mode A (default): diamond D-pad, bottom-right, cardinal tips.
    //   Mode B: joystick (bottom-left) + JUMP (bottom-right). Point the stick at
    //   a direction, then JUMP commits one hop that way. The stick is a single
    //   PlayStation-style toggle - no separate up/down or left/right sticks.
    // MOBILE INPUT IS A SWIPE, and only a swipe.
    //
    // There used to be a D-pad, a joystick, a control dock and a row/overlay
    // toggle - four mechanisms all solving one problem: the buttons covered the
    // character you were steering. Gabriel's call, and the right one - a swipe
    // has no buttons, so the problem cannot occur. Everything those buttons
    // needed went with them: the dock and its CSS, the layout toggle, the mode
    // toggle, and the renderer's controls-overlay allowance.
    //
    // A drag hops one square in the dominant direction. Nothing else moves the
    // frog on touch - a tap deliberately does nothing. Quartered on the
    // diagonals like a 4-way stick, so the player only has to be roughly right.
    function bindSwipe() {
        const canvas = document.getElementById('game-canvas');
        if (!canvas) return;
        const MIN_SWIPE = 26;      // px before a drag counts as a direction
        let sx = 0, sy = 0, active = false;

        canvas.addEventListener('pointerdown', ev => {
            if (!Sim.isRunning()) return;
            active = true; sx = ev.clientX; sy = ev.clientY;
        });

        canvas.addEventListener('pointerup', ev => {
            if (!active) return;
            active = false;
            if (!Sim.isRunning()) return;
            const dx = ev.clientX - sx, dy = ev.clientY - sy;
            const dist = Math.hypot(dx, dy);
            // SWIPE ONLY. A tap used to hop forward, the endless-hopper
            // convention - Gabriel's call to drop it: on a board where a single
            // wrong hop is fatal, every incidental touch became a move.
            if (dist < MIN_SWIPE) return;               // too small to mean anything
            // Only a REAL gesture retires the hint. Hanging it off handleMove
            // instead meant anything that moved the frog - including a keyboard
            // press - marked it seen forever, before a touch player had read it.
            hideSwipeHint();
            // Snap the swipe angle to the nearest of 4 or 8 compass points.
            // Angle-snapping rather than axis comparison because it gives both
            // modes from one expression: with 4 sectors the boundaries land on
            // the diagonals and cos/sin come out as exact 0/+-1; with 8 they
            // land every 45 degrees and a diagonal rounds to (+-1, +-1).
            const sectors = swipe8() ? 8 : 4;
            const step = 2 * Math.PI / sectors;
            const k = Math.round(Math.atan2(dy, dx) / step);
            handleMove(Math.round(Math.cos(k * step)), Math.round(Math.sin(k * step)));
        });

        canvas.addEventListener('pointercancel', () => { active = false; });
    }

    // FOUR-WAY or EIGHT-WAY swipe, Gabriel's call. The sim has always accepted
    // diagonals - the keyboard has had them all along - so this only decides how
    // finely a swipe angle is quantised. Remembered per browser.
    const SWIPE8_KEY = 'burnquest_swipe_8way';

    function swipe8() {
        try { return localStorage.getItem(SWIPE8_KEY) === '1'; } catch (e) { return false; }
    }

    function paintSwipeDirs() {
        const btn = document.getElementById('btn-swipe-dirs');
        if (!btn) return;
        const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        btn.hidden = !touch;                 // a keyboard already has diagonals
        const on = swipe8();
        btn.setAttribute('aria-pressed', String(on));
        btn.title = on ? '8-way swipe (tap for 4-way)' : '4-way swipe (tap for 8-way)';
        btn.setAttribute('aria-label', on ? 'Swipe: 8 directions' : 'Swipe: 4 directions');
    }

    function bindSwipeDirs() {
        const btn = document.getElementById('btn-swipe-dirs');
        if (!btn) return;
        btn.onclick = () => {
            try { localStorage.setItem(SWIPE8_KEY, swipe8() ? '0' : '1'); } catch (e) {}
            paintSwipeDirs();
        };
        paintSwipeDirs();
        window.addEventListener('orientationchange', paintSwipeDirs);
    }

    // With no visible controls a first-time player has nothing telling them what
    // to do, so say it once on a touch device and never again.
    const SWIPE_HINT_KEY = 'burnquest_swipe_hint_seen';
    let swipeHintTimer = null;

    function showSwipeHint() {
        const el = document.getElementById('swipe-hint');
        if (!el) return;
        const touch = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
        let seen = false;
        try { seen = localStorage.getItem(SWIPE_HINT_KEY) === '1'; } catch (e) {}
        if (!touch || seen) return;
        el.classList.remove('hidden');
        if (swipeHintTimer) clearTimeout(swipeHintTimer);
        swipeHintTimer = setTimeout(hideSwipeHint, 4500);
    }

    function hideSwipeHint() {
        const el = document.getElementById('swipe-hint');
        if (!el || el.classList.contains('hidden')) return;
        el.classList.add('hidden');
        try { localStorage.setItem(SWIPE_HINT_KEY, '1'); } catch (e) {}
    }

    const CELEBRATE_MS = 2600;
    // Popups hold on screen long enough to actually be read: the banner's
    // stage-in animation and every dashboard swap run off this one number.
    const BANNER_MS = 4000;

    function celebrate(done) {
        if (!renderer || !renderer.startCelebration) { done(); return; }
        renderer.startCelebration();
        // Drive music intensity from inside the celebration loop too - this
        // spin loop calls renderer.draw directly (not loop()), so without
        // this the bed would hold its last tempo for all of CELEBRATE_MS.
        const until = performance.now() + CELEBRATE_MS;
        (function spin() {
            if (performance.now() >= until) {
                renderer.stopCelebration();
                done();
                return;
            }
            updateMusicIntensity(Sim.getState());
            renderer.draw(Sim.getState());
            requestAnimationFrame(spin);
        })();
    }

    function handleMove(dx, dy) {
        // The hint has done its job the moment the player actually moves.
        // Dismissing on pointerdown instead let the PLAY RUN click itself
        // close it, because the game screen swaps in under the cursor.
        hideSwipeHint();
        const before = Sim.getState().frog;
        const events = Sim.moveFrog(dx, dy);
        const after = Sim.getState().frog;
        // Only chirp when the hop actually happened - moveFrog is rate-gated,
        // so a blocked press must stay silent or it sounds broken.
        if (after.x !== before.x || after.y !== before.y) playSound('hop');
        events.forEach(handleEvent);
    }

    // Stage announcement. Timed off wall-clock deliberately: it is a piece of
    // presentation, not gameplay, and the run keeps running underneath it.
    let stageBannerTimer = null;
    function showStageBanner(evt) {
        const el = document.getElementById('stage-banner');
        if (!el) return;
        const name = el.querySelector('.stage-banner-name');
        const sub = el.querySelector('.stage-banner-sub');
        if (name) name.textContent = evt.name || ('STAGE ' + evt.stage);
        if (sub) {
            const st = Sim.getState();
            sub.textContent = evt.sub || (`Score ${st.score} carried \u00b7 ` +
                              `${st.lives} ${st.lives === 1 ? 'life' : 'lives'} left`);
        }
        el.classList.remove('hidden');
        el.classList.remove('show');
        void el.offsetWidth;                 // restart the animation
        el.classList.add('show');
        if (stageBannerTimer) clearTimeout(stageBannerTimer);
        stageBannerTimer = setTimeout(() => {
            el.classList.remove('show');
            el.classList.add('hidden');
        }, BANNER_MS);
    }

    // ?stage=N starts a practice run on that board, to try stages 2-5 without
    // playing up to them. The sim banks nothing for a practice run.
    function practiceStart() {
        try {
            const n = parseInt(new URLSearchParams(location.search).get('stage'), 10);
            return n > 1 ? { stage: n } : undefined;
        } catch (e) { return undefined; }
    }

    // Which half of the banking rule just applied: points from levels already
    // passed are safe, points from the level being played are lost with it.
    function burnSplit(evt) {
        if (evt.practice) return 'Practice run \u2022 nothing was banked';
        const kept = evt.bankedThisRun || 0;
        const lost = evt.forfeited || 0;
        if (!kept && !lost) return 'No points earned this run';
        if (!lost) return kept + ' banked to your burn estimate \u2022 nothing lost';
        if (!kept) return lost + ' lost \u2014 the level was never passed';
        return kept + ' banked \u2022 ' + lost + ' lost with the level you were on';
    }

    // Stage clock (stages 2+, Sim.STAGES[].timeLimit), beside STAGE in the HUD.
    // Written only when the shown second changes; red in the last 20 seconds.
    let timerShown = null;
    function updateTimerHud(state) {
        const box = document.getElementById('time-box');
        if (!box) return;
        if (state.timeLeft == null) {
            if (!box.hidden) box.hidden = true;
            timerShown = null;
            return;
        }
        const s = Math.ceil(state.timeLeft / 1000);
        if (s === timerShown) return;
        timerShown = s;
        box.hidden = false;
        document.getElementById('time-left').textContent =
            Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
        box.classList.toggle('low', s <= 20);
    }

    // Sim never touches audio/DOM directly; it emits events and the
    // orchestrator reacts to them here.
    function handleEvent(evt) {
        if (!evt) return;
        switch (evt.type) {
            case 'collect':
                document.getElementById('score').textContent = Sim.getState().score;
                playSound('collect', evt.combo);
                break;
            case 'boost':
                document.getElementById('score').textContent = Sim.getState().score;
                playSound('bug');
                break;
            case 'shades':
                document.getElementById('score').textContent = Sim.getState().score;
                playSound('collect', 5);
                break;
            case 'life': {
                const s = Sim.getState();
                document.getElementById('lives').textContent = '🐸'.repeat(Math.max(0, s.lives));
                document.getElementById('score').textContent = s.score;
                playSound('collect', 5);
                break;
            }
            case 'hit': {
                document.getElementById('lives').textContent = '🐸'.repeat(Math.max(0, evt.livesLeft));
                // The sim tells us WHY. This used to re-derive the cause from
                // the frog's current position, which the respawn had already
                // moved back to the start row, so a drowning could play the
                // splat. Effects consume the outcome; they do not decide it.
                playSound(evt.cause === 'water' ? 'drown' : 'hit');
                break;
            }
            // A stage was cleared and the next board is already built. The run
            // does not end - score and lives carry - but PASSING the level is
            // exactly what pays into the burn (Gabriel 2026-09-11), so the
            // banner says what was banked the moment it stops being at risk.
            case 'stage': {
                const n = document.getElementById('stage-num');
                if (n) n.textContent = evt.stage;
                playSound('success');
                // The shrink-into-the-portal only ever ran on 'finish', i.e.
                // after stage 5, which almost no run reaches - so nobody saw it.
                // The sim built the next board in the same tick the frog
                // touched the gate: hold the run while he is drawn in, then
                // hand over to the stage banner and the new board.
                Sim.pause();
                celebrate(() => {
                    if (keyHeld && keyHeld.clear) keyHeld.clear();
                    if (keyTapped && keyTapped.clear) keyTapped.clear();
                    // Only resume a run the celebration paused: if the player
                    // hit pause meanwhile, the dashboard is up and stays up.
                    if (!document.getElementById('game-screen').classList.contains('hidden')) {
                        Sim.resume();
                        requestAnimationFrame(loop);
                    }
                    const cleared = Sim.getState();
                    showStageBanner(evt.banked > 0
                        ? Object.assign({}, evt, {
                            sub: '+' + evt.banked + ' banked to your burn estimate \u00b7 ' +
                                 cleared.lives + (cleared.lives === 1 ? ' life' : ' lives') + ' left' })
                        : evt);
                });
                break;
            }
            case 'gameover':
                stopMusic();
                playSound('gameover');
                if (evt.cause === 'time') {
                    // Say WHY before leaving: dropping to the dashboard with no
                    // message would read as a crash, not as the clock.
                    showStageBanner({ name: "TIME'S UP", sub: burnSplit(evt) });
                    setTimeout(() => {
                        document.getElementById('game-screen').classList.add('hidden');
                        document.getElementById('dashboard').classList.remove('hidden');
                        updateDashboard();
                    }, BANNER_MS);
                    break;
                }
                // Same courtesy as the clock branch: say what happened to the
                // points before the dashboard replaces the screen.
                showStageBanner({ name: 'GAME OVER', sub: burnSplit(evt) });
                setTimeout(() => {
                    document.getElementById('game-screen').classList.add('hidden');
                    document.getElementById('dashboard').classList.remove('hidden');
                    updateDashboard();
                }, BANNER_MS);
                break;
            case 'finish':
                playSound('success');
                document.getElementById('run-points').textContent = evt.points;
                document.getElementById('run-message').textContent =
                    evt.maxed
                        ? `Points added to ${evt.campaignName} • all burn levels complete`
                        : evt.levelsGained > 0
                            ? `Points added to ${evt.campaignName} • BURN LEVEL ${evt.level} reached!`
                            : `Points added to ${evt.campaignName} • Campaign is now ${evt.pct}% to burn level ${evt.level + 1}`;
                if (evt.practice) {
                    document.getElementById('run-message').textContent =
                        'Practice run (?stage=) \u2022 points are not banked';
                }
                // Let the frog dance at the portal before the modal covers it.
                // The sim has already stopped, so the celebration needs its own
                // draw loop to keep the scene alive.
                celebrate(() => {
                    stopMusic();
                    document.getElementById('run-complete').classList.remove('hidden');
                });
                break;
        }
    }

    // Put the player back into the run they paused. Deliberately does NOT touch
    // setCols/startRun - re-running those would rebuild the board and lose the
    // position, which is what the old pause button effectively did.
    function resumeRun() {
        if (!Sim.resume()) return;
        document.getElementById('dashboard').classList.add('hidden');
        document.getElementById('game-screen').classList.remove('hidden');
        applyViewportCols();      // same reason as startRun: measure once visible
        // Clear anything held from before the pause so the frog does not take a
        // stale step the moment play resumes. CLEAR the sets - do not reassign
        // them. keyHeld is the live Set the keydown listener writes into, and
        // setting it to null made pollInput()'s `if (!keyHeld) return` fire
        // forever: the game resumed, drew and ran, but no input ever moved the
        // frog again.
        if (keyHeld && keyHeld.clear) keyHeld.clear();
        if (keyTapped && keyTapped.clear) keyTapped.clear();
        startMusic();
        requestAnimationFrame(loop);
    }

    // Ask for real fullscreen on a phone, so the tab strip and URL bar are not
    // eating the top of a landscape game. MUST be called from inside a user
    // gesture - PLAY RUN's click is one - or browsers reject it silently.
    //
    // Touch devices only: fullscreening someone's desktop browser because they
    // pressed play would be obnoxious.
    //
    // Support, so nobody re-tests this: Android Chrome yes, iPad yes, iPhone
    // Safari NO - it has no element fullscreen at all. The
    // apple-mobile-web-app-capable meta in index.html covers the iPhone case,
    // but only for a home-screen install. Every call is best-effort; a refusal
    // must never stop the run from starting.
    function goFullscreenIfPhone() {
        try {
            const coarse = window.matchMedia && window.matchMedia('(pointer: coarse)').matches;
            // A touchscreen laptop reports a coarse pointer too - fullscreening
            // a desktop browser because they pressed play is still obnoxious.
            // "Phone" needs a small screen as well (phones <640px short side).
            const s = window.screen || { width: 0, height: 0 };
            if (!coarse || Math.min(s.width, s.height) >= 640) return;
            if (document.fullscreenElement || document.webkitFullscreenElement) return;
            const el = document.documentElement;
            const req = el.requestFullscreen || el.webkitRequestFullscreen;
            if (!req) return;
            const p = req.call(el, { navigationUI: 'hide' });
            if (p && p.catch) p.catch(() => {});
            // Landscape lock is a bonus and throws on most browsers; never let
            // it surface.
            if (screen.orientation && screen.orientation.lock) {
                try { const q = screen.orientation.lock('landscape');
                      if (q && q.catch) q.catch(() => {}); } catch (e) {}
            }
        } catch (e) { /* fullscreen is a nicety, never a requirement */ }
    }

    function startRun() {
        goFullscreenIfPhone();
        Sim.abandonRun();          // a fresh run replaces any paused one
        Sim.pause();               // ensure setCols() below is allowed to act
        applyViewportCols();
        Sim.startRun(practiceStart());

        document.getElementById('dashboard').classList.add('hidden');
        document.getElementById('game-screen').classList.remove('hidden');
        // The canvas has no box until the game screen is visible, so the sizing
        // done at init fell back to the window. Re-measure now that the flex
        // layout (and the portrait control dock) actually exists, or the
        // renderer keeps drawing at window height and the board runs on down
        // behind the dock.
        applyViewportCols();
        showSwipeHint();
        document.getElementById('score').textContent = '0';
        document.getElementById('lives').textContent = '🐸🐸🐸';
        // The HUD's STAGE readout is the board, not the burn level; it is
        // driven by the stage event and by startRun, not from campaign data.
        const stageNum = document.getElementById('stage-num');
        if (stageNum) stageNum.textContent = Sim.getStage();
        timerShown = null;                   // stage 1 is untimed: hide the clock
        updateTimerHud(Sim.getState());
        // A banner left over from a previous run must not greet the new one.
        const banner = document.getElementById('stage-banner');
        if (banner) { banner.classList.remove('show'); banner.classList.add('hidden'); }


        startMusic();
        requestAnimationFrame(loop);
    }

    // Direction keys currently down, plus any tapped since the last poll so a
    // very short press is never swallowed between frames.
    let keyHeld = null, keyTapped = null;
    const KEY_AXES = {
        ArrowUp: [0, -1], KeyW: [0, -1], ArrowDown: [0, 1], KeyS: [0, 1],
        ArrowLeft: [-1, 0], KeyA: [-1, 0], ArrowRight: [1, 0], KeyD: [1, 0]
    };

    // Two keys are never pressed on the same millisecond. Firing the first one
    // instantly consumes the hop and the second lands inside the rate gate and
    // is dropped - which is exactly why the diagonal kept vanishing. So a tap
    // waits this long for a partner before committing. Short enough not to feel
    // laggy, long enough to catch a deliberate two-key press.
    const DIAG_WINDOW_MS = 70;
    let pendingSince = 0;

    function pollInput() {
        if (!keyHeld) return;
        // ONE hop per press: holding a key does nothing further. Polling off the
        // held set alone brought the machine-gun movement straight back.
        if (keyTapped.size === 0) { pendingSince = 0; return; }

        let dx = 0, dy = 0;
        const seen = new Set();
        [keyTapped, keyHeld].forEach(set => set.forEach(code => {
            if (seen.has(code)) return;
            seen.add(code);
            const a = KEY_AXES[code];
            if (a) { dx += a[0]; dy += a[1]; }
        }));
        dx = Math.sign(dx); dy = Math.sign(dy);   // opposite keys cancel
        if (!dx && !dy) { keyTapped.clear(); pendingSince = 0; return; }

        const now = performance.now();
        if (!pendingSince) pendingSince = now;
        // commit at once if it is already a diagonal, else give a partner time
        if (!(dx && dy) && now - pendingSince < DIAG_WINDOW_MS) return;

        keyTapped.clear();
        pendingSince = 0;
        handleMove(dx, dy);                        // Sim still gates the rate
    }

    let lastTime = 0;

    // The bed's tempo and brightness follow how far up the board you are, and
    // lift again while a speed bug is active.
    function updateMusicIntensity(state) {
        if (!window.GameAudio) return;
        const rows = state.rows || 37;
        const progress = 1 - (state.frog.y / (rows - 1));
        window.GameAudio.setIntensity(progress, state.boost > 0);
    }

    function loop(now) {
        if (!Sim.isRunning()) { lastTime = 0; return; }

        // Delta time in 60fps-frame units, so the original tuning numbers
        // still mean what they meant regardless of display refresh rate.
        if (!lastTime) lastTime = now;
        const dt = (now - lastTime) / 16.667;
        lastTime = now;

        pollInput();

        const events = Sim.update(dt);
        events.forEach(handleEvent);

        const state = Sim.getState();
        updateTimerHud(state);
        updateMusicIntensity(state);
        renderer.draw(state);
        requestAnimationFrame(loop);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
