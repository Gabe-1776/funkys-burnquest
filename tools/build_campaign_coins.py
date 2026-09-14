#!/usr/bin/env python3
"""Build consistent two-sided campaign coin GLBs from canonical token artwork.

Meshy's raw image-to-3D candidates are retained under test-shots/coins/meshy/.
They are identity/shape references, not release assets: several have blank or
mirrored backs and several are not coins. This deterministic Blender pass gives
every campaign the KSTO-approved geometry contract while preserving its exact
source artwork on both correctly oriented faces.

Run headless:
  Blender -b --factory-startup --python tools/build_campaign_coins.py
  Blender -b --factory-startup --python tools/build_campaign_coins.py -- heal
"""
import json
import math
import os
import pathlib
import sys

import bpy
from mathutils import Vector

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "coins"
RAW = ROOT / "test-shots" / "coins" / "meshy"
OUT = ROOT / "test-shots" / "coins" / "built"
COINS = {
    "ksto": (0.55, 0.10, 0.75, 1.0),
    "heal": (0.09, 0.79, 0.39, 1.0),
    "pbr": (0.63, 0.13, 0.94, 1.0),
    "snippy": (0.00, 0.83, 1.00, 1.0),
    "snipling": (1.00, 0.67, 0.00, 1.0),
    "lbug": (1.00, 0.20, 0.40, 1.0),
    "love": (1.00, 0.40, 0.67, 1.0),
    "bender": (0.20, 1.00, 0.80, 1.0),
    "yen": (1.00, 0.84, 0.00, 1.0),
}


def reset_scene():
    bpy.ops.wm.read_factory_settings(use_empty=True)


def material(name, color, metallic, roughness):
    value = bpy.data.materials.new(name)
    value.use_nodes = True
    bsdf = value.node_tree.nodes.get("Principled BSDF")
    bsdf.inputs["Base Color"].default_value = color
    bsdf.inputs["Metallic"].default_value = metallic
    bsdf.inputs["Roughness"].default_value = roughness
    return value


def face_material(coin_id, source):
    value = bpy.data.materials.new(f"{coin_id.upper()}Face")
    value.use_nodes = True
    nodes = value.node_tree.nodes
    links = value.node_tree.links
    nodes.clear()
    output = nodes.new("ShaderNodeOutputMaterial")
    bsdf = nodes.new("ShaderNodeBsdfPrincipled")
    bsdf.inputs["Metallic"].default_value = 0.1
    bsdf.inputs["Roughness"].default_value = 0.55
    texture = nodes.new("ShaderNodeTexImage")
    texture.image = bpy.data.images.load(str(source))
    texture.extension = "CLIP"
    uv = nodes.new("ShaderNodeTexCoord")
    links.new(uv.outputs["UV"], texture.inputs["Vector"])
    links.new(texture.outputs["Color"], bsdf.inputs["Base Color"])
    links.new(texture.outputs["Color"], bsdf.inputs["Emission Color"])
    bsdf.inputs["Emission Strength"].default_value = 0.55
    links.new(bsdf.outputs["BSDF"], output.inputs["Surface"])
    return value


def add_face_disc(parent, face_mat, z, mirror_u):
    bpy.ops.mesh.primitive_cylinder_add(
        radius=0.96, depth=0.005, vertices=64, location=(0, 0, z))
    disc = bpy.context.active_object
    disc.name = "FaceDiscBack" if mirror_u else "FaceDiscFront"
    disc.data.materials.append(face_mat)
    uv_layer = disc.data.uv_layers.active or disc.data.uv_layers.new()
    for polygon in disc.data.polygons:
        for loop_index in polygon.loop_indices:
            vertex = disc.data.vertices[disc.data.loops[loop_index].vertex_index].co
            u = vertex.x / 1.92 + 0.5
            if mirror_u:
                u = 1.0 - u
            uv_layer.data[loop_index].uv = (u, vertex.y / 1.92 + 0.5)
    disc.parent = parent
    disc.matrix_parent_inverse = parent.matrix_world.inverted().copy()
    return disc


def point_camera(camera, target):
    direction = target - camera.location
    camera.rotation_euler = direction.to_track_quat("-Z", "Y").to_euler()

def render_view(scene, camera, path, back=False):
    camera.location = (0, 0, -3.2 if back else 3.2)
    point_camera(camera, Vector((0, 0, 0)))
    if back:
        # Preserve conventional page orientation in the reverse-face proof.
        camera.rotation_euler.rotate_axis("Z", math.pi)
    scene.render.filepath = str(path)
    bpy.ops.render.render(write_still=True)


