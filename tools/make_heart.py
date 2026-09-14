"""Build a 3D green heart GLB for the extra-life pickup.

A heart is two lobes on top meeting at a point at the bottom. Built from a
UV sphere deformed into the classic heart silhouette — no Meshy, no credits,
one Blender bake. Output: assets/models/glb/fv/life.glb

Run:
  /Applications/Blender.app/Contents/MacOS/Blender -b --python tools/make_heart.py
"""
import math
import os
import sys

import bpy

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
                   "assets", "models", "glb", "fv", "life.glb")

def build_heart():
    bpy.ops.wm.read_factory_settings(use_empty=True)

    # Start from a UV sphere, deform it into a heart silhouette.
    bpy.ops.mesh.primitive_uv_sphere_add(segments=48, ring_count=32, radius=0.5)
    obj = bpy.context.active_object
    obj.name = "Heart"

    mesh = obj.data
    for v in mesh.vertices:
        x, y, z = v.co
        # Heart shape: the classic parametric heart in the XZ plane, extruded
        # along Y. The top has two lobes (split at x=0), the bottom comes to a
        # point. We remap the sphere to a heart using the implicit form:
        #   (x^2 + z^2 - 1)^3 - x^2 * z^3 <= 0  (the heart curve)
        # Normalize the sphere to a 2D point on the unit circle, test the
        # heart curve, then scale depth by how "inside" the heart it is.
        r = math.sqrt(x * x + z * z)
        if r < 1e-6:
            v.co = (0, y * 0.35, 0)
            continue
        nx, nz = x / r, z / r
        # Heart implicit curve. Shift so the point is at the bottom.
        hx, hz = nx, nz + 0.2
        heart_val = (hx * hx + hz * hz - 1) ** 3 - hx * hx * hz * hz * hz
        # Scale factor: inside the heart (val < 0) maps toward the surface.
        # Use the heart curve to push points to the heart boundary.
        scale = 1.0
        if heart_val < 0:
            # Inside the heart — keep at full radius
            scale = r
        else:
            # Outside — pull toward the heart boundary
            scale = r * 0.85
        v.co = (nx * scale * 0.7, y * 0.35, (nz * scale - 0.1) * 0.9)

    # Smooth shading
    for poly in mesh.polygons:
        poly.use_smooth = True

    # Green heart material — strong emissive so it glows vivid green
    mat = bpy.data.materials.new("HeartMat")
    mat.use_nodes = True
    bsdf = mat.node_tree.nodes.get("Principled BSDF")
    if bsdf:
        bsdf.inputs["Base Color"].default_value = (0.05, 0.9, 0.25, 1.0)  # vivid green
        bsdf.inputs["Roughness"].default_value = 0.3
        if "Emission Color" in bsdf.inputs:
            bsdf.inputs["Emission Color"].default_value = (0.05, 0.9, 0.25, 1.0)
        if "Emission Strength" in bsdf.inputs:
            bsdf.inputs["Emission Strength"].default_value = 1.0
    obj.data.materials.append(mat)

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
    build_heart()
