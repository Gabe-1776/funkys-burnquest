"""Bake TRELLIS GLBs to the game's compact JSON (positions/normals/indices + groups).

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_trellis_glb.py

Pipeline per job:
  import GLB → join → apply → rotate to game axes → decimate → sample
  texture onto vertex colors → origin at base, scale to existing bounds →
  emit JSON. Character/portal keep RGB vertex colors. Cars/trucks cluster
  faces into named materials (CarBody / DioCarBody) so lane tint still works;
  body vertex colors are stored as luminance so tint * shading stays clean.
"""
from __future__ import annotations

import array
import json
import math
import os
import sys
import traceback

import bpy
from mathutils import Vector, Euler, Matrix

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB_DIR = os.path.join(ROOT, "test-shots/bakeoff")
OUT_DIR = os.path.join(ROOT, "assets/models")
PREVIEW_DIR = os.path.join(ROOT, "test-shots/bakeoff")
STATS_PATH = os.path.join(PREVIEW_DIR, "bake-stats.json")

JOBS = [
    {
        "id": "funky",
        "glb": "trellis-funky-c4.glb",
        "out": "fv/funky",
        "kind": "character",
        "rotate_z": 0.0,
        "target_height": 1.10,
        "target_faces": 9000,
        "vertex_colors": True,
        "body_luminance": False,
    },
    {
        "id": "car",
        "glb": "trellis-fv-muscle-car.glb",
        "out": "fv/car",
        "kind": "car",
        # glTF forward (-Y in Blender) → -X so headlights sit on the -x end
        "rotate_z": -math.pi / 2,
        "target_length": 1.00,
        "target_faces": 4000,
        "vertex_colors": False,
        "body_luminance": False,
        "yaw_extra": math.pi,
        "mat_names": ["CarBody", "CarGlass", "CarTrim", "CarTyre", "CarHead", "CarTail"],
    },
    {
        "id": "truck",
        "glb": "trellis-diorama-truck.glb",
        "out": "diorama/truck",
        "kind": "truck",
        "rotate_z": 0.0,
        "target_length": 1.00,
        "target_faces": 4000,
        "vertex_colors": False,
        "body_luminance": False,
        "yaw_extra": math.pi,
        "mat_names": [
            "DioCarBody", "DioGlass", "DioCargo", "DioChrome",
            "DioHead", "DioTail", "DioTyre",
        ],
    },
    {
        "id": "portal",
        "glb": "trellis-fv-portal.glb",
        "out": "fv/portal-frame",
        "vortex_out": "fv/portal-vortex",
        "kind": "portal",
        "rotate_z": 0.0,
        "target_width": 2.20,
        "target_faces": 4500,
        "vertex_colors": True,
        "body_luminance": False,
    },
]


def log(msg):
    print(msg, flush=True)


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def import_glb(path):
    before = set(bpy.data.objects)
    ok = False
    for op in (
        lambda: bpy.ops.import_scene.gltf(filepath=path),
        lambda: bpy.ops.wm.gltf_import(filepath=path),
    ):
        try:
            op()
            ok = True
            break
        except Exception as e:
            log("  import attempt failed: %s" % e)
    if not ok:
        raise RuntimeError("could not import %s" % path)
    meshes = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    if not meshes:
        meshes = [o for o in bpy.data.objects if o.type == "MESH"]
    return meshes


def ensure_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.hide_set(False)
    obj.hide_viewport = False
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()


def unparent_keep(obj):
    if not obj.parent:
        return
    ensure_active(obj)
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    bpy.context.view_layer.update()


def join_meshes(meshes, name):
    if not meshes:
        raise RuntimeError("no meshes to join")
    for o in meshes:
        o.hide_set(False)
        o.hide_viewport = False
        o.select_set(True)
        for mod in list(o.modifiers):
            ensure_active(o)
            try:
                bpy.ops.object.modifier_apply(modifier=mod.name)
            except Exception:
                o.modifiers.remove(mod)
    ensure_active(meshes[0])
    for o in meshes:
        o.select_set(True)
    if len(meshes) > 1:
        bpy.ops.object.join()
    obj = bpy.context.active_object
    obj.name = name
    unparent_keep(obj)
    ensure_active(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    bpy.context.view_layer.update()
    return obj


def world_bounds(obj):
    corners = [obj.matrix_world @ Vector(c) for c in obj.bound_box]
    xs = [v.x for v in corners]
    ys = [v.y for v in corners]
    zs = [v.z for v in corners]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))


