"""Scripted Blender model: the funkyverse street-racer coupe.

Recreation of the pipeline-car concept (test-shots/pipeline-car/), modelled
from scratch in code - no Meshy, no sculpting. Reference pack:
  00-canonical-34-sunset.jpg  identity lock
  01-meshy-isolate-34.jpg     clean 3/4 (Meshy's input)
  03/04/05/06                 ortho front/side/rear + 3/4 rear
  SPEC.md                     material callouts

Modelling brief used (vision-extracted from the refs, fractions of length L):
  proportions L:W:H = 1.00 : 0.42 : 0.28
  side silhouette (x from nose 0.0 -> tail 1.0, z as fraction of H):
    nose 0.35 | hood front 0.42 | windshield base 0.55 | roof front 0.98
    roof rear 1.00 | deck 0.72 | tail 0.65
  widest at the rear fenders (0.70-0.90), front flares at 0.12-0.28,
  wheels at 0.18 / 0.82 with diameter 0.16, wing above the roof,
  magenta body, orange+purple flames on the doors, black flares,
  chrome deep-dish rims with pink lips, purple canopy, cyan headlights,
  magenta taillight bar.

Build: two-box sweep (lower body + narrower greenhouse) with superellipse
cross-sections, then hard-surface parts (flares, wing, splitter, diffuser,
exhausts, mirrors, lights, flame decals). Everything beveled; flat shading
for the faceted toy look that matches the game's voxel world.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -t 4 --python tools/make_car.py
Outputs:
  assets/models/glb/fv/car-vulcan.glb
  test-shots/car/render-{three-quarter,side,front,rear}.png
"""
import bpy, bmesh, math, os
from mathutils import Vector, Matrix

import sys
ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
TAG = ""
if "--" in sys.argv:
    _extra = sys.argv[sys.argv.index("--") + 1:]
    if _extra:
        TAG = "-" + _extra[0]
GLB_OUT = os.path.join(ROOT, "assets/models/glb/fv/car-vulcan.glb")
SHOT_DIR = os.path.join(ROOT, "test-shots/car")
os.makedirs(SHOT_DIR, exist_ok=True)
os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)

L, W, H = 1.00, 0.42, 0.28          # length (X), width (Y), height (Z)
X0, X1 = -L / 2, L / 2              # nose at -X (game convention)
TARGET_TRIS = 30000                 # hero vehicle; detail is the point


# ----------------------------------------------------------------- materials
def pbr(name, base, metallic=0.0, rough=0.5, emit=None, emit_strength=0.0, alpha=1.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = (*base, 1.0)
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


def make_materials():
    return {
        "body":    pbr("BodyMagenta", (0.95, 0.02, 0.62), metallic=0.35, rough=0.28),
        "flameO":  pbr("FlameOrange", (1.0, 0.32, 0.02), metallic=0.1, rough=0.35,
                       emit=(1.0, 0.35, 0.02), emit_strength=0.55),
        "flameP":  pbr("FlamePurple", (0.42, 0.10, 0.72), metallic=0.15, rough=0.35),
        "flare":   pbr("FlareBlack", (0.035, 0.033, 0.040), metallic=0.3, rough=0.55),
        "carbon":  pbr("Carbon", (0.055, 0.055, 0.065), metallic=0.45, rough=0.32),
        "glass":   pbr("Canopy", (0.055, 0.025, 0.10), metallic=0.15, rough=0.08, alpha=0.88),
        "trim":    pbr("CyanTrim", (0.25, 0.95, 0.92), metallic=0.0, rough=0.2,
                       emit=(0.35, 1.0, 0.96), emit_strength=1.4),
        "chrome":  pbr("Chrome", (0.86, 0.88, 0.92), metallic=1.0, rough=0.07),
        "pinklip": pbr("PinkLip", (1.0, 0.12, 0.62), metallic=0.7, rough=0.18,
                       emit=(1.0, 0.15, 0.65), emit_strength=0.7),
        "head":    pbr("HeadlightCyan", (0.30, 0.95, 0.92), metallic=0.0, rough=0.15,
                       emit=(0.35, 1.0, 0.96), emit_strength=3.4),
        "tail":    pbr("TaillightMagenta", (1.0, 0.10, 0.70), metallic=0.0, rough=0.2,
                       emit=(1.0, 0.14, 0.72), emit_strength=2.6),
        "tyre":    pbr("Tyre", (0.030, 0.030, 0.034), metallic=0.0, rough=0.88),
        "exhaust": pbr("Exhaust", (0.42, 0.43, 0.46), metallic=1.0, rough=0.25),
    }


# -------------------------------------------------------------- mesh helpers
def new_obj(name, bm, mats):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    for m in (mats if isinstance(mats, (list, tuple)) else [mats]):
        me.materials.append(m)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def bevel(ob, width=0.004, segments=2, angle=40):
    mod = ob.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(angle)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def box(name, size, loc, mats, rot=(0, 0, 0), bev=0.004):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    for ax, a in zip("XYZ", rot):
        if a:
            bmesh.ops.rotate(bm, matrix=Matrix.Rotation(a, 3, ax), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    ob = new_obj(name, bm, mats)
    if bev:
        bevel(ob, bev)
    return ob


def cylinder(name, r, depth, loc, mats, axis="Y", segments=20, r2=None, bev=0.0):
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=segments,
                          radius1=r, radius2=(r if r2 is None else r2), depth=depth)
    if axis == "Y":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "X"), verts=bm.verts)
    elif axis == "X":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "Y"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    ob = new_obj(name, bm, mats)
    if bev:
        bevel(ob, bev, 1)
    return ob


