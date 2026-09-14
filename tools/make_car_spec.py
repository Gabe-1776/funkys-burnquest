"""Builder for a vision-model-authored car spec.

Protocol: a vision model (the EYES) studies the reference images and emits a
numeric build spec (test-shots/car/spec-*.json). This script (the HANDS)
implements that spec exactly - no creative latitude - renders it, and the
render goes back to the EYES for numeric corrections.

The spec contract is documented in the spec file itself; key conventions:
  X = length (nose -0.5, tail +0.5), Y = width (centre 0), Z = height (ground 0)
  body/cabin/glass loft widths are HALF-widths; wing span/chord are FULL
  angles are degrees, positive trailing edge up
  wheel openings (radius 0.085) are subtracted from the body

Run:
  Blender -b -t 4 --python tools/make_car_spec.py -- <spec.json> [tag]
"""
import bpy, bmesh, json, math, os, sys
from mathutils import Vector, Matrix

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
SHOT_DIR = os.path.join(ROOT, "test-shots/car")
GLB_DIR = os.path.join(ROOT, "assets/models/glb/fv")

argv = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
SPEC_PATH = argv[0] if argv else os.path.join(ROOT, "test-shots/car/spec-astra.json")
TAG = argv[1] if len(argv) > 1 else "spec"
SPEC = json.load(open(SPEC_PATH))
M = SPEC["materials"]


# ------------------------------------------------------------------ helpers
def pbr(name, rgb, metallic=0.0, rough=0.5, emit=None, emit_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*rgb, 1.0)
    b.inputs["Metallic"].default_value = metallic
    b.inputs["Roughness"].default_value = rough
    if emit:
        b.inputs["Emission Color"].default_value = (*emit, 1.0)
        b.inputs["Emission Strength"].default_value = emit_strength
    if alpha < 1.0:
        b.inputs["Alpha"].default_value = alpha
        for attr, val in (("blend_method", "BLEND"), ("surface_render_method", "BLENDED")):
            try:
                setattr(m, attr, val)
            except Exception:
                pass
    return m


def mats():
    return {
        "body":   pbr("Body", M["body"], metallic=0.35, rough=0.24),
        "flameO": pbr("FlameOrange", M["flame_o"], metallic=0.1, rough=0.35,
                      emit=M["flame_o"], emit_strength=0.4),
        "flameP": pbr("FlamePurple", M["flame_p"], metallic=0.15, rough=0.35),
        "glass":  pbr("Glass", M["glass"], metallic=0.2, rough=0.14, alpha=0.85),
        "chrome": pbr("Chrome", M["chrome"], metallic=1.0, rough=0.18),
        "tyre":   pbr("Tyre", M["tyre"], metallic=0.0, rough=0.86),
        "cyan":   pbr("Cyan", M["cyan"], metallic=0.0, rough=0.15,
                      emit=M["cyan"], emit_strength=2.6),
        "tail":   pbr("Tail", M["tail"], metallic=0.0, rough=0.2,
                      emit=M["tail"], emit_strength=2.2),
        "carbon": pbr("Carbon", (0.05, 0.05, 0.06), metallic=0.45, rough=0.32),
    }


def new_obj(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def bevel(ob, width=0.002, segments=1, angle=35):
    mod = ob.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def sect(w_half, z0, z1, n=4.0, steps=16, taper=1.0):
    """Closed cross-section in YZ; taper scales the top edge inward."""
    cz = (z0 + z1) / 2
    hz = (z1 - z0) / 2
    pts = []
    for i in range(steps):
        a = (i / steps) * math.tau
        ca, sa = math.cos(a), math.sin(a)
        w = w_half * (taper if math.sin(a) > 0 else 1.0)
        y = math.copysign(abs(ca) ** (2 / n), ca) * w
        z = cz + math.copysign(abs(sa) ** (2 / n), sa) * hz
        pts.append((y, z))
    return pts


def loft(name, stations, mat, taper=1.0, n=4.0, bev=0.002):
    bm = bmesh.new()
    rings = []
    for x, w_half, z0, z1 in stations:
        ring = [bm.verts.new((x, y, z)) for y, z in sect(w_half, z0, z1, n=n, taper=taper)]
        rings.append(ring)
    cnt = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(cnt):
            j = (i + 1) % cnt
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat)
    if bev:
        bevel(ob, bev)
    return ob