def dims(obj):
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
    return mx_x - mn_x, mx_y - mn_y, mx_z - mn_z


def apply_rot_z(obj, radians):
    if abs(radians) < 1e-8:
        return
    unparent_keep(obj)
    ensure_active(obj)
    # Headless -b often no-ops transform_apply; rotate the mesh data itself.
    obj.data.transform(Matrix.Rotation(radians, 4, "Z"))
    obj.data.update()
    bpy.context.view_layer.update()
    dx, dy, dz = dims(obj)
    log("  after rot_z %.1f deg: x=%.3f y=%.3f z=%.3f" % (
        math.degrees(radians), dx, dy, dz))


def orient_length_on_x(obj):
    """Put the longest ground-plane axis on X (lane direction)."""
    dx, dy, dz = dims(obj)
    log("  pre-orient dims x=%.3f y=%.3f z=%.3f" % (dx, dy, dz))
    if dy > dx * 1.1:
        apply_rot_z(obj, math.pi / 2.0)
        return True
    return False


def headlights_to_neg_x(obj, colors):
    """Cars travel along X; render3d.js puts lamps on the -x end."""
    me = obj.data
    pos_w = neg_w = pos_l = neg_l = 0.0
    for v in me.vertices:
        r, g, b = colors[v.index]
        lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
        if v.co.x >= 0:
            pos_w += 1.0
            pos_l += lum
        else:
            neg_w += 1.0
            neg_l += lum
    pos_avg = pos_l / max(1.0, pos_w)
    neg_avg = neg_l / max(1.0, neg_w)
    log("  headlight probe  +X lum=%.3f  -X lum=%.3f" % (pos_avg, neg_avg))
    if pos_avg > neg_avg + 0.02:
        apply_rot_z(obj, math.pi)
        log("  flipped 180 so brighter end is -X")
        return True
    return False


def wire_vertex_color_nodes(obj):
    """EEVEE preview: plug the Col attribute into Principled Base Color."""
    for mat in obj.data.materials:
        if not mat or not mat.node_tree:
            continue
        ntree = mat.node_tree
        prin = find_principled(mat)
        if not prin:
            continue
        attr = ntree.nodes.get("BakeCol")
        if attr is None:
            try:
                attr = ntree.nodes.new("ShaderNodeVertexColor")
            except RuntimeError:
                attr = ntree.nodes.new("ShaderNodeAttribute")
                attr.attribute_name = "Col"
            attr.name = "BakeCol"
            attr.location = (-280, 200)
        if hasattr(attr, "layer_name"):
            attr.layer_name = "Col"
        if not prin.inputs["Base Color"].links:
            ntree.links.new(attr.outputs[0], prin.inputs["Base Color"])


def delete_faces_named(obj, mat_name):
    me = obj.data
    idx = None
    for i, mat in enumerate(me.materials):
        if mat.name == mat_name:
            idx = i
            break
    if idx is None:
        return 0
    ensure_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    n = 0
    for p in me.polygons:
        if p.material_index == idx:
            p.select = True
            n += 1
    if n == 0:
        return 0
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.delete(type="FACE")
    bpy.ops.object.mode_set(mode="OBJECT")
    log("  deleted %d leftover %s faces" % (n, mat_name))
    return n


def origin_at_base_and_scale(obj, job):
    """Origin at bottom-centre. Uniform scale to the job's target axis."""
    ensure_active(obj)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(obj)
    cx = 0.5 * (mn_x + mx_x)
    cy = 0.5 * (mn_y + mx_y)
    obj.location.x -= cx
    obj.location.y -= cy
    obj.location.z -= mn_z
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)

    dx, dy, dz = dims(obj)
    kind = job["kind"]
    if kind == "character":
        target, current = job["target_height"], dz
    elif kind in ("car", "truck"):
        target, current = job["target_length"], dx
    elif kind == "portal":
        target, current = job["target_width"], dx
    else:
        target, current = 1.0, max(dx, dy, dz)
    if current < 1e-6:
        raise RuntimeError("%s has zero size" % job["id"])
    f = target / current
    obj.scale = (f, f, f)
    bpy.ops.object.transform_apply(location=False, rotation=False, scale=True)
    got = dims(obj)
    log("  scaled %s: blender dims x=%.3f y=%.3f z=%.3f (factor %.4f)" % (
        job["id"], got[0], got[1], got[2], f))
    return got


