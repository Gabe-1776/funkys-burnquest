"""Funky, rebuilt in Blender from Grok Build's concept-4 reference art.

Gabriel (2026-09-11): "polish it up in blender then, use the reference images".
The in-game model was a TRELLIS bake of those references and came out soft and
blobby; the references are crisp VOXEL art. This rebuilds him to match them:
  - EVERY part voxelised on one shared lattice (greedy-meshed), each voxel a
    random dark / mid / light shade like the reference's speckled surface
  - a real chain of interlocking rectangular links; purple cross with a gold
    edge; fine box fingers
  - round black glasses with rainbow double-spiral lenses
  - every part RIGID on its own bone, so a raised arm swings cleanly instead of
    dragging torso skin (the TRELLIS rig's shoulder stretch)
Clips, renders and export are shared with tools/rig_funky.py
(tools/funky_rig_common.py), so he moves exactly as before.

All dimensions are MEASURED from test-shots/character/funky-c4-{front,side}.png
(colour-class segmentation), scaled so hat top -> sole = 1.1 units, the game's
character height. Three.js coords: Y up, faces -X, side-to-side is z; origin
on the hat's centre line.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/make_funky.py
Outputs (candidate until reviewed against the references):
  test-shots/voxel/funky-voxel.glb     (FUNKY_OUT overrides)
  test-shots/voxel/*.png               renders framed like the reference art
"""
import bpy, colorsys, math, os, sys
import numpy as np
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from funky_rig_common import FPS, b, build_rig, author_clips, shoot_poses, export_glb

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
OUT = os.environ.get("FUNKY_OUT", os.path.join(ROOT, "test-shots/voxel/funky-voxel.glb"))
SHOTS = os.environ.get("FUNKY_SHOTS", os.path.join(ROOT, "test-shots/voxel"))


def lin(r, g, bb):
    f = lambda c: (c / 255) / 12.92 if c / 255 <= 0.04045 else (((c / 255) + 0.055) / 1.055) ** 2.4
    return (f(r), f(g), f(bb))


def raw(r, g, bb):
    return (r / 255, g / 255, bb / 255)

# Vertex colours in the convention the GAME draws: three.js takes them as-is,
# and the TRELLIS Funky players have been seeing stores ~(0.51, 0.78, 0.23) for
# his lime. Converting the reference sRGB to linear (v1) made him far darker
# than that. So: the in-game lime exactly, and the reference hues on the same
# scale (reference medians are lit colours, nudged ~1.15x toward albedo).
COL = {
    # NEON: Gabriel's pick from an in-game A/B (tools/funky-green-ab.js,
    # 2026-09-11). The old model's lime (0.51, 0.78, 0.23) read pale cream on
    # the olive start-row grass under the sunset light; this reads green and
    # pops, so he is found at a glance while dodging traffic.
    "green": (0.20, 1.00, 0.10), "nostril": raw(40, 70, 14),
    # Saturated hues keep their LOW channels low - raw() of the reference made
    # the hat and gold read pale lavender / khaki (v2 renders). Deep violet and
    # rich gold, matching the reference's look rather than its raw numbers.
    "hat": (0.25, 0.02, 0.52), "gold": (0.62, 0.40, 0.04),
    "black": (0.012, 0.012, 0.012), "silver": (0.58, 0.59, 0.61), "silver2": (0.36, 0.37, 0.40),
    "cross": (0.22, 0.03, 0.46), "crossgold": (0.70, 0.46, 0.06),
}

# ---- mesh accumulator (three.js coords) ------------------------------------
V, F, C, BONE = [], [], [], []
AX = {0: (1, 2), 1: (2, 0), 2: (0, 1)}      # (u, w) with u x w = axis


