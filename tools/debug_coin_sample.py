"""Trace the bake: reassign slots, planar UVs, then sample like bake_vertex_colors."""
import os
import sys

sys.path.insert(0, os.path.expanduser("~/Developer/funkys-burnquest/tools"))
from bake_trellis_glb import reset_scene, import_glb, join_meshes, ensure_active, world_bounds, find_principled, walk_to_image, image_pixels, sample_px  # noqa: E402
import bpy  # noqa: E402

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB = ROOT + "/test-shots/coins/ksto/ksto-coin.glb"

reset_scene()
meshes = import_glb(GLB)
meshes = [o for o in meshes if not o.name.startswith("FaceDisc")]
for d in [o for o in bpy.data.objects if o.name.startswith("FaceDisc")]:
    bpy.data.objects.remove(d, do_unlink=True)
obj = join_meshes(meshes, "coin-ksto")
ensure_active(obj)
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
diameter = max(mx_x - mn_x, mx_y - mn_y)
s = 0.5 / diameter if diameter > 0 else 1.0
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
obj.location.x -= 0.5 * (mn_x + mx_x)
obj.location.y -= 0.5 * (mn_y + mx_y)
obj.location.z -= 0.5 * (mn_z + mx_z)
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
me = obj.data
face_idx = next((i for i, m in enumerate(me.materials) if m and 'Face' in m.name), 0)
for poly in me.polygons:
    poly.material_index = face_idx if abs(poly.normal.z) > 0.5 else 1
uv_layer = me.uv_layers.active or me.uv_layers.new()
me.uv_layers.active = uv_layer
for poly in me.polygons:
    for li in poly.loop_indices:
        v = me.vertices[me.loops[li].vertex_index].co
        uv_layer.data[li].uv = (v.x / 0.5 + 0.5, v.y / 0.5 + 0.5)

# Now sample exactly like the bake does
from collections import Counter
mat = me.materials[face_idx]
prin = find_principled(mat)
img = walk_to_image(prin.inputs["Base Color"])
print("FACE_IMG:", img.name if img else None)
packed = image_pixels(img) if img else None
print("PACKED:", bool(packed), "px_dims:", packed[1] if packed else None)
uv = me.uv_layers.active
hist = Counter()
tested = 0
for poly in me.polygons:
    if poly.material_index != face_idx:
        continue
    for li in poly.loop_indices:
        u, v = uv.data[li].uv
        if packed and uv:
            r, g, b = sample_px(packed[0], packed[1], packed[2], u, v)
        else:
            r, g, b = (-1, -1, -1)
        hist[(round(r, 2), round(g, 2), round(b, 2))] += 1
        tested += 1
print("SAMPLED_LOOPS:", tested, "UNIQUE:", len(hist))
print("TOP5:", hist.most_common(5))
# UV range check on caps
us, vs = [], []
for poly in me.polygons:
    if abs(poly.normal.z) > 0.5:
        for li in poly.loop_indices:
            u, v = uv.data[li].uv
            us.append(u); vs.append(v)
print("CAP_UV_RANGE: u", round(min(us), 2), round(max(us), 2), "v", round(min(vs), 2), round(max(vs), 2))
