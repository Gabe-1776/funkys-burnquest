#!/usr/bin/env python3
"""Pull the baseColor texture out of a Meshy GLB so it can be inspected.

When a baked asset looks flat in game the question is always the same: did the
BAKE lose the detail, or was it never in the source? Answering it by eye on the
in-game mesh is guesswork - the turtle read as an olive blob and the suspicion
was the vertex-colour bake, but the texture turned out to be flat lime already.

Run: python3 tools/extract-glb-texture.py <glb> [out.png]
"""
import json, struct, os, sys
from PIL import Image

def extract(glb, out=None):
    d = open(glb, "rb").read()
    off, js, binc = 12, None, None
    while off < len(d):
        ln, ty = struct.unpack_from("<II", d, off)
        if ty == 0x4E4F534A:
            js = json.loads(d[off + 8:off + 8 + ln])
        elif ty == 0x004E4942:
            binc = d[off + 8:off + 8 + ln]
        off += 8 + ln
    if not js.get("images"):
        print(f"{os.path.basename(glb)}: no images"); return None
    img = js["images"][0]
    bv = js["bufferViews"][img["bufferView"]]
    s = bv.get("byteOffset", 0)
    raw = binc[s:s + bv["byteLength"]]
    out = out or os.path.splitext(glb)[0] + "-tex.png"
    open(out, "wb").write(raw)
    im = Image.open(out).convert("RGB")
    return im, out


def summarise(glb):
    r = extract(glb, "/tmp/_tex_probe.bin")
    if not r:
        return
    im, _ = r
    small = im.resize((320, 320))
    import colorsys
    buckets = {}
    for px in small.getdata():
        h, s, v = colorsys.rgb_to_hsv(*[c / 255 for c in px])
        if s < 0.25 or v < 0.15:
            continue
        k = int(h * 18)
        e = buckets.setdefault(k, [0, 0, 0, 0])
        e[0] += 1; e[1] += px[0]; e[2] += px[1]; e[3] += px[2]
    top = sorted(buckets.items(), key=lambda kv: -kv[1][0])[:3]
    name = os.path.basename(glb)
    parts = ["#%02x%02x%02x(%d%%)" % (e[1] // e[0], e[2] // e[0], e[3] // e[0],
             round(100 * e[0] / sum(b[0] for b in buckets.values())))
             for _, e in top]
    print(f"  {name:22} {im.size[0]}x{im.size[1]}  hues: " + "  ".join(parts))


if __name__ == "__main__":
    for a in sys.argv[1:]:
        summarise(a)