def add_poly(pts, cols, bone, want=None):
    """One face. If `want` (a normal) is given, the winding is flipped to match."""
    if want is not None:
        p0, p1, p2 = (np.array(p) for p in pts[:3])
        if np.dot(np.cross(p1 - p0, p2 - p0), want) < 0:
            pts, cols = pts[::-1], cols[::-1]
    i = len(V)
    V.extend(pts); C.extend(cols); BONE.extend([bone] * len(pts))
    F.append(tuple(range(i, i + len(pts))))


def quad(axis, sign, level, u0, u1, w0, w1):
    ua, wa = AX[axis]
    corners = [(u0, w0), (u1, w0), (u1, w1), (u0, w1)]
    if sign < 0:
        corners = corners[::-1]
    out = []
    for cu, cw in corners:
        p = [0.0, 0.0, 0.0]
        p[axis], p[ua], p[wa] = level, cu, cw
        out.append(tuple(p))
    return out


def box(x0, x1, y0, y1, z0, z1, col, bone):
    lo, hi = (x0, y0, z0), (x1, y1, z1)
    for axis in range(3):
        ua, wa = AX[axis]
        for sign in (1, -1):
            add_poly(quad(axis, sign, hi[axis] if sign > 0 else lo[axis],
                          lo[ua], hi[ua], lo[wa], hi[wa]), [COL[col]] * 4, bone)


# ---- voxel parts, greedy-meshed, speckled ------------------------------------
# One lattice for every part (multiples of VOX from the origin), so a torso and
# an arm meet on the same voxel steps. Each part is meshed on its OWN grid, so
# it is a closed shell that can swing on its bone without holes showing.
VOX = 0.022
SPECKLE = (0.82, 1.0, 1.14)          # dark / mid / light shade of every colour
SPECKLE_P = (0.22, 0.56, 0.22)       # the reference's voxel surface is speckled
_rng = np.random.default_rng(1776)   # fixed seed: rebuilds are identical


def shade(c, k):
    return tuple(min(1.0, ch * SPECKLE[k]) for ch in c)


def voxel_part(lo, hi, inside, colour_of, bone):
    """inside(x,y,z) and colour_of(x,y,z) take cell-centre arrays; colour_of
    returns an array of COL names. Cells snap to the shared lattice."""
    i0 = [int(math.floor(lo[a_] / VOX)) for a_ in range(3)]
    i1 = [int(math.ceil(hi[a_] / VOX)) for a_ in range(3)]
    shape = tuple(i1[a_] - i0[a_] for a_ in range(3))
    origin = np.array([i0[a_] * VOX for a_ in range(3)])
    ii = np.meshgrid(*[np.arange(n) for n in shape], indexing="ij")
    cx, cy, cz = (origin[a_] + (ii[a_] + 0.5) * VOX for a_ in range(3))
    occ = inside(cx, cy, cz)
    base = colour_of(cx, cy, cz)
    names = sorted(set(base[occ].tolist()))
    k = _rng.choice(3, size=shape, p=SPECKLE_P)
    cid = np.full(shape, -1)
    for bi, nm in enumerate(names):
        cid = np.where(occ & (base == nm), bi * 3 + k, cid)
    palette = [shade(COL[nm], kk) for nm in names for kk in range(3)]
    mesh_voxels(occ, cid, palette, origin, shape, bone)


