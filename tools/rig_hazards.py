"""Skeletons and clips for the three attackers, in Blender.

Gabriel 2026-09-11: "add the skeletons to the assets then". Meshy's auto-rig
refuses non-humanoid characters (it refused Funky with HTTP 422), so these are
rigged locally: a bone chain fitted to each creature's own long axis, weights
computed from distance along that chain, and one looping clip each.

  snake  spine chain -> a travelling sine wave (slither)
  bird   body + two wing bones -> flap, with a little pitch bob
  gator  spine chain + jaw -> tail sway, and the jaw opens now and then

Each model faces +Z (glTF forward) and its long axis is z; render3d turns it a
quarter at load, so the rig works in the model's own space here.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/rig_hazards.py
Outputs (candidates until reviewed):
  test-shots/hazards-rigged/<kind>-rigged.glb  + posed renders
"""
import bpy, json, math, os, sys
import numpy as np
from mathutils import Vector, Quaternion

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets/models/glb/fv")
OUT = os.environ.get("HZ_OUT", os.path.join(ROOT, "test-shots/hazards-rigged"))
FPS = 24

# Bones per kind: (name, head_t, tail_t) as fractions ALONG the model's z axis,
# plus how much of the body each one owns. Fitted to the real bounds at runtime.
# Gabriel 2026-09-12: "the bird bottom butt feathers on its end are flapping and
# they shouldnt, only birds main wings on the sides of them should flap".
#
# The wing test was off-centre ONLY: anything more than 18% of the width from the
# midline became a wing at 0.85 weight. The chain runs along the model's longest
# horizontal axis, which for a bird is the WINGSPAN (measured 1.902 vs a 1.536
# body), so the tail fans out in the same axis the test splits on and was caught
# with it - and the flap clip keys wingL/wingR with 24 keys, so the tail beat
# along with them.
#
# MEASURED per y-decile (0 = beak, 1 = tail): the head is narrow in x AND z
# (0.137-0.420 wide, off-centre p95 0.035-0.104); the wings are wide in x and
# THICK in z (1.724-1.902 wide, 1.161-1.189 tall) across 0.3-0.6; the tail is
# moderately wide but FLAT (0.721-0.919 wide, only 0.090-0.150 tall) from 0.6 on.
# z-height collapses 0.519 -> 0.150 at exactly 0.6, so that is the boundary.
BIRD_WING_END = 0.60      # body-axis fraction past which verts are tail, not wing

PLAN = {
    "snake": {"chain": 8, "clip": "slither", "frames": 48},
    "gator": {"chain": 5, "clip": "swim", "frames": 60},
    "bird":  {"chain": 2, "clip": "flap", "frames": 24},
}


def import_model(path):
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    if not meshes:
        raise SystemExit("no mesh in " + path)
    if len(meshes) > 1:                       # one skinned mesh is simpler to drive
        bpy.ops.object.select_all(action="DESELECT")
        for m in meshes:
            m.select_set(True)
        bpy.context.view_layer.objects.active = meshes[0]
        bpy.ops.object.join()
        meshes = [bpy.context.view_layer.objects.active]
    return meshes[0]


def bounds(obj):
    lo = Vector((1e9,) * 3)
    hi = Vector((-1e9,) * 3)
    for c in obj.bound_box:
        w = obj.matrix_world @ Vector(c)
        lo = Vector(map(min, lo, w))
        hi = Vector(map(max, hi, w))
    return lo, hi


def build_chain(scene, obj, kind, n):
    """A bone chain along the model's longest horizontal axis (Blender Y after
    the glTF import, which maps the model's +Z forward onto -Y)."""
    lo, hi = bounds(obj)
    span = hi - lo
    axis = 1 if abs(span.y) >= abs(span.x) else 0      # 0 = x, 1 = y
    a0, a1 = (lo[axis], hi[axis])
    mid = [(lo[i] + hi[i]) / 2 for i in range(3)]
    data = bpy.data.armatures.new(kind + "Rig")
    rig = bpy.data.objects.new(kind + "Rig", data)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    prev = None
    heads = []
    for i in range(n):
        t0, t1 = a0 + (a1 - a0) * i / n, a0 + (a1 - a0) * (i + 1) / n
        e = data.edit_bones.new(f"seg{i}")
        h = list(mid)
        h[axis] = t0
        t = list(mid)
        t[axis] = t1
        h[2] = t[2] = lo.z + (hi.z - lo.z) * 0.45      # run the chain mid-body
        e.head, e.tail = Vector(h), Vector(t)
        e.roll = 0.0
        if prev:
            e.parent = prev
            e.use_connect = True
        prev = e
        heads.append(t0)
    extras = {}
    if kind == "bird":
        for side, s in (("L", 1), ("R", -1)):
            w = data.edit_bones.new("wing" + side)
            wh = list(mid)
            wh[2] = lo.z + (hi.z - lo.z) * 0.6
            wt = list(wh)
            wt[0] = wh[0] + s * span.x * 0.45          # out along the wingspan
            w.head, w.tail = Vector(wh), Vector(wt)
            w.parent = data.edit_bones["seg0"]
            extras["wing" + side] = True
    if kind == "gator":
        j = data.edit_bones.new("jaw")
        jh = list(mid)
        jh[axis] = a0 + (a1 - a0) * 0.08
        jh[2] = lo.z + (hi.z - lo.z) * 0.35
        jt = list(jh)
        jt[axis] = a0
        j.head, j.tail = Vector(jh), Vector(jt)
        j.parent = data.edit_bones["seg0"]
        extras["jaw"] = True
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig, axis, (a0, a1), extras


