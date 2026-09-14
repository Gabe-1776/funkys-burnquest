"""Rig the NEW Funky (Grok Build's locked plates -> Meshy) for the game.

Gabriel picked this one over the voxel build (2026-09-11). It arrives as a bare
model, so it gets the same treatment the voxel Funky had: a 14-bone skeleton and
the shared idle / hop / dance clips (tools/funky_rig_common.py), which means
render3d needs no changes - it loads fv/funky-rigged.glb and plays clips by name.

Landmarks are MEASURED from this mesh, not copied from the voxel Funky: this
frog is slimmer with much longer legs, and reusing the old numbers would put the
knees in his shins. Weights are computed (distance to bone segments, restricted
to the region each bone can own) because bone heat fails silently on a Meshy
bake - it left 9678/9678 verts unweighted on the TRELLIS Funky.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/rig_funky_meshy.py
Outputs:
  test-shots/funky-meshy/funky-rigged.glb   (candidate; copy over fv/ when reviewed)
  test-shots/funky-meshy/*.png              posed frames
"""
import bpy, json, math, os, sys
import numpy as np
from mathutils import Vector, Matrix
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from funky_rig_common import FPS, b, build_rig, author_clips, shoot_poses, export_glb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.environ.get("FUNKY_SRC", os.path.join(ROOT, "test-shots/meshy-out/hazards/funky.glb"))
OUT = os.environ.get("FUNKY_OUT", os.path.join(ROOT, "test-shots/funky-meshy/funky-rigged.glb"))
SHOTS = os.environ.get("FUNKY_SHOTS", os.path.join(ROOT, "test-shots/funky-meshy"))
HEIGHT = 1.1                      # the board's character height

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
bpy.ops.import_scene.gltf(filepath=SRC)
meshes = [o for o in scene.objects if o.type == "MESH"]
if len(meshes) > 1:
    bpy.ops.object.select_all(action="DESELECT")
    for m in meshes:
        m.select_set(True)
    bpy.context.view_layer.objects.active = meshes[0]
    bpy.ops.object.join()
body = bpy.context.view_layer.objects.active if len(meshes) > 1 else meshes[0]
body.name = "Funky"

# ---- normalise: face -X, 1.1 tall, feet on the ground ----------------------
# glTF +Z forward imports as Blender -Y; the game's character faces three -X
# (theme.characterFaceOffset), which is Blender -X. -90 deg about Z does it.
# MEASURED: the shipped voxel FunkyRig has left/right on z (thigh.L +0.093 /
# thigh.R -0.093, hand.L +0.203 / hand.R -0.203) and toes pointing -x (foot.L
# tail x -0.044). The Meshy Funky arrives facing +z with left/right on x, so he
# needs a further -90 on top of the original -90. -90 alone laid every .L/.R mask
# across his front-to-back axis: thigh.L got 17 verts against thigh.R's 1576, and
# hand.L got none. Both renders showed it too - 'front' came out as a side view.
# Rotate the MESH DATA, not the object. Setting rotation_euler leaves
# matrix_world stale until the depsgraph updates, so transform_apply baked an
# identity matrix and returned {'FINISHED'} - measured: every angle, including
# +0, produced the same spans (1.068, 0.716, 1.902) and the same foot gap on x.
# The -90 was right all along; it simply never took effect.
# Verified after this change: toes point -x (foot-vs-shin dx -0.151) and the
# feet split evenly on z (657 / 683 at +-0.278), matching the shipped voxel
# FunkyRig (thigh.L +0.093 / thigh.R -0.093, foot.L tail x -0.044).
body.data.transform(Matrix.Rotation(math.radians(-90), 4, 'Z'))
body.data.update()


def bbox():
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for c in body.bound_box:
        w = body.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
    return lo, hi


lo, hi = bbox()
s = HEIGHT / (hi.z - lo.z)
body.scale = (s, s, s)
bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
lo, hi = bbox()
body.location = (-(lo.x + hi.x) / 2, -(lo.y + hi.y) / 2, -lo.z)
bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
lo, hi = bbox()
print("NORMALISED", {"bbox": [round(v, 3) for v in (hi - lo)], "scale": round(s, 4)})

