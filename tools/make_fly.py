"""Scripted Blender model: the BurnQuest fly collectible ("burn hoverfly").

Design brief (Vulcan's own vision, 2026-09-08):
  The funkyverse is a blocky voxel arcade world with a neon sunset. A realistic
  insect would clash, so the fly is a FACETED low-poly creature: chunky
  flat-shaded chitin forms, beveled hard edges, and neon emissive accents that
  read at 30 px gameplay size. It carries a small orange "burn core" under the
  thorax - the token-burn theme, and it is what makes the pickup read as a
  glowing collectible instead of a dark blob against the sunset road.

  Parts: abdomen (8-sided lofted gem, 2 emissive stripe bands), thorax
  (beveled block), head (beveled block), two faceted compound eyes (large,
  cartoon proportions), two swept translucent wings, six bent legs with
  emissive feet, two antennae with emissive tips, one emissive burn core.

  Orientation: front at -X (game convention), up +Z in Blender. The game spins
  the mesh on Y anyway. Longest axis is X; the GLB dims are reported so the
  game loader can fit-scale it like every other asset.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b -t 4 --python tools/make_fly.py
Outputs:
  assets/models/glb/fv/fly.glb
  test-shots/fly/render-{three-quarter,side,front,game-scale}.png
"""
import bpy, bmesh, math, os
from mathutils import Vector, Matrix

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB_OUT = os.path.join(ROOT, "assets/models/glb/fv/fly.glb")
SHOT_DIR = os.path.join(ROOT, "test-shots/fly")
os.makedirs(SHOT_DIR, exist_ok=True)
os.makedirs(os.path.dirname(GLB_OUT), exist_ok=True)

TARGET_TRIS = 9000          # tiny collectible, but with real up-close structure


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
        # deep violet-black chitin, slightly metallic so the sunset rim pops
        "chitin": pbr("Chitin", (0.105, 0.052, 0.165), metallic=0.50, rough=0.35),
        # neon magenta compound eyes - the strongest read at gameplay size
        "eye": pbr("EyeGlow", (0.42, 0.025, 0.34), metallic=0.1, rough=0.32,
                   emit=(1.0, 0.20, 0.86), emit_strength=2.4),
        # cyan-tinted membrane wings, translucent
        "wing": pbr("WingMembrane", (0.72, 0.52, 0.95), metallic=0.0, rough=0.15,
                    emit=(1.0, 0.38, 0.92), emit_strength=1.1, alpha=0.62),
        # abdomen stripe bands - thin emissive rings
        "stripe": pbr("Stripe", (0.9, 0.15, 0.7), metallic=0.0, rough=0.4,
                      emit=(1.0, 0.22, 0.85), emit_strength=2.0),
        # the burn core: orange, hottest emission on the model
        "core": pbr("BurnCore", (1.0, 0.45, 0.08), metallic=0.0, rough=0.3,
                    emit=(1.0, 0.52, 0.10), emit_strength=6.0),
        # legs/antennae: matte near-black
        "limb": pbr("Limb", (0.10, 0.095, 0.12), metallic=0.25, rough=0.6),
    }


# -------------------------------------------------------------- mesh helpers
def new_obj(name, bm, mat):
    me = bpy.data.meshes.new(name)
    bm.to_mesh(me)
    bm.free()
    me.materials.append(mat)
    ob = bpy.data.objects.new(name, me)
    bpy.context.collection.objects.link(ob)
    return ob


def bevel(ob, width=0.006, segments=2):
    """Hard-surface bevel: what gives the faceted look its chunky toy feel."""
    mod = ob.modifiers.new("bev", "BEVEL")
    mod.width = width
    mod.segments = segments
    mod.limit_method = "ANGLE"
    mod.angle_limit = math.radians(40)
    bpy.context.view_layer.objects.active = ob
    bpy.ops.object.modifier_apply(modifier=mod.name)


