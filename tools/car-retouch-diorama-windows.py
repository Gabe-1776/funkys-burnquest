#!/usr/bin/env python3
"""Repaint diorama car windows (wagon-red and wagon-lime) with clean tinted glass.

Gabriel 2026-09-12: "windows in cars blue and red in theme are like strange glitchy looking".
Theme 1 (diorama) wagon-red.glb and wagon-lime.glb had high-contrast specular noise and
mottled artifacts baked into their window UV islands by Meshy's image-to-3D pipeline,
causing severe spatial/temporal aliasing ("window flicker") when moving at toy scale.

This tool isolates the window triangles by model-space coordinates and surface normals,
rasterises the exact window UV footprint, and smoothly repaints the glass with clean
diorama cyan glass tone ([140, 195, 225]) matching the concept isolates.

Run: python3 tools/car-retouch-diorama-windows.py [--dry]
"""
import os, sys
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_uv_mask import load, primitives, mask_for
from glb_retouch import read_image, write_image, feather

GLASS_COLOR = np.array([140.0, 195.0, 225.0])
DRY = '--dry' in sys.argv


def is_win_red(c, n, bb):
    x, y, z = c[0], c[1], c[2]
    nx, ny, nz = n[0], n[1], n[2]
    if y < 0.05 or y > 0.19:
        return False
    if ny > 0.80 or ny < -0.3:
        return False
    if abs(z) > 0.15 and abs(nz) > 0.45:
        return True
    if -0.38 < x < -0.08 and nx < -0.25 and ny > 0.15:
        return True
    if 0.22 < x < 0.42 and nx > 0.25 and ny > 0.15:
        return True
    return False


def is_win_lime(c, n, bb):
    x, y, z = c[0], c[1], c[2]
    nx, ny, nz = n[0], n[1], n[2]
    if y < 0.04 or y > 0.17:
        return False
    if ny > 0.80 or ny < -0.3:
        return False
    if abs(z) > 0.14 and abs(nz) > 0.45:
        return True
    if -0.38 < x < -0.08 and nx < -0.25 and ny > 0.15:
        return True
    if 0.20 < x < 0.42 and nx > 0.25 and ny > 0.15:
        return True
    return False


JOBS = [
    ('assets/models/glb/diorama/wagon-red.glb', is_win_red, 'wagon-red'),
    ('assets/models/glb/diorama/wagon-lime.glb', is_win_lime, 'wagon-lime'),
]


def main():
    for glb_path, is_win_fn, name in JOBS:
        js, binc, img, s, n = read_image(glb_path)
        prims = primitives(js, binc)
        mask, n_win, total = mask_for(prims, img.size[0], is_win_fn)
        print(f'{glb_path}: selected {n_win} of {total} window triangles')

        tex = np.array(img).astype(np.float64)
        alpha = feather((mask * 255).astype(np.uint8), radius=1.5)[:, :, None]
        out_tex = tex * (1.0 - alpha) + GLASS_COLOR[None, None, :] * alpha
        out_img = Image.fromarray(out_tex.astype(np.uint8))

        if DRY:
            tmp_png = f'/tmp/{name}-dry.png'
            out_img.save(tmp_png)
            print(f'   dry run: wrote {tmp_png}')
            continue

        tmp_glb = glb_path + '.tmp'
        write_image(glb_path, tmp_glb, out_img)
        os.replace(tmp_glb, glb_path)
        print(f'   wrote {glb_path}')


if __name__ == '__main__':
    main()
