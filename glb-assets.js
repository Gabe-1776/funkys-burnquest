/*
 * Textured-GLB asset layer for Funky's BurnQuest (LOCAL + DEPLOYED).
 *
 * Loads the original Meshy textured GLBs directly through GLTFLoader
 * (r0.160 UMD global, see glb-loader.js) instead of the vertex-color JSON
 * bakes, preserving the paint the JSON bake flattens. JSON stays as the
 * fallback: any load error leaves the current JSON asset visible.
 *
 * Geometry contract (verified 2026-09-08): the JSON bakes were produced from
 * these very GLBs by an axis-swap bake whose net transform is the identity in
 * glTF space — so a GLB loaded straight into three.js sits in the SAME
 * coordinate frame as its JSON. Per-slug normalization therefore only
 * grounds (min y = 0), centers XZ, and applies a uniform fit-scale against
 * the JSON bounding box (glb-dims.json), guarding against origin drift.
 *
 * Template cache: each GLB is parsed ONCE per theme/slug; per-use instances
 * are Object3D clones that share geometry/materials/textures (three.js clone
 * semantics) — one texture upload per asset (atlases capped at 512 via tools/optimize-glb-textures.py) no matter how many copies
 * spawn. render3d.js disposeMesh only disposes top-level groups, so shared
 * resources are never torn down per instance.
 */
