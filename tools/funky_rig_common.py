"""Shared Blender pieces for Funky's rigs: skeleton, the hop / idle / dance
clips, posed renders and GLB export. Used by tools/rig_funky.py (the TRELLIS
bake, computed weights) and tools/make_funky.py (the voxel rebuild, rigid
parts), so both characters move identically and a clip is tuned in one place.

Coordinates: callers give bones in three.js space (Y up, the character faces
-X, side-to-side is z). b() converts to Blender (Z up); the glTF exporter
converts straight back, so the game's placement code needs no changes.
Import inside Blender only (needs bpy).
"""
import bpy, math, os
from mathutils import Vector, Quaternion

FPS = 24
SIDE = Vector((0, 1, 0))     # rotation about this swings a hanging limb; +deg = forward (-X)
FWD = Vector((-1, 0, 0))     # rotation about this rolls sideways
UP = Vector((0, 0, 1))


def b(x, y, z):
    """three.js (Y up) -> Blender (Z up)."""
    return Vector((x, -z, y))


def build_rig(scene, bones):
    """bones: [(name, head, tail, parent_or_None)] in three.js coords."""
    data = bpy.data.armatures.new("FunkyRig")
    rig = bpy.data.objects.new("FunkyRig", data)
    scene.collection.objects.link(rig)
    bpy.context.view_layer.objects.active = rig
    bpy.ops.object.mode_set(mode="EDIT")
    eb = {}
    for name, h, t, parent in bones:
        e = data.edit_bones.new(name)
        e.head, e.tail = b(*h), b(*t)
        e.roll = 0.0
        if parent:
            e.parent = eb[parent]
            e.use_connect = False
        eb[name] = e
    bpy.ops.object.mode_set(mode="OBJECT")
    for pb in rig.pose.bones:
        pb.rotation_mode = "QUATERNION"
    return rig


def _pose_q(rig, bone_name, rots):
    # WORLD-axis rotations turned into the bone's rest frame, so "swing forward"
    # means the same for an arm and a leg regardless of bone roll.
    rest = rig.data.bones[bone_name].matrix_local.to_3x3()
    q = Quaternion()
    for axis, deg in rots:
        q = Quaternion(axis, math.radians(deg)) @ q
    return (rest.inverted() @ q.to_matrix() @ rest).to_quaternion()


def _key(rig, frame, pose, hips_drop=0.0):
    """pose: {bone: [(axis, deg), ...]} - bones not listed return to rest."""
    for pb in rig.pose.bones:
        pb.rotation_quaternion = _pose_q(rig, pb.name, pose.get(pb.name, []))
        pb.keyframe_insert("rotation_quaternion", frame=frame, group=pb.name)
    hips = rig.pose.bones["hips"]
    hips.location = (0.0, -hips_drop, 0.0)     # hips bone Y points up the body
    hips.keyframe_insert("location", frame=frame, group="hips")


def _limbs(thigh=0, shin=0, foot=0, arm=0, hand=0, arm_out=0, mirror_arm=None):
    p = {}
    for side, s in (("L", 1), ("R", -1)):
        p[f"thigh.{side}"] = [(SIDE, thigh)]
        p[f"shin.{side}"] = [(SIDE, shin)]
        p[f"foot.{side}"] = [(SIDE, foot)]
        a = arm if mirror_arm is None else (arm if side == "L" else mirror_arm)
        p[f"arm.{side}"] = [(SIDE, a), (FWD, s * arm_out)]
        p[f"hand.{side}"] = [(SIDE, hand)]
    return p


def _new_action(rig, name):
    act = bpy.data.actions.new(name)
    act.use_fake_user = True
    rig.animation_data_create()
    rig.animation_data.action = act
    return act


# Arm angles per key: (forward swing, outward throw). "fused" is for a mesh whose
# arms are welded to the torso (the TRELLIS bake): kept under ~115 deg and only
# a little outward, or the upper arm drags torso skin. "free" is for rigid parts
# (the voxel rebuild): arms thrown OUT to the sides, so a jump never swings them
# up across his face and glasses.
ARMS = {
    "fused": {"takeoff": (100, 30), "apex": (110, 40), "reach": (60, 28), "dance": (115, 38)},
    "free":  {"takeoff": (55, 70),  "apex": (65, 85),  "reach": (35, 55), "dance": (95, 70)},
}


