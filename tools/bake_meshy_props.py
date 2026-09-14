"""Bake Meshy isolate GLBs (test-shots/meshy-out) into the game's JSON slots.

Reuses the proven helpers from bake_trellis_glb.py (import, join, scale/origin,
texture->vertex-color, compact JSON export). Run headless:

  /Applications/Blender.app/Contents/MacOS/Blender -b -t 2 --python tools/bake_meshy_props.py

Conventions (match assets/models/*.json authored by bake_trellis_glb):
  vehicles  length 1.0 along X, grounded, front toward -X (yaw fixed per job
            after the browser facing check)
  character fv height 1.10; diorama frog footprint 0.75 (squat toy)
  floats    log/lilypad/turtle/portal-ring are Y-CENTERED (the loader offsets
            the group, not the mesh)
Facing is verified in the browser after the first pass; adjust rotate_z here.
"""
import bpy
import json
import math
import os
import sys

sys.path.insert(0, os.path.expanduser("~/Developer/funkys-burnquest/tools"))
from bake_trellis_glb import (  # noqa: E402  (proven helpers, reused as-is)
    reset_scene, import_glb, join_meshes, origin_at_base_and_scale,
    bake_vertex_colors, export_json, apply_rot_z, world_bounds, ensure_active,
    dims,
)

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
MSH = "test-shots/meshy-out"

