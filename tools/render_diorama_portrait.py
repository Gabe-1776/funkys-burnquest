"""Render a portrait of the diorama frog for the character selector.

Imports diorama/funky.json, frames it like a fighting-game portrait
(head + upper torso), renders to a PNG.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/render_diorama_portrait.py
"""
import bpy, json, os, math

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
SRC = os.path.join(ROOT, "assets/models/diorama/funky.json")
OUT = os.path.join(ROOT, "assets/images/portrait-diorama.png")

bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene

# Load the JSON mesh — positions are flat [x,y,z, ...] in three.js coords
data = json.load(open(SRC))
pos = data["positions"]
verts = [(pos[i], pos[i+1], pos[i+2]) for i in range(0, len(pos), 3)]
idx = data["indices"]
faces = [(idx[i], idx[i+1], idx[i+2]) for i in range(0, len(idx), 3)]

mesh = bpy.data.meshes.new("DioramaFrog")
mesh.from_pydata(verts, [], faces)
mesh.update()

# Materials — create one per group
for mi, g in enumerate(data["groups"]):
    mdata = data["materials"][mi]
    mat = bpy.data.materials.new(mdata["name"])
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (*mdata["color"], 1.0)
    bsdf.inputs["Roughness"].default_value = mdata.get("roughness", 0.5)
    mesh.materials.append(mat)

obj = bpy.data.objects.new("DioramaFrog", mesh)
scene.collection.objects.link(obj)

# Assign material indices per face group
for mi, g in enumerate(data["groups"]):
    start = g["start"] // 3
    count = g["count"] // 3
    for fi in range(start, start + count):
        if fi < len(mesh.polygons):
            mesh.polygons[fi].material_index = mi

# Smooth shading
for poly in mesh.polygons:
    poly.use_smooth = True

# The model is in three.js coords (Y up). Blender needs Z up.
# Rotate the object so Y becomes Z.
obj.rotation_euler = (math.radians(90), 0, 0)
bpy.context.view_layer.objects.active = obj
bpy.ops.object.transform_apply(rotation=True)

# Re-measure in Blender coords
import numpy as np
va = np.array([v.co for v in mesh.vertices], dtype=float)
z_min, z_max = va[:, 2].min(), va[:, 2].max()
x_min, x_max = va[:, 0].min(), va[:, 0].max()
y_min, y_max = va[:, 1].min(), va[:, 1].max()
H = z_max - z_min
W = x_max - x_min
D = y_max - y_min
cx = (x_min + x_max) / 2
cy = (y_min + y_max) / 2
cz = (z_min + z_max) / 2
print(f"MODEL  bbox: {W:.3f} x {D:.3f} x {H:.3f}  center=({cx:.2f},{cy:.2f},{cz:.2f})")

# The model faces -Y in Blender (which was +Z in three.js).
# Camera in front, looking at the upper body (head + torso).
cam_data = bpy.data.cameras.new("PortraitCam")
cam = bpy.data.objects.new("PortraitCam", cam_data)
scene.collection.objects.link(cam)
scene.camera = cam

# Position camera directly in front of the model's face.
# The model's front is at y_min (faces -Y in Blender after the rotation).
cam_dist = max(W, H) * 2.0
cam_height = z_min + H * 0.50  # eye level with the frog
cam.location = (cx, y_min - cam_dist, cam_height)

# Aim at the face (top 60% of the model — the eyes/head area)
from mathutils import Vector
target = Vector((cx, cy, z_min + H * 0.55))
direction = target - cam.location
cam.rotation_euler = direction.to_track_quat('-Z', 'Y').to_euler()

cam_data.type = 'ORTHO'
cam_data.ortho_scale = W * 0.85  # tighter crop — just the face

# Render — use Eevee for real materials
scene.render.engine = "BLENDER_EEVEE"
scene.render.resolution_x = 256
scene.render.resolution_y = 256
scene.render.resolution_percentage = 100
scene.render.image_settings.file_format = "PNG"
scene.render.filepath = OUT
scene.render.film_transparent = True

# Eevee needs a world with a color for reflections
world = bpy.data.worlds.new("World")
scene.world = world
world.use_nodes = True
bg = world.node_tree.nodes["Background"]
bg.inputs[0].default_value = (0.08, 0.08, 0.12, 1.0)
bg.inputs[1].default_value = 0.5

# Key light — warm sun from upper right
sun = bpy.data.lights.new("Sun", "SUN")
sun.energy = 4.0
sun.angle = math.radians(25)
sun.color = (1.0, 0.9, 0.8)
sun_obj = bpy.data.objects.new("Sun", sun)
scene.collection.objects.link(sun_obj)
sun_obj.rotation_euler = (math.radians(50), math.radians(-20), 0)

# Fill light — soft area from front-left
fill = bpy.data.lights.new("Fill", "AREA")
fill.energy = 150
fill.size = 4
fill.color = (0.7, 0.8, 1.0)
fill_obj = bpy.data.objects.new("Fill", fill)
scene.collection.objects.link(fill_obj)
fill_obj.location = (cx - W * 0.8, y_min - 2, z_min + H * 0.8)

# Rim light — subtle from behind
rim = bpy.data.lights.new("Rim", "AREA")
rim.energy = 80
rim.size = 2
rim.color = (0.5, 0.9, 0.4)
rim_obj = bpy.data.objects.new("Rim", rim)
scene.collection.objects.link(rim_obj)
rim_obj.location = (cx, y_min + D * 0.5, z_min + H * 0.9)

bpy.ops.render.render(write_still=True)
print(f"-> {OUT}")
