#!/usr/bin/env python3
"""Repaint part of a baked GLB's texture, selected by MESH GEOMETRY.

Meshy atlases are scattered islands, so "the hood" cannot be found by looking at
the texture - it has to be selected as triangles (position + normal) and
rasterised into a UV mask. glb_uv_mask.py does that; this applies an edit inside
the mask and writes the GLB back.

Writing back: the new JPEG is encoded to be <= the original's byte length and
then PADDED with zero bytes to exactly that length. JPEG decoders stop at the
EOI marker, so trailing bytes are ignored - and keeping the length identical
means every bufferView offset in the file stays valid. Rebuilding the buffer
and re-offsetting everything would work too, and is a much larger blast radius
for no gain.
"""
import io, json, struct, sys
import numpy as np
from PIL import Image, ImageFilter


def image_slice(js, idx=0):
    im = js['images'][idx]
    bv = js['bufferViews'][im['bufferView']]
    s = bv.get('byteOffset', 0)
    return s, bv['byteLength']


def read_image(glb_path, idx=0):
    from glb_uv_mask import load
    js, binc = load(glb_path)
    s, n = image_slice(js, idx)
    return js, binc, Image.open(io.BytesIO(binc[s:s + n])).convert('RGB'), s, n


def write_image(glb_path, out_path, new_img, idx=0, min_quality=60):
    """Re-encode new_img into the same byte budget and rewrite the GLB."""
    d = open(glb_path, 'rb').read()
    from glb_uv_mask import load
    js, binc = load(glb_path)
    start, budget = image_slice(js, idx)

    blob = None
    for q in range(95, min_quality - 1, -5):
        buf = io.BytesIO()
        new_img.save(buf, format='JPEG', quality=q, subsampling=0, optimize=True)
        if buf.tell() <= budget:
            blob = buf.getvalue()
            print(f'   re-encoded at quality {q}: {len(blob)} of {budget} bytes')
            break
    if blob is None:
        raise SystemExit(f'could not fit the new texture into {budget} bytes')
    blob = blob + b'\x00' * (budget - len(blob))   # pad; decoders stop at EOI

    # Splice into the BIN chunk in the original file bytes.
    off = 12
    while off < len(d):
        ln, ty = struct.unpack_from('<II', d, off)
        if ty == 0x004E4942:
            bin_start = off + 8
            out = bytearray(d)
            out[bin_start + start: bin_start + start + budget] = blob
            open(out_path, 'wb').write(bytes(out))
            return
        off += 8 + ln + ((4 - ln % 4) % 4 if ln % 4 else 0)
    raise SystemExit('no BIN chunk found')


def feather(mask, radius=2):
    """Soften a hard triangle mask so repaints do not leave stair-stepped edges."""
    m = Image.fromarray(mask).filter(ImageFilter.GaussianBlur(radius))
    return np.array(m).astype(np.float64) / 255.0