def mesh_voxels(occ, cid, palette, origin, shape, bone):
    for axis in range(3):
        ua, wa = AX[axis]
        for sign in (1, -1):
            for s in range(shape[axis]):
                sl = [slice(None)] * 3
                sl[axis] = s
                cur = occ[tuple(sl)]
                t = s + sign
                if 0 <= t < shape[axis]:
                    sl2 = [slice(None)] * 3
                    sl2[axis] = t
                    nb = occ[tuple(sl2)]
                else:
                    nb = np.zeros_like(cur)
                g = np.where(cur & ~nb, cid[tuple(sl)], -1)
                if axis == 1:
                    g = g.T                     # remaining dims are (x, z) = (w, u)
                done = np.zeros(g.shape, bool)
                level = origin[axis] + (s + 1 if sign > 0 else s) * VOX
                for iu in range(g.shape[0]):
                    for iw in range(g.shape[1]):
                        c = g[iu, iw]
                        if c < 0 or done[iu, iw]:
                            continue
                        we = iw
                        while we + 1 < g.shape[1] and g[iu, we + 1] == c and not done[iu, we + 1]:
                            we += 1
                        ue = iu
                        while (ue + 1 < g.shape[0] and np.all(g[ue + 1, iw:we + 1] == c)
                               and not done[ue + 1, iw:we + 1].any()):
                            ue += 1
                        done[iu:ue + 1, iw:we + 1] = True
                        add_poly(quad(axis, sign, level,
                                      origin[ua] + iu * VOX, origin[ua] + (ue + 1) * VOX,
                                      origin[wa] + iw * VOX, origin[wa] + (we + 1) * VOX),
                                 [palette[c]] * 4, bone)


def solid(name):
    return lambda x, y, z: np.full(x.shape, name, dtype=object)


def vbox(x0, x1, y0, y1, z0, z1, name, bone):
    """A box built from lattice voxels (speckled), not one flat slab."""
    voxel_part((x0, y0, z0), (x1, y1, z1),
               lambda x, y, z: (x >= x0) & (x <= x1) & (y >= y0) & (y <= y1) & (z >= z0) & (z <= z1),
               solid(name), bone)


# HEAD: skull + wide snout (side view: face front -0.097 at y 0.73, snout tip
# -0.24 at y 0.60-0.66, back of head +0.18; front view: widest +-0.219 at y
# 0.63, chin +-0.12 at 0.53).
def head_inside(x, y, z):
    skull = ((x - 0.035) / 0.145) ** 2 + ((y - 0.67) / 0.16) ** 2 + (z / 0.225) ** 2 <= 1
    snout = ((x + 0.13) / 0.115) ** 2 + ((y - 0.62) / 0.06) ** 2 + (z / 0.17) ** 2 <= 1
    return (skull | snout) & (y >= 0.505) & (y <= 0.83)


def head_colour(x, y, z):
    snout = ((x + 0.13) / 0.115) ** 2 + ((y - 0.62) / 0.06) ** 2 + (z / 0.17) ** 2 <= 1
    nostril = snout & (x < -0.19) & (np.abs(y - 0.655) < 0.013) & (np.abs(np.abs(z) - 0.042) < 0.013)
    return np.where(nostril, "nostril", "green").astype(object)


voxel_part((-0.26, 0.50, -0.24), (0.19, 0.84, 0.24), head_inside, head_colour, "head")


# HAT: crown flares slightly toward the top (side depth 0.28 -> 0.31), gold band
# y 0.845-0.905, one-voxel brim of radius 0.222 at y 0.82.
def hat_inside(x, y, z):
    r = np.sqrt(x * x + z * z)
    crown_r = 0.140 + 0.013 * np.clip((y - 0.905) / 0.195, 0, 1)
    return ((y >= 0.845) & (y <= 1.10) & (r <= crown_r)) | ((y >= 0.82) & (y < 0.845) & (r <= 0.222))


def hat_colour(x, y, z):
    return np.where((y >= 0.845) & (y < 0.905), "gold", "hat").astype(object)


voxel_part((-0.24, 0.80, -0.24), (0.24, 1.11, 0.24), hat_inside, hat_colour, "hat")