# ---- measure the landmarks off the mesh ------------------------------------
# three.js coords for the rig: x = blender x, y = blender z, z = -blender y.
V = np.array([[(body.matrix_world @ v.co).x, (body.matrix_world @ v.co).z,
               -(body.matrix_world @ v.co).y] for v in body.data.vertices])
X, Y, Z = V[:, 0], V[:, 1], V[:, 2]


def band(lo_y, hi_y):
    return V[(Y >= lo_y) & (Y < hi_y)]


def gap_split(sl, axis=2, min_gap=0.012):
    """Is this slice two separate limbs? Returns the inner edge if so."""
    vals = np.sort(np.unique(np.round(sl[:, axis], 3)))
    if len(vals) < 3:
        return None
    gaps = [(vals[i], vals[i + 1]) for i in range(len(vals) - 1) if vals[i + 1] - vals[i] > min_gap]
    mid = [g for g in gaps if g[0] < 0 < g[1]]
    return mid[0] if mid else None


# MEASURED off this mesh (see the vertical profile, 2026-09-11). The first
# attempt guessed with heuristics and got both ends wrong: "lowest left/right
# gap" found the ARM gap at 0.53 and called it the crotch, and the neck
# detector fired inside the head, so head+hat took 69% of the mesh and the
# hands took none. The profile is unambiguous, so read the bands directly:
#   0.00-0.05  feet, splayed toes (x +-0.31)
#   0.05-0.25  thin shins (55-88 verts a band, |z| ~0.08)
#   0.25-0.50  hips, torso and the arms hanging out to |z| 0.20
#   0.50-0.55  the torso narrows into the neck
#   0.55-0.70  head (the dense bands: 2048 + 3664 + 2030 verts)
#   0.70-0.80  hat brim, the widest upper band (|z| up to 0.207)
#   0.80-1.10  crown
def widest(lo_y, hi_y, step=0.02):
    best = (lo_y, 0.0)
    for t in np.arange(lo_y, hi_y, step):
        sl = band(t, t + step)
        if not len(sl):
            continue
        w = float(np.percentile(np.abs(sl[:, 2]), 95))
        if w > best[1]:
            best = (round(float(t), 3), w)
    return best

def density(lo_y, hi_y, step=0.05):
    return [(round(float(t), 3), len(band(t, t + step))) for t in np.arange(lo_y, hi_y, step)]

# head = the densest run below the brim; brim = widest band above the head
head_bands = density(0.45, 0.80)
head_peak = max(head_bands, key=lambda r: r[1])[0]
brim = widest(head_peak + 0.08, 0.92)[0]
# neck: walk down from the head peak until the slice narrows to a third of it
head_w = float(np.percentile(np.abs(band(head_peak, head_peak + 0.05)[:, 2]), 95))
neck = round(head_peak - 0.05, 3)
for t in np.arange(head_peak - 0.05, 0.32, -0.02):  # below the head, same band width
    sl = band(t, t + 0.05)
    if not len(sl):
        continue
    if float(np.percentile(np.abs(sl[:, 2]), 95)) < head_w * 0.72:
        neck = round(float(t) + 0.05, 3)
        break
# legs: the thin lower column, measured BELOW the torso so arms cannot pollute it
shin = band(0.10, 0.24)
leg_z = float(np.percentile(np.abs(shin[:, 2]), 60)) if len(shin) else 0.06
leg_top = 0.0
for t in np.arange(0.20, 0.45, 0.02):                 # hips: where the body widens out
    sl = band(t, t + 0.04)
    if len(sl) and float(np.percentile(np.abs(sl[:, 2]), 95)) > leg_z * 1.9:
        leg_top = round(float(t), 3)
        break
leg_top = leg_top or 0.28
foot = band(0.0, 0.05)
foot_x = float(np.percentile(foot[:, 0], 10)) if len(foot) else -0.12
# hands: outermost verts in the arm band, which sits ABOVE the hips
arm_band = band(leg_top + 0.05, neck - 0.03)
hand_z = float(np.percentile(np.abs(arm_band[:, 2]), 99.5)) if len(arm_band) else 0.20
L = {"leg_top": leg_top, "leg_z": round(leg_z, 3), "foot_x": round(foot_x, 3),
     "hand_z": round(hand_z, 3), "brim": brim, "neck": neck, "head_peak": head_peak}