# rotate_z is in Blender space around the up axis; fixed after visual check.
JOBS = [
    # --- diorama ---
    # dio-frog is DELIBERATELY not baked. Gabriel picked the original rounded
    # authored frog over Meshy's blocky one for the diorama theme ("the block
    # looking one im not vibing with"), and diorama/funky.json holds that
    # authored mesh restored from b719f7d. Re-adding this job silently replaces
    # his choice on the next rebake - which is exactly how it came back once.
    # The source GLB is kept at test-shots/meshy-out/diorama/frog.glb.
    {"id": "dio-truck-blue", "glb": f"{MSH}/diorama/truck-blue.glb", "out": "diorama/truck-blue",   "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "dio-wagon-lime", "glb": f"{MSH}/diorama/wagon-lime.glb", "out": "diorama/wagon-lime",   "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "dio-wagon-red",  "glb": f"{MSH}/diorama/wagon-red.glb",  "out": "diorama/wagon-red",    "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "dio-turtle",     "glb": f"{MSH}/diorama/turtle.glb",     "out": "diorama/turtle",       "kind": "prop",   "target": 0.95, "center_y": True},
    {"id": "dio-lily",       "glb": f"{MSH}/diorama/lily.glb",       "out": "diorama/lilypad",      "kind": "prop",   "target": 1.00, "center_y": True},
    {"id": "dio-log",        "glb": f"{MSH}/diorama/log.glb",        "out": "diorama/log",          "kind": "car",    "target": 1.00, "center_y": True},
    {"id": "dio-portal",     "glb": f"{MSH}/diorama/portal.glb",     "out": "diorama/portal-vortex","kind": "portal", "target": 0.72, "center_y": True},
    {"id": "fv-funky",       "glb": f"{MSH}/funkyverse/funky-c4.glb","out": "fv/funky",             "kind": "character", "target": 1.10, "center_y": False, "rotate_z": -math.pi / 2},
    {"id": "fv-muscle",      "glb": f"{MSH}/funkyverse/muscle-flame.glb", "out": "fv/muscle-flame", "kind": "car",    "target": 1.00, "center_y": False},
        # The taxi was regenerated with ai_model "latest" (the smart-topology
    # models kept producing a hollow body with no flank panels). That model
    # returns the RAW dense mesh - 1.9M tris - so this is the one asset that
    # genuinely needs the decimation valve the other jobs no longer use.
    {"id": "fv-taxi",        "glb": f"{MSH}/funkyverse/taxi.glb",    "out": "fv/taxi",              "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "fv-truck-purple","glb": f"{MSH}/funkyverse/truck-purple.glb", "out": "fv/truck-purple", "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "fv-truck-teal",  "glb": f"{MSH}/funkyverse/truck-teal.glb",   "out": "fv/truck-teal",   "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "fv-coupe-red",   "glb": f"{MSH}/funkyverse/coupe-red.glb",    "out": "fv/coupe-red",    "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "fv-sedan-orange","glb": f"{MSH}/funkyverse/sedan-orange.glb", "out": "fv/sedan-orange", "kind": "car",    "target": 1.00, "center_y": False},
    {"id": "fv-turtle",      "glb": f"{MSH}/funkyverse/turtle.glb",  "out": "fv/turtle",            "kind": "prop",   "target": 0.95, "center_y": True},
    {"id": "fv-log",         "glb": f"{MSH}/funkyverse/log.glb",     "out": "fv/log",               "kind": "car",    "target": 1.00, "center_y": True},
    {"id": "fv-flower-pad",  "glb": f"{MSH}/funkyverse/flower-pad.glb", "out": "fv/lilypad",        "kind": "prop",   "target": 1.00, "center_y": True},
    {"id": "fv-portal-gate", "glb": f"{MSH}/funkyverse/portal-arcade.glb", "out": "fv/portal-frame","kind": "portal", "target": 2.20, "center_y": False},
    {"id": "fv-palm",        "glb": f"{MSH}/funkyverse/palm.glb",   "out": "fv/palm",              "kind": "prop",   "target": 2.60, "center_y": False},
]


def center_y(obj):
    """Re-centre the mesh on its own Y midpoint (for floating props)."""
    ensure_active(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
    obj.location.y -= 0.5 * (mn_y + mx_y)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


def scale_max_dim(obj, target):
    """Origin at bottom-centre, uniform scale so the LARGEST dim == target.
    (origin_at_base_and_scale's else-branch hardcodes target 1.0, so props
    with a custom footprint target get this mirror of the same pattern.)"""
    ensure_active(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
    obj.location.x -= 0.5 * (mn_x + mx_x)
    obj.location.y -= 0.5 * (mn_y + mx_y)
    obj.location.z -= mn_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    dx, dy, dz = dims(obj)
    current = max(dx, dy, dz)
    if current < 1e-6:
        raise RuntimeError("zero-size prop")
    f = target / current
    obj.scale = (f, f, f)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
def center_y(obj):
    """Re-centre the mesh on its own vertical midpoint. Blender Z is the game's
    Y (up) after export_json's (x, z, -y) mapping, and the loader places floats
    (log/lilypad/turtle/portal ring) by group offset - so the MESH must be
    centred on Blender Z, not grounded like vehicles."""
    ensure_active(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
    obj.location.z -= 0.5 * (mn_z + mx_z)
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)


# Meshy already returns game-ready meshes at 6-8k tris. An earlier pass here
# decimated them to 12-38% on the assumption that the repeated props would cost
# draw time -- measured on the real board (tools/tri-count.js), the whole
# visible scene is ~15k triangles, so that budget was never under pressure.
# All the decimation bought was faceted silhouettes, and because it runs BEFORE
# bake_vertex_colors() the collapse also resampled the paint onto moved
# vertices, muddying saturated body colours. Ship source resolution.
#
# Per-kind ceilings stay wired up as a safety valve for any future source that
# arrives genuinely dense; None means "no decimation".
DEFAULT_TRIS = {"car": None, "prop": None, "portal": None, "character": None}


def decimate(obj, target_tris):
    """Collapse-decimate to roughly target_tris. Silhouette is preserved far
    better than by any vertex-welding pass, which cannot remove triangles.
    A target of None (or one at/above the current count) is a no-op."""
    ensure_active(obj)
    before = len(obj.data.polygons)
    if not target_tris or before <= target_tris:
        return before, before
    # Iterate rather than clamp. A single modifier is floored at ratio 0.05 to
    # avoid shredding a mesh in one pass, but the "latest" Meshy model returns
    # ~1.9M tris, where 0.05 still leaves 95k. Repeated gentle passes reach the
    # target and preserve the silhouette better than one violent collapse.
    cur = before
    for _ in range(8):
        if cur <= target_tris:
            break
        mod = obj.modifiers.new("dec", "DECIMATE")
        mod.decimate_type = "COLLAPSE"
        mod.ratio = max(0.05, min(1.0, target_tris / float(cur)))
        bpy.ops.object.modifier_apply(modifier=mod.name)
        cur = len(obj.data.polygons)
    return before, cur


def main():
    # GUARD. This script rebuilds ALL assets from their GLBs and therefore
    # DESTROYS every post-bake pass (match-reference-colors, detail-pass).
    # That silently shipped an unchanged-looking turtle and a washed-out taxi
    # twice in one session, because re-baking one asset quietly reverted the
    # others. tools/rebake.sh runs the passes in the right order and sets this
    # variable; running the bake bare is almost always a mistake.
    if not os.environ.get("REBAKE_PIPELINE"):
        sys.stderr.write(
            "\nREFUSING: run tools/rebake.sh instead.\n"
            "This bake wipes the colour-match and detail passes for EVERY asset,\n"
            "not just the one you meant to rebuild.\n"
            "Override with REBAKE_PIPELINE=1 only if you will re-run those passes.\n\n")
        raise SystemExit(2)

    stats = {}
    for job in JOBS:
        reset_scene()
        meshes = import_glb(os.path.join(ROOT, job["glb"]))
        obj = join_meshes(meshes, job["id"])
        apply_rot_z(obj, job.get("rotate_z", 0.0))
        if job["kind"] == "prop":
            scale_max_dim(obj, job["target"])
        else:
            # origin_at_base_and_scale keys off job["kind"]; "target" feeds
            # the same role as target_length/target_width/target_height.
            scaled_job = dict(job)
            scaled_job.setdefault("target_length", job["target"])
            scaled_job.setdefault("target_width", job["target"])
            scaled_job.setdefault("target_height", job["target"])
            origin_at_base_and_scale(obj, scaled_job)
        if job.get("center_y"):
            center_y(obj)
        # Decimate BEFORE the vertex-colour bake, so colours are sampled onto
        # the final vertices. Doing it after would throw away the very data the
        # bake just produced.
        tgt = job.get("tris", DEFAULT_TRIS.get(job["kind"]))
        t0, t1 = decimate(obj, tgt)
        colors = bake_vertex_colors(obj)
        st = export_json(obj, job["out"], colors, job)
        if isinstance(st, dict):
            st["tris_before"] = t0
            st["tris_after"] = t1
        print("  %-18s %6d -> %6d tris" % (job["id"], t0, t1), flush=True)
        stats[job["id"]] = st
    out = os.path.join(ROOT, "test-shots/meshy-out/bake-stats.json")
    with open(out, "w") as f:
        json.dump(stats, f, indent=2)
    print("ALL_BAKED %d jobs -> %s" % (len(stats), out), flush=True)


if __name__ == "__main__":
    main()
