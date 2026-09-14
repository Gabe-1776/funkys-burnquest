/* SkeletonUtils.clone for the UMD build, bound to the existing global THREE.
 * Source: three.js r0.160 examples/jsm/utils/SkeletonUtils.js (clone only).
 * MIT license, copyright (c) 2010-2024 three.js authors.
 *
 * Why this file exists: glb-assets prepare() duplicates a template with
 * scene.clone(true), which is right for a static prop and WRONG for a rigged
 * one - every SkinnedMesh copy would keep pointing at the source skeleton, so
 * four snakes on a board would animate as one. This rebuilds the bone graph per
 * clone and rebinds each SkinnedMesh to its own skeleton.
 */
(function (root) {
    'use strict';
    var THREE = root.THREE;
    if (!THREE) return;

    function parallelTraverse(a, b, callback) {
        callback(a, b);
        for (var i = 0; i < a.children.length; i++) {
            parallelTraverse(a.children[i], b.children[i], callback);
        }
    }

    root.skeletonClone = function skeletonClone(source) {
        var sourceLookup = new Map();
        var cloneLookup = new Map();
        var clone = source.clone();

        parallelTraverse(source, clone, function (sourceNode, clonedNode) {
            sourceLookup.set(clonedNode, sourceNode);
            cloneLookup.set(sourceNode, clonedNode);
        });

        clone.traverse(function (node) {
            if (!node.isSkinnedMesh) return;
            var sourceMesh = sourceLookup.get(node);
            var sourceBones = sourceMesh.skeleton.bones;
            node.skeleton = sourceMesh.skeleton.clone();
            node.bindMatrix.copy(sourceMesh.bindMatrix);
            node.skeleton.bones = sourceBones.map(function (bone) {
                return cloneLookup.get(bone);
            });
            node.bind(node.skeleton, node.bindMatrix);
        });

        return clone;
    };
}(typeof window !== 'undefined' ? window : this));