print("LANDMARKS", json.dumps(L))

hips_y, spine_y = leg_top, (leg_top + neck) / 2
knee_y, ankle_y = leg_top * 0.60, 0.06
BONES = [
    ("hips",  (0.0, hips_y * 0.85, 0.0), (0.0, hips_y, 0.0), None),
    ("spine", (0.0, hips_y, 0.0),        (0.0, spine_y, 0.0), "hips"),
    ("head",  (0.0, neck, 0.0),          (0.0, brim, 0.0),    "spine"),
    ("hat",   (0.0, brim, 0.0),          (0.0, HEIGHT, 0.0),  "head"),
]
for sd, sgn in (("L", 1.0), ("R", -1.0)):
    BONES += [
        (f"thigh.{sd}", (0.0, hips_y, sgn * leg_z),   (0.0, knee_y, sgn * leg_z),  "hips"),
        (f"shin.{sd}",  (0.0, knee_y, sgn * leg_z),     (0.0, ankle_y, sgn * leg_z), f"thigh.{sd}"),
        (f"foot.{sd}",  (0.0, ankle_y, sgn * leg_z),  (foot_x, 0.02, sgn * leg_z), f"shin.{sd}"),
        (f"arm.{sd}",   (0.0, spine_y, sgn * hand_z * 0.72), (0.0, (spine_y + hips_y) / 2, sgn * hand_z * 0.9), "spine"),
        (f"hand.{sd}",  (0.0, (spine_y + hips_y) / 2, sgn * hand_z * 0.9), (0.0, hips_y * 0.92, sgn * hand_z), f"arm.{sd}"),
    ]

rig = build_rig(scene, BONES)

# ---- weights: distance to bone segments, region-limited --------------------
names = [n for n, *_ in BONES]
seg = {n: (np.array(h, float), np.array(t, float)) for n, h, t, _ in BONES}


def seg_dist(a, e):
    ab = e - a
    t = np.clip(((V - a) @ ab) / max(float(ab @ ab), 1e-9), 0.0, 1.0)
    return np.linalg.norm(V - (a + t[:, None] * ab), axis=1)


W = np.zeros((len(V), len(names)))
az = np.abs(Z)
for j, n in enumerate(names):
    ok = np.ones(len(V), bool)
    if "." in n:
        ok &= (Z > 0) if n.endswith(".L") else (Z < 0)
    if n.startswith(("thigh", "shin", "foot")):
        ok &= (Y < leg_top + 0.03) & (az < hand_z * 0.75)
    if n.startswith(("arm", "hand")):
        ok &= (Y > leg_top) & (Y < neck) & (az > hand_z * 0.55)
    if n == "hips":
        ok &= Y < spine_y
    if n == "spine":
        ok &= (Y > hips_y * 0.8) & (Y < neck + 0.03)
    if n == "head":
        ok &= Y > neck - 0.03
    if n == "hat":
        ok &= Y > brim - 0.02
    W[:, j] = np.where(ok, 1.0 / (seg_dist(*seg[n]) + 0.012) ** 4, 0.0)

top = np.argsort(-W, axis=1)[:, :3]
groups = {n: body.vertex_groups.new(name=n) for n in names}
dominant = {n: 0 for n in names}
unweighted = 0
for i in range(len(V)):
    ws = W[i, top[i]]
    tot = ws.sum()
    if tot <= 0:
        unweighted += 1
        continue
    ws = ws / tot
    keep = ws > 0.02
    ws = ws[keep] / ws[keep].sum()
    for j, w in zip(top[i][keep], ws):
        groups[names[j]].add([i], float(w), "REPLACE")
    dominant[names[top[i][0]]] += 1
body.parent = rig
body.modifiers.new("Armature", "ARMATURE").object = rig
print("WEIGHTS", json.dumps({"verts": len(V), "unweighted": unweighted, "dominant": dominant}))

author_clips(rig, arms="fused")
shoot_poses(scene, rig, SHOTS, centre_z=0.55, ortho=1.45,
            poses=(("hop", (1, 6, 12)), ("dance", (1,))))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
export_glb([body, rig], OUT)