# ---- glasses: rainbow double-spiral lenses in black rings --------------------
LX, LY, LZ, LR = -0.112, 0.735, 0.136, 0.061
for s in (-1, 1):
    cz = s * LZ
    rings, segs = 10, 40
    def lens_col(rr, th):
        h = (2 * th / (2 * math.pi) + 2.2 * rr / LR) % 1.0
        return lin(*[int(255 * c) for c in colorsys.hsv_to_rgb(h, 0.88, 0.97)])
    for ri in range(rings):
        r0, r1 = LR * ri / rings, LR * (ri + 1) / rings
        for si in range(segs):
            t0, t1 = 2 * math.pi * si / segs, 2 * math.pi * (si + 1) / segs
            pts = [(LX, LY + r0 * math.sin(t0), cz + r0 * math.cos(t0)),
                   (LX, LY + r1 * math.sin(t0), cz + r1 * math.cos(t0)),
                   (LX, LY + r1 * math.sin(t1), cz + r1 * math.cos(t1)),
                   (LX, LY + r0 * math.sin(t1), cz + r0 * math.cos(t1))]
            cols = [lens_col(r0, t0), lens_col(r1, t0), lens_col(r1, t1), lens_col(r0, t1)]
            if ri == 0:
                pts, cols = pts[1:], cols[1:]          # centre: triangle, not a sliver quad
            add_poly(pts, cols, "head", want=(-1, 0, 0))
    # frame: an annular prism, so it has depth from the side
    ri_, ro_, x0, x1, segs = LR, LR + 0.013, LX - 0.006, LX + 0.012, 40
    for si in range(segs):
        t0, t1 = 2 * math.pi * si / segs, 2 * math.pi * (si + 1) / segs
        P = lambda xx, rr, t: (xx, LY + rr * math.sin(t), cz + rr * math.cos(t))
        k = [COL["black"]] * 4
        add_poly([P(x0, ri_, t0), P(x0, ro_, t0), P(x0, ro_, t1), P(x0, ri_, t1)], k, "head", want=(-1, 0, 0))
        add_poly([P(x1, ri_, t0), P(x1, ro_, t0), P(x1, ro_, t1), P(x1, ri_, t1)], k, "head", want=(1, 0, 0))
        mid = (t0 + t1) / 2
        add_poly([P(x0, ro_, t0), P(x1, ro_, t0), P(x1, ro_, t1), P(x0, ro_, t1)], k, "head",
                 want=(0, math.sin(mid), math.cos(mid)))
    # temple arm back along the side of the head
    box(LX, 0.07, LY + 0.004, LY + 0.016, s * 0.197 - 0.006, s * 0.197 + 0.006, "black", "head") if s > 0 else \
        box(LX, 0.07, LY + 0.004, LY + 0.016, -0.197 - 0.006, -0.197 + 0.006, "black", "head")
box(LX - 0.004, LX + 0.008, LY + 0.004, LY + 0.016, -0.075, 0.075, "black", "head")   # bridge

# ---- body: crisp boxes, each on its own bone ----------------------------------
TX0, TX1, TZ = -0.066, 0.101, 0.135          # torso depth / half-width (measured)
vbox(TX0, TX1, 0.38, 0.51, -TZ, TZ, "green", "spine")
vbox(TX0, TX1, 0.24, 0.38, -TZ, TZ, "green", "hips")
# chain: REAL links, like the reference - rectangular rings that alternate
# between two planes along the path, so neighbours read as interlocking.
def obox(c, axes, half, col, bone):
    """Oriented box: centre, three unit axes, half-extents along them."""
    c = np.array(c, float)
    ax = [np.array(v, float) for v in axes]
    corner = lambda s0, s1, s2: tuple(c + s0 * half[0] * ax[0] + s1 * half[1] * ax[1] + s2 * half[2] * ax[2])
    for i in range(3):
        j, k = (i + 1) % 3, (i + 2) % 3
        for s in (1, -1):
            pts = []
            for a_, b_ in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
                sv = [0, 0, 0]
                sv[i], sv[j], sv[k] = s, a_, b_
                pts.append(corner(*sv))
            add_poly(pts, [COL[col]] * 4, bone, want=s * ax[i])


def unit(v):
    v = np.array(v, float)
    return v / np.linalg.norm(v)