def torus(name, major, minor, loc, mats, axis="Y", rot_extra=None, arc=math.tau):
    bm = bmesh.new()
    steps = 24
    minor_steps = 8
    rings = []
    for i in range(steps):
        a = (i / steps) * arc
        ring = []
        cx, cz = math.cos(a) * major, math.sin(a) * major
        for j in range(minor_steps):
            b = (j / minor_steps) * math.tau
            ring.append(bm.verts.new((cx + math.cos(a) * math.cos(b) * minor,
                                      math.sin(b) * minor,
                                      cz + math.sin(a) * math.cos(b) * minor)))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(minor_steps):
            j = (i + 1) % minor_steps
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if abs(arc - math.tau) < 1e-6:
        for i in range(minor_steps):
            j = (i + 1) % minor_steps
            bm.faces.new((rings[-1][i], rings[-1][j], rings[0][j], rings[0][i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    if axis == "Y":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "X"), verts=bm.verts)
    elif axis == "X":
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "Z"), verts=bm.verts)
    # axis "XZ": no rotation - vertical arch (fender flare) or wheel-face ring
    if rot_extra:
        for ax, a in zip("XYZ", rot_extra):
            if a:
                bmesh.ops.rotate(bm, matrix=Matrix.Rotation(a, 3, ax), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mats)


def superellipse_section(w, z0, z1, n=3.2, steps=16):
    """Rounded-rect cross section in the YZ plane (squircle)."""
    cz = (z0 + z1) / 2
    hz = (z1 - z0) / 2
    pts = []
    for i in range(steps):
        a = (i / steps) * math.tau
        ca, sa = math.cos(a), math.sin(a)
        y = math.copysign(abs(ca) ** (2 / n), ca) * w / 2
        z = cz + math.copysign(abs(sa) ** (2 / n), sa) * hz
        pts.append((y, z))
    return pts


def sweep(name, stations, mats, cap=True, n=3.2, bev=0.006):
    """stations: [(x, width, z_bottom, z_top), ...] -> lofted closed body.

    n controls the cross-section: 3 = rounded, 7+ = boxy slab. The reference
    car is an angular 80s wedge, so the body runs n=6.5 and the cabin n=8.5.
    """
    bm = bmesh.new()
    rings = []
    for x, w, z0, z1 in stations:
        ring = [bm.verts.new((x, y, z)) for y, z in superellipse_section(w, z0, z1, n=n)]
        rings.append(ring)
    n = len(rings[0])
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(n):
            j = (i + 1) % n
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    if cap:
        bm.faces.new(list(reversed(rings[0])))
        bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mats)
    if bev:
        bevel(ob, width=bev, segments=1, angle=30)
    return ob