def box(name, size, loc, mat, rot=(0, 0, 0), bev=0.002):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    for ax, a in zip("XYZ", rot):
        if a:
            bmesh.ops.rotate(bm, matrix=Matrix.Rotation(a, 3, ax), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    ob = new_obj(name, bm, mat)
    if bev:
        bevel(ob, bev)
    return ob


def cyl(name, r, depth, loc, mat, axis="Y", seg=20, r2=None):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=seg, radius1=r,
                          radius2=(r if r2 is None else r2), depth=depth)
    if axis == "Y":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "X"), verts=bm.verts)
    elif axis == "X":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "Y"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mat)


def annulus(name, r_out, r_in, depth, loc, mat, seg=24):
    bm = bmesh.new()
    outer, inner = [], []
    for i in range(seg):
        a = (i / seg) * math.tau
        for lst, r in ((outer, r_out), (inner, r_in)):
            lst.append(bm.verts.new((math.cos(a) * r, -depth / 2, math.sin(a) * r)))
            lst.append(bm.verts.new((math.cos(a) * r, depth / 2, math.sin(a) * r)))
    for i in range(seg):
        j = (i + 1) % seg
        o0, o1, o2, o3 = outer[i*2], outer[i*2+1], outer[j*2], outer[j*2+1]
        i0, i1, i2, i3 = inner[i*2], inner[i*2+1], inner[j*2], inner[j*2+1]
        bm.faces.new((o0, o2, o3, o1)); bm.faces.new((i1, i3, i2, i0))
        bm.faces.new((o1, o3, i3, i1)); bm.faces.new((i0, i2, o2, o0))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mat)


def arch(name, r, width, thickness, loc, mat, seg=8):
    """Faceted bolt-on arch shell (flat faces, hard edges)."""
    bm = bmesh.new()
    rings = []
    for i in range(seg + 1):
        a = math.pi * (i / seg)
        cx, cz = math.cos(a) * r, math.sin(a) * r
        nx, nz = math.cos(a), math.sin(a)
        ring = []
        for dy in (-width / 2, width / 2):
            for dr in (-thickness / 2, thickness / 2):
                ring.append(bm.verts.new((cx + nx * dr, dy, cz + nz * dr)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(4):
            j = (i + 1) % 4
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(list(reversed(rings[0]))); bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mat)


def poly_decal(name, pts, thickness, mat, side):
    bm = bmesh.new()
    front = [bm.verts.new((x, 0.0, z)) for x, z in pts]
    back = [bm.verts.new((x, thickness, z)) for x, z in pts]
    bm.faces.new(front); bm.faces.new(list(reversed(back)))
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector((0, side * (SPEC["body_loft"][5][1] + 0.001), 0)), verts=bm.verts)
    return new_obj(name, bm, mat)


