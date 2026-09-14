"""Tandem car bake (v2): Meshy volume kept WHOLE + Blender retopo wing only.

Run headless:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/bake_car_tandem.py

Phase B philosophy applied to the actual asset: Phase-A scoring showed Meshy's
body, rims, glass and paint are its strong suit (body=3, rims=4, glass=3) while
the disconnected rear wing shells read as a stub. The best "combined" car keeps
the full Meshy volume/paint AND retopoes the rear wing (plus a clean glass roof
insert) from the orthos, without carving holes in the textured shell.

Steps:
  1. Import Meshy GLB whole (single textured shell).
  2. Remove ONLY the detached rear-wing shells (small islands up above the rear
     deck), leaving body+arches+glass+rims untouched.
  3. Build a proper swan-neck wing (magenta uprights + carbon top + endplates)
     whose uprights sink into the rear deck so it reads mounted.
  4. Bake JSON in the SAME frame as car_meshy.json with vertex colors: body
     keeps the Meshy texture; wing vertices get their flat material colour.
"""
import bpy, json, os, math, bmesh

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
GLB = os.path.join(ROOT, "test-shots/pipeline-car/car_meshy_tex.glb")
OUT = os.path.join(ROOT, "assets/models/bakeoff/car_tandem.json")

sys_path = os.path.join(ROOT, "tools")
if sys_path not in __import__("sys").path:
    __import__("sys").path.insert(0, sys_path)
from bake_trellis_glb import reset_scene, log  # noqa

def import_glb_simple(path):
    before = set(bpy.data.objects)
    try:
        bpy.ops.import_scene.gltf(filepath=path)
    except Exception:
        bpy.ops.wm.gltf_import(filepath=path)
    return [o for o in bpy.data.objects if o not in before and o.type == "MESH"]

def ensure_active(obj):
    bpy.ops.object.select_all(action="DESELECT")
    obj.select_set(True)
    bpy.context.view_layer.objects.active = obj
    bpy.context.view_layer.update()

def measure_bounds(obj):
    bb = obj.bound_box
    xs = [v[0] for v in bb]; ys = [v[1] for v in bb]; zs = [v[2] for v in bb]
    return (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))

def delete_rear_wing_islands(obj, roof_line):
    """Remove detached islands whose zmax sits above the cabin roof line."""
    ensure_active(obj)
    bpy.ops.object.mode_set(mode="EDIT")
    bm = bmesh.from_edit_mesh(obj.data)
    bmesh.ops.triangulate(bm, faces=bm.faces)
    bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=1e-5)
    parent = list(range(len(bm.verts)))
    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x
    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra
    for e in bm.edges:
        union(e.verts[0].index, e.verts[1].index)
    comp = {}
    for v in bm.verts:
        comp.setdefault(find(v.index), []).append(v)
    delete = set()
    for vs in comp.values():
        xs = [v.co.x for v in vs]; ys = [v.co.y for v in vs]; zs = [v.co.z for v in vs]
        zmax = max(zs); cx = (min(xs) + max(xs)) / 2
        # any disconnected island that reaches above the roof is Meshy wing
        # plates/endplates (rear +x). The body shell itself tops at ~0.108.
        if zmax > roof_line and (max(xs) - min(xs)) < 0.6 and (max(ys) - min(ys)) < 0.6:
            for v in vs:
                delete.add(v.index)
    if delete:
        bm.verts.ensure_lookup_table()
        bm.faces.ensure_lookup_table()
        del_faces = [f for f in bm.faces if all(v.index in delete for v in f.verts)]
        bmesh.ops.delete(bm, geom=del_faces, context="FACES")
    bmesh.update_edit_mesh(obj.data)
    bpy.ops.object.mode_set(mode="OBJECT")
    log("  removed %d above-roof verts" % len(delete))

def assign_mat(obj, mat):
    obj.data.materials.clear()
    obj.data.materials.append(mat)

def add_box(name, size, loc, rot=(0, 0, 0)):
    bpy.ops.mesh.primitive_cube_add(size=1, location=loc)
    o = bpy.context.active_object
    o.name = name
    o.scale = (size[0], size[1], size[2])
    o.rotation_euler = rot
    return o

