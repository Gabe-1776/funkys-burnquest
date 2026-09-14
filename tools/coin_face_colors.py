#!/usr/bin/env python3
"""Post-pass: paint coin cap verts with the face art using PIL.

Blender background mode reads img.pixels back as flat grey, so the JSON bake
carries geometry + edge colors only. This rewrites cap-vert colors from the
face PNG with the same planar UV rule the bake used (diameter 0.5, centered).

Blender Z-up (x, y) plane maps to game (x, z): cap verts are those whose
Blender-space normal is ±Z. export_json maps (x, z, -y), so recover Blender
coords by inverting: bx = x, by = -z_game... simpler: cap = verts NOT on the
rim wall. The coin is 0.5 wide, 0.14*0.5/2 thick: caps are verts with |game_y|
near +/-half-thickness. Half thickness in game units: bake scaled diameter to
0.5 from ~2.0 (s=0.25); thickness 0.14*0.25 = 0.035, half = 0.0175. Use a
generous bound and planar-map (x, z_game) which equals Blender (x, y).

Usage: python3 tools/coin_face_colors.py <coin.json> <face.png>
"""
import json
import sys
from PIL import Image


def linear(c):
    c = c / 255.0
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def main(json_path, face_path):
    d = json.load(open(json_path))
    pos = d["positions"]
    n = len(pos) // 3
    # half-thickness bound: coin is thin in game-Y; caps are the two flat sides
    ys = [pos[3 * i + 1] for i in range(n)]
    lo, hi = min(ys), max(ys)
    span = hi - lo
    mid = (hi + lo) / 2
    # caps = verts within 15% of span from either extreme
    cap = [i for i in range(n)
           if abs(pos[3 * i + 1] - hi) < span * 0.15
           or abs(pos[3 * i + 1] - lo) < span * 0.15]
    img = Image.open(face_path).convert("RGB")
    W, H = img.size
    px = img.load()
    # Full-bleed: the whole image square maps onto the whole cap disc.
    # Cap footprint is the disc; normalize cap positions over it so the
    # entire image fills the entire face, edge to edge.
    xs = [pos[3 * i] for i in cap]
    zs = [pos[3 * i + 2] for i in cap]
    cx0, cx1 = min(xs), max(xs)
    cz0, cz1 = min(zs), max(zs)
    cols = d["colors"][:] if isinstance(d["colors"], list) else [0.0] * (3 * n)
    if len(cols) != 3 * n:
        cols = [0.0] * (3 * n)
    for i in cap:
        u = (pos[3 * i] - cx0) / (cx1 - cx0) if cx1 > cx0 else 0.5
        # Mirror V on the bottom cap so the back reads upright, not mirrored.
        v = (pos[3 * i + 2] - cz0) / (cz1 - cz0) if cz1 > cz0 else 0.5
        if pos[3 * i + 1] < mid:
            v = 1.0 - v
        xi = min(W - 1, max(0, int(u * (W - 1))))
        yi = min(H - 1, max(0, int((1.0 - v) * (H - 1))))
        r, g, b = px[xi, yi]
        cols[3 * i], cols[3 * i + 1], cols[3 * i + 2] = linear(r), linear(g), linear(b)
    d["colors"] = cols
    json.dump(d, open(json_path, "w"))
    uniq = len(set(tuple(round(cols[3 * i + j], 2) for j in range(3)) for i in range(n)))
    print(f"PAINTED {json_path}: caps={len(cap)} unique={uniq}")


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
