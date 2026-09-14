/* char-motion.js - procedural secondary motion for the player character.
 *
 * The Funky mesh is a single unrigged TRELLIS bake: one material, 9678 verts,
 * no skeleton and no glTF animations (verified against both funky.json files).
 * So there are no joints to drive and nothing to re-parent. What DOES work on
 * an unrigged mesh is a height-weighted vertex deform: every vertex moves as a
 * smooth function of how far up the body it sits, feet pinned, shoulders free.
 *
 * That smoothness is the point. The wheel-split experiment failed because it
 * CLASSIFIED vertices - body triangles that fell inside a wheel radius got
 * re-origined and smeared. Here there is no classification: one continuous
 * weight curve, so the worst a bad tuning value can do is look wobbly.
 *
 * The deform runs in the vertex shader via onBeforeCompile, so it costs one
 * uniform update per frame regardless of vertex count.
 */
(function (root) {
    'use strict';

    var THREE_ = root.THREE;
    if (!THREE_) return;

    // Shared driver uniforms. three.js lets several programs point at the SAME
    // uniform object, so one assignment per frame reaches every patched
    // material - including the depth material used for shadows.
    var U = {
        whip:  { value: 0 },   // lean along the facing axis (units)
        sway:  { value: 0 },   // lean across it (units)
        twist: { value: 0 },   // torso rotation about the feet (radians)
        tuck:  { value: 0 },   // legs drawn up in flight (units)
        fwd:   { value: new THREE_.Vector2(0, -1) }  // facing axis in model space
    };

    var DECL = [
        'uniform float uWhip;',
        'uniform float uSway;',
        'uniform float uTwist;',
        'uniform float uTuck;',
        'uniform vec2  uFwd;',
        'uniform float uY0;',
        'uniform float uYH;'
    ].join('\n');

    // h is 0 at the feet and 1 at the crown; squaring it keeps the legs planted
    // while the upper body carries almost all of the motion.
    var BODY = [
        'float h = clamp((transformed.y - uY0) / uYH, 0.0, 1.0);',
        'float w = h * h;',
        'float a = uTwist * w;',
        'float ca = cos(a), sa = sin(a);',
        'transformed.xz = vec2(ca * transformed.x + sa * transformed.z,',
        '                     -sa * transformed.x + ca * transformed.z);',
        'transformed.xz += uFwd * (uWhip * w);',
        'transformed.xz += vec2(-uFwd.y, uFwd.x) * (uSway * w);',
        // Raising the LOWER body is what reads as a tuck; the crown is untouched
        // so the character does not appear to shrink.
        'transformed.y += uTuck * (1.0 - h) * (1.0 - h);'
    ].join('\n');

    function patch(material, y0, yh) {
        if (!material || material.userData.__charMotion) return;
        material.userData.__charMotion = true;
        var prev = material.onBeforeCompile;
        material.onBeforeCompile = function (shader) {
            if (prev) prev.apply(this, arguments);
            shader.uniforms.uWhip  = U.whip;
            shader.uniforms.uSway  = U.sway;
            shader.uniforms.uTwist = U.twist;
            shader.uniforms.uTuck  = U.tuck;
            shader.uniforms.uFwd   = U.fwd;
            shader.uniforms.uY0    = { value: y0 };
            shader.uniforms.uYH    = { value: yh };
            shader.vertexShader = DECL + '\n' + shader.vertexShader.replace(
                '#include <begin_vertex>',
                '#include <begin_vertex>\n' + BODY
            );
            // three.js only calls this when it is actually building the program,
            // so keeping the shader is how tools/ can prove the deform reached
            // the GPU rather than just sitting in a patch string.
            material.userData.__cmShader = shader;
        };
        material.needsUpdate = true;
    }

    // Hop amplitudes, exposed so tools/char-motion-check.js reads them rather
    // than keeping its own copy that could drift from what actually ships.
    var AMP = { whip: 0.17, twist: 0.30, tuck: 0.085 };

    root.BurnQuestCharMotion = {
        AMP: AMP,

        // Attach to a loaded character model. Safe to call on a Group with any
        // number of meshes; each one is weighted by its OWN local height, which
        // is exactly right for the single-node bakes this game ships.
        attach: function (obj) {
            if (!obj) return false;
            var any = false;
            obj.traverse(function (n) {
                if (!n.isMesh || !n.geometry) return;
                n.geometry.computeBoundingBox();
                var bb = n.geometry.boundingBox;
                if (!bb) return;
                var yh = bb.max.y - bb.min.y;
                if (!(yh > 1e-4)) return;
                var mats = Array.isArray(n.material) ? n.material : [n.material];
                mats.forEach(function (m) { patch(m, bb.min.y, yh); });
                // Shadows are cast through a separate depth material, which
                // would otherwise draw the UNDEFORMED silhouette. Patching it
                // too keeps the shadow honest for free.
                var dm = new THREE_.MeshDepthMaterial({ depthPacking: THREE_.RGBADepthPacking });
                dm.userData = {};
                patch(dm, bb.min.y, yh);
                n.customDepthMaterial = dm;
                any = true;
            });
            return any;
        },

        // Model-space facing axis. The character group is rotated by
        // atan2(-dx,-dy) + faceOffset, so travel lands at -faceOffset from the
        // group's local -Z. Deriving it beats hardcoding: the two themes have
        // different offsets and one of them used to hop backwards.
        setFaceOffset: function (off) {
            var a = -(off || 0);
            U.fwd.value.set(-Math.sin(a), -Math.cos(a));
        },

        // Called once per frame from the render loop.
        //   now   - ms, for the idle cycles
        //   hopT  - 0..1 through a hop, or >=1 when resting
        //   alive - false while a death/dance effect owns the character
        update: function (now, hopT, alive) {
            this.drive(now, hopT, alive);
            // Opt-in trace for tools/char-motion-check.js. Recorded HERE, by
            // the render loop, because every sampler run from outside was
            // throttled by headless chromium and missed the 200ms hop.
            var tr = root.__cmTrace;
            if (tr && tr.length < 600) tr.push([hopT, U.whip.value, U.twist.value, U.tuck.value]);
        },

        drive: function (now, hopT, alive) {
            if (!alive) {
                U.whip.value = U.sway.value = U.twist.value = U.tuck.value = 0;
                return;
            }
            if (hopT < 1) {
                var air = Math.sin(hopT * Math.PI);
                // One full cycle across the hop: lean into the launch, recover
                // through the apex, rock back on the landing. This is the
                // anticipation/follow-through a rigged character would get from
                // its spine, and it is what makes a static bake read as alive.
                U.whip.value  = Math.sin(hopT * Math.PI * 2) * AMP.whip;
                U.twist.value = Math.sin(hopT * Math.PI * 2) * -AMP.twist;
                U.tuck.value  = air * AMP.tuck;
                U.sway.value  = 0;
            } else {
                // Idle: two slow cycles at different periods so the loop never
                // lines up and never looks mechanical.
                U.whip.value  = Math.sin(now / 1450) * 0.012;
                U.sway.value  = Math.sin(now / 890) * 0.022;
                U.twist.value = Math.sin(now / 1150) * 0.075;
                U.tuck.value  = 0;
            }
        }
    };
}(typeof window !== 'undefined' ? window : this));
