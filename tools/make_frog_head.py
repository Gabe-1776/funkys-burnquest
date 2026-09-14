"""Build a 3D frog head GLB for the extra-life pickup.

A frog head matching the diorama toy frog's colour scheme:
medium green head, lighter cream belly/chin, white eyes, dark pupils.
Built from primitives in Blender — no Meshy, no credits.

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/make_frog_head.py
"""
import math
import os

import bpy

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "assets", "models", "glb", "fv", "life.glb")


def make_mat(name, color, roughness=0.4, emission_strength=0.0):
    mat = bpy.data.materials.new(name)
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = color
        bsdf.inputs["Roughness"].default_value = roughness
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = color
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = emission_strength
    return mat


def build_frog_head():
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Diorama frog colours: body green, eye white, pupil dark
    green = make_mat("FrogBody", (0.13, 0.78, 0.32, 1.0), roughness=0.4, emission_strength=0.4)
    white = make_mat("EyeWhite", (1.0, 1.0, 1.0, 1.0), roughness=0.3)
    black = make_mat("Pupil", (0.03, 0.05, 0.04, 1.0), roughness=0.5)

    # Head — wide green ellipsoid
    bpy.ops.mesh.primitive_uv_sphere_add(segments=32, ring_count=24, radius=0.24)
    head = bpy.context.active_object
    head.name = "FrogHead"
    head.scale = (1.0, 0.62, 0.70)
    head.data.materials.append(green)

    # Eye bumps — green spheres on top, slightly forward, BIGGER like the emoji
    for x in (-0.10, 0.10):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=24, ring_count=16, radius=0.11)
        bump = bpy.context.active_object
        bump.location = (x, -0.02, 0.16)
        bump.scale = (1.0, 0.9, 0.9)
        bump.data.materials.append(green)

    # Eyeballs — white spheres inside the bumps, bigger
    for x in (-0.10, 0.10):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=20, ring_count=12, radius=0.072)
        eye = bpy.context.active_object
        eye.location = (x, -0.05, 0.16)
        eye.data.materials.append(white)

    # Pupils — dark spheres in front of the eyeballs
    for x in (-0.10, 0.10):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=16, ring_count=10, radius=0.032)
        pupil = bpy.context.active_object
        pupil.location = (x, -0.11, 0.16)
        pupil.data.materials.append(black)

    # Nostrils — two tiny dark dots on the front of the snout
    for x in (-0.04, 0.04):
        bpy.ops.mesh.primitive_uv_sphere_add(segments=8, ring_count=6, radius=0.008)
        nostril = bpy.context.active_object
        nostril.location = (x, -0.19, 0.02)
        nostril.data.materials.append(black)

    # No mouth — the frog emoji has just eyes on a green head.

    # Join everything
    bpy.ops.object.select_all(action='SELECT')
    bpy.context.view_layer.objects.active = head
    bpy.ops.object.join()

    # Tilt the face up ~10 degrees (rotate around X so the -Y face points up)
    head.rotation_euler = (math.radians(-10), 0, 0)
    bpy.ops.object.transform_apply(rotation=True)

    # Smooth shading
    for poly in head.data.polygons:
        poly.use_smooth = True

    # Export as GLB
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=OUT,
        export_format="GLB",
        export_apply=True,
        use_selection=True,
    )
    size = os.path.getsize(OUT)
    print(f"-> {OUT} ({size // 1024} KB)")


if __name__ == "__main__":
    build_frog_head()
