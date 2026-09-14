/**
 * Funky's BurnQuest - procedural audio.
 *
 * No sample files and no external service: everything here is synthesised
 * with the Web Audio API. The music is a composed four-bar Am-F-C-G loop
 * ("Pond at Sunset") - sine sub bass, triangle pad, triangle lead - whose
 * tempo and brightness rise slightly as the frog nears the goal and lift
 * again during a speed boost. SFX are short synth voices for hop / collect /
 * bug / splat / drown / goal / gameover.
 */
(function (root) {
    'use strict';

    let ctx = null, master = null, musicGain = null, sfxGain = null;
    let started = false, muted = false;
    let step = 0, nextNoteAt = 0, timer = null;
    let intensity = 0;      // 0..1, driven by progress up the board
    let boosted = false;

    // A minor pentatonic, for SFX melodies.
    const SCALE = [0, 3, 5, 7, 10, 12, 15];
    const ROOT = 55;        // A1

    function midiToHz(m) { return 440 * Math.pow(2, (m - 69) / 12); }

    function ensure() {
        if (ctx) return ctx;
        const AC = root.AudioContext || root.webkitAudioContext;
        if (!AC) return null;
        ctx = new AC();
        master = ctx.createGain();
        master.gain.value = 0.9;
        master.connect(ctx.destination);
        musicGain = ctx.createGain(); musicGain.gain.value = 0.0; musicGain.connect(master);
        sfxGain   = ctx.createGain(); sfxGain.gain.value   = 0.9; sfxGain.connect(master);
        return ctx;
    }

    function env(node, t, a, d, peak) {
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + a);
        g.gain.exponentialRampToValueAtTime(0.0001, t + a + d);
        node.connect(g);
        return g;
    }

    function tone(freq, type, t, a, d, peak, dest, detune) {
        const o = ctx.createOscillator();
        o.type = type;
        o.frequency.setValueAtTime(freq, t);
        if (detune) o.detune.setValueAtTime(detune, t);
        const g = env(o, t, a, d, peak);
        g.connect(dest || sfxGain);
        o.start(t); o.stop(t + a + d + 0.02);
        return o;
    }

    function noise(t, dur, peak, filterHz, dest) {
        const n = Math.floor(ctx.sampleRate * dur);
        const buf = ctx.createBuffer(1, n, ctx.sampleRate);
        const d = buf.getChannelData(0);
        for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
        const src = ctx.createBufferSource(); src.buffer = buf;
        const bp = ctx.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = filterHz;
        const g = ctx.createGain(); g.gain.value = peak;
        src.connect(bp); bp.connect(g); g.connect(dest || sfxGain);
        src.start(t);
    }

    // ---------------- SFX ----------------
    const SFX = {
        hop() {
            const t = ctx.currentTime;
            const o = ctx.createOscillator(); o.type = 'triangle';
            o.frequency.setValueAtTime(300, t);
            o.frequency.exponentialRampToValueAtTime(720, t + 0.09);
            const g = env(o, t, 0.006, 0.10, 0.40); g.connect(sfxGain);
            o.start(t); o.stop(t + 0.14);
        },
        // ONE blip per pickup. This was two stacked tones, and the sample it
        // used to play instead was a 5-second win-level jingle restarted on
        // every spark - which is what "too many beeps" was. Pitch still climbs
        // with the combo, so a streak reads as a rising run of single notes.
        collect(combo) {
            const t = ctx.currentTime;
            const n = Math.min(8, Math.max(1, combo || 1));
            tone(midiToHz(74 + n * 2), 'triangle', t, 0.004, 0.13, 0.55);
        },
        bug() {
            const t = ctx.currentTime;
            [0, 4, 7, 12, 16].forEach((s, i) =>
                tone(midiToHz(69 + s), 'sawtooth', t + i * 0.045, 0.004, 0.16, 0.13));
            noise(t, 0.30, 0.10, 2200);
        },
        splat() {
            const t = ctx.currentTime;
            // Wet thud + squish instead of the sawtooth squawk: a low sine
            // drop for the body of the hit, band-limited noise for the squash.
            // All timings x1.43 = ~30% slower (Gabriel 2026-09-12).
            const o = ctx.createOscillator(); o.type = 'sine';
            o.frequency.setValueAtTime(240, t);
            o.frequency.exponentialRampToValueAtTime(55, t + 0.23);
            const g = env(o, t, 0.004, 0.29, 0.34); g.connect(sfxGain);
            o.start(t); o.stop(t + 0.37);
            noise(t, 0.20, 0.30, 900);
            noise(t + 0.09, 0.14, 0.18, 500);
        },
        drown() {
            const t = ctx.currentTime;
            // Splash, then sinking bubbles: a soft noise wash plus three
            // descending sine blubs instead of one long falling whistle.
            // All timings x1.43 = ~30% slower (Gabriel 2026-09-12).
            noise(t, 0.43, 0.22, 900);
            [0, 0.20, 0.43].forEach((dt, i) => {
                const o = ctx.createOscillator(); o.type = 'sine';
                o.frequency.setValueAtTime(420 - i * 110, t + dt);
                o.frequency.exponentialRampToValueAtTime(180 - i * 40, t + dt + 0.14);
                const g = env(o, t + dt, 0.011, 0.17, 0.16 - i * 0.03);
                g.connect(sfxGain);
                o.start(t + dt); o.stop(t + dt + 0.23);
            });
        },
        goal() {
            const t = ctx.currentTime;
            // Portal arrival: a rising bell run. Each step is a sine voice
            // with a quiet octave-up partial for shimmer - that pairing is
            // what makes a synth note read as a chime - over a soft airy
            // wash. Nothing square, nothing sawtooth.
            [0, 4, 7, 12, 16, 19].forEach((s, i) => {
                const f = midiToHz(67 + s);
                tone(f, 'sine', t + i * 0.09, 0.008, 0.55, 0.16);
                tone(f * 2, 'sine', t + i * 0.09, 0.008, 0.40, 0.05);
            });
            noise(t + 0.1, 0.7, 0.035, 5200);
        },
        gameover() {
            const t = ctx.currentTime;
            // Timings x1.43 = ~30% slower (Gabriel 2026-09-12): the descent
            // lands heavier when each note gets room.
            [0, -3, -5, -12].forEach((s, i) =>
                tone(midiToHz(69 + s), 'triangle', t + i * 0.23, 0.014, 0.49, 0.20));
        }
    };

    // ---------------- composed bed: D-minor chiptune ----------------
    // Recreated from the original tatamusic track (analysed: D minor, ~130 BPM,
    // descending bass D-C-Bb-A, melody centred on A/D with a G#->A leading
    // tone). The progression is i - VII - VI - V (Dm - C - Bb - A, the A major
    // for its C# leading tone) - the same descending pull the original had.
    //   bass  - square, root of each chord, quarter notes (the pulse)
    //   arp   - triangle, 16th notes cycling the chord tones (chip texture)
    //   lead  - square, an explicit 8th-note melody (the tune, not a formula)
    // Tempo ~130 BPM, quickening slightly toward the portal and on boost.

    const BARS = [
        // bass, arp (4 notes), lead (8 notes per bar) - absolute MIDI numbers
        { bass: 50, arp: [62, 65, 69, 74], lead: [69, 0, 65, 0, 69, 0, 74, 0] },  // Dm: D A F A D F A D
        { bass: 48, arp: [60, 64, 67, 72], lead: [67, 0, 64, 0, 67, 0, 72, 0] },  // C:  G E C E G C G C
        { bass: 46, arp: [58, 62, 65, 70], lead: [65, 0, 62, 0, 65, 0, 70, 0] },  // Bb: F D Bb D F Bb F Bb
        { bass: 45, arp: [57, 61, 64, 69], lead: [64, 0, 61, 0, 56, 0, 61, 0] }   // A:  E C# A C# G# C# A C#
    ];

    function scheduler() {
        if (!ctx || muted) return;
        // 16th-note step = 0.09s -> quarter = 0.36s ~ 166 BPM. Intensity
        // shaves it toward the portal; boost takes it further.
        const beat = (boosted ? 0.072 : 0.09) - intensity * 0.015;
        while (nextNoteAt < ctx.currentTime + 0.20) {
            const t = Math.max(nextNoteAt, ctx.currentTime + 0.01);
            const bar = Math.floor(step / 16) % 4;
            const chord = BARS[bar];
            const s = step % 16;

            // Bass: square on the root, quarter notes (every 4 steps).
            if (s % 4 === 0) {
                const f = midiToHz(chord.bass);
                const o = ctx.createOscillator(); o.type = 'square';
                o.frequency.setValueAtTime(f, t);
                const g = env(o, t, 0.005, beat * 3, 0.09 + intensity * 0.03);
                g.connect(musicGain);
                o.start(t); o.stop(t + beat * 3.5);
            }

            // Arpeggio: triangle 16th notes cycling the chord tones. Quiet
            // texture under the lead.
            {
                const f = midiToHz(chord.arp[s % 4]);
                const o = ctx.createOscillator(); o.type = 'triangle';
                o.frequency.setValueAtTime(f, t);
                const lp = ctx.createBiquadFilter();
                lp.type = 'lowpass';
                lp.frequency.setValueAtTime(
                    1800 + intensity * 2800 + (boosted ? 1400 : 0), t);
                const g = env(o, t, 0.003, beat * 1.5, 0.045 + intensity * 0.02);
                o.connect(lp); lp.connect(g); g.connect(musicGain);
                o.start(t); o.stop(t + beat * 1.8);
            }

            // Lead: explicit 8th-note melody (every 2 steps), 0 = rest. The
            // tune itself - square for that chip voice, lowpassed to keep the
            // edge off. The G# (56) on the A bar is the leading tone back to A.
            {
                const note = chord.lead[s >> 1];
                if (note) {
                    const f = midiToHz(note);
                    const o = ctx.createOscillator(); o.type = 'square';
                    o.frequency.setValueAtTime(f, t);
                    const lp = ctx.createBiquadFilter();
                    lp.type = 'lowpass';
                    lp.frequency.setValueAtTime(
                        1400 + intensity * 2600 + (boosted ? 1200 : 0), t);
                    const g = env(o, t, 0.004, beat * 1.4, 0.05);
                    o.connect(lp); lp.connect(g); g.connect(musicGain);
                    o.start(t); o.stop(t + beat * 1.6);
                }
            }

            // Light hats at higher intensity, on off-beats.
            if (intensity > 0.3 && s % 2 === 1) {
                noise(t, 0.02, 0.018 + intensity * 0.012, 8000, musicGain);
            }

            nextNoteAt = t + beat;
            step = (step + 1) % 64;
        }
    }

    const api = {
        start() {
            if (!ensure()) return;
            if (ctx.state === 'suspended') ctx.resume();
            if (started) return;
            started = true;
            nextNoteAt = ctx.currentTime + 0.1;
            musicGain.gain.cancelScheduledValues(ctx.currentTime);
            musicGain.gain.setValueAtTime(0.0001, ctx.currentTime);
            // Bed level: 0.12 (was 0.35 - too loud).
            musicGain.gain.exponentialRampToValueAtTime(muted ? 0.0001 : 0.12, ctx.currentTime + 1.2);
            timer = setInterval(scheduler, 60);
        },
        stop() {
            if (!ctx || !started) return;
            started = false;
            clearInterval(timer); timer = null;
            musicGain.gain.cancelScheduledValues(ctx.currentTime);
            musicGain.gain.setTargetAtTime(0.0001, ctx.currentTime, 0.25);
        },
        /** progress 0..1 up the board, and whether a speed bug is active */
        setIntensity(progress, isBoosted) {
            intensity = Math.max(0, Math.min(1, progress || 0));
            boosted = !!isBoosted;
        },
        setMuted(m) {
            muted = !!m;
            if (!ctx) return;
            master.gain.setTargetAtTime(muted ? 0.0001 : 0.9, ctx.currentTime, 0.05);
        },
        play(name, arg) {
            if (!ensure() || muted) return;
            if (ctx.state === 'suspended') ctx.resume();
            if (SFX[name]) { try { SFX[name](arg); } catch (e) {} }
        }
    };

    root.GameAudio = api;
}(typeof window !== 'undefined' ? window : this));
