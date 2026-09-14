#!/usr/bin/env python3
"""Remove the flame livery from the muscle car's TOP surfaces, keep the flanks.

Gabriel 2026-09-09: "remove the car hood flames just keep the side flames."

Selection is geometric, not by eye: every triangle whose normal points up
(n.y > 0.5) is hood, roof or boot. Within only those triangles' UV footprint,
pixels that are flame-coloured - the yellows and reds - are repainted with the
car's own body orange, sampled from the same region so it matches under any
lighting. Side-facing triangles are never touched, so the flank flames survive
exactly as baked.

Run: python3 tools/car-remove-hood-flames.py [--dry]
"""
import colorsys, sys, os
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_uv_mask import load, primitives, mask_for
from glb_retouch import read_image, write_image, feather

GLB = 'assets/models/glb/fv/muscle-flame.glb'
DRY = '--dry' in sys.argv


def hsv_planes(rgb):
    a = rgb.astype(np.float64) / 255.0
    mx = a.max(axis=2); mn = a.min(axis=2)
    v = mx
    d = mx - mn
    s = np.where(mx > 1e-9, d / np.maximum(mx, 1e-9), 0)
    h = np.zeros_like(mx)
    r, g, b = a[:, :, 0], a[:, :, 1], a[:, :, 2]
    nz = d > 1e-9
    idx = (mx == r) & nz
    h[idx] = ((g - b)[idx] / d[idx]) % 6
    idx = (mx == g) & nz
    h[idx] = ((b - r)[idx] / d[idx]) + 2
    idx = (mx == b) & nz
    h[idx] = ((r - g)[idx] / d[idx]) + 4
    return h * 60.0, s, v


def main():
    js, binc, img, _, _ = read_image(GLB)
    tex = np.array(img).astype(np.float64)
    size = img.size[0]
    print(f'   texture {img.size[0]}x{img.size[1]}')

    prims = primitives(*load(GLB))
    top, ntop, total = mask_for(prims, size, lambda c, n, bb: n[1] > 0.5)
    print(f'   top-facing triangles: {ntop} of {total}')

    h, s, v = hsv_planes(tex)
    # Flame = the hot yellows and reds. The body orange (~19-40 deg) is NOT a
    # flame and must survive, or the whole car turns flat.
    # The livery is TWO layers: hot yellow/red tongues sitting on a dark burnt
    # -brown ground. Removing only the hot tongues left the brown silhouette
    # behind, so the boot still read as flamed from above - the shape is the
    # brown, not the yellow.
    hot = (((h >= 40) & (h <= 75)) | (h >= 340) | (h <= 18)) & (s > 0.45) & (v > 0.30)
    # Burnt ground. MEASURED, not assumed: sampling the dark pixels actually
    # left on the top surface put them at hue ~330-345 - a dark MAROON - not
    # the orange-brown I first guessed, so an `h <= 45` test missed the whole
    # thing and the boot stayed flamed. It wraps past 0, hence the two ranges.
    # The windows sit at hue ~225 with s~1.0, v~0.1 (dark blue) and are
    # excluded by hue, so they survive.
    burnt = ((h >= 320) | (h <= 45)) & (s > 0.30) & (v <= 0.45)
    flame = hot | burnt
    body = (h > 18) & (h < 40) & (s > 0.35) & (v > 0.25)

    in_top = top > 0
    target = flame & in_top
    print(f'   flame pixels on top surfaces: {target.sum():,} '
          f'(hot {int((hot & in_top).sum()):,} + burnt ground {int((burnt & in_top).sum()):,})')

    src = tex[body & in_top]
    if len(src) < 500:
        src = tex[body]
    paint = np.median(src, axis=0)
    print(f'   repainting with body orange #{int(paint[0]):02x}{int(paint[1]):02x}{int(paint[2]):02x}'
          f'  (from {len(src):,} sampled px)')

    # Feather the mask so the repaint does not leave a hard triangle edge.
    a = feather((target * 255).astype(np.uint8), radius=1.5)[:, :, None]
    out = tex * (1 - a) + paint[None, None, :] * a

    kept = (flame & (~in_top)).sum()
    print(f'   flame pixels left on flanks: {kept:,}')

    if DRY:
        Image.fromarray(out.astype(np.uint8)).save('/tmp/claude-501/muscle-noflame.png')
        Image.fromarray((target * 255).astype(np.uint8)).save('/tmp/claude-501/muscle-target.png')
        print('   dry run: wrote /tmp/claude-501/muscle-noflame.png')
        return
    write_image(GLB, GLB + '.tmp', Image.fromarray(out.astype(np.uint8)))
    os.replace(GLB + '.tmp', GLB)
    print(f'   wrote {GLB}')


main()
