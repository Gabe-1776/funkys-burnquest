"""Render side-by-side preview: Blender coin vs Meshy coin."""
import bpy
import os
import math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
COIN_DIR = os.path.join(ROOT, "test-shots", "coins", "ksto")
BLEND_COIN = os.path.join(COIN_DIR, "ksto-coin.glb")
MESHY_COIN = os.path.join(COIN_DIR, "ksto-meshy.glb")
RENDER = os.path.join(COIN_DIR, "ksto-vs-meshy.png")

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

# Import both, place side by side, normalize to ~2 units tall
for path, x in ((BLEND_COIN, -1.3), (MESHY_COIN, 1.3)):
    bpy.ops.object.select_all(action='DESELECT')
    bpy.ops.import_scene.gltf(filepath=path)
    imported = [o for o in bpy.context.selected_objects]
    # normalize scale: fit largest dim to 2.0
    dims = [0, 0, 0]
    for o in imported:
        if o.type == 'MESH':
            for c in o.bound_box:
                w = o.matrix_world @ __import__('mathutils').Vector(c)
                dims[0] = max(dims[0], abs(w.x))
                dims[1] = max(dims[1], abs(w.y))
                dims[2] = max(dims[2], abs(w.z))
    s = 1.0 / max(dims) if max(dims) > 0 else 1.0
    root = bpy.data.objects.new("root", None)
    bpy.context.collection.objects.link(root)
    for o in imported:
        o.parent = root
    root.scale = (s, s, s)
    root.location = (x, 0, 1.0)
    bpy.context.view_layer.update()

# Lights
bpy.ops.object.light_add(type='SUN', location=(3, -2, 6))
bpy.context.active_object.data.energy = 3.5
bpy.ops.object.light_add(type='AREA', location=(0, -4, 3))
bpy.context.active_object.data.energy = 150.0

# Camera: straight-on front view of both
bpy.ops.object.camera_add(location=(0, -6.5, 1.6))
cam = bpy.context.active_object
bpy.ops.object.empty_add(location=(0, 0, 0.8))
con = cam.constraints.new('TRACK_TO')
con.target = bpy.context.active_object
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'

scene = bpy.context.scene
scene.camera = cam
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 960
scene.render.resolution_y = 540
scene.render.film_transparent = True
scene.render.filepath = RENDER
scene.render.image_settings.file_format = 'PNG'
scene.eevee.taa_render_samples = 64
bpy.ops.render.render(write_still=True)
print("WROTE", RENDER)
