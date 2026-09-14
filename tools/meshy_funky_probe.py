"""Report what Meshy actually delivered for Funky, before integrating it.

The game drives ONE GLB with clips named idle / hop / dance, facing -X, 1.1
units tall, feet at y 0 (see render3d installRiggedCharacter). Meshy's output
differs on every one of those: its models face +Z, its rig has its own bone
set, each animation arrives as a separate GLB, and a jump clip may carry root
motion that would double up with the game's own hop. So this only READS the
files tools/meshy_character_rig.py downloaded and prints the facts the combine
step needs: bones, facing, size, clip lengths and root travel.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/meshy_funky_probe.py
"""
import bpy, json, os
from mathutils import Vector

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
D = os.path.join(ROOT, "test-shots/meshy-out/funkyverse/funky-rig")
FILES = ["rigged.glb", "anim-walking.glb", "anim-running.glb",
         "anim-jump.glb", "anim-hop.glb", "anim-idle.glb", "anim-dance.glb"]


def world_bbox(objs):
    lo, hi = Vector((1e9,) * 3), Vector((-1e9,) * 3)
    for o in objs:
        for c in o.bound_box:
            w = o.matrix_world @ Vector(c)
            lo = Vector(map(min, lo, w)); hi = Vector(map(max, hi, w))
    return lo, hi


report = {}
for f in FILES:
    path = os.path.join(D, f)
    if not os.path.exists(path):
        report[f] = "missing"
        continue
    bpy.ops.wm.read_factory_settings(use_empty=True)
    bpy.ops.import_scene.gltf(filepath=path)
    arms = [o for o in bpy.context.scene.objects if o.type == "ARMATURE"]
    meshes = [o for o in bpy.context.scene.objects if o.type == "MESH"]
    r = {"armatures": len(arms), "meshes": len(meshes),
         "tris": sum(sum(len(p.vertices) - 2 for p in m.data.polygons) for m in meshes)}
    if meshes:
        lo, hi = world_bbox(meshes)
        r["bbox_blender"] = [[round(v, 3) for v in lo], [round(v, 3) for v in hi]]
        r["height"] = round(hi.z - lo.z, 3)
    if arms:
        a = arms[0]
        bones = [b.name for b in a.data.bones]
        r["bones"] = len(bones)
        r["bone_names"] = bones[:40]
        # facing hint: where the head/nose-ish bones sit relative to the hips
        byname = {b.name.lower(): b for b in a.data.bones}
        hips = next((b for n, b in byname.items() if "hip" in n or "pelvis" in n), None)
        head = next((b for n, b in byname.items() if "head" in n and "end" not in n), None)
        if hips and head:
            r["hips_head_local"] = [round(v, 3) for v in hips.head_local]
            r["head_head_local"] = [round(v, 3) for v in head.head_local]
    acts = []
    for act in bpy.data.actions:
        fr = act.frame_range
        root_travel = None
        for fc in act.fcurves:
            if fc.data_path.endswith("location") and ("hip" in fc.data_path.lower() or "pelvis" in fc.data_path.lower()):
                vals = [k.co[1] for k in fc.keyframe_points]
                if vals:
                    root_travel = (root_travel or {})
                    root_travel[f"{fc.data_path.split('\"')[1] if '\"' in fc.data_path else 'root'}[{fc.array_index}]"] = \
                        round(max(vals) - min(vals), 3)
        acts.append({"name": act.name, "frames": [round(fr[0]), round(fr[1])],
                     "seconds": round((fr[1] - fr[0]) / bpy.context.scene.render.fps, 2),
                     "root_travel": root_travel})
    r["actions"] = acts
    report[f] = r
print("PROBE " + json.dumps(report, indent=1))
