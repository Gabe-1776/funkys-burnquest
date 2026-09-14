"""Debug: report materials, UVs, image links on the joined coin."""
import os
import sys

sys.path.insert(0, os.path.expanduser("~/Developer/funkys-burnquest/tools"))
from bake_trellis_glb import reset_scene, import_glb, join_meshes, find_principled, walk_to_image  # noqa: E402
import bpy  # noqa: E402

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB = ROOT + "/test-shots/coins/ksto/ksto-coin.glb"

reset_scene()
meshes = import_glb(GLB)
print("IMPORTED:", [(o.name, o.type) for o in meshes])
meshes = [o for o in meshes if not o.name.startswith("FaceDisc")]
obj = join_meshes(meshes, "coin-ksto")
me = obj.data
print("MATS:", [m.name if m else None for m in me.materials])
print("UV_LAYERS:", [l.name for l in me.uv_layers], "active:", me.uv_layers.active.name if me.uv_layers.active else None)
for mi, mat in enumerate(me.materials):
    if not mat:
        continue
    prin = find_principled(mat)
    print(f"mat{mi} {mat.name}: principled={bool(prin)}", end=" ")
    if prin:
        try:
            img = walk_to_image(prin.inputs["Base Color"])
            print("image=", img.name if img else None,
                  "size=", tuple(img.size) if img else None)
        except Exception as e:
            print("walk_err=", str(e)[:120])
    else:
        print()
# polygon slot census
from collections import Counter
c = Counter()
for poly in me.polygons:
    c[(poly.material_index, abs(poly.normal.z) > 0.5)] += 1
print("POLY_CENSUS (slot, is_cap):", dict(c))