def box(name, size, loc, mat, rot=(0, 0, 0)):
    bm = bmesh.new()
    bmesh.ops.create_cube(bm, size=1.0)
    bmesh.ops.scale(bm, vec=Vector(size), verts=bm.verts)
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(rot[0], 3, "X"), verts=bm.verts)
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(rot[1], 3, "Y"), verts=bm.verts)
    bmesh.ops.rotate(bm, matrix=Matrix.Rotation(rot[2], 3, "Z"), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    ob = new_obj(name, bm, mat)
    bevel(ob)
    return ob


def loft(name, profile, mat, axis="X", sides=8):
    """Lathe-style loft: profile = [(pos_along_axis, radius), ...].

    Builds a closed faceted tube through the profile - the chunky-gem look.
    Caps both ends with n-gons.
    """
    bm = bmesh.new()
    rings = []
    for pos, radius in profile:
        ring = []
        for i in range(sides):
            a = (i / sides) * math.tau
            u, v = math.cos(a) * radius, math.sin(a) * radius
            if axis == "X":
                co = (pos, u, v)
            elif axis == "Y":
                co = (u, pos, v)
            else:
                co = (u, v, pos)
            ring.append(bm.verts.new(co))
        rings.append(ring)
    for r0, r1 in zip(rings, rings[1:]):
        for i in range(sides):
            j = (i + 1) % sides
            bm.faces.new((r0[i], r0[j], r1[j], r1[i]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    ob = new_obj(name, bm, mat)
    bevel(ob, width=0.004, segments=1)
    return ob


def facet_ball(name, radius, loc, mat, scale=(1, 1, 1), subdiv=1):
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=subdiv, radius=radius)
    bmesh.ops.scale(bm, vec=Vector(scale), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector(loc), verts=bm.verts)
    return new_obj(name, bm, mat)


def leg(name, joints, radius, mat):
    """Chunky bent limb through joint points (list of Vectors)."""
    bm = bmesh.new()

    def merge(src, matrix):
        me = bpy.data.meshes.new("tmp")
        src.to_mesh(me)
        src.free()
        me.transform(matrix)
        bm.from_mesh(me)
        bpy.data.meshes.remove(me)

    for a, b in zip(joints, joints[1:]):
        d = b - a
        seg = bmesh.new()
        bmesh.ops.create_cone(seg, cap_ends=True, segments=6,
                              radius1=radius, radius2=radius * 0.75, depth=d.length)
        rot = d.to_track_quat("Z", "Y").to_matrix().to_4x4()
        merge(seg, Matrix.Translation(a + d * 0.5) @ rot)
    # knuckle at each bend so joints read as joints, not pinches
    for p in joints[1:-1]:
        k = bmesh.new()
        bmesh.ops.create_icosphere(k, subdivisions=1, radius=radius * 1.15)
        merge(k, Matrix.Translation(p))
    return new_obj(name, bm, mat)


def build_fly():
    """v2 (2026-09-08): fly-read fixes from the two-reader critique.
    A bee/wasp read came from the striped bulky abdomen and a single visible
    eye; flies read by TWO dominant compound eyes on the head sides and TWO
    large wings. So: compact abdomen, no stripe bands (the pink collars are
    gone), eyes enlarged and moved to the head sides, wings enlarged with
    explicit root bars, legs thickened and tucked.
    """
    mats = make_materials()
    parts = []

    # abdomen: COMPACT taper (was 0.35 long - the bee body). Flies are stubby.
    parts.append(loft("Abdomen", [(-0.015, 0.088), (0.045, 0.112), (0.105, 0.100),
                                  (0.165, 0.068), (0.205, 0.030)], mats["chitin"]))
    # one thin cyan waist ring where abdomen meets thorax - neon trim, NOT a
    # bee stripe: single, thin, cool-coloured.
    parts.append(loft("Waist", [(-0.022, 0.098), (-0.010, 0.096)], mats["wing"], sides=8))

    # thorax: compact motor block
    parts.append(box("Thorax", (0.135, 0.125, 0.108), (-0.075, 0, 0), mats["chitin"]))

    # dark collar: luminance break between the bright head and dark thorax
    parts.append(box("Collar", (0.020, 0.126, 0.112), (-0.133, 0, 0.004), mats["limb"]))

    # head: wider than deep so the eyes sit on the SIDES (the fly signature)
    parts.append(box("Head", (0.072, 0.112, 0.098), (-0.175, 0, 0.006), mats["chitin"]))

    # compound eyes: dominant, on the head sides, bulging forward-out
    for sz in (-1, 1):
        parts.append(facet_ball("Eye%d" % sz, 0.058, (-0.198, sz * 0.052, 0.014),
                                mats["eye"], scale=(1.05, 0.90, 1.0), subdiv=2))
    # dark septum between the eyes: the gap is what makes TWO eyes read
    parts.append(box("Septum", (0.022, 0.030, 0.092), (-0.188, 0, 0.010), mats["limb"]))

    # antennae: short bars + small aligned tips
    for sz in (-1, 1):
        tip = Vector((-0.305, sz * 0.058, 0.055))
        parts.append(leg("Antenna%d" % sz,
                         [Vector((-0.212, sz * 0.026, 0.034)), tip], 0.008, mats["limb"]))
        parts.append(facet_ball("AntTip%d" % sz, 0.0095, tip, mats["core"], subdiv=1))

    # wings: the other fly signature. Large blades held out in a shallow V,
    # swept back, each with a solid root bar so the attachment reads.
    # 2026-09-11 (Gabriel: "the wings are touching each other"): at 58 deg of
    # sideways swing from a root only 0.066 off-centre, each 0.18-radius blade
    # reached 0.153 across - 0.087 PAST the centreline - so the pair crossed in
    # an X over the thorax. Swept back to 32 deg with the centre moved out to
    # 0.135, the inner ends sit 0.04 off the centreline (a visible gap) and the
    # outer tips stay at about the old span, so the GLB dims do not change.
    WING_SWING, WING_CX, WING_CY = 32, 0.075, 0.105
    for sz in (-1, 1):
        # dark rim blade UNDER the membrane: a hard silhouette edge is what
        # makes the wing readable at 30 px (translucency alone disappears)
        bm = bmesh.new()
        bmesh.ops.create_circle(bm, cap_ends=True, segments=12, radius=0.148)
        bmesh.ops.scale(bm, vec=Vector((1.0, 0.36, 1.0)), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "X"), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(sz * -14), 3, "Y"), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(sz * WING_SWING), 3, "Z"), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((WING_CX, sz * WING_CY, 0.078)), verts=bm.verts)
        parts.append(new_obj("WingRim%d" % sz, bm, mats["stripe"]))

        bm = bmesh.new()
        bmesh.ops.create_circle(bm, cap_ends=True, segments=12, radius=0.132)
        bmesh.ops.scale(bm, vec=Vector((1.0, 0.34, 1.0)), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(90), 3, "X"), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(sz * -14), 3, "Y"), verts=bm.verts)
        bmesh.ops.rotate(bm, matrix=Matrix.Rotation(math.radians(sz * WING_SWING), 3, "Z"), verts=bm.verts)
        bmesh.ops.translate(bm, vec=Vector((WING_CX, sz * WING_CY, 0.081)), verts=bm.verts)
        parts.append(new_obj("Wing%d" % sz, bm, mats["wing"]))
        # root bar: solid chitin, visually anchors the wing to the thorax
        parts.append(box("WingRoot%d" % sz, (0.075, 0.016, 0.014),
                         (-0.078, sz * 0.040, 0.074), mats["chitin"],
                         rot=(0, math.radians(sz * -12), math.radians(sz * WING_SWING))))

    # legs: six, thicker, tucked - front pair forward, rear pair back, clearly
    # separated in silhouette instead of three parallel rods.
    leg_specs = [(-0.135, 0.052, -0.068, 0.030),   # (x, spread, drop, fore/aft)
                 (-0.075, 0.058, -0.084, 0.0),
                 (-0.015, 0.054, -0.074, -0.030)]
    for sz in (-1, 1):
        for i, (x, spread, drop, aft) in enumerate(leg_specs):
            # tucked tripod: feet pulled in toward the body, thicker limbs
            knee = Vector((x + aft * 0.5, sz * (spread + 0.038), drop))
            foot = Vector((x + aft, sz * (spread + 0.046), drop - 0.056))
            parts.append(leg("Leg%d%d" % (sz, i),
                             [Vector((x, sz * spread, -0.032)), knee, foot],
                             0.019, mats["limb"]))
            parts.append(facet_ball("Foot%d%d" % (sz, i), 0.0085, foot,
                                    mats["core"], subdiv=1))

    # burn core: emissive octahedron slung under the thorax (token-burn read)
    bm = bmesh.new()
    bmesh.ops.create_icosphere(bm, subdivisions=0, radius=0.034)
    bmesh.ops.scale(bm, vec=Vector((1.15, 1.0, 1.0)), verts=bm.verts)
    bmesh.ops.translate(bm, vec=Vector((-0.075, 0, -0.082)), verts=bm.verts)
    parts.append(new_obj("BurnCore", bm, mats["core"]))

    # join + apply
    bpy.ops.object.select_all(action="DESELECT")
    for p in parts:
        p.select_set(True)
    bpy.context.view_layer.objects.active = parts[0]
    bpy.ops.object.join()
    fly = bpy.context.active_object
    fly.name = "Fly"
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    fly.data.polygons.foreach_set("use_smooth", [False] * len(fly.data.polygons))
    fly.data.update()
    return fly