def decimate(obj, target_faces):
    me = obj.data
    n = len(me.polygons)
    if n <= target_faces:
        log("  faces=%d already under target %d" % (n, target_faces))
        return n
    ratio = max(0.01, min(1.0, target_faces / float(n)))
    ensure_active(obj)
    mod = obj.modifiers.new("game_decimate", "DECIMATE")
    mod.ratio = ratio
    bpy.ops.object.modifier_apply(modifier=mod.name)
    log("  decimate %d -> %d faces (ratio %.4f)" % (n, len(obj.data.polygons), ratio))
    return len(obj.data.polygons)


def find_principled(mat):
    if not mat or not mat.use_nodes or not mat.node_tree:
        return None
    for n in mat.node_tree.nodes:
        if n.type == "BSDF_PRINCIPLED":
            return n
    return None


_COLOR_SOCKETS = (
    "Color", "Color1", "Color2", "A", "B", "Image", "Base Color", "Shader",
)


def walk_to_image(socket, depth=0):
    """Follow only colour sockets. Scanning every input finds the normal map."""
    if socket is None or not socket.links or depth > 8:
        return None
    node = socket.links[0].from_node
    if node.type == "TEX_IMAGE" and node.image:
        return node.image
    for name in _COLOR_SOCKETS:
        if name in node.inputs and node.inputs[name].links:
            img = walk_to_image(node.inputs[name], depth + 1)
            if img:
                return img
    return None


_PIXEL_CACHE = {}


def image_pixels(img):
    key = id(img)
    if key in _PIXEL_CACHE:
        return _PIXEL_CACHE[key]
    w, h = img.size
    n = w * h * 4
    px = array.array("f", [0.0]) * n
    img.pixels.foreach_get(px)
    _PIXEL_CACHE[key] = (w, h, px)
    return _PIXEL_CACHE[key]


def sample_px(w, h, px, u, v):
    uu = u - math.floor(u)
    vv = v - math.floor(v)
    x = min(w - 1, max(0, int(uu * (w - 1))))
    y = min(h - 1, max(0, int(vv * (h - 1))))
    i = (y * w + x) * 4
    return px[i], px[i + 1], px[i + 2]


def mat_fallback(mat):
    n = find_principled(mat)
    if n:
        c = n.inputs["Base Color"].default_value
        return (c[0], c[1], c[2])
    if mat:
        c = mat.diffuse_color
        return (c[0], c[1], c[2])
    return (0.7, 0.7, 0.7)


def bake_vertex_colors(obj):
    """Average UV-sampled baseColor (or Principled default) per vertex."""
    me = obj.data
    uv = me.uv_layers.active
    nverts = len(me.vertices)
    acc = [[0.0, 0.0, 0.0, 0] for _ in range(nverts)]
    images = []
    fallbacks = []
    for mat in me.materials:
        fb = mat_fallback(mat)
        fallbacks.append(fb)
        prin = find_principled(mat)
        img = walk_to_image(prin.inputs["Base Color"]) if prin else None
        images.append(img)

    if not me.materials:
        images = [None]
        fallbacks = [(0.7, 0.7, 0.7)]

    for poly in me.polygons:
        mi = poly.material_index if me.materials else 0
        mi = min(mi, len(images) - 1)
        img = images[mi]
        fb = fallbacks[mi]
        packed = image_pixels(img) if img else None
        for li in poly.loop_indices:
            vi = me.loops[li].vertex_index
            if packed and uv:
                u, v = uv.data[li].uv
                r, g, b = sample_px(packed[0], packed[1], packed[2], u, v)
            else:
                r, g, b = fb
            acc[vi][0] += r
            acc[vi][1] += g
            acc[vi][2] += b
            acc[vi][3] += 1

    colors = []
    for r, g, b, c in acc:
        if c <= 0:
            colors.append((0.7, 0.7, 0.7))
        else:
            colors.append((r / c, g / c, b / c))

    if "Col" in me.color_attributes:
        me.color_attributes.remove(me.color_attributes["Col"])
    attr = me.color_attributes.new(name="Col", type="FLOAT_COLOR", domain="POINT")
    for i, (r, g, b) in enumerate(colors):
        attr.data[i].color = (r, g, b, 1.0)
    return colors