# --------------------------------------------------------------------- build
def build():
    mt = mats()
    parts = []

    # --- body shell
    body = loft("Body", SPEC["body_loft"], mt["body"], n=4.0, bev=0.003)
    parts.append(body)

    # --- wheel openings: subtract a cylinder at each wheel station
    W = SPEC["wheels"]
    for wx in (W["x_front"], W["x_rear"]):
        cutter = cyl("cut%d" % int(wx * 1000), 0.085, 1.0, (wx, 0, W["radius"]), mt["body"], axis="Y", seg=24)
        mod = body.modifiers.new("bool", "BOOLEAN")
        mod.operation = "DIFFERENCE"
        mod.object = cutter
        bpy.context.view_layer.objects.active = body
        bpy.ops.object.modifier_apply(modifier=mod.name)
        bpy.data.objects.remove(cutter, do_unlink=True)

    # --- cabin (tapers to 0.72x at the roof) + glass shell
    parts.append(loft("Cabin", SPEC["cabin_loft"], mt["body"], taper=0.72, n=5.0, bev=0.002))
    parts.append(loft("Glass", SPEC["glass_loft"], mt["glass"], taper=0.78, n=5.0, bev=0.001))

    # --- wheels: tyre + annulus rim + dish + spokes
    for wx in (W["x_front"], W["x_rear"]):
        for sy in (-1, 1):
            cy = sy * 0.218
            parts.append(cyl("Tyre%d%d" % (int(wx*1000), sy), W["radius"], W["width"],
                             (wx, cy, W["radius"]), mt["tyre"], axis="Y", seg=24))
            face_y = cy + sy * (W["width"] / 2 - 0.002)
            parts.append(annulus("Rim%d%d" % (int(wx*1000), sy), W["radius"] * 0.80,
                                 W["radius"] * 0.44, 0.010, (wx, face_y, W["radius"]), mt["chrome"]))
            parts.append(cyl("Dish%d%d" % (int(wx*1000), sy), W["radius"] * 0.44, 0.012,
                             (wx, face_y - sy * W["dish_depth"], W["radius"]), mt["chrome"],
                             axis="Y", seg=20))
            for k in range(W["spokes"]):
                a = k * math.tau / W["spokes"]
                parts.append(box("Spoke%d%d%d" % (int(wx*1000), sy, k),
                                 (W["radius"] * 0.66, 0.010, 0.009),
                                 (wx + math.cos(a) * W["radius"] * 0.38, face_y,
                                  W["radius"] + math.sin(a) * W["radius"] * 0.38),
                                 mt["chrome"], rot=(0, -a, 0), bev=0.001))

    # --- bolt-on flares + rivets
    for fl in SPEC["flares"]:
        for sy in (-1, 1):
            parts.append(arch("Flare%d%d" % (int(fl["x"]*1000), sy), fl["radius"],
                              fl["width"], fl["thickness"],
                              (fl["x"], sy * 0.235, W["radius"]), mt["carbon"]))
            for i in range(5):
                a = math.pi * (0.15 + 0.7 * i / 4)
                parts.append(cyl("Rivet%d%d%d" % (int(fl["x"]*1000), sy, i), 0.0018, 0.006,
                                 (fl["x"] + math.cos(a) * fl["radius"],
                                  sy * (0.235 + fl["width"] / 2), W["radius"] + math.sin(a) * fl["radius"]),
                                 mt["chrome"], axis="Y", seg=6))

    # --- wing
    G = SPEC.get("wing") or {}
    if not G:
        print("NOTE: spec has no wing - eyes omitted it; building without")
    for sy in (-1, 1) if G else ():
        parts.append(box("Pylon%d" % sy, (G["pylon_w"], G["pylon_w"], G["pylon_h"]),
                         (G["pylon_x"], sy * 0.095, G["main"][3] - G["pylon_h"] / 2 - 0.004),
                         mt["body"], rot=(0, math.radians(6), 0), bev=0.002))
    for key, mat in (("main", mt["carbon"]), ("upper", mt["carbon"])):
        x, span, chord, z, ang = G[key]
        parts.append(box("Wing_" + key, (chord, span, 0.011), (x, 0, z), mat,
                         rot=(0, math.radians(-ang), 0), bev=0.002))
    ex, ey, eh, ec = G["endplate"]
    for sy in (-1, 1):
        parts.append(box("Endplate%d" % sy, (ec, 0.008, eh), (ex, sy * ey, G["upper"][3] + 0.004),
                         mt["body"], rot=(0, math.radians(-8), 0), bev=0.002))

    # --- front + rear
    F = SPEC["front"]; R = SPEC["rear"]
    bx, bw, bz0, bz1 = F["bumper"]
    parts.append(box("Bumper", (0.030, bw * 2, bz1 - bz0), (bx, 0, (bz0 + bz1) / 2), mt["carbon"]))
    H = F["headlight"]
    for sy in (-1, 1):
        parts.append(cyl("Head%d" % sy, H["r"], 0.014, (H["x"], sy * H["y"], H["z"]),
                         mt["cyan"], axis="X", seg=16))
    sx, sw, sz, sd = F["splitter"]
    parts.append(box("Splitter", (sd, sw * 2, 0.010), (sx, 0, sz), mt["carbon"]))
    tx, tw, tz, th = R["taillight_bar"]
    parts.append(box("TailBar", (0.012, tw * 2, th), (tx, 0, tz), mt["tail"]))
    E = R["exhausts"]
    for sy in (-1, 1):
        parts.append(cyl("Exhaust%d" % sy, E["r"], 0.05, (E["x"], sy * E["y"], E["z"]),
                         mt["chrome"], axis="X", seg=14))
    dx, dw, dz, dd = R["diffuser"]
    parts.append(box("Diffuser", (dd, dw * 2, 0.045), (dx, 0, dz), mt["carbon"],
                     rot=(0, math.radians(12), 0)))

    # --- flames (spec polygons project onto both sides; first two also on hood)
    for i, poly in enumerate(SPEC["flames"]):
        mat = mt["flameO"] if i % 2 == 0 else mt["flameP"]
        for sy in (-1, 1):
            parts.append(poly_decal("Flame%d%d" % (i, sy), poly, 0.002, mat, sy))

    # join
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = "CarSpec"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    car.data.polygons.foreach_set("use_smooth", [False] * len(car.data.polygons))
    car.data.update()
    return car