def annulus(name, r_out, r_in, depth, loc, mats, segments=20):
    """Flat ring (rim face) with a real hole so spokes read from the side."""
    bm = bmesh.new()
    outer, inner = [], []
    for i in range(segments):
        a = (i / segments) * math.tau
        for lst, r in ((outer, r_out), (inner, r_in)):
            lst.append(bm.verts.new((math.cos(a) * r, -depth / 2, math.sin(a) * r)))
            lst.append(bm.verts.new((math.cos(a) * r, depth / 2, math.sin(a) * r)))
    for i in range(segments):
        j = (i + 1) % segments
        o0, o1 = outer[i * 2], outer[i * 2 + 1]
        o2, o3 = outer[j * 2], outer[j * 2 + 1]
        i0, i1 = inner[i * 2], inner[i * 2 + 1]
        i2, i3 = inner[j * 2], inner[j * 2 + 1]
        bm.faces.new((o0, o2, o3, o1))          # outer wall
        bm.faces.new((i1, i3, i2, i0))          # inner wall
        bm.faces.new((o1, o3, i3, i1))          # face -Y
        bm.faces.new((i0, i2, o2, o0))          # face +Y
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mats)


def bolt_on_arch(name, r, width, thickness, loc, mats, segments=7):
    """Bolt-on overfender: a flat-sided arch shell (Rocket-Bunny style).

    Rectangle cross-section swept along a half-circle in the XZ plane, flat
    outer face, hard edges - the reference car's flares are separate bolted
    pieces, not blended bodywork.
    """
    bm = bmesh.new()
    rings = []
    for i in range(segments + 1):
        a = math.pi * (i / segments)          # 0..pi, over the top
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
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mats)


def flame_tongue(name, pts, thickness, mats, side):
    """Flat flame shape in the XZ plane, extruded +Y, then placed on one side.

    The shape is drawn once in car space (x = length, z = height) and used on
    both sides - a side decal has the same silhouette left and right.
    """
    bm = bmesh.new()
    front = [bm.verts.new((x, 0.0, z)) for x, z in pts]
    back = [bm.verts.new((x, thickness, z)) for x, z in pts]
    bm.faces.new(front)
    bm.faces.new(list(reversed(back)))
    for i in range(len(pts)):
        j = (i + 1) % len(pts)
        bm.faces.new((front[i], front[j], back[j], back[i]))
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    bmesh.ops.translate(bm, vec=Vector((0, side * (W / 2 - thickness - 0.001), 0)),
                        verts=bm.verts)
    return new_obj(name, bm, mats)