(function (root) {
    var THEME_DIR = { fv: 'fv', diorama: 'diorama' };
    var DIMS = root.__GLB_DIMS__ || {};
    // Assets one theme borrows from another. The funkyverse bee is the one
    // Gabriel picked for every theme (2026-09-11); diorama has no fly.glb of
    // its own and was drawing the procedural sphere-bee instead.
    // Gabriel 2026-09-12: "theme 1 needs the same hunter animals as funkyverse".
    // They already SPAWN there - the sim has no theme concept and render3d builds
    // hazard meshes unconditionally - but assets/models/glb/diorama/ has no
    // snake/bird/gator, so the load 404s and they fall back to box placeholders.
    // Share the one set, exactly as fly is already shared.
    var SHARED_FROM = { fly: 'fv', snake: 'fv', bird: 'fv', gator: 'fv',
                        life: 'fv', 'funky-classic': 'fv', 'funky-classic-rigged': 'fv' };
    function dirFor(themeDir, slug) {
        // Campaign coins are theme-independent community assets. Store one
        // canonical GLB under fv instead of duplicating every coin per theme.
        return /^coin-/.test(slug) ? 'fv' : (SHARED_FROM[slug] || themeDir);
    }
    var GLB_ASSET_VERSION = '189';   // bump when any GLB under assets/models/glb changes
    var templateCache = {};   // key -> parsed {scene, tris}
    var pending = {};         // key -> Promise while the GLB is loading
    // Failed entries now carry a timestamp and expire after FAIL_TTL_MS, so a
    // transient fetch error (502, brief network drop) can recover on the next
    // request instead of killing that asset for the entire session. 404-refetch
    // spam is still suppressed within the TTL window; a persistent 404 re-enters
    // the cache immediately on retry.
    var failed = {};          // key -> { err, at } (negative cache with TTL)
    var FAIL_TTL_MS = 30000;  // 30s
    var loaderPromise = null;

    var gltfCache = {};

    function ensureLoader() {
        if (root.THREE && root.THREE.GLTFLoader) return Promise.resolve();
        if (loaderPromise) return loaderPromise;
        loaderPromise = new Promise(function (resolve, reject) {
            var s = document.createElement('script');
            // Cache-bust with the GLB asset version, consistent with every
            // other JS file in index.html. A stale cached loader can no longer
            // survive a deploy.
            s.src = 'glb-loader.js?v=' + GLB_ASSET_VERSION;
            s.onload = function () { resolve(); };
            s.onerror = function () { loaderPromise = null; reject(new Error('glb-loader.js failed to load')); };
            document.head.appendChild(s);
        });
        return loaderPromise;
    }

    // Which assets get the wheel split. Deliberately a list, not "anything with
    // low geometry": splitting a log or a turtle would carve lumps out of it.
    // DISABLED 2026-09-11. The geometric split was too greedy: triangles that
    // belong to the body but fall inside a wheel's radius were re-origined
    // onto that wheel and then ROTATED with it, smearing pink wedges out of
    // the trucks and cars. Live rendering damage, so it is off until the
    // selection is tightened (a wheel is a flat disc normal to z, not every
    // triangle within a radius). Set this back to the pattern below to
    // re-enable:
    //   /\/(car|car-opus|coupe-red|sedan-orange|taxi|muscle-flame|truck|truck-blue|truck-purple|truck-teal|wagon-lime|wagon-red|compact)$/
    var WHEELED = /$^/;   // matches nothing

    function loadTemplate(key, url) {
        var f = failed[key];
        if (f) {
            // TTL expired: drop the negative cache and let the request retry.
            if (Date.now() - f.at >= FAIL_TTL_MS) delete failed[key];
            else return Promise.reject(f.err);
        }
        // CHECK THE PARSED CACHE FIRST. pending[key] only dedupes callers that
        // arrive while a load is still in flight; it is deleted on completion.
        // Without this line a caller arriving AFTER the load finished found no
        // pending entry, ignored the perfectly good parsed template sitting in
        // templateCache, and started a whole new fetch + parse + texture upload.
        // Measured on the live site: palm.glb and portal-frame.glb were each
        // downloaded TWICE (~6.8MB re-fetched) because buildBoard runs again on
        // a theme swap or a column change, long after their first load settled.
        // Cars never showed it - they are all instanced inside one frame, while
        // pending is still set.
        if (templateCache[key]) return Promise.resolve(templateCache[key]);
        if (pending[key]) return pending[key];
        pending[key] = ensureLoader().then(function () {
            return new Promise(function (resolve, reject) {
                new THREE.GLTFLoader().load(url, function (gltf) {
                    var tris = 0;
                    gltf.scene.traverse(function (o) {
                        if (o.isMesh) {
                            var g = o.geometry;
                            tris += g.index ? g.index.count / 3 : g.attributes.position.count / 3;
                        }
                    });
                    // Sanitize multi-material assets: transparent / glass materials
                    // must not write depth to avoid z-fighting. Single-material
                    // Meshy cars have monolithic textures and are retouched via
                    // tools/car-retouch-diorama-windows.py instead.
                    gltf.scene.traverse(function (o) {
                        if (!o.isMesh) return;
                        var mats = Array.isArray(o.material) ? o.material : [o.material];
                        mats.forEach(function (m) {
                            if (!m) return;
                            var n = (m.name || '') + ' ' + (o.name || '');
                            if (m.transparent === true || /glass|window|windshield/i.test(n)) {
                                m.depthWrite = false;
                            }
                        });
                    });
                    // Gabriel 2026-09-12: Meshy exports vehicles with
                    // doubleSided=true, which renders interior cavity faces and
                    // causes z-fighting / shadow acne on thin geometry like
                    // windows. Force FrontSide on single-material car templates
                    // (diorama wagons, truck-blue) to cull backfaces.
                    if (/^(diorama\/wagon|diorama\/truck-blue|fv\/)/.test(key)) {
                        gltf.scene.traverse(function (o) {
                            if (!o.isMesh) return;
                            var mats = Array.isArray(o.material) ? o.material : [o.material];
                            mats.forEach(function (m) {
                                if (m && m.side === THREE.DoubleSide) {
                                    m.side = THREE.FrontSide;
                                    m.needsUpdate = true;
                                }
                            });
                        });
                    }
                    // Vehicles arrive as ONE welded mesh with no wheel nodes,
                    // so split the wheels off here - once per TEMPLATE, before
                    // anything clones it. Clones then inherit body + 4 wheels
                    // and still share geometry, so the cost is one pass per
                    // asset rather than per car. A failed split returns null and
                    // the original scene is used unchanged.
                    var sceneObj = gltf.scene;
                    if (WHEELED.test(key) && root.BurnQuestWheelSplit) {
                        try {
                            var split = root.BurnQuestWheelSplit.splitWheels(THREE, sceneObj);
                            if (split) sceneObj = split;
                        } catch (e) { /* keep the unsplit mesh */ }
                    }
                    // Keep the CLIPS too: a rigged asset (the hazards) is
                    // useless without them, and instance() hands them to each
                    // clone so every snake gets its own mixer.
                    templateCache[key] = { scene: sceneObj, tris: tris,
                                           animations: gltf.animations || [] };
                    delete pending[key];
                    resolve(templateCache[key]);
                }, undefined, function (err) { delete pending[key]; failed[key] = { err: err, at: Date.now() }; reject(err); });
            });
        });
        return pending[key];
    }

    // Normalize a fresh clone: fit-scale to the JSON bbox, center XZ, ground.
    function prepare(tmpl, dims) {
        // A rigged template needs its bone graph rebuilt per copy: a plain
        // clone leaves every SkinnedMesh bound to the SOURCE skeleton, so four
        // snakes on one board would animate as a single snake.
        var rigged = false;
        tmpl.scene.traverse(function (o) { if (o.isSkinnedMesh) rigged = true; });
        var inst = (rigged && root.skeletonClone) ? root.skeletonClone(tmpl.scene)
                                                  : tmpl.scene.clone(true);
        if (rigged) inst.userData.animations = tmpl.animations || [];
        inst.traverse(function (o) { o.userData.sharedRes = true; });
        var box = new THREE.Box3().setFromObject(inst);
        if (!isFinite(box.min.x)) return null;
        var size = box.getSize(new THREE.Vector3());
        var s = 1;
        if (dims) {
            var rx = dims.dx && size.x > 1e-6 ? dims.dx / size.x : 1;
            var ry = dims.dy && size.y > 1e-6 ? dims.dy / size.y : 1;
            var rz = dims.dz && size.z > 1e-6 ? dims.dz / size.z : 1;
            s = Math.min(rx, ry, rz);
        }
        if (isFinite(s) && s > 0 && Math.abs(s - 1) > 0.01) inst.scale.setScalar(s);
        inst.updateMatrixWorld(true);
        var b2 = new THREE.Box3().setFromObject(inst);
        inst.position.x -= (b2.min.x + b2.max.x) / 2;
        inst.position.z -= (b2.min.z + b2.max.z) / 2;
        if (isFinite(b2.min.y)) inst.position.y -= b2.min.y;   // feet/wheels on the deck
        inst.userData.triangles = tmpl.tris;
        return inst;
    }

    root.BurnQuestGLBAssets = {
        has: function (themeDir, slug) {
            // Per-theme opt-outs. BOTH themes keep an authored JSON character
            // and neither is an accident:
            //   fv       - the TRELLIS-baked frog; the Meshy c4 GLB is the boxy
            //              voxel take and its feet sit wrong on platforms.
            //   diorama  - the frog MODELLED IN BLENDER, Gabriel's call
            //              2026-09-08: it is the toy-plastic theme and the
            //              hand-authored frog is the one that reads as a toy.
            //              The Meshy GLB (2.4MB against the JSON's 105KB) stays
            //              on disk for comparison.
            if (slug === 'funky') return false;
            var dir = dirFor(themeDir, slug);
            return !!(DIMS[dir] && DIMS[dir][slug]);
        },
        // The FULL gltf (scene + animations) for the one rigged character.
        // instance() clones a template and drops gltf.animations, and a
        // SkinnedMesh cannot be cloned that way anyway - there is only one
        // Funky, so he gets the loaded scene itself.
        loadGLTF: function (themeDir, slug) {
            var url = 'assets/models/glb/' + THEME_DIR[themeDir] + '/' + slug +
                      '.glb?v=' + GLB_ASSET_VERSION;
            // Cached so a theme switch does not re-download the character.
            if (!gltfCache[url]) {
                gltfCache[url] = ensureLoader().then(function () {
                    return new Promise(function (resolve, reject) {
                        new THREE.GLTFLoader().load(url, resolve, undefined, reject);
                    });
                });
                gltfCache[url].catch(function () { delete gltfCache[url]; });
            }
            return gltfCache[url];
        },
        // Promise<normalized THREE.Group clone>.
        instance: function (themeDir, slug) {
            themeDir = dirFor(themeDir, slug);
            var dims = DIMS[themeDir] && DIMS[themeDir][slug];
            var key = themeDir + '/' + slug;
            var url = 'assets/models/glb/' + THEME_DIR[themeDir] + '/' + slug + '.glb?v=' + GLB_ASSET_VERSION;
            return loadTemplate(key, url).then(function (tmpl) {
                var inst = prepare(tmpl, dims);
                if (!inst) throw new Error('GLB clone produced non-finite bounds');
                return inst;
            });
        }
    };
}(typeof window !== 'undefined' ? window : this));
