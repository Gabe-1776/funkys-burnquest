"""Bake the Blender KSTO coin GLB into the game's compact JSON slot format.

Reuses proven helpers from bake_trellis_glb (import, join, vertex-color bake,
compact JSON export). Coin is small: target diameter ~0.5 world units.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b -t 2 --python tools/bake_coin_ksto.py
"""
import bpy
import os
import sys

sys.path.insert(0, os.path.expanduser("~/Developer/funkys-burnquest/tools"))
from bake_trellis_glb import (  # noqa: E402
    reset_scene, import_glb, join_meshes, origin_at_base_and_scale,
    bake_vertex_colors, export_json, world_bounds, ensure_active,
)

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB = ROOT + "/test-shots/coins/ksto/ksto-coin.glb"
OUT = "shared/coin-ksto"  # shared across themes; campaign picks the coin
reset_scene()
meshes = import_glb(GLB)
# Drop the separate face discs: planar-map the joined mesh's active UV layer
# instead. The coin is flat, so one XY projection serves both caps; rim and
# edge verts belong to the imageless edge material and fall back to purple.
discs = [o for o in meshes if o.name.startswith("FaceDisc")]
meshes = [o for o in meshes if not o.name.startswith("FaceDisc")]
for d in discs:
    bpy.data.objects.remove(d, do_unlink=True)
obj = join_meshes(meshes, "coin-ksto")
# Coin: uniform scale so diameter == 0.5, Y-centered (floats like a pickup).
# Blender Z is the game's Y (up) after export_json's (x, z, -y) mapping.
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
me = obj.data
# Caps (±Z faces) sample the face artwork; walls keep the edge metal.
# Slot 0 must be the face material for the bake sampler AND the exporter.
face_idx = next((i for i, m in enumerate(me.materials) if m and 'Face' in m.name), 0)
edge_idx = next((i for i, m in enumerate(me.materials) if m and 'Edge' in m.name), 1)
for poly in me.polygons:
    poly.material_index = face_idx if abs(poly.normal.z) > 0.5 else edge_idx
uv_layer = me.uv_layers.active or me.uv_layers.new()
me.uv_layers.active = uv_layer
# Planar map AFTER scaling: coin diameter is 0.5, centered on origin.
for poly in me.polygons:
    for li in poly.loop_indices:
        v = me.vertices[me.loops[li].vertex_index].co
        uv_layer.data[li].uv = (v.x / 0.5 + 0.5, v.y / 0.5 + 0.5)
# Fresh-load the face art with PIL: Blender's img.pixels reads back flat grey
# for file images in background mode (both GLB-imported AND fresh-loaded all
# sampled 0.23). PIL gives ground-truth sRGB; convert to linear for vertex Cx.
from PIL import Image as _PIL  # noqa: E402
_face = _PIL.open(ROOT + "/test-shots/coins/ksto/ksto-face.png").convert("RGB")
_FW, _FH = _face.size
_FPX = _face.load()
def _linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
face_rgb = {}
for poly in me.polygons:
    if poly.material_index != face_idx:
        continue
    for li in poly.loop_indices:
        vi = me.loops[li].vertex_index
        if vi in face_rgb:
            continue
        u, v = uv_layer.data[li].uv
        uu = u - int(u // 1) if u >= 0 else u - int(u // 1)
        vv = v - int(v // 1) if v >= 0 else v - int(v // 1)
        # Blender UV v=0 is BOTTOM; PIL y=0 is TOP.
        xi = min(_FW - 1, max(0, int(uu * (_FW - 1))))
        yi = min(_FH - 1, max(0, int((1.0 - vv) * (_FH - 1))))
        r, g, b = _FPX[xi, yi]
        face_rgb[vi] = (_linear(r), _linear(g), _linear(b))
colors = bake_vertex_colors(obj)
# Override cap verts with the direct file samples.
for vi, (r, g, b) in face_rgb.items():
    colors[vi] = (r, g, b)
export_json(obj, "shared/coin-ksto", colors, {"id": "coin-ksto"})
print("BAKED shared/coin-ksto faces=%d" % len(face_rgb))
