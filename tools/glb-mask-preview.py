#!/usr/bin/env python3
"""Paint a UV selection onto a COPY of a GLB so the selection can be SEEN.

Reasoning about which triangles a selector covers, from counts alone, is how you
end up repainting the wrong part of a car twice. This writes a throwaway GLB
whose texture is the original with the selected region flooded green - render it
and the answer is obvious.

Run: python3 tools/glb-mask-preview.py <glb> <out.glb> <selector>
     selector: normal-up | height | deck | rear
"""
import sys, os
import numpy as np
from PIL import Image

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from glb_uv_mask import load, primitives, mask_for
from glb_retouch import read_image, write_image

SEL = {
    'normal-up': lambda c, n, bb: n[1] > 0.5,
    'height':    lambda c, n, bb: c[1] > 0.02,
    'deck':      lambda c, n, bb: c[1] > 0.02 and c[0] < -0.15,
    'rear':      lambda c, n, bb: c[0] < -0.15,
}

glb, out, which = sys.argv[1], sys.argv[2], sys.argv[3]
js, binc, img, _, _ = read_image(glb)
tex = np.array(img).astype(np.uint8)
prims = primitives(*load(glb))
mask, cnt, tot = mask_for(prims, img.size[0], SEL[which])
print(f'   selector {which!r}: {cnt} of {tot} triangles')
tex[mask > 0] = (0, 255, 60)
write_image(glb, out, Image.fromarray(tex))
print(f'   wrote {out}')