def decimate_to(ob, target):
    ob.data.calc_loop_triangles()
    tris = len(ob.data.loop_triangles)
    passes = 0
    while tris > target and passes < 6:
        ratio = max(0.05, target / tris)
        mod = ob.modifiers.new("dec", "DECIMATE")
        mod.ratio = ratio
        bpy.context.view_layer.objects.active = ob
        bpy.ops.object.modifier_apply(modifier=mod.name)
        ob.data.calc_loop_triangles()
        tris = len(ob.data.loop_triangles)
        passes += 1
    return tris


def render_previews(ob):
    """Matched neutral rig - same methodology as every other asset sheet."""
    sc = bpy.context.scene
    sc.render.engine = ("BLENDER_EEVEE_NEXT"
                        if "BLENDER_EEVEE_NEXT" in [e.identifier for e in
                        bpy.types.RenderSettings.bl_rna.properties["engine"].enum_items]
                        else "BLENDER_EEVEE")
    sc.render.resolution_x, sc.render.resolution_y = 900, 650
    sc.world = bpy.data.worlds.new("N")
    sc.world.use_nodes = True
    sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.10, 0.09, 0.12, 1)
    sc.view_settings.view_transform = "Standard"

    for loc, power, size in [((1, -2, 3), 160, 3), ((-2, 1, 2), 90, 2)]:
        bpy.ops.object.light_add(type="AREA", location=loc)
        L = bpy.context.object
        L.data.energy = power
        L.data.shape = "DISK"
        L.data.size = size
        L.rotation_euler = (Vector((0, 0, 0.05)) - L.location).to_track_quat("-Z", "Y").to_euler()

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
        "three-quarter": (Vector((1.1, -1.1, 0.75)), 1.25),
        "side":          (Vector((0.0, -1.9, 0.25)), 1.25),
        "front":         (Vector((-1.9, 0.0, 0.25)), 1.25),
        # game-scale: how it reads at collectible size on the board
        "game-scale":    (Vector((1.1, -1.1, 0.75)), 5.5),
        # game-scale over fv water cyan: the collectible floats over water rows,
        # so contrast against the bright cyan tiles is the real gameplay test
        "game-scale-water": (Vector((1.1, -1.1, 0.75)), 5.5),
    }
    for name, (dirv, mult) in views.items():
        if name.endswith("-water"):
            sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.31, 0.77, 0.78, 1)
        else:
            sc.world.node_tree.nodes["Background"].inputs[0].default_value = (0.10, 0.09, 0.12, 1)
        cam.data.ortho_scale = span * mult
        cam.location = ctr + dirv.normalized() * 3.0
        cam.rotation_euler = (ctr - cam.location).to_track_quat("-Z", "Y").to_euler()
        sc.render.filepath = os.path.join(SHOT_DIR, "render-%s.png" % name)
        bpy.ops.render.render(write_still=True)


