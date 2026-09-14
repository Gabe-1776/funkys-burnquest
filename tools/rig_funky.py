"""Rig Funky locally in Blender and author his hop / idle / dance clips.

Why: the funkyverse Funky (assets/models/fv/funky.json, the TRELLIS bake of
Grok Build's concept-4 voxel frog) is one unrigged mesh, so the game could only
squash it. Gabriel (2026-09-11): "he needs better movement lol like his legs
moving and arms". The Meshy auto-rig route is ready (tools/meshy_character_rig.py)
but spends credits; this is the free, local route - a skeleton fitted to the
MEASURED body, Blender's bone-heat weights, and hand-keyed clips.

The mesh is built from the same JSON the game draws, in the same coordinates,
so the renderer's placement code (feet at the rig origin, faceOffset -PI/2 ->
the model faces -X) applies unchanged.

Measured landmarks (height slices of funky.json, 1.1 tall, faces -X, side = z):
  feet  y 0.00-0.09, two blocks either side of z +-0.05
  legs  y 0.09-0.37, separate at z +-0.07..0.14
  hands hang at |z| 0.20-0.23 down to y ~0.18; arms merge with torso 0.37-0.55
  head/glasses/brim 0.55-0.92, hat 0.92-1.10

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/rig_funky.py
Outputs:
  assets/models/glb/fv/funky-rigged.glb   skinned mesh + actions idle/hop/dance
  test-shots/rig/*.png                    posed frames, rendered in Blender
Weights are computed from the measured anatomy (see below): Blender's bone
heat cannot solve this mesh.
"""
import bpy, json, os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from funky_rig_common import FPS, b, build_rig, author_clips, shoot_poses, export_glb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets/models/fv/funky.json")
OUT = os.environ.get("FUNKY_OUT", os.path.join(ROOT, "assets/models/glb/fv/funky-rigged.glb"))
SHOTS = os.environ.get("FUNKY_SHOTS", os.path.join(ROOT, "test-shots/rig"))

# ---- scene ---------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS

# ---- mesh from the game's own JSON --------------------------------------
d = json.load(open(SRC))
P, N, I, C = d["positions"], d["normals"], d["indices"], d["colors"]
nv = len(P) // 3
verts = [b(P[3*i], P[3*i+1], P[3*i+2]) for i in range(nv)]
faces = [(I[k], I[k+1], I[k+2]) for k in range(0, len(I), 3)]
me = bpy.data.meshes.new("Funky")
me.from_pydata([tuple(v) for v in verts], [], faces)
me.update()
me.normals_split_custom_set_from_vertices(
    [tuple(b(N[3*i], N[3*i+1], N[3*i+2]).normalized()) for i in range(nv)])
col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
for i in range(nv):
    col.data[i].color = (C[3*i], C[3*i+1], C[3*i+2], 1.0)
me.color_attributes.active_color = col
body = bpy.data.objects.new("Funky", me)
scene.collection.objects.link(body)

# Base colour comes from the vertex colours, exactly as the JSON path draws it.
mat = bpy.data.materials.new("FunkyMat")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
vc = nt.nodes.new("ShaderNodeVertexColor")
vc.layer_name = "Col"
nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.6
me.materials.append(mat)

# ---- skeleton, fitted to the measured slices ----------------------------
# (name, head, tail, parent) in three.js coords. Knees carry a slight forward
# (-x) bend at rest so they fold the right way.
BONES = [
    ("hips",    (0.0, 0.36, 0.0),    (0.0, 0.46, 0.0),    None),
    ("spine",   (0.0, 0.46, 0.0),    (0.0, 0.56, 0.0),    "hips"),
    ("head",    (0.0, 0.56, 0.0),    (0.0, 0.92, 0.0),    "spine"),
    ("hat",     (0.0, 0.92, 0.0),    (0.0, 1.10, 0.0),    "head"),
]
for side, s in (("L", 1.0), ("R", -1.0)):
    BONES += [
        (f"thigh.{side}", (0.0, 0.37, s*0.10),   (-0.015, 0.21, s*0.10), "hips"),
        (f"shin.{side}",  (-0.015, 0.21, s*0.10), (0.0, 0.07, s*0.11),   f"thigh.{side}"),
        (f"foot.{side}",  (0.0, 0.07, s*0.11),   (-0.07, 0.02, s*0.12),  f"shin.{side}"),
        (f"arm.{side}",   (0.0, 0.53, s*0.17),   (0.0, 0.36, s*0.20),    "spine"),
        (f"hand.{side}",  (0.0, 0.36, s*0.20),   (0.0, 0.18, s*0.215),   f"arm.{side}"),
    ]
rig = build_rig(scene, BONES)

# ---- weights: measured anatomy, not bone heat ------------------------------
# Blender's bone heat FAILED on this mesh: "failed to find solution for one or
# more bones", 9678 of 9678 verts unweighted. A TRELLIS bake is thousands of
# split-normal islands, which heat diffusion cannot solve across. So each
# vertex gets a smooth inverse-distance blend of its nearest bone SEGMENTS,
# restricted to the bones that can own that region (from the measured gaps:
# legs separate at |z| 0.07..0.14, hands hang at |z| > 0.165 below y 0.37).
# The weights stay continuous - no vertex is snapped to a part - which is the
# lesson from the wheel split that smeared the cars.
import numpy as np
names = [n for n, *_ in BONES]
seg = {n: (np.array(h, float), np.array(t, float)) for n, h, t, _ in BONES}
V = np.array(P, dtype=float).reshape(-1, 3)
x, y, z = V[:, 0], V[:, 1], V[:, 2]
az = np.abs(z)

def seg_dist(a, e):
    ab = e - a
    t = np.clip(((V - a) @ ab) / (ab @ ab), 0.0, 1.0)
    return np.linalg.norm(V - (a + t[:, None] * ab), axis=1)

W = np.zeros((nv, len(names)))
for j, n in enumerate(names):
    ok = np.ones(nv, bool)
    if "." in n:
        ok &= (z > 0) if n.endswith(".L") else (z < 0)
    if n.startswith(("thigh", "shin", "foot")):
        ok &= (y < 0.14) | ((y < 0.42) & (az < 0.165))
    if n.startswith(("arm", "hand")):
        ok &= (y > 0.15) & (y < 0.58) & ((az > 0.165) | ((y < 0.37) & (az > 0.14)))
    if n == "hips":
        ok &= y < 0.52
    if n == "spine":
        ok &= (y > 0.36) & (y < 0.66)
    if n == "head":
        ok &= y > 0.50
    if n == "hat":
        ok &= y > 0.88
    W[:, j] = np.where(ok, 1.0 / (seg_dist(*seg[n]) + 0.012) ** 4, 0.0)

top = np.argsort(-W, axis=1)[:, :3]          # at most 3 influences per vertex
for n in names:
    body.vertex_groups.new(name=n)
dominant = {n: 0 for n in names}
unweighted = 0
for i in range(nv):
    ws = W[i, top[i]]
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

# ---- clips, posed renders, export (shared with tools/make_funky.py) -------
author_clips(rig)
shoot_poses(scene, rig, SHOTS)
export_glb([body, rig], OUT)
