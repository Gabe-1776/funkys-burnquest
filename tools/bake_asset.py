"""Bake a Blender object to the game's compact JSON mesh format.

The game has no build step and three.js r0.160's UMD build has no GLTFLoader,
so meshes ship as positions/normals/indices + one group per material and are
turned into a BufferGeometry at runtime by render3d.js.

Usage inside Blender:
    import bake_asset; bake_asset.bake("Car", "car")
"""
import bpy, json, os

OUT_DIR = os.path.expanduser("~/Developer/funkys-burnquest/assets/models")

def bake(object_name, out_slug, target_width=None):
    obj = bpy.data.objects[object_name]

    # apply modifiers + join is the caller's job; here we just read the mesh
    if target_width:
        # A HIDDEN object cannot be selected, so transform_apply silently no-ops
        # and the mesh ships at the wrong scale with no error at all. This bit
        # the log: asked for width 1.0, got 1.746. Unhide, apply, then ASSERT
        # the result rather than trusting the operator.
        was_hidden = obj.hide_get()
        obj.hide_set(False)
        bpy.ops.object.select_all(action="DESELECT")
        obj.select_set(True)
        bpy.context.view_layer.objects.active = obj
        f = target_width / obj.dimensions.x
        obj.scale = (f, f, f)
        bpy.ops.object.transform_apply(scale=True)
        got = obj.dimensions.x
        if abs(got - target_width) > 1e-3:
            raise RuntimeError(
                "bake(%r): asked for width %.3f, got %.3f - scale did not apply"
                % (object_name, target_width, got))
        if was_hidden:
            obj.hide_set(True)

    me = obj.data
    me.calc_loop_triangles()

    mats = []
    for m in me.materials:
        n = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        c = n.inputs["Base Color"].default_value if n else (1, 1, 1, 1)
        r = n.inputs["Roughness"].default_value if n else 0.6
        e = n.inputs["Emission Strength"].default_value if n and "Emission Strength" in n.inputs else 0.0
        mats.append({"name": m.name,
                     "color": [round(c[0], 4), round(c[1], 4), round(c[2], 4)],
                     "roughness": round(r, 3),
                     "emissive": round(e, 3)})

    by_mat = {}
    for t in me.loop_triangles:
        by_mat.setdefault(t.material_index, []).append(t)

    pos, nrm, idx, groups, vmap = [], [], [], [], {}
    for mi in sorted(by_mat):
        start = len(idx)
        for t in by_mat[mi]:
            for li in t.loops:
                loop = me.loops[li]
                v = me.vertices[loop.vertex_index]
                n_ = loop.normal if t.use_smooth else t.normal
                key = (loop.vertex_index, round(n_.x,4), round(n_.y,4), round(n_.z,4), mi)
                i = vmap.get(key)
                if i is None:
                    i = len(pos) // 3
                    vmap[key] = i
                    # Blender Z-up -> three.js Y-up
                    pos.extend([round(v.co.x,4), round(v.co.z,4), round(-v.co.y,4)])
                    nrm.extend([round(n_.x,4), round(n_.z,4), round(-n_.y,4)])
                idx.append(i)
        groups.append({"start": start, "count": len(idx)-start, "materialIndex": mi})

    os.makedirs(OUT_DIR, exist_ok=True)
    path = os.path.join(OUT_DIR, out_slug + ".json")
    with open(path, "w") as f:
        json.dump({"name": out_slug, "materials": mats, "groups": groups,
                   "positions": pos, "normals": nrm, "indices": idx},
                  f, separators=(",", ":"))
    d = obj.dimensions
    return {"path": path, "bytes": os.path.getsize(path), "tris": len(idx)//3,
            "verts": len(pos)//3, "dims": [round(d.x,3), round(d.y,3), round(d.z,3)]}


def finish(name):
    """Apply every modifier on the selected meshes, join them, name the result,
    and drop the origin to the base centre."""
    meshes = [o for o in bpy.context.selected_objects if o.type == "MESH"]
    for o in meshes:
        bpy.context.view_layer.objects.active = o
        for mod in list(o.modifiers):
            bpy.ops.object.modifier_apply(modifier=mod.name)
    bpy.context.view_layer.objects.active = meshes[0]
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name

    # CRITICAL: bake() reads LOCAL vertex coordinates, so any residual
    # object-level rotation or scale is silently dropped from the export.
    # join() bakes the transforms of the non-active objects but leaves the
    # ACTIVE object's own rotation intact - so if the first selected mesh
    # happened to be rotated, the exported asset comes out wrong. That is
    # exactly how the portal shipped collapsed on its side while looking
    # perfect in Blender. Earlier assets only survived by luck.
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    bpy.context.scene.cursor.location = (0, 0, 0)
    bpy.ops.object.origin_set(type="ORIGIN_CURSOR")
    return obj