def sat_lum(r, g, b):
    mx = max(r, g, b)
    mn = min(r, g, b)
    sat = 0.0 if mx < 1e-6 else (mx - mn) / mx
    lum = 0.2126 * r + 0.7152 * g + 0.0722 * b
    return sat, lum


def classify_face(kind, r, g, b):
    sat, lum = sat_lum(r, g, b)
    if kind == "car":
        # TRELLIS muscle car is mostly orange; keep that in CarBody so lane tint hits it.
        if lum < 0.16:
            return "CarTyre"
        if lum > 0.82 and sat < 0.25:
            return "CarHead"
        if sat < 0.16 and 0.2 < lum < 0.7:
            return "CarTrim"
        return "CarBody"
    if kind == "truck":
        if lum < 0.16:
            return "DioTyre"
        if lum > 0.62 and sat < 0.22:
            return "DioCargo"
        if lum > 0.75 and sat > 0.3 and r > 0.5 and g > 0.4 and b < 0.35:
            return "DioHead"
        if sat < 0.16 and 0.2 < lum < 0.65:
            return "DioChrome"
        return "DioCarBody"
    if kind == "portal":
        # inner swirl is dark + high-sat magenta/orange; chrome is low-sat grey
        if sat > 0.35 or lum < 0.18:
            return "PortalSwirl"
        if 0.35 < lum < 0.7 and r > 0.4 and g < 0.35:
            return "PortalBulb"
        return "PortalFrame"
    return "Main"


def assign_clustered_materials(obj, colors, job):
    me = obj.data
    kind = job["kind"]
    names = job.get("mat_names")
    if kind == "portal":
        names = ["PortalFrame", "PortalBulb", "PortalSwirl"]
    if kind == "character":
        names = ["Funky"]
    counts = {n: 0 for n in names}
    sums = {n: [0.0, 0.0, 0.0] for n in names}

    face_name = []
    for poly in me.polygons:
        rs = gs = bs = 0.0
        n = 0
        for vi in poly.vertices:
            r, g, b = colors[vi]
            rs += r
            gs += g
            bs += b
            n += 1
        r, g, b = rs / n, gs / n, bs / n
        if kind == "character":
            name = "Funky"
        else:
            name = classify_face(kind, r, g, b)
            if name not in counts:
                name = names[0]
        face_name.append(name)
        counts[name] += 1
        sums[name][0] += r
        sums[name][1] += g
        sums[name][2] += b

    # Drop empty slots so we don't emit unused materials
    used = [n for n in names if counts.get(n, 0) > 0]
    if not used:
        used = [names[0]]
    index_of = {n: i for i, n in enumerate(used)}
    use_vc = job.get("vertex_colors", True)

    me.materials.clear()
    for n in used:
        mat = bpy.data.materials.new(n)
        mat.use_nodes = True
        prin = find_principled(mat)
        if prin:
            if use_vc:
                prin.inputs["Base Color"].default_value = (1, 1, 1, 1)
            else:
                c = counts[n] or 1
                prin.inputs["Base Color"].default_value = (
                    sums[n][0] / c, sums[n][1] / c, sums[n][2] / c, 1)
            prin.inputs["Roughness"].default_value = 0.45
            if "Head" in n or "Bulb" in n:
                if "Emission Strength" in prin.inputs:
                    prin.inputs["Emission Strength"].default_value = 1.6
            if "Tail" in n:
                if "Emission Strength" in prin.inputs:
                    prin.inputs["Emission Strength"].default_value = 1.1
        me.materials.append(mat)

    for poly, name in zip(me.polygons, face_name):
        poly.material_index = index_of.get(name, 0)

    log("  clusters: " + ", ".join("%s=%d" % (n, counts.get(n, 0)) for n in names))
    return used, counts