LINK_L, LINK_W, WIRE = 0.016, 0.010, 0.0042
_link_n = [0]
def chain_link(p, t, n1, n2):
    """Ring in the plane (t, n) - n alternates between n1 and n2 per link."""
    _link_n[0] += 1
    t = unit(t)
    n = unit(n1 if _link_n[0] % 2 else n2)
    q = unit(np.cross(t, n))
    col = "silver" if _link_n[0] % 3 else "silver2"
    p = np.array(p, float)
    for s in (1, -1):                                  # the two long sides
        obox(p + s * (LINK_W - WIRE) * n, (t, n, q), (LINK_L, WIRE, WIRE), col, "spine")
    for s in (1, -1):                                  # the two short ends
        obox(p + s * (LINK_L - WIRE) * t, (t, n, q), (WIRE, LINK_W, WIRE), col, "spine")


COLLAR_C, COLLAR_Y, COLLAR_RX, COLLAR_RZ = (0.022, 0.0), 0.517, 0.100, 0.152
NL = 30
for i in range(NL):                                    # collar loop round the neck
    a_ = 2 * math.pi * i / NL
    p = (COLLAR_C[0] + COLLAR_RX * math.cos(a_), COLLAR_Y, COLLAR_RZ * math.sin(a_))
    t = (-COLLAR_RX * math.sin(a_), 0.0, COLLAR_RZ * math.cos(a_))
    radial = (math.cos(a_) / COLLAR_RX, 0.0, math.sin(a_) / COLLAR_RZ)
    chain_link(p, t, (0, 1, 0), radial)
NU = 12
for i in range(NU):                                    # the U hanging to the cross
    zz = -0.118 + 0.236 * (i + 0.5) / NU
    yy = 0.378 + 0.137 * (zz / 0.118) ** 2
    t = (0.0, 2 * 0.137 * zz / 0.118 ** 2, 1.0)
    front = (-1.0, 0.0, 0.0)
    chain_link((TX0 - 0.012, yy, zz), t, front, np.cross(unit(t), front))
# cross: purple bars in front of slightly larger gold bars = a gold edge
box(-0.094, -0.078, 0.270, 0.360, -0.012, 0.012, "cross", "spine")
box(-0.094, -0.078, 0.318, 0.342, -0.038, 0.038, "cross", "spine")
box(-0.086, -0.072, 0.264, 0.366, -0.018, 0.018, "crossgold", "spine")
box(-0.086, -0.072, 0.312, 0.348, -0.044, 0.044, "crossgold", "spine")
AX0, AX1 = -0.004, 0.038                     # arm depth ~0.042 (front view ~0.046)
for s, sd in ((1, "L"), (-1, "R")):
    zs = lambda a, bb: (min(s * a, s * bb), max(s * a, s * bb))
    # arms hang slightly outward: upper arm, then a stepped-out forearm (voxel stair)
    vbox(AX0, AX1, 0.365, 0.495, *zs(0.137, 0.177), "green", f"arm.{sd}")
    vbox(AX0, AX1, 0.262, 0.372, *zs(0.163, 0.203), "green", f"hand.{sd}")
    for off in (-0.016, 0.0, 0.016):         # three stubby fingers
        box(AX0 + 0.008, AX1 - 0.008, 0.232, 0.266, *zs(0.186 + off - 0.006, 0.186 + off + 0.006),
            "green", f"hand.{sd}")
    # legs: thigh + shin, 0.083 wide, 0.105 deep, at z +-0.093
    vbox(-0.037, 0.068, 0.165, 0.25, *zs(0.052, 0.134), "green", f"thigh.{sd}")
    vbox(-0.032, 0.063, 0.098, 0.172, *zs(0.056, 0.130), "green", f"shin.{sd}")
    # big three-toed feet: sole, ankle, toes reaching forward to -0.145
    vbox(-0.07, 0.10, 0.0, 0.045, *zs(0.066, 0.182), "green", f"foot.{sd}")
    vbox(-0.035, 0.07, 0.045, 0.10, *zs(0.07, 0.15), "green", f"foot.{sd}")
    for off in (-0.045, 0.0, 0.045):
        vbox(-0.145, -0.068, 0.004, 0.05, *zs(0.124 + off - 0.015, 0.124 + off + 0.015), "green", f"foot.{sd}")