def build(coin_id):
    reset_scene()
    source = SOURCE / f"{coin_id}.png"
    if not source.exists():
        raise RuntimeError(f"missing campaign artwork: {source}")
    destination = OUT / coin_id
    destination.mkdir(parents=True, exist_ok=True)

    face_mat = face_material(coin_id, source)
    edge_mat = material(f"{coin_id.upper()}Edge", COINS[coin_id], 0.95, 0.25)

    bpy.ops.mesh.primitive_cylinder_add(
        radius=1.0, depth=0.14, vertices=64, location=(0, 0, 0))
    coin = bpy.context.active_object
    coin.name = f"Coin_{coin_id}"
    coin.data.materials.append(edge_mat)
    bevel = coin.modifiers.new("RimBevel", "BEVEL")
    bevel.width = 0.03
    bevel.segments = 2
    bevel.limit_method = "ANGLE"
    bpy.context.view_layer.objects.active = coin
    bpy.ops.object.modifier_apply(modifier=bevel.name)

    parts = [coin]
    for z in (0.07, -0.07):
        bpy.ops.mesh.primitive_torus_add(
            major_radius=0.97, minor_radius=0.035,
            major_segments=64, minor_segments=12, location=(0, 0, z))
        rim = bpy.context.active_object
        rim.name = "Rim"
        rim.data.materials.append(edge_mat)
        rim.parent = coin
        rim.matrix_parent_inverse = coin.matrix_world.inverted().copy()
        parts.append(rim)
    parts.append(add_face_disc(coin, face_mat, 0.085, False))
    parts.append(add_face_disc(coin, face_mat, -0.085, True))

    # Neutral proof lighting on both faces; artwork has low textured emission so
    # black backgrounds stay black while identity remains readable in-game.
    bpy.ops.object.light_add(type="AREA", location=(0, 0, 3))
    front_light = bpy.context.active_object
    front_light.data.energy = 90
    front_light.data.shape = "DISK"
    front_light.data.size = 4
    bpy.ops.object.light_add(type="AREA", location=(0, 0, -3))
    back_light = bpy.context.active_object
    back_light.data.energy = 90
    back_light.data.shape = "DISK"
    back_light.data.size = 4

    bpy.ops.object.camera_add(location=(0, 0, 3.2))
    camera = bpy.context.active_object
    camera.data.lens = 55
    scene = bpy.context.scene
    scene.camera = camera
    scene.render.engine = "BLENDER_EEVEE"
    scene.render.resolution_x = 512
    scene.render.resolution_y = 512
    scene.render.resolution_percentage = 100
    scene.render.film_transparent = True
    scene.render.image_settings.file_format = "PNG"
    scene.render.image_settings.color_mode = "RGBA"
    scene.eevee.taa_render_samples = 32
    render_view(scene, camera, destination / "front.png", False)
    render_view(scene, camera, destination / "back.png", True)

    bpy.ops.object.select_all(action="DESELECT")
    for part in parts:
        part.select_set(True)
    bpy.context.view_layer.objects.active = coin
    glb = destination / f"coin-{coin_id}.glb"
    bpy.ops.export_scene.gltf(filepath=str(glb), export_format="GLB", use_selection=True)
    raw = RAW / f"{coin_id}.glb"
    record = {
        "id": coin_id,
        "source": str(source.relative_to(ROOT)),
        "meshy_raw": str(raw.relative_to(ROOT)) if raw.exists() else None,
        "release": str(glb.relative_to(ROOT)),
        "diameter_blender_units": 2.0,
        "thickness_blender_units": 0.17,
        "front_and_back_art": True,
    }
    (destination / "manifest.json").write_text(json.dumps(record, indent=2) + "\n")
    print("BUILT", coin_id, glb, flush=True)


def main():
    requested = sys.argv[sys.argv.index("--") + 1:] if "--" in sys.argv else []
    ids = requested or list(COINS)
    unknown = [coin_id for coin_id in ids if coin_id not in COINS]
    if unknown:
        raise SystemExit("unknown coin ids: " + ", ".join(unknown))
    for coin_id in ids:
        build(coin_id)
    print("DONE", len(ids), "campaign coins")


if __name__ == "__main__":
    main()