def split_portal_vortex(obj, colors):
    """Duplicate inner swirl faces into a second object, origin at its centre."""
    me = obj.data
    swirl_idx = None
    for i, mat in enumerate(me.materials):
        if mat.name == "PortalSwirl":
            swirl_idx = i
            break
    if swirl_idx is None:
        return None
    swirl_faces = [p.index for p in me.polygons if p.material_index == swirl_idx]
    if len(swirl_faces) < 30:
        log("  vortex skip: only %d swirl faces" % len(swirl_faces))
        return None

    ensure_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bpy.ops.mesh.select_all(action="DESELECT")
    bpy.ops.object.mode_set(mode="OBJECT")
    for p in me.polygons:
        p.select = p.material_index == swirl_idx
    bpy.ops.object.mode_set(mode="EDIT")
    try:
        bpy.ops.mesh.separate(type="SELECTED")
    except Exception as e:
        log("  separate failed: %s" % e)
        bpy.ops.object.mode_set(mode="OBJECT")
        return None
    bpy.ops.object.mode_set(mode="OBJECT")

    vortex = None
    for o in bpy.context.selected_objects:
        if o != obj and o.type == "MESH":
            vortex = o
    if vortex is None:
        # join leftover selection
        for o in bpy.data.objects:
            if o != obj and o.type == "MESH" and "portal" in o.name.lower():
                vortex = o
                break
    if vortex is None:
        log("  vortex separate produced no object")
        return None

    vortex.name = "PortalVortex"
    ensure_active(vortex)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    mn_x, mx_x, mn_y, mx_y, mn_z, mx_z = world_bounds(vortex)
    cx = 0.5 * (mn_x + mx_x)
    cy = 0.5 * (mn_y + mx_y)
    cz = 0.5 * (mn_z + mx_z)
    vortex.location.x -= cx
    vortex.location.y -= cy
    vortex.location.z -= cz
    bpy.ops.object.transform_apply(location=True, rotation=False, scale=False)
    log("  vortex split: faces=%d centre_world=(%.3f, %.3f, %.3f) -> origin 0" % (
        len(vortex.data.polygons), cx, cy, cz))
    vortex["_centre_x"] = float(cx)
    vortex["_centre_y"] = float(cy)
    vortex["_centre_z"] = float(cz)
    return vortex


