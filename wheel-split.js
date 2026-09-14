/*
 * Split a baked vehicle mesh into body + four spinning wheels, in code.
 *
 * Meshy welds a whole vehicle into ONE unnamed mesh - `nodes=1 meshes=1` - so
 * there is no wheel object to rotate and the cars slid along with dead wheels.
 * Re-authoring the GLBs would mean new nodes, accessors and bufferViews in
 * every file; doing it here instead costs one pass per TEMPLATE (not per
 * instance), and because clones share geometry the four wheels still upload
 * once no matter how many cars spawn.
 *
 * Wheels are found geometrically, not by name (there are no names): vertices in
 * the lower part of the model form two dense clusters along the length - the
 * axles - with a clear gap between them, and each axle has a left and right
 * side. A triangle belongs to a wheel when its centroid sits inside that
 * wheel's radius in the length/height plane and on its side of the centre line.
 *
 * Everything else stays in the body, so a misclassification can only ever leave
 * a triangle behind - it can never delete one.
 */
(function (root) {
    'use strict';

    function centroids(geo) {
        var pos = geo.attributes.position;
        var idx = geo.index;
        var n = idx ? idx.count : pos.count;
        var tris = n / 3;
        var c = new Float32Array(tris * 3);
        for (var t = 0; t < tris; t++) {
            var a = idx ? idx.getX(t * 3) : t * 3;
            var b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
            var d = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
            c[t * 3] = (pos.getX(a) + pos.getX(b) + pos.getX(d)) / 3;
            c[t * 3 + 1] = (pos.getY(a) + pos.getY(b) + pos.getY(d)) / 3;
            c[t * 3 + 2] = (pos.getZ(a) + pos.getZ(b) + pos.getZ(d)) / 3;
        }
        return c;
    }

    /* Two axle positions along x, from the density of low-lying triangles. */
    function findAxles(cen, lo, hi) {
        var BINS = 24;
        var span = hi.x - lo.x;
        var yCut = lo.y + (hi.y - lo.y) * 0.34;
        var hist = new Array(BINS).fill(0);
        for (var t = 0; t < cen.length / 3; t++) {
            if (cen[t * 3 + 1] > yCut) continue;
            var k = Math.floor(((cen[t * 3] - lo.x) / span) * BINS);
            if (k >= 0 && k < BINS) hist[k]++;
        }
        // Heaviest bin in the front half and in the rear half: a vehicle has an
        // axle near each end, and the middle is the gap between them.
        function peak(from, to) {
            var best = -1, bi = from;
            for (var i = from; i < to; i++) if (hist[i] > best) { best = hist[i]; bi = i; }
            return { x: lo.x + (bi + 0.5) * (span / BINS), n: best };
        }
        var third = Math.floor(BINS / 3);
        return [peak(0, third + 2), peak(BINS - third - 2, BINS)];
    }

    function splitWheels(THREE, rootObj) {
        var mesh = null;
        rootObj.traverse(function (o) { if (!mesh && o.isMesh && o.geometry) mesh = o; });
        if (!mesh) return null;

        var geo = mesh.geometry;
        geo.computeBoundingBox();
        var bb = geo.boundingBox, lo = bb.min, hi = bb.max;
        var cen = centroids(geo);
        var tris = cen.length / 3;

        var axles = findAxles(cen, lo, hi);
        if (!axles[0].n || !axles[1].n) return null;

        var height = hi.y - lo.y;
        var radius = Math.min(height * 0.42, (hi.x - lo.x) * 0.13);
        var wheelY = lo.y + radius;
        var zMid = (lo.z + hi.z) / 2;
        var zOut = (hi.z - lo.z) * 0.16;        // ignore anything near the centre line

        // groupOf[t] = -1 body, 0..3 wheel index
        var groupOf = new Int8Array(tris).fill(-1);
        var wheels = [];
        for (var a = 0; a < 2; a++) {
            for (var s = 0; s < 2; s++) {
                wheels.push({ x: axles[a].x, y: wheelY,
                              zSign: s ? 1 : -1, count: 0, zSum: 0 });
            }
        }
        for (var t = 0; t < tris; t++) {
            var cx = cen[t * 3], cy = cen[t * 3 + 1], cz = cen[t * 3 + 2];
            if (Math.abs(cz - zMid) < zOut) continue;         // too central to be a wheel
            for (var w = 0; w < wheels.length; w++) {
                var wh = wheels[w];
                if ((cz - zMid) * wh.zSign <= 0) continue;    // wrong side
                var dx = cx - wh.x, dy = cy - wh.y;
                if (dx * dx + dy * dy <= radius * radius) {
                    groupOf[t] = w; wh.count++; wh.zSum += cz;
                    break;
                }
            }
        }

        var anyWheel = wheels.some(function (w) { return w.count > 12; });
        if (!anyWheel) return null;

        function subGeometry(pick) {
            var src = geo.attributes, idx = geo.index;
            var keep = [];
            for (var t = 0; t < tris; t++) if (pick(t)) keep.push(t);
            if (!keep.length) return null;
            var out = new THREE.BufferGeometry();
            Object.keys(src).forEach(function (name) {
                var at = src[name], size = at.itemSize;
                var arr = new Float32Array(keep.length * 3 * size);
                for (var i = 0; i < keep.length; i++) {
                    for (var v = 0; v < 3; v++) {
                        var vi = idx ? idx.getX(keep[i] * 3 + v) : keep[i] * 3 + v;
                        for (var c = 0; c < size; c++) {
                            arr[(i * 3 + v) * size + c] = at.array[vi * size + c];
                        }
                    }
                }
                out.setAttribute(name, new THREE.BufferAttribute(arr, size));
            });
            return out;
        }

        var bodyGeo = subGeometry(function (t) { return groupOf[t] < 0; });
        if (!bodyGeo) return null;

        var group = new THREE.Group();
        var body = new THREE.Mesh(bodyGeo, mesh.material);
        body.castShadow = mesh.castShadow;
        body.receiveShadow = mesh.receiveShadow;
        group.add(body);

        var spinners = [];
        wheels.forEach(function (wh, w) {
            if (wh.count <= 12) return;
            var g = subGeometry(function (t) { return groupOf[t] === w; });
            if (!g) return;
            var cz = wh.zSum / wh.count;
            // Re-origin the geometry on the wheel centre so rotation.x spins it
            // about its own axle instead of swinging it around the car.
            g.translate(-wh.x, -wh.y, -cz);
            var m = new THREE.Mesh(g, mesh.material);
            m.position.set(wh.x, wh.y, cz);
            m.castShadow = mesh.castShadow;
            m.userData.isWheel = true;
            group.add(m);
            spinners.push(m);
        });
        if (!spinners.length) return null;

        group.userData.wheels = spinners;
        group.userData.wheelRadius = radius;
        // Carry the source transform so the caller can drop this in place.
        group.position.copy(mesh.position);
        group.rotation.copy(mesh.rotation);
        group.scale.copy(mesh.scale);
        return group;
    }

    root.BurnQuestWheelSplit = { splitWheels: splitWheels };
}(typeof window !== 'undefined' ? window : this));