# ---- skeleton on the part joints ------------------------------------------------
BONES = [
    ("hips",  (0.017, 0.24, 0.0), (0.017, 0.38, 0.0), None),
    ("spine", (0.017, 0.38, 0.0), (0.017, 0.51, 0.0), "hips"),
    ("head",  (0.02, 0.51, 0.0),  (0.02, 0.82, 0.0),  "spine"),
    ("hat",   (0.0, 0.82, 0.0),   (0.0, 1.10, 0.0),   "head"),
]
for sd, s in (("L", 1.0), ("R", -1.0)):
    BONES += [
        (f"thigh.{sd}", (0.016, 0.25, s * 0.093),  (0.016, 0.17, s * 0.093),  "hips"),
        (f"shin.{sd}",  (0.016, 0.17, s * 0.093),  (0.016, 0.10, s * 0.093),  f"thigh.{sd}"),
        (f"foot.{sd}",  (0.016, 0.10, s * 0.10),   (-0.12, 0.02, s * 0.124),  f"shin.{sd}"),
        (f"arm.{sd}",   (0.017, 0.49, s * 0.150),  (0.017, 0.368, s * 0.18),  "spine"),
        (f"hand.{sd}",  (0.017, 0.368, s * 0.18),  (0.017, 0.235, s * 0.205), f"arm.{sd}"),
    ]

# ---- Blender objects ---------------------------------------------------------------
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
scene.render.fps = FPS
scene.view_settings.view_transform = "Standard"     # true colours in the renders
scene.display.shading.show_cavity = True            # shade the voxel steps
scene.display.shading.cavity_type = "BOTH"
scene.display.shading.show_shadows = True
me = bpy.data.meshes.new("Funky")
me.from_pydata([tuple(b(*p)) for p in V], [], F)
me.update()
col = me.color_attributes.new("Col", "FLOAT_COLOR", "POINT")
for i, c in enumerate(C):
    col.data[i].color = (c[0], c[1], c[2], 1.0)
me.color_attributes.active_color = col
body = bpy.data.objects.new("Funky", me)
scene.collection.objects.link(body)
mat = bpy.data.materials.new("FunkyMat")
mat.use_nodes = True
nt = mat.node_tree
bsdf = nt.nodes["Principled BSDF"]
vc = nt.nodes.new("ShaderNodeVertexColor")
vc.layer_name = "Col"
nt.links.new(vc.outputs["Color"], bsdf.inputs["Base Color"])
bsdf.inputs["Roughness"].default_value = 0.65
me.materials.append(mat)

rig = build_rig(scene, BONES)
# RIGID: every vertex belongs 100% to its part's bone.
groups = {n: body.vertex_groups.new(name=n) for n, *_ in BONES}
by_bone = {}
for i, bn in enumerate(BONE):
    by_bone.setdefault(bn, []).append(i)
for bn, idx in by_bone.items():
    groups[bn].add(idx, 1.0, "REPLACE")
body.parent = rig
body.modifiers.new("Armature", "ARMATURE").object = rig
print("MESH", {"verts": len(V), "faces": len(F), "tris": sum(len(f) - 2 for f in F),  # budget: <15k tris
               "per_bone_verts": {k: len(v) for k, v in sorted(by_bone.items())}})

author_clips(rig, arms="free")     # rigid parts: throw the arms OUT
# Framed exactly like the reference art: 1024 px, 836 px from sole to hat top.
shoot_poses(scene, rig, SHOTS, centre_z=0.549, ortho=1.347, res=1024, bg=(0.21, 0.21, 0.21),
            poses=(("hop", (6, 12)), ("dance", (1,))))
os.makedirs(os.path.dirname(OUT), exist_ok=True)
export_glb([body, rig], OUT)
