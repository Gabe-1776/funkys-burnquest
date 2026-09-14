"""Bake a Blender cloud to the game's compact JSON mesh format.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_cloud_blender.py

Models the reference (assets/models/bakeoff/cloud_ref.png): ONE dominant central
puff, two symmetric flanking puffs lower and overlapping, two small fill puffs,
and a wide flat base slab. Matches the silhouette; warm two-tone cream.
"""
import bpy, json, os

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
OUT = os.path.join(ROOT, "assets/models/bakeoff/cloud_blender.json")

def clean_scene():
    bpy.ops.object.select_all(action="SELECT")
    bpy.ops.object.delete(use_global=False)
    for b in list(bpy.data.meshes): bpy.data.meshes.remove(b)

def make_cloud():
    # Puffs: (x, y, z, radius)  - x = left/right, y = depth, z = height
    # Reference proportions: central puff dominant/high, flanks lower+overlap.
    puffs = [
        (0.00, 0.00, 0.62, 0.72),   # central - largest, highest
        (-0.72, 0.05, 0.30, 0.52),  # left flank, lower
        (0.72, 0.05, 0.30, 0.52),   # right flank, lower
        (-0.34, -0.12, 0.20, 0.44), # left fill (forward)
        (0.34, -0.12, 0.20, 0.44),  # right fill (forward)
        (0.00, 0.12, 0.16, 0.42),   # rear fill
    ]
    objs = []
    for i, (x, y, z, r) in enumerate(puffs):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10,
                                             radius=r, location=(x, y, z))
        s = bpy.context.active_object
        s.name = "CloudPuff%d" % i
        # slight vertical squash so puffs read as clouds, not balls
        s.scale = (1.0, 0.88, 0.80)
        objs.append(s)
    # Wide flat base slab (the rectangle in the reference).
    bpy.ops.mesh.primitive_cube_add(size=2.0, location=(0.0, 0.0, -0.12))
    base = bpy.context.active_object
    base.name = "CloudBase"
    base.scale = (1.15, 0.48, 0.13)
    objs.append(base)

    bpy.ops.object.select_all(action="DESELECT")
    for o in objs: o.select_set(True)
    bpy.context.view_layer.objects.active = objs[0]
    bpy.ops.object.join()
    cloud = bpy.context.active_object
    cloud.name = "Cloud"
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)

    # Two-tone cream: puffs lighter, base slightly darker for definition.
    mat_puff = bpy.data.materials.new("CloudBody")
    mat_puff.use_nodes = True
    b = mat_puff.node_tree.nodes.get("Principled BSDF")
    b.inputs["Base Color"].default_value = (0.955, 0.925, 0.855, 1.0)
    b.inputs["Roughness"].default_value = 0.85
    mat_base = bpy.data.materials.new("CloudBase")
    mat_base.use_nodes = True
    b2 = mat_base.node_tree.nodes.get("Principled BSDF")
    b2.inputs["Base Color"].default_value = (0.90, 0.862, 0.775, 1.0)
    b2.inputs["Roughness"].default_value = 0.9
    # Assign: puffs material 0, base (last material slot) material 1.
    cloud.data.materials.clear()
    cloud.data.materials.append(mat_puff)
    cloud.data.materials.append(mat_base)
    # Base slab is the last faces (largest z<0 contiguous); reassign by z.
    for poly in cloud.data.polygons:
        if poly.center.z < -0.02:
            poly.material_index = 1
    return cloud

def bake(cloud, out_slug):
    me = cloud.data
    me.calc_loop_triangles()
    mats = []
    for m in me.materials:
        n = m.node_tree.nodes.get("Principled BSDF") if m.use_nodes else None
        c = n.inputs["Base Color"].default_value if n else (1, 1, 1, 1)
        r = n.inputs["Roughness"].default_value if n else 0.6
        mats.append({"name": m.name,
                     "color": [round(c[0],4), round(c[1],4), round(c[2],4)],
                     "roughness": round(r,3), "emissive": 0.0})
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
                    i = len(pos)//3
                    vmap[key] = i
                    # Blender Z-up -> three.js Y-up
                    pos.extend([round(v.co.x,4), round(v.co.z,4), round(-v.co.y,4)])
                    nrm.extend([round(n_.x,4), round(n_.z,4), round(-n_.y,4)])
                idx.append(i)
        groups.append({"start": start, "count": len(idx)-start, "materialIndex": mi})
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump({"name": out_slug, "materials": mats, "groups": groups,
                   "positions": pos, "normals": nrm, "indices": idx}, f)
    print("BAKED %s: %d verts, %d tris, %d materials -> %s"
          % (out_slug, len(pos)//3, len(idx)//3, len(mats), OUT))

clean_scene()
cloud = make_cloud()
bake(cloud, "cloud_blender")
