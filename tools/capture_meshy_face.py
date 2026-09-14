"""Render Meshy's KSTO medallion straight-on to a square PNG for coin faces."""
import bpy
import mathutils
import os

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "test-shots", "coins", "ksto", "ksto-meshy.glb")
RENDER = os.path.join(ROOT, "test-shots", "coins", "ksto", "ksto-face.png")

bpy.ops.object.select_all(action='SELECT')
bpy.ops.object.delete(use_global=False)

bpy.ops.object.select_all(action='DESELECT')
bpy.ops.import_scene.gltf(filepath=SRC)
imported = list(bpy.context.selected_objects)
# normalize: largest dim -> 2.0, centered
dims = [0, 0, 0]
for o in imported:
    if o.type == 'MESH':
        for c in o.bound_box:
            w = o.matrix_world @ mathutils.Vector(c)
            dims[0] = max(dims[0], abs(w.x))
            dims[1] = max(dims[1], abs(w.y))
            dims[2] = max(dims[2], abs(w.z))
s = 1.0 / max(dims) if max(dims) > 0 else 1.0
root = bpy.data.objects.new("root", None)
bpy.context.collection.objects.link(root)
for o in imported:
    o.parent = root
root.scale = (s, s, s)
bpy.context.view_layer.update()

bpy.ops.object.light_add(type='SUN', location=(0, -2, 5))
bpy.context.active_object.data.energy = 4.0
bpy.ops.object.light_add(type='AREA', location=(0, -3, 1))
fill = bpy.context.active_object
fill.data.energy = 200.0

# Straight-on front camera
bpy.ops.object.camera_add(location=(0, -4.5, 0))
cam = bpy.context.active_object
bpy.ops.object.empty_add(location=(0, 0, 0))
con = cam.constraints.new('TRACK_TO')
con.target = bpy.context.active_object
con.track_axis = 'TRACK_NEGATIVE_Z'
con.up_axis = 'UP_Y'

scene = bpy.context.scene
scene.camera = cam
scene.render.engine = 'BLENDER_EEVEE'
scene.render.resolution_x = 512
scene.render.resolution_y = 512
scene.render.film_transparent = False
scene.render.filepath = RENDER
scene.render.image_settings.file_format = 'PNG'
scene.render.image_settings.color_mode = 'RGB'
scene.eevee.taa_render_samples = 64
bpy.ops.render.render(write_still=True)
print("WROTE", RENDER)