# ------------------------------------------------------------------ the car
def build_car():
    mats = make_materials()
    parts = []

    def fx(f):  # length fraction -> world X (0 = nose)
        return X0 + f * L

    # ---- lower body: rocker to beltline, widest at the rear fenders
    # (x_frac, width_frac, z_bottom_frac, z_top_frac)
    lower = [
        (0.000, 0.70, 0.13, 0.28),
        (0.030, 0.88, 0.11, 0.32),
        (0.130, 1.06, 0.09, 0.38),
        (0.230, 1.06, 0.09, 0.42),
        (0.310, 0.92, 0.09, 0.50),
        (0.430, 0.86, 0.09, 0.54),
        (0.570, 0.88, 0.09, 0.54),
        (0.700, 1.02, 0.09, 0.54),
        (0.820, 1.06, 0.09, 0.58),
        (0.920, 1.00, 0.11, 0.62),
        (1.000, 0.94, 0.17, 0.62),
    ]
    parts.append(sweep("Body", [(fx(f), w * W, z0 * H, z1 * H)
                                for f, w, z0, z1 in lower], mats["body"],
                       n=6.5, bev=0.003))

    # ---- greenhouse: narrower cabin sweep, windshield -> roof -> deck
    cabin = [
        (0.360, 0.84, 0.44, 0.50),
        (0.420, 0.82, 0.48, 0.80),
        (0.460, 0.80, 0.50, 0.86),
        (0.575, 0.80, 0.50, 0.86),
        (0.650, 0.82, 0.50, 0.82),
        (0.720, 0.84, 0.48, 0.70),
        (0.790, 0.86, 0.46, 0.58),
    ]
    parts.append(sweep("Cabin", [(fx(f), w * W, z0 * H, z1 * H)
                                 for f, w, z0, z1 in cabin], mats["body"],
                       n=8.5, bev=0.002))

    # ---- canopy glass: thin shell over the cabin front (windshield + sides)
    glass = [
        (0.395, 0.78, 0.48, 0.56),
        (0.440, 0.76, 0.54, 0.78),
        (0.490, 0.74, 0.56, 0.84),
        (0.595, 0.74, 0.56, 0.82),
        (0.665, 0.76, 0.54, 0.72),
    ]
    parts.append(sweep("Canopy", [(fx(f), w * W, z0 * H, z1 * H)
                                  for f, w, z0, z1 in glass], mats["glass"],
                       n=8.5, bev=0.002))

    # ---- fender flares: half-torus arches over each wheel, black
    for wheel_x, arc_r in ((0.18, 0.126), (0.82, 0.132)):
        for sy in (-1, 1):
            parts.append(bolt_on_arch("Flare%d%d" % (int(wheel_x * 100), sy),
                                      arc_r, 0.064, 0.038,
                                      (fx(wheel_x), sy * (W / 2 + 0.004), 0.082),
                                      mats["flare"]))

    # ---- wheels: tyre + deep-dish rim + chrome lip + pink lip ring + spokes
    WHEEL_R = 0.098
    for wheel_x in (0.18, 0.82):
        for sy in (-1, 1):
            cx = fx(wheel_x)
            cy = sy * (W / 2 - 0.028)
            parts.append(cylinder("Tyre%d%d" % (int(wheel_x * 100), sy),
                                  WHEEL_R, 0.062, (cx, cy, WHEEL_R), mats["tyre"],
                                  axis="Y", segments=24))
            # rim face = annulus, so the spokes show through
            parts.append(annulus("Rim%d%d" % (int(wheel_x * 100), sy),
                                 0.070, 0.048, 0.014,
                                 (cx, cy + sy * 0.022, WHEEL_R), mats["chrome"]))
            # recessed dish plate behind the spokes
            parts.append(cylinder("Dish%d%d" % (int(wheel_x * 100), sy),
                                  0.048, 0.010, (cx, cy - sy * 0.008, WHEEL_R),
                                  mats["chrome"], axis="Y", segments=20))
            # hub
            parts.append(cylinder("Hub%d%d" % (int(wheel_x * 100), sy),
                                  0.016, 0.020, (cx, cy + sy * 0.024, WHEEL_R),
                                  mats["chrome"], axis="Y", segments=12))
            # pink lip ring on the outer face
            parts.append(torus("Lip%d%d" % (int(wheel_x * 100), sy),
                               0.070, 0.006, (cx, cy + sy * 0.028, WHEEL_R),
                               mats["pinklip"], axis="XZ"))
            # 8 spokes from hub to rim, radial
            for k in range(8):
                a = k * math.tau / 8
                parts.append(box("Spoke%d%d%d" % (int(wheel_x * 100), sy, k),
                                 (0.056, 0.012, 0.010),
                                 (cx + math.cos(a) * 0.033, cy + sy * 0.024,
                                  WHEEL_R + math.sin(a) * 0.033),
                                 mats["chrome"], rot=(0, -a, 0), bev=0.001))

    # ---- wing: two swan-neck stands + blade + endplates
    # GT wing: tubular mounts, lower main plane, upper second element
    # dual-element GT wing: 100% of 6 reviewer judgments named the wing as the
    # top defect - "massive adjustable wing mounted high on the rear quarter
    # panels with visible support struts, scale up 40%". Tall magenta pylons,
    # elements above roof height, wing moved rearward.
    for sy in (-1, 1):
        parts.append(box("Pylon%d" % sy, (0.028, 0.040, 0.250),
                         (fx(0.880), sy * 0.120, 0.56 * H + 0.120),
                         mats["body"], rot=(0, math.radians(10), 0), bev=0.003))
        parts.append(box("PylonFoot%d" % sy, (0.090, 0.040, 0.018),
                         (fx(0.888), sy * 0.120, 0.56 * H + 0.009),
                         mats["body"], bev=0.002))
    parts.append(box("WingMain", (0.145, 0.560, 0.016),
                     (fx(0.858), 0, 0.56 * H + 0.245), mats["carbon"],
                     rot=(0, math.radians(-9), 0), bev=0.003))
    parts.append(box("WingUpper", (0.100, 0.520, 0.012),
                     (fx(0.820), 0, 0.56 * H + 0.315), mats["carbon"],
                     rot=(0, math.radians(-15), 0), bev=0.003))
    for sy in (-1, 1):
        parts.append(box("Endplate%d" % sy, (0.190, 0.011, 0.115),
                         (fx(0.845), sy * 0.282, 0.56 * H + 0.275),
                         mats["body"], rot=(0, math.radians(-9), 0), bev=0.002))

    # ---- splitter, diffuser, exhausts
    parts.append(box("Splitter", (0.095, 0.98 * W, 0.012),
                     (fx(0.008), 0, 0.048), mats["carbon"], bev=0.003))
    parts.append(box("Diffuser", (0.090, 0.92 * W, 0.055),
                     (fx(0.955), 0, 0.095), mats["carbon"],
                     rot=(0, math.radians(14), 0), bev=0.003))
    for sy in (-1, 1):
        parts.append(cylinder("Exhaust%d" % sy, 0.020, 0.070,
                              (fx(0.975), sy * 0.085, 0.135), mats["exhaust"],
                              axis="X", segments=16))

    # ---- pop-up headlight pods (closed) on the hood front + boxy air dam
    for sy in (-1, 1):
        parts.append(box("Pod%d" % sy, (0.070, 0.105, 0.022),
                         (fx(0.045), sy * 0.115, 0.435 * H),
                         mats["body"], rot=(0, math.radians(-4), 0), bev=0.002))
    # matte-black hood panel (the reference's defining front graphic)
    parts.append(box("HoodPanel", (0.230, 0.30, 0.012),
                     (fx(0.165), 0, 0.415 * H), mats["flare"],
                     rot=(0, math.radians(-3), 0), bev=0.002))
    # hood crease ridge: the reference has a hard centre line down the bonnet
    parts.append(box("HoodCrease", (0.165, 0.020, 0.010),
                     (fx(0.155), 0, 0.455 * H), mats["body"],
                     rot=(0, math.radians(-2), 0), bev=0.002))
    # chunky black front bumper: the reference has a distinct bolt-on fascia
    parts.append(box("Bumper", (0.055, 0.96 * W, 0.085),
                     (fx(0.030), 0, 0.135), mats["carbon"], bev=0.003))
    parts.append(box("AirDam", (0.045, 0.92 * W, 0.045),
                     (fx(0.020), 0, 0.078), mats["carbon"], bev=0.003))

    # ---- lights: cyan squares front, magenta bar rear
    for sy in (-1, 1):
        # recessed angular housing, then a round emissive lens inside it
        parts.append(box("HeadBox%d" % sy, (0.055, 0.115, 0.052),
                         (fx(0.040), sy * 0.118, 0.45 * H), mats["carbon"], bev=0.002))
        parts.append(cylinder("HeadLens%d" % sy, 0.030, 0.016,
                              (fx(0.016), sy * 0.118, 0.45 * H), mats["head"],
                              axis="X", segments=16))
        # hood scoop flanking each headlight (haiku: "hood scoops around them")
        parts.append(box("Scoop%d" % sy, (0.070, 0.052, 0.016),
                         (fx(0.135), sy * 0.085, 0.455 * H),
                         mats["flare"], rot=(0, math.radians(-4), 0), bev=0.002))
        parts.append(box("TailEnd%d" % sy, (0.016, 0.070, 0.024),
                         (fx(0.995), sy * 0.115, 0.58 * H), mats["tail"], bev=0.002))
    parts.append(box("TailBar", (0.014, 0.30, 0.020),
                     (fx(0.995), 0, 0.58 * H), mats["tail"], bev=0.002))

    # purple lower-rear body panel (glm: "purple rear body is an identity cue")
    for sy in (-1, 1):
        parts.append(box("PurpleRear%d" % sy, (0.230, 0.006, 0.055),
                         (fx(0.640), sy * (W / 2 - 0.004), 0.24 * H),
                         mats["flameP"], bev=0.002))

    # ---- mirrors
    for sy in (-1, 1):
        parts.append(box("Mirror%d" % sy, (0.030, 0.045, 0.022),
                         (fx(0.315), sy * (W / 2 + 0.012), 0.63 * H),
                         mats["carbon"], bev=0.003))

    # ---- side flames: three tongues per side, hugging the door surface
    # x values are fractions of length (door area ~0.33-0.66), z fractions of H
    # long tapered tongues sweeping the full flank (reviewers: "one small
    # blob" -> extend up the door, purple undertones)
    flame_shapes = [
        [(0.300, 0.30), (0.380, 0.46), (0.480, 0.42), (0.620, 0.50), (0.700, 0.38),
         (0.560, 0.30), (0.420, 0.24)],
        [(0.320, 0.20), (0.430, 0.32), (0.560, 0.26), (0.680, 0.34), (0.720, 0.22),
         (0.520, 0.16)],
        [(0.340, 0.46), (0.440, 0.58), (0.560, 0.52), (0.660, 0.60), (0.700, 0.46),
         (0.500, 0.40)],
        [(0.380, 0.34), (0.500, 0.44), (0.640, 0.38), (0.720, 0.44), (0.660, 0.30),
         (0.460, 0.28)],
    ]
    for sy in (-1, 1):
        for i, shape in enumerate(flame_shapes):
            pts = [(fx(f), z * H) for f, z in shape]
            mat = mats["flameO"] if i % 2 == 0 else mats["flameP"]
            parts.append(flame_tongue("Flame%d%d" % (sy, i), pts, 0.004, mat, sy))

    # join everything
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = "CarVulcan"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    car.data.polygons.foreach_set("use_smooth", [False] * len(car.data.polygons))
    car.data.update()
    return car