def author_clips(rig, drop=1.0, arms="fused"):
    """The three clips the game plays. drop scales the hip dip to body size."""
    k = lambda f, pose, d=0.0: _key(rig, f, pose, d * drop)
    L = _limbs
    A = ARMS[arms]
    # Arm angles stay at or under ~115 deg and lean OUTWARD (arm_out): on the
    # TRELLIS bake the arms are fused into the torso, and at 150-160 deg the
    # upper arm dragged torso skin into a diagonal sheet down his side.
    # HOP - 24 frames (1s), SCRUBBED by the game across each 200ms hop:
    # 1 push-off crouch, 6 take-off arms up, 12 tucked apex, 19 reach, 24 land.
    _new_action(rig, "hop")
    k(1,  dict(L(thigh=28, shin=-55, foot=27, arm=-35, hand=-10), spine=[(SIDE, 8)]), 0.05)
    k(6,  dict(L(thigh=-18, shin=6, foot=-20, arm=A['takeoff'][0], hand=18, arm_out=A['takeoff'][1]),
               spine=[(SIDE, -6)], head=[(SIDE, -8)]), -0.01)
    k(12, dict(L(thigh=48, shin=-78, foot=30, arm=A['apex'][0], hand=15, arm_out=A['apex'][1]),
               spine=[(SIDE, 4)], hat=[(SIDE, -12)]))
    k(19, dict(L(thigh=14, shin=-16, foot=4, arm=A['reach'][0], hand=10, arm_out=A['reach'][1]),
               spine=[(SIDE, 2)], hat=[(SIDE, 10)]))
    k(24, dict(L(thigh=30, shin=-58, foot=28, arm=-12, hand=-6),
               spine=[(SIDE, 7)], hat=[(SIDE, 6)]), 0.05)
    # IDLE - 2s loop, first frame == last so it cycles cleanly.
    _new_action(rig, "idle")
    for f, ph in ((1, 0), (13, 1), (25, 2), (37, 3), (49, 0)):
        s, c = math.sin(ph * math.pi / 2), math.cos(ph * math.pi / 2)
        k(f, dict(L(arm=6 * s, hand=4 * s, arm_out=3 + 2 * c, mirror_arm=-6 * s),
                  spine=[(FWD, 3 * s)], head=[(UP, 6 * c), (FWD, -2 * s)], hat=[(FWD, 4 * s)]))
    # DANCE - the portal celebration: alternate arm pumps, hip sway, knee bounce.
    _new_action(rig, "dance")
    for i in range(13):
        up = i % 2 == 0
        k(1 + i * 5, dict(
            L(thigh=18 if up else 4, shin=-32 if up else -8, foot=14 if up else 4,
              arm=A['dance'][0] if up else -20, hand=20, arm_out=A['dance'][1],
              mirror_arm=-20 if up else A['dance'][0]),
            hips=[(FWD, 8 if up else -8)], spine=[(FWD, -5 if up else 5)],
            head=[(UP, 14 if up else -14), (FWD, 6 if up else -6)],
            hat=[(FWD, -10 if up else 10)]), 0.04 if up else 0.0)
    rig.animation_data.action = bpy.data.actions["idle"]


def shoot_poses(scene, rig, shots_dir, centre_z=0.55, ortho=1.45,
                poses=(("hop", (1, 6, 12, 19)), ("dance", (1, 6))), res=420, bg=None):
    """Workbench renders of rest + posed frames, front (-X) and side views.
    res/bg let a caller frame renders pixel-for-pixel like its reference art."""
    os.makedirs(shots_dir, exist_ok=True)
    scene.render.engine = "BLENDER_WORKBENCH"
    scene.display.shading.light = "STUDIO"
    scene.display.shading.color_type = "VERTEX"
    scene.render.resolution_x = scene.render.resolution_y = res
    scene.world = bpy.data.worlds.new("W")
    if bg is not None:
        scene.world.color = bg
    cd = bpy.data.cameras.new("Cam")
    cd.type, cd.ortho_scale = "ORTHO", ortho
    cam = bpy.data.objects.new("Cam", cd)
    scene.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0, 0, centre_z))
    views = {"front": Vector((-3, 0, centre_z)), "side": Vector((0, -3, centre_z))}

    def shoot(tag):
        for vname, pos in views.items():
            cam.location = pos
            cam.rotation_euler = (target - pos).to_track_quat("-Z", "Y").to_euler()
            scene.render.filepath = os.path.join(shots_dir, f"{tag}-{vname}.png")
            bpy.ops.render.render(write_still=True)

    rig.animation_data.action = None
    for pb in rig.pose.bones:
        pb.rotation_quaternion = Quaternion()
        pb.location = (0, 0, 0)
    shoot("rest")
    for act, frames in poses:
        rig.animation_data.action = bpy.data.actions[act]
        for f in frames:
            scene.frame_set(f)
            shoot(f"{act}-f{f:02d}")
    rig.animation_data.action = bpy.data.actions["idle"]
    scene.frame_set(1)
    bpy.data.objects.remove(cam)


def export_glb(objects, out_path):
    bpy.ops.object.select_all(action="DESELECT")
    for o in objects:
        o.select_set(True)
    bpy.ops.export_scene.gltf(
        filepath=out_path, export_format="GLB", use_selection=True,
        export_yup=True, export_skins=True, export_animations=True,
        export_animation_mode="ACTIONS", export_force_sampling=True,
        export_vertex_color="ACTIVE", export_normals=True, export_apply=False)
    print("EXPORTED", out_path, os.path.getsize(out_path))
