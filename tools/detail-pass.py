#!/usr/bin/env python3
"""Paint detail that the source texture never had onto a baked asset.

Measured with tools/extract-glb-texture.py, two funkyverse sources are flat:
the turtle's texture is 94% a single lime with no shell pattern, the taxi's is
93% a single gold with no checker stripe. The bake was faithful - the detail was
never generated. A Meshy retexture pass was tried first and came back drab and
desaturated (grey-green turtle), so the detail is authored here instead, keyed
off geometry, where the colours can be taken straight from the reference plates.

Only CHROMATIC vertices are touched, so already-correct black windows, tyres,
eyes and chrome survive untouched. Values are stored linear, matching the bake.

Run: python3 tools/detail-pass.py [--apply] [turtle|taxi ...]
"""
import colorsys, json, os, sys

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
SAT_MIN, VAL_MIN = 0.30, 0.20


def to_linear(c):
    return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4


def to_srgb(c):
    c = max(0.0, min(1.0, c))
    return c * 12.92 if c <= 0.0031308 else 1.055 * (c ** (1 / 2.4)) - 0.055


def hx(s):
    s = s.lstrip("#")
    return tuple(int(s[i:i + 2], 16) / 255 for i in (0, 2, 4))


def blocks(v, size):
    """Quantise a coordinate into voxel-sized blocks, for hard pixel edges."""
    import math
    return int(math.floor(v / size))


# ---- reference colours, read off the isolate plates -------------------------
# Sampled from the plate, not invented. Clustering 01-turtle.jpg gives a tight
# family of YELLOW-greens at hue 71-90 and value 0.43-0.67, with LOW contrast
# between shell base and pattern. An earlier pass pitched these much brighter
# (skin at value 0.82) to fight the warm dim sun; the result read as polished
# metal rather than matte plastic. Reference values, lifted ~8% for the light.
SHELL_MID = hx("#8ba32f")     # domed shell base green   (plate #7f972a)
SHELL_DARK = hx("#5a771a")    # darker pixel blocks      (plate #526d16)
SKIN_LIME = hx("#a2b743")     # head, legs, belly plate  (plate #97ab3e)
CHECK_DARK = hx("#161616")
CHECK_LIGHT = hx("#e6e6e6")


def turtle(pos, nrm, col, i):
    """Shell above the belly line, skin below; blocky camo on the shell.
    The board is viewed from above, so the shell pattern is what reads."""
    x, y, z = pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]
    if y > 0.02:
        # Coarse blocks on purpose: the turtle is ~50px on screen, so a fine
        # camo reads as dirt rather than pattern.
        bx, bz = blocks(x, 0.085), blocks(z, 0.085)
        dark = ((bx * 73856093) ^ (bz * 19349663)) % 100 < 42
        return SHELL_DARK if dark else SHELL_MID
    return SKIN_LIME


def taxi(pos, nrm, col, i):
    """Checkerboard stripe along both flanks, below the windows. Everything
    else keeps the body yellow it already has."""
    x, y, z = pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]
    # Select the flank by NORMAL, not by |z|. An |z| threshold looked right on
    # paper but rejected the very panels it was meant to catch - measured, the
    # side-facing yellow vertices peak at y 0.125-0.225 and the stripe never
    # appeared. A side-facing normal is what actually defines a flank.
    if 0.125 <= y <= 0.215 and abs(nrm[i * 3 + 2]) > 0.75:
        # A SOLID dark stripe, not the reference's checkerboard. Tried both a
        # fine and a four-square checker first: the flank band this model gives
        # us is thin and fragmented, so the white squares blended into the
        # chrome and the black ones into the shadow gaps and neither read at
        # any distance. A solid stripe carries the value contrast that survives
        # - it is the checker stylised down to what 60px can actually show.
        return CHECK_DARK
    return None                      # leave as-is


# taxi is DELIBERATELY not in here. The checker stripe was authored for the old
# dense mesh; the low-poly regeneration carries the checker in its own texture
# and has only ~6.4k tris, so painting a band across it produced stray dark
# wedges along the flank that read as damage rather than a stripe. Sparse
# geometry cannot hold a pattern that fine - leave it to the bake.
RULES = {"turtle": turtle}


def run(name, apply):
    p = os.path.join(ROOT, "assets/models/fv", name + ".json")
    d = json.load(open(p))
    pos, nrm, col = d["positions"], d["normals"], d["colors"]
    fn = RULES[name]
    n = 0
    for i in range(len(col) // 3):
        s = [to_srgb(col[i * 3 + k]) for k in range(3)]
        _, sa, va = colorsys.rgb_to_hsv(*s)
        if sa < SAT_MIN or va < VAL_MIN:
            continue                 # black windows, tyres, eyes, chrome
        out = fn(pos, nrm, col, i)
        if out is None:
            continue
        for k in range(3):
            col[i * 3 + k] = round(to_linear(out[k]), 4)
        n += 1
    print(f"  {name:8} repainted {n} of {len(col)//3} vertices")
    if apply:
        open(p, "w").write(json.dumps(d, separators=(",", ":")))


def matte(apply):
    """Every reference plate is MATTE plastic. The bakes ship roughness 0.8,
    which still draws a soft specular sweep across Meshy's smoothed voxel
    normals - on a rounded shape like the turtle that reads as polished metal,
    which is exactly what Gabriel called out. Applies to every asset in both
    themes, not just ones with an authored rule."""
    import glob
    n = 0
    for p in sorted(glob.glob(os.path.join(ROOT, "assets/models/*/*.json"))):
        d = json.load(open(p))
        mats = d.get("materials") or []
        if not mats:
            continue
        changed = False
        for m in mats:
            if m.get("roughness") != 0.97:
                m["roughness"] = 0.97
                changed = True
        if changed and apply:
            open(p, "w").write(json.dumps(d, separators=(",", ":")))
        n += changed
    print(f"  matte    roughness 0.97 on {n} assets")


if __name__ == "__main__":
    names = [a for a in sys.argv[1:] if not a.startswith("-")] or list(RULES)
    ap = "--apply" in sys.argv
    for nm in names:
        run(nm, ap)
    matte(ap)
    if not ap:
        print("\n  dry run - pass --apply to write")