def export_json(obj, out_slug, colors, job, extra=None):
    me = obj.data
    me.calc_loop_triangles()
    body_names = {"CarBody", "DioCarBody"}
    use_vc = job.get("vertex_colors", True)
    body_lum = job.get("body_luminance", False)

    mats = []
    for m in me.materials:
        n = find_principled(m)
        c = n.inputs["Base Color"].default_value if n else (1, 1, 1, 1)
        rgh = n.inputs["Roughness"].default_value if n else 0.6
        em = 0.0
        if n and "Emission Strength" in n.inputs:
            em = n.inputs["Emission Strength"].default_value
        mats.append({
            "name": m.name,
            "color": [round(c[0], 4), round(c[1], 4), round(c[2], 4)],
            "roughness": round(rgh, 3),
            "emissive": round(em, 3),
        })
    if not mats:
        mats = [{"name": "Main", "color": [1, 1, 1], "roughness": 0.55, "emissive": 0.0}]

    by_mat = {}
    for t in me.loop_triangles:
        by_mat.setdefault(t.material_index, []).append(t)

    pos, nrm, col, idx, groups, vmap = [], [], [], [], [], {}
    for mi in sorted(by_mat):
        start = len(idx)
        mat_name = mats[mi]["name"] if mi < len(mats) else "Main"
        grey_body = body_lum and mat_name in body_names
        for t in by_mat[mi]:
            for li in t.loops:
                loop = me.loops[li]
                v = me.vertices[loop.vertex_index]
                n_ = loop.normal if t.use_smooth else t.normal
                key = (
                    loop.vertex_index,
                    round(n_.x, 4), round(n_.y, 4), round(n_.z, 4),
                    mi,
                )
                i = vmap.get(key)
                if i is None:
                    i = len(pos) // 3
                    vmap[key] = i
                    # Blender Z-up → three.js Y-up: (x, y, z) -> (x, z, -y)
                    pos.extend([round(v.co.x, 4), round(v.co.z, 4), round(-v.co.y, 4)])
                    nrm.extend([round(n_.x, 4), round(n_.z, 4), round(-n_.y, 4)])
                    cr, cg, cb = colors[loop.vertex_index]
                    if grey_body:
                        y = 0.2126 * cr + 0.7152 * cg + 0.0722 * cb
                        # keep some contrast so flames read as shading
                        y = 0.35 + 0.65 * y
                        cr = cg = cb = y
                    col.extend([round(cr, 3), round(cg, 3), round(cb, 3)])
                idx.append(i)
        groups.append({"start": start, "count": len(idx) - start, "materialIndex": mi})

    payload = {
        "name": out_slug,
        "materials": mats,
        "groups": groups,
        "positions": pos,
        "normals": nrm,
        "indices": idx,
    }
    if use_vc:
        payload["colors"] = col
    if extra:
        payload.update(extra)

    path = os.path.join(OUT_DIR, out_slug + ".json")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        json.dump(payload, f, separators=(",", ":"))

    xs, ys, zs = pos[0::3], pos[1::3], pos[2::3]
    stats = {
        "path": path,
        "bytes": os.path.getsize(path),
        "verts": len(pos) // 3,
        "tris": len(idx) // 3,
        "mats": [m["name"] for m in mats],
        "bounds": {
            "x": [round(min(xs), 3), round(max(xs), 3)],
            "y": [round(min(ys), 3), round(max(ys), 3)],
            "z": [round(min(zs), 3), round(max(zs), 3)],
        },
        "has_colors": use_vc,
    }
    log("  wrote %s  %d verts  %d tris  %d bytes  mats=%s  y%s" % (
        path, stats["verts"], stats["tris"], stats["bytes"],
        stats["mats"], stats["bounds"]["y"]))
    return stats


def setup_preview_world():
    scene = bpy.context.scene
    scene.render.engine = "BLENDER_EEVEE_NEXT" if "BLENDER_EEVEE_NEXT" in bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items else "BLENDER_EEVEE"
    try:
        scene.eevee.taa_render_samples = 8
    except Exception:
        pass
    scene.render.resolution_x = 640
    scene.render.resolution_y = 640
    scene.render.film_transparent = False
    world = bpy.data.worlds.new("PreviewWorld")
    scene.world = world
    world.use_nodes = True
    bg = world.node_tree.nodes.get("Background")
    if bg:
        bg.inputs[0].default_value = (0.55, 0.55, 0.58, 1)
        bg.inputs[1].default_value = 1.0
    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = 3.0
    sun_obj = bpy.data.objects.new("Sun", sun)
    bpy.context.collection.objects.link(sun_obj)
    sun_obj.rotation_euler = Euler((0.9, 0.2, 0.6), "XYZ")


def look_at(obj, target):
    direction = target - obj.location
    if direction.length < 1e-6:
        return
    obj.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()


def render_previews(obj, job_id, use_vc=True):
    for o in bpy.data.objects:
        if o.type == "MESH":
            o.hide_render = o != obj
            o.hide_viewport = o != obj
    if use_vc:
        wire_vertex_color_nodes(obj)
    setup_preview_world()
    scene = bpy.context.scene
    dx, dy, dz = dims(obj)
    radius = max(dx, dy, dz) * 1.8 + 0.4
    cam_data = bpy.data.cameras.new("BakeCam")
    cam_data.clip_start = 0.01
    cam_data.clip_end = 100
    cam = bpy.data.objects.new("BakeCam", cam_data)
    bpy.context.collection.objects.link(cam)
    scene.camera = cam
    target = Vector((0.0, 0.0, dz * 0.45))

    shots = {
        "front": Vector((0.0, -radius, dz * 0.45)),
        "threeq": Vector((radius * 0.7, -radius * 0.85, dz * 0.55)),
    }
    paths = {}
    for name, loc in shots.items():
        cam.location = loc
        look_at(cam, target)
        out = os.path.join(PREVIEW_DIR, "baked-%s-%s.png" % (job_id, name))
        scene.render.filepath = out
        bpy.ops.render.render(write_still=True)
        paths[name] = out
        log("  preview %s" % out)
    return paths


