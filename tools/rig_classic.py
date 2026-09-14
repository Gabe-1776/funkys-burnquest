"""Rig the classic Funky (funky-classic.glb) with a skeleton and clips.

Bone heat fails on this Meshy model just like the TRELLIS bake (split-normal
islands), so weights are computed the same way: smooth inverse-distance blend
of each vertex to its nearest bone segments, restricted by measured height
slices.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/rig_classic.py
Outputs:
  assets/models/glb/fv/funky-classic-rigged.glb   skinned mesh + idle/hop/dance
  test-shots/classic-rig/*.png                    posed frames for review
"""
import bpy, os, sys, json
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from funky_rig_common import FPS, b, build_rig, author_clips, shoot_poses, export_glb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets/models/glb/fv/funky-classic.glb")
OUT = os.environ.get("CLASSIC_OUT", os.path.join(ROOT, "assets/models/glb/fv/funky-classic-rigged.glb"))
SHOTS = os.environ.get("CLASSIC_SHOTS", os.path.join(ROOT, "test-shots/classic-rig"))

# ---- scene ---------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS

# ---- import the funky-classic GLB ----------------------------------------
bpy.ops.import_scene.gltf(filepath=SRC)
body = bpy.context.selected_objects[0]
body.name = "ClassicFunky"

# The model's bounding box in Blender coords (Z up after GLB import).
import numpy as np
verts = np.array([v.co for v in body.data.vertices], dtype=float)
z_min, z_max = verts[:, 2].min(), verts[:, 2].max()
x_min, x_max = verts[:, 0].min(), verts[:, 0].max()
y_min, y_max = verts[:, 1].min(), verts[:, 1].max()
H = z_max - z_min
W = x_max - x_min
D = y_max - y_min
print(f"MODEL  bbox: {W:.3f} x {D:.3f} x {H:.3f}  (Blender: X=right Y=depth Z=up)")

# Normalize: feet at Z=0, scale to target height.
# The funkyverse rigged model has its origin at the feet and is ~1.1 units
# tall. The classic model's origin is at the center — shift it so feet = 0
# and scale to match the target dims (1.12).
TARGET_H = 0.90
scale = TARGET_H / H
body.scale = (scale, scale, scale)
body.location.z = -z_min * scale
bpy.context.view_layer.objects.active = body
bpy.ops.object.transform_apply(location=True, scale=True)
# Re-measure after transform
verts = np.array([v.co for v in body.data.vertices], dtype=float)
z_min, z_max = verts[:, 2].min(), verts[:, 2].max()
x_min, x_max = verts[:, 0].min(), verts[:, 0].max()
y_min, y_max = verts[:, 1].min(), verts[:, 1].max()
H = z_max - z_min
print(f"MODEL  normalized: {x_max-x_min:.3f} x {y_max-y_min:.3f} x {H:.3f}  feet at z={z_min:.3f}")

# ---- skeleton, proportional to the model ----------------------------------
# three.js coords: Y is up. The model faces +Z in glTF.
# Feet at three.js y = 0 (after normalization).
y_feet = 0.0
y_head = H
h = H  # shorthand for the bone math below

BONES = [
    ("hips",    (0, y_feet + 0.30*h, 0),    (0, y_feet + 0.38*h, 0),    None),
    ("spine",   (0, y_feet + 0.38*h, 0),    (0, y_feet + 0.50*h, 0),    "hips"),
    ("head",    (0, y_feet + 0.50*h, 0),    (0, y_feet + 0.80*h, 0),    "spine"),
    ("hat",     (0, y_feet + 0.80*h, 0),    (0, y_feet + 0.95*h, 0),    "head"),
]
for side, s in (("L", 1.0), ("R", -1.0)):
    BONES += [
        (f"thigh.{side}", (0, y_feet + 0.32*h, s*0.08),    (0, y_feet + 0.18*h, s*0.08),    "hips"),
        (f"shin.{side}",  (0, y_feet + 0.18*h, s*0.08),    (0, y_feet + 0.06*h, s*0.09),    f"thigh.{side}"),
        (f"foot.{side}",  (0, y_feet + 0.06*h, s*0.09),    (0, y_feet + 0.01*h, s*0.10),    f"shin.{side}"),
        (f"arm.{side}",   (0, y_feet + 0.50*h, s*0.12),    (0, y_feet + 0.35*h, s*0.14),    "spine"),
        (f"hand.{side}",  (0, y_feet + 0.35*h, s*0.14),    (0, y_feet + 0.18*h, s*0.15),    f"arm.{side}"),
    ]
