#!/usr/bin/env python3
"""Correct a baked asset's vertex colours to match its reference plate.

Meshy's bake comes back hue-shifted against the isolate photo it was generated
from - the muscle car lands amber rather than the reference's true orange, and
it ends up nearly indistinguishable from the orange sedan on the road. Rather
than eyeball a tint, this measures BOTH ends and applies the per-channel gain
that carries one onto the other.

COLOUR SPACE - this is the whole trick, and an earlier version got it wrong.
Blender's `image.pixels` hands back LINEAR floats, so that is what sits in the
baked `colors` array. Reference plates are ordinary sRGB JPEGs. Comparing the
two directly is meaningless: it previously asked for a blue gain of x2.03 on
the taxi, which would have washed the car out. Everything below is compared and
scaled in sRGB, converting in and out at the edges.

MATCH HUE AND SATURATION, NOT BRIGHTNESS. A studio plate cannot tell you how
bright the paint is: its brightest pixels are white specular highlights on
glossy plastic (which asked for a blue gain of x1.85) and its most saturated
pixels are the shadowed flank (which asked for x0.53 on everything). Both are
lighting artefacts. What the plate DOES report reliably is hue and chroma, and
that is exactly what "wrong colours" meant here - the muscle car came back
amber instead of orange. So each chromatic vertex is rotated to the reference
hue and scaled to its saturation, keeping its own value; shading and the flame
decals' internal contrast survive untouched.

Greys, tyres, glass and chrome are left alone - only chromatic vertices are
touched, so checkerboard, windows and trim survive untouched.

Run: python3 tools/match-reference-colors.py [--apply] [name ...]
"""
import json, os, sys, colorsys
from PIL import Image

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
ISO = "test-shots/meshy-isolates/funkyverse"
PAIRS = [                       # (baked json, reference plate)
    ("assets/models/fv/taxi.json",         f"{ISO}/01-taxi.jpg"),
    ("assets/models/fv/muscle-flame.json", f"{ISO}/01-muscle-flame.jpg"),
    ("assets/models/fv/coupe-red.json",    f"{ISO}/01-coupe-red.jpg"),
    ("assets/models/fv/truck-purple.json", f"{ISO}/01-truck-purple.jpg"),
    ("assets/models/fv/truck-teal.json",   f"{ISO}/01-truck-teal.jpg"),
    ("assets/models/fv/sedan-orange.json", f"{ISO}/01-sedan-orange.jpg"),
]
SAT_MIN = 0.35          # below this a pixel/vertex is grey: tyre, glass, chrome
VAL_MIN = 0.25
MAX_SAT_SCALE = 1.6     # a bigger chroma correction than this means a bad pairing


def to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def dominant_bucket(samples):
    """samples: iterable of sRGB (r,g,b) floats. Returns the members of the
    most-populated hue bucket that clear the saturation/value floors."""
    buckets = {}
    for r, g, b in samples:
        h, s, v = colorsys.rgb_to_hsv(r, g, b)
        if s < SAT_MIN or v < VAL_MIN:
            continue                      # white backdrop, black trim, chrome
        buckets.setdefault(int(h * 24), []).append((r, g, b, v))
    if not buckets:
        return None
    return max(buckets.values(), key=len)


def dominant_from_image(path):
    im = Image.open(os.path.join(ROOT, path)).convert("RGB")
    im.thumbnail((320, 320))
    mem = dominant_bucket((r / 255, g / 255, b / 255) for r, g, b in im.getdata())
    return hue_sat(mem)


def dominant_from_mesh(colors):
    """Vertex colours are stored LINEAR; convert to sRGB before bucketing so
    the hue/saturation test and the gain both happen in one space."""
    srgb = [(to_srgb(colors[i]), to_srgb(colors[i+1]), to_srgb(colors[i+2]))
            for i in range(0, len(colors), 3)]
    return hue_sat(dominant_bucket(srgb))


def hue_sat(mem):
    """Median hue and saturation of a hue bucket. Median, not mean, so a few
    blown highlights or deep shadow pixels cannot drag the answer."""
    if not mem:
        return None
    hs = sorted(colorsys.rgb_to_hsv(m[0], m[1], m[2])[0] for m in mem)
    ss = sorted(colorsys.rgb_to_hsv(m[0], m[1], m[2])[1] for m in mem)
    vs = sorted(colorsys.rgb_to_hsv(m[0], m[1], m[2])[2] for m in mem)
    mid = len(hs) // 2
    return hs[mid], ss[mid], vs[mid]


def hexs(c):
    return "#%02x%02x%02x" % tuple(max(0, min(255, round(x * 255))) for x in c)


def main(apply, only):
    for jf, rf in PAIRS:
        name = jf.split("/")[-1]
        if only and not any(o in name for o in only):
            continue
        p = os.path.join(ROOT, jf)
        d = json.load(open(p))
        cols = d.get("colors")
        if not cols:
            print(f"  {name:20} no vertex colours, skipped"); continue
        ref, got = dominant_from_image(rf), dominant_from_mesh(cols)
        if not ref or not got:
            print(f"  {name:20} could not sample, skipped"); continue
        dh = ref[0] - got[0]
        if dh > 0.5:                      # take the short way round the wheel
            dh -= 1.0
        elif dh < -0.5:
            dh += 1.0
        ss = max(1 / MAX_SAT_SCALE, min(MAX_SAT_SCALE, ref[1] / max(1e-3, got[1])))
        n = 0
        if apply:
            for i in range(0, len(cols), 3):
                srgb = [to_srgb(cols[i]), to_srgb(cols[i+1]), to_srgb(cols[i+2])]
                h, sa, v = colorsys.rgb_to_hsv(*srgb)
                if sa < SAT_MIN or v < VAL_MIN:
                    continue              # leave greys/tyres/glass exactly as-is
                out = colorsys.hsv_to_rgb((h + dh) % 1.0, min(1.0, sa * ss), v)
                for k in range(3):
                    cols[i+k] = round(to_linear(out[k]), 4)
                n += 1
            open(p, "w").write(json.dumps(d, separators=(",", ":")))
        show = lambda t: hexs(colorsys.hsv_to_rgb(t[0], t[1], t[2]))
        print(f"  {name:20} baked {show(got)} -> ref {show(ref)}   "
              f"hue {dh*360:+6.1f}deg  sat x{ss:.2f}" + (f"   {n} verts" if apply else ""))
    if not apply:
        print("\n  dry run - pass --apply to write")


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if not a.startswith("-")]
    main("--apply" in sys.argv, args)