def process_job(job):
    global _PIXEL_CACHE
    _PIXEL_CACHE = {}
    reset_scene()
    glb = os.path.join(GLB_DIR, job["glb"])
    log("=== %s  %s ===" % (job["id"], glb))
    if not os.path.isfile(glb):
        raise FileNotFoundError(glb)
    meshes = import_glb(glb)
    log("  imported %d mesh objects" % len(meshes))
    obj = join_meshes(meshes, job["id"])
    if job["kind"] in ("car", "truck"):
        orient_length_on_x(obj)
    else:
        apply_rot_z(obj, job.get("rotate_z") or 0.0)
    # Decimate while still in TRELLIS units so later UV sampling hits ~target faces.
    decimate(obj, job["target_faces"])
    origin_at_base_and_scale(obj, job)

    colors = bake_vertex_colors(obj)
    extra = job.get("yaw_extra") or 0.0
    if extra:
        apply_rot_z(obj, extra)
        origin_at_base_and_scale(obj, job)
        colors = bake_vertex_colors(obj)
    elif job["kind"] in ("car", "truck"):
        if headlights_to_neg_x(obj, colors):
            origin_at_base_and_scale(obj, job)
            colors = bake_vertex_colors(obj)
    assign_clustered_materials(obj, colors, job)
    if job.get("vertex_colors", True):
        wire_vertex_color_nodes(obj)

    attr = obj.data.color_attributes.get("Col")
    if attr:
        colors = [tuple(attr.data[i].color[:3]) for i in range(len(obj.data.vertices))]

    vortex_stats = None
    vortex_centre = None
    if job["kind"] == "portal" and job.get("vortex_out"):
        vortex = split_portal_vortex(obj, colors)
        if vortex is not None:
            vortex_centre = (
                float(vortex.get("_centre_x", 0.0)),
                float(vortex.get("_centre_y", 0.0)),
                float(vortex.get("_centre_z", 0.0)),
            )
            vcol = bake_vertex_colors(vortex)
            # single swirl material
            vortex.data.materials.clear()
            mat = bpy.data.materials.new("PortalSwirlA")
            mat.use_nodes = True
            prin = find_principled(mat)
            if prin:
                prin.inputs["Base Color"].default_value = (1, 1, 1, 1)
                prin.inputs["Roughness"].default_value = 0.35
                if "Emission Strength" in prin.inputs:
                    prin.inputs["Emission Strength"].default_value = 0.8
            vortex.data.materials.append(mat)
            vjob = dict(job)
            vjob["vertex_colors"] = True
            vjob["body_luminance"] = False
            vortex_stats = export_json(vortex, job["vortex_out"], vcol, vjob)
            vortex.hide_render = True
            vortex.hide_viewport = True
            delete_faces_named(obj, "PortalSwirl")
            # Frame origin can shift after the leftover-face delete
            origin_at_base_and_scale(obj, job)
            colors = bake_vertex_colors(obj)

    stats = export_json(obj, job["out"], colors, job)
    previews = render_previews(obj, job["id"], job.get("vertex_colors", True))
    stats["previews"] = previews
    if vortex_stats:
        stats["vortex"] = vortex_stats
        stats["vortex_centre_blender"] = vortex_centre
    return stats


def main():
    all_stats = {}
    errors = {}
    for job in JOBS:
        try:
            all_stats[job["id"]] = process_job(job)
        except Exception:
            errors[job["id"]] = traceback.format_exc()
            log("FAILED %s\n%s" % (job["id"], errors[job["id"]]))
    payload = {"ok": all_stats, "errors": errors}
    with open(STATS_PATH, "w") as f:
        json.dump(payload, f, indent=2)
    log("STATS %s" % STATS_PATH)
    if errors:
        log("DONE with errors: %s" % list(errors))
        sys.exit(1)
    log("DONE all jobs")


if __name__ == "__main__":
    main()
