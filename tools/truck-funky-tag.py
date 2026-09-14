#!/usr/bin/env python3
"""Replace the purple truck's graffiti tag with "FUNKY".

Gabriel 2026-09-09: "in the purple truck change the writing and put Funky."

The baked tag reads KROMD in yellow with a heavy black outline, on the cargo
box side. It lives in one region of the Meshy atlas (x 105-500, y 1840-1995),
so the edit is: clear the coloured graffiti there back to the truck's own purple
- while PROTECTING the pale grey chassis pixels that share the region, because
they belong to other parts of the truck - then draw the new word in the same
place, same style: heavy face, yellow fill, thick black outline.

Run: python3 tools/truck-funky-tag.py [--dry]
"""
import math, os, sys
import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_uv_mask import load, primitives, mask_for
from glb_retouch import read_image, write_image

GLB = 'assets/models/glb/fv/truck-purple.glb'
WORD = 'FUNKY'
FONT = '/System/Library/Fonts/Supplemental/Impact.ttf'
PURPLE = (110, 0, 185)

# The truck carries DIFFERENT artwork on each flank, so replacing one tag left
# the other side still reading as the old graffiti - which is exactly what
# Gabriel saw. Each entry is (rect, flank) where flank is the sign of the
# surface normal in z; the clear is constrained to that flank's own triangles so
# a rectangle in a scattered Meshy atlas cannot bleed onto an unrelated part.
#
# Regions were MEASURED, not eyeballed: intersect each flank's UV mask with
# "saturated, not body purple, not chassis grey" and take the largest connected
# cluster. That put the +z tag at x260-526 y1831-1973 and the -z tag at
# x138-563 y1171-1386.
# The third value is a rotation in degrees applied to the drawn word. The -z
# panel's UV island is rotated relative to the atlas axes, so axis-aligned text
# comes out tilted ON THE MODEL and runs off the panel edge. Its island is only
# 7 large triangles with a ~98 degree orientation spread across the rect, so
# solving the angle analytically does not converge - it is measured off the
# render instead and checked by re-rendering.
TAGS = [
    ((62, 1800, 556, 2008), +1, 0),
    ((150, 1170, 545, 1385), -1, -17),
]

DRY = '--dry' in sys.argv


def main():
    js, binc, img, _, _ = read_image(GLB)
    tex = np.array(img).astype(np.int32)
    prims = primitives(*load(GLB))

    flank_mask = {}
    for sign in (+1, -1):
        m, cnt, _ = mask_for(prims, img.size[0],
                             lambda c, n, bb, s=sign: (n[2] * s) > 0.5 and c[1] > 0.0)
        flank_mask[sign] = m > 0
        print(f'   flank {"+z" if sign > 0 else "-z"}: {cnt} triangles')

    for (x0, y0, x1, y1), sign, _rot in TAGS:
        sub = tex[y0:y1, x0:x1]
        fl = flank_mask[sign][y0:y1, x0:x1]
        mx = sub.max(axis=2); mn = sub.min(axis=2)
        neutral_light = (mn > 120) & ((mx - mn) < 60)
        purple_ish = (sub[:, :, 2] > 120) & (sub[:, :, 0] > 60) & \
                     (sub[:, :, 0] < 170) & (sub[:, :, 1] < 80)
        clear = fl & ~neutral_light & ~purple_ish
        local = sub[fl & purple_ish]
        fill = np.median(local, axis=0).astype(np.int32) if len(local) > 500 \
               else np.array(PURPLE)
        sub[clear] = fill
        tex[y0:y1, x0:x1] = sub
        print(f'   {"+z" if sign > 0 else "-z"} tag {x1-x0}x{y1-y0}: cleared {int(clear.sum()):,} px, '
              f'fill #{fill[0]:02x}{fill[1]:02x}{fill[2]:02x}')

    out = Image.fromarray(tex.astype(np.uint8))
    d = ImageDraw.Draw(out)
    for (x0, y0, x1, y1), sign, rot in TAGS:
        bw, bh = (x1 - x0) - 30, (y1 - y0) - 40
        size = 10
        while size < 400:
            f = ImageFont.truetype(FONT, size + 4)
            bb = d.textbbox((0, 0), WORD, font=f, stroke_width=max(2, (size + 4) // 12))
            w, h = bb[2] - bb[0], bb[3] - bb[1]
            if rot:
                r = abs(math.radians(rot))
                w, h = (w * math.cos(r) + h * math.sin(r),
                        w * math.sin(r) + h * math.cos(r))
            if w > bw or h > bh:
                break
            size += 4
        font = ImageFont.truetype(FONT, size)
        stroke = max(3, size // 11)
        bb = d.textbbox((0, 0), WORD, font=font, stroke_width=stroke)
        tw, th = bb[2] - bb[0], bb[3] - bb[1]

        # Draw onto a transparent layer so it can be rotated before compositing.
        pad = stroke * 3
        layer = Image.new('RGBA', (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
        ld = ImageDraw.Draw(layer)
        ld.text((pad - bb[0], pad - bb[1]), WORD, font=font, fill=(255, 226, 60, 255),
                stroke_width=stroke, stroke_fill=(0, 0, 0, 255))
        if rot:
            layer = layer.rotate(rot, expand=True, resample=Image.BICUBIC)
        lx = x0 + ((x1 - x0) - layer.size[0]) // 2
        ly = y0 + ((y1 - y0) - layer.size[1]) // 2
        out.paste(layer, (lx, ly), layer)
        print(f'   drew "{WORD}" on {"+z" if sign > 0 else "-z"} at {size}px, rot {rot} deg')

    if DRY:
        out.save('/tmp/claude-501/truck-funky.png')
        print('   dry run: /tmp/claude-501/truck-funky.png')
        return
    write_image(GLB, GLB + '.tmp', out)
    os.replace(GLB + '.tmp', GLB)
    print(f'   wrote {GLB}')


main()