def render_previews(ob):
    sc = bpy.context.scene
    sc.render.engine = ("BLENDER_EEVEE_NEXT"
                        if "BLENDER_EEVEE_NEXT" in [e.identifier for e in
                        bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
                        else "BLENDER_EEVEE")
    sc.render.resolution_x, sc.render.resolution_y = 1000, 640
    sc.world = bpy.data.worlds.new("N"); sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.24, 0.24, 0.26, 1)
    sc.view_settings.view_transform = "Standard"
    for loc, power, size in [((1, -2, 3), 200, 3), ((-2, 1, 2), 110, 2)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        Lg = bpy.context.object; Lg.data.energy = power; Lg.data.shape = "DISK"; Lg.data.size = size
        Lg.rotation_euler = (Vector((0, 0, 0.1)) - Lg.location).to_track_quat("-Z", "Y").to_euler()
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    hi = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    ctr = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    bpy.ops.object.camera_add(); cam = bpy.context.object
    cam.data.type = "ORTHO"; sc.camera = cam
    views = {"three-quarter": (Vector((1.2, -1.4, 0.8)), 1.15),
             "side": (Vector((0, -2, 0.35)), 1.12),
             "front": (Vector((-2, 0, 0.45)), 1.30),
             "rear": (Vector((2, 0, 0.45)), 1.30)}
    for name, (dirv, mult) in views.items():
        cam.data.ortho_scale = span * mult
        cam.location = ctr + dirv.normalized() * 3.0
        cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(SHOT_DIR, "spec-%s-%s.png" % (name, TAG))
        bpy.ops.render.render(write_still=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    car = build()
    car.data.calc_loop_triangles()
    tris = len(car.data.loop_triangles)
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    car.location = (0, 0, 0)
    corners = [car.matrix_world @ Vector(c) for c in car.bound_box]
    dims = [round(max(v[i] for v in corners) - min(v[i] for v in corners), 4) for i in range(3)]
    os.makedirs(GLB_DIR, exist_ok=True)
    glb = os.path.join(GLB_DIR, "car-spec-%s.glb" % TAG)
    bpy.ops.object.select_all(action="DESELECT")
    car.select_set(True); bpy.context.view_layer.objects.active = car
    bpy.ops.export_scene.gltf(filepath=glb, export_format="GLB", use_selection=True,
                              export_yup=True, export_apply=True, export_image_format="AUTO")
    render_previews(car)
    print("SPECSTATS %s" % {"tris": tris, "dims": dims,
                            "glb_bytes": os.path.getsize(glb), "spec": os.path.basename(SPEC_PATH)})


main()