rig = build_rig(scene, BONES)

# ---- weights: inverse-distance blend, restricted by height slices --------
# Same approach as rig_funky.py: each vertex gets a smooth blend of its
# nearest bone segments, restricted to bones that can own that region.
names = [n for n, *_ in BONES]
seg = {n: (np.array(h_, float), np.array(t_, float)) for n, h_, t_, _ in BONES}
# V is in Blender coords (from the imported GLB). The bones are specified in
# three.js coords, so convert V to three.js coords: (x, z, -y) since
# b(x,y,z) = (x,-z,y) means Blender(x,-z,y) = three.js(x,y,z).
# So three.js_x = Blender_x, three.js_y = Blender_z, three.js_z = -Blender_y.
V3 = np.column_stack([verts[:, 0], verts[:, 2], -verts[:, 1]])  # three.js coords
x, y, z = V3[:, 0], V3[:, 1], V3[:, 2]
az = np.abs(z)
nv = len(V3)

def seg_dist(a, e):
    ab = e - a
    t = np.clip(((V3 - a) @ ab) / (ab @ ab), 0.0, 1.0)
    return np.linalg.norm(V3 - (a + t[:, None] * ab), axis=1)

Wt = np.zeros((nv, len(names)))
for j, n in enumerate(names):
    ok = np.ones(nv, bool)
    if "." in n:
        ok &= (z > 0) if n.endswith(".L") else (z < 0)
    if n.startswith(("thigh", "shin", "foot")):
        ok &= (y < 0.45*h) | ((y < 0.42*h) & (az < 0.15))
    if n.startswith(("arm", "hand")):
        ok &= (y > 0.15*h) & (y < 0.60*h) & ((az > 0.10) | ((y < 0.40*h) & (az > 0.08)))
    if n == "hips":
        ok &= y < 0.55*h
    if n == "spine":
        ok &= (y > 0.35*h) & (y < 0.65*h)
    if n == "head":
        ok &= y > 0.45*h
    if n == "hat":
        ok &= y > 0.75*h
    Wt[:, j] = np.where(ok, 1.0 / (seg_dist(*seg[n]) + 0.012) ** 4, 0.0)

top = np.argsort(-Wt, axis=1)[:, :3]
for n in names:
    body.vertex_groups.new(name=n)
dominant = {n: 0 for n in names}
unweighted = 0
for i in range(nv):
    ws = Wt[i, top[i]]
    s = ws.sum()
    if s <= 0:
        unweighted += 1
        continue
    ws = ws / s
    keep = ws > 0.02
    ws = ws[keep] / ws[keep].sum()
    for j, w in zip(top[i][keep], ws):
        body.vertex_groups[names[j]].add([i], float(w), "REPLACE")
    dominant[names[top[i][0]]] += 1
body.parent = rig
mod = body.modifiers.new("Armature", "ARMATURE")
mod.object = rig
print("WEIGHTS", json.dumps({"unweighted": unweighted, "verts": nv, "dominant_per_bone": dominant}))

# ---- clips, posed renders, export -----------------------------------------
author_clips(rig, drop=h * 0.6)
shoot_poses(scene, rig, SHOTS, centre_z=h * 0.5, ortho=h * 0.75)
export_glb([body, rig], OUT)