def decimate_to(ob, target):
    ob.data.calc_loop_triangles()
    tris = len(ob.data.loop_triangles)
    passes = 0
    while tris > target and passes < 5:
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.ratio = max(0.05, target / tris)
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
        ob.data.calc_loop_triangles()
        tris = len(ob.data.loop_triangles)
        passes += 1
    return tris


def render_previews(ob):
    sc = bpy.context.scene
    sc.render.engine = ("BLENDER_EEVEE_NEXT"
                        if "BLENDER_EEVEE_NEXT" in [e.identifier for e in
                        bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
                        else "BLENDER_EEVEE")
    sc.render.resolution_x, sc.render.resolution_y = 1000, 640
    sc.world = bpy.data.worlds.new("N")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.24, 0.24, 0.26, 1)
    sc.view_settings.view_transform = "Standard"
    for loc, power, size in [((1, -2, 3), 200, 3), ((-2, 1, 2), 110, 2)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        Lg = bpy.context.object
        Lg.data.energy = power
        Lg.data.shape = "DISK"
        Lg.data.size = size
        Lg.rotation_euler = (Vector((0, 0, 0.1)) - Lg.location).to_track_quat("-Z", "Y").to_euler()
    corners = [ob.matrix_world @ Vector(c) for c in ob.bound_box]
    lo = Vector((min(v.x for v in corners), min(v.y for v in corners), min(v.z for v in corners)))
    hi = Vector((max(v.x for v in corners), max(v.y for v in corners), max(v.z for v in corners)))
    ctr = (lo + hi) / 2
    span = max(hi.x - lo.x, hi.y - lo.y, hi.z - lo.z)
    bpy.ops.object.camera_add()
    cam = bpy.context.object
    cam.data.type = "ORTHO"
    sc.camera = cam
    views = {
        "three-quarter": (Vector((1.2, -1.4, 0.8)), 1.15),
        "side":          (Vector((0.0, -2.0, 0.35)), 1.12),
        "front":         (Vector((-2.0, 0.0, 0.45)), 1.30),
        "rear":          (Vector((2.0, 0.0, 0.45)), 1.30),
    }
    for name, (dirv, mult) in views.items():
        cam.data.ortho_scale = span * mult
        cam.location = ctr + dirv.normalized() * 3.0
        cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(SHOT_DIR, "render-%s%s.png" % (name, TAG))
        bpy.ops.render.render(write_still=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    car = build_car()
    car.data.calc_loop_triangles()
    tris_before = len(car.data.loop_triangles)
    tris = decimate_to(car, TARGET_TRIS)
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    car.location = (0, 0, 0)
    corners = [car.matrix_world @ Vector(c) for c in car.bound_box]
    dims = [round(max(v[i] for v in corners) - min(v[i] for v in corners), 4) for i in range(3)]
    bpy.ops.object.select_all(action="DESELECT")
    car.select_set(True)
    bpy.context.view_layer.objects.active = car
    bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format="GLB",
                              use_selection=True, export_yup=True, export_apply=True,
                              export_image_format="AUTO",
                              export_draco_mesh_compression_enable=False)
    render_previews(car)
    print("CARSTATS %s" % {"tris_before": tris_before, "tris": tris, "dims": dims,
                           "glb_bytes": os.path.getsize(GLB_OUT),
                           "materials": len(car.data.materials)})


main()