def weight(obj, rig, axis, a0, a1, n, extras, kind):
    """Distance-along-the-chain weights, computed - bone heat is unreliable on
    a Meshy bake and there is nothing to salvage if it fails silently."""
    me = obj.data
    groups = {b.name: obj.vertex_groups.new(name=b.name) for b in rig.data.bones}
    span = (a1 - a0) or 1.0
    lo, hi = bounds(obj)
    for v in me.vertices:
        w = obj.matrix_world @ v.co
        t = (w[axis] - a0) / span                      # 0 at the nose, 1 at the tail
        f = min(max(t * n - 0.5, 0.0), n - 1.0)
        i0 = int(math.floor(f))
        i1 = min(i0 + 1, n - 1)
        frac = f - i0
        pairs = [(f"seg{i0}", 1.0 - frac), (f"seg{i1}", frac)]
        if kind == "bird" and abs(w.x - (lo.x + hi.x) / 2) > (hi.x - lo.x) * 0.18 \
                and (w.y - lo.y) / ((hi.y - lo.y) or 1.0) < BIRD_WING_END:
            side = "wingL" if w.x > (lo.x + hi.x) / 2 else "wingR"
            pairs = [(side, 0.85), ("seg0", 0.15)]
        if kind == "gator" and t < 0.16 and w.z < lo.z + (hi.z - lo.z) * 0.45:
            pairs = [("jaw", 0.9), ("seg0", 0.1)]      # lower jaw only
        for name, wt in pairs:
            if wt > 0.01:
                groups[name].add([v.index], float(wt), "REPLACE")
    obj.parent = rig
    obj.modifiers.new("Armature", "ARMATURE").object = rig


def key(rig, frame, pose):
    for pb in rig.pose.bones:
        pb.rotation_quaternion = pose.get(pb.name, Quaternion())
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)


def author(rig, kind, n, frames):
    act = bpy.data.actions.new(PLAN[kind]["clip"])
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    steps = 8
    for s in range(steps + 1):
        f = 1 + round((frames - 1) * s / steps)
        ph = 2 * math.pi * s / steps
        pose = {}
        if kind in ("snake", "gator"):
            amp = math.radians(22 if kind == "snake" else 9)
            for i in range(n):                          # a wave travelling down the body
                ang = amp * math.sin(ph - i * (1.4 if kind == "snake" else 0.8))
                pose[f"seg{i}"] = Quaternion((0, 0, 1), ang)
            if kind == "gator":
                bite = max(0.0, math.sin(ph * 2)) ** 6   # a snap now and then
                pose["jaw"] = Quaternion((1, 0, 0), math.radians(26) * bite)
        else:
            flap = math.sin(ph)
            pose["wingL"] = Quaternion((0, 1, 0), math.radians(38) * flap)
            pose["wingR"] = Quaternion((0, 1, 0), math.radians(-38) * flap)
            pose["seg0"] = Quaternion((1, 0, 0), math.radians(5) * math.sin(ph * 2))
        key(rig, f, pose)


def shoot(scene, kind, rig, frames):
    os.makedirs(OUT, exist_ok=True)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "TEXTURE"
    scene.view_settings.view_transform = "Standard"
    scene.render.resolution_x = scene.render.resolution_y = 520
    scene.world = bpy.data.worlds.new("W")
    scene.world.color = (0.22, 0.22, 0.24)
    cd = bpy.data.cameras.new("C")
    cd.type = "ORTHO"
    cd.ortho_scale = 2.8
    cam = bpy.data.objects.new("C", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    cam.location = Vector((-2.2, -2.4, 1.7))
    cam.rotation_euler = (Vector((0, 0, 0.2)) - cam.location).to_track_quat("-Z", "Y").to_euler()
    for f in (1, 1 + frames // 3, 1 + 2 * frames // 3):
        scene.frame_set(f)
        scene.render.filepath = os.path.join(OUT, f"{kind}-f{f:02d}.png")
        bpy.ops.render.render(write_still=True)


report = {}
for kind, plan in PLAN.items():
    src = os.path.join(SRC, f"{kind}.glb")
    obj = import_model(src)
    scene = bpy.context.scene
    scene.render.fps = FPS
    n = plan["chain"]
    rig, axis, (a0, a1), extras = build_chain(scene, obj, kind, n)
    weight(obj, rig, axis, a0, a1, n, extras, kind)
    author(rig, kind, n, plan["frames"])
    shoot(scene, kind, rig, plan["frames"])
    os.makedirs(OUT, exist_ok=True)
    dest = os.path.join(OUT, f"{kind}-rigged.glb")
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    rig.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=dest, export_format="GLB", use_selection=True,
        export_yup=True, export_skins=True, export_animations=True,
        export_animation_mode="ACTIONS", export_force_sampling=True,
        export_normals=True, export_apply=False)
    unweighted = sum(1 for v in obj.data.vertices if not v.groups)
    report[kind] = {"bones": len(rig.data.bones), "clip": plan["clip"],
                    "verts": len(obj.data.vertices), "unweighted": unweighted,
                    "bytes": os.path.getsize(dest)}
print("RIGGED " + json.dumps(report))