def main():
    reset_scene()
    objs = import_glb_simple(GLB)
    if len(objs) > 1:
        ensure_active(objs[0])
        for o in objs[1:]:
            o.select_set(True)
        bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = "Tandem"
    ensure_active(car)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)

    x0, x1, y0, y1, z0, z1 = measure_bounds(car)
    log("  body bbox x[%.3f,%.3f] y[%.3f,%.3f] z[%.3f,%.3f]" % (x0, x1, y0, y1, z0, z1))

    # find cabin roof first (needed to strip stray shells above it)
    roof = -9
    for v in car.data.vertices:
        if -0.15 < v.co.y < 0.15 and v.co.x > x0 + 0.15 * (x1 - x0) and v.co.x < x0 + 0.55 * (x1 - x0):
            if v.co.z > roof:
                roof = v.co.z
    log("  initial cabin roof z=%.3f" % roof)

    # strip stray disconnected shells that float above the roof (meshy wing plates)
    delete_rear_wing_islands(car, roof + 0.002)
    x0, x1, y0, y1, z0, z1 = measure_bounds(car)
    log("  body after strip bbox x[%.3f,%.3f] z[%.3f,%.3f]" % (x0, x1, z0, z1))

    # NOW find the real trunk deck (max z in rear 25% AFTER the wing is gone)
    deck = -9
    deck_x = 0
    for v in car.data.vertices:
        if -0.15 < v.co.y < 0.15 and v.co.x > x0 + 0.7 * (x1 - x0):
            if v.co.z > deck:
                deck = v.co.z
                deck_x = v.co.x
    if deck < -1:
        deck = z1
    log("  rear deck z=%.3f at x=%.3f" % (deck, deck_x))
    car_mid_x = (x0 + x1) / 2

    mats = {}
    def mat(name, rgb, rough=0.5, metal=0.0, emit=None, es=0.0):
        if name in mats:
            return mats[name]
        m = bpy.data.materials.new(name)
        m.use_nodes = True
        b = m.node_tree.nodes.get("Principled BSDF")
        b.inputs["Base Color"].default_value = (*rgb, 1.0)
        b.inputs["Roughness"].default_value = rough
        b.inputs["Metallic"].default_value = metal
        if emit:
            b.inputs["Emission Color"].default_value = (*emit, 1.0)
            b.inputs["Emission Strength"].default_value = es
        mats[name] = m
        return m

    retopo = []

    # ---- glass canopy: SKIP box (Meshy paint already reads as canopy/glass) ----
    # ---- rear wing (magenta uprights + carbon top) mounted on the REAL deck ----
    mat_wing = mat("WingMagenta", (0.92, 0.12, 0.72), rough=0.3, metal=0.35)
    mat_carbon = mat("Carbon", (0.06, 0.06, 0.07), rough=0.42, metal=0.3)
    wing_x = x1 - 0.05
    half_w = (y1 - y0) * 0.38
    # wing top must clear the cabin roof line but supports start AT the trunk deck
    top_z = max(roof + 0.02, deck + 0.05)
    support_h = max(0.04, top_z - deck)
    for side in (-1, 1):
        sy = side * half_w * 0.55
        up = add_box("WingUpright", (0.05, 0.035, support_h + 0.02),
                     (wing_x - 0.02, sy, deck + (support_h + 0.02) / 2))
        assign_mat(up, mat_wing)
        retopo.append(up)
        ep = add_box("WingEndplate", (0.12, 0.022, top_z - deck + 0.02),
                     (wing_x, side * half_w * 0.92, deck + (top_z - deck + 0.02) / 2))
        assign_mat(ep, mat_wing)
        retopo.append(ep)
    wt = add_box("WingTop", (0.24, half_w * 2.0, 0.02),
                 (wing_x, 0, top_z + 0.012), rot=(0, -0.05, 0))
    assign_mat(wt, mat_carbon)
    retopo.append(wt)

    # join wing + canopy into the body
    bpy.ops.object.select_all(action="DESELECT")
    for o in retopo:
        o.select_set(True)
    car.select_set(True)
    bpy.context.view_layer.objects.active = car
    bpy.ops.object.join()
    car = bpy.context.active_object
    car.name = "Tandem"
    ensure_active(car)
    bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)
    log("  joined retopo -> %d verts %d polys" % (len(car.data.vertices), len(car.data.polygons)))

    import shutil
    import bake_trellis_glb as btg
    colors = btg.bake_vertex_colors(car)
    body_mat_idx = None
    for i, m in enumerate(car.data.materials):
        if m and "Material_0" in m.name:
            body_mat_idx = i
    attr = car.data.color_attributes.get("Col")
    if attr is not None:
        me = car.data
        me.calc_loop_triangles()
        white = set()
        for poly in me.polygons:
            if body_mat_idx is None or poly.material_index != body_mat_idx:
                for li in poly.loop_indices:
                    white.add(me.loops[li].vertex_index)
        for vi in white:
            attr.data[vi].color = (1.0, 1.0, 1.0, 1.0)
            colors[vi] = (1.0, 1.0, 1.0)
        log("  %d retopo verts -> white vertex color (body mat %s)" % (len(white), body_mat_idx))

    btg.export_json(car, "car_tandem", colors, {"vertex_colors": True})
    src = os.path.join(ROOT, "assets/models/car_tandem.json")
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    shutil.move(src, OUT)
    log("TANDEM OK -> %s" % OUT)

main()