def main():
    bpy.ops.wm.read_factory_settings(use_empty=True)
    fly = build_fly()
    fly.data.calc_loop_triangles()
    tris_before = len(fly.data.loop_triangles)
    tris = decimate_to(fly, TARGET_TRIS)

    # normalize: centre on origin (the game positions and spins the mesh)
    bpy.ops.object.origin_set(type="ORIGIN_GEOMETRY", center="BOUNDS")
    fly.location = (0, 0, 0)

    corners = [fly.matrix_world @ Vector(c) for c in fly.bound_box]
    dims = (max(v.x for v in corners) - min(v.x for v in corners),
            max(v.y for v in corners) - min(v.y for v in corners),
            max(v.z for v in corners) - min(v.z for v in corners))

    bpy.ops.object.select_all(action="DESELECT")
    fly.select_set(True)
    bpy.context.view_layer.objects.active = fly
    bpy.ops.export_scene.gltf(filepath=GLB_OUT, export_format="GLB",
                              use_selection=True, export_yup=True, export_apply=True,
                              export_image_format="AUTO",
                              export_draco_mesh_compression_enable=False)
    render_previews(fly)
    print("FLYSTATS %s" % {
        "tris_before": tris_before, "tris": tris,
        "dims": [round(d, 4) for d in dims],
        "glb_bytes": os.path.getsize(GLB_OUT), "materials": len(fly.data.materials),
    })


main()
