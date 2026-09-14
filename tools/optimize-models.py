#!/usr/bin/env python3
"""Shrink baked model JSON without changing how it looks in game.

Two lossless-at-display-scale passes:

  1. QUANTISE. Positions/normals/colours are baked at 4 decimals. Models are
     ~1 world unit and drawn 40-120px on screen, so 3 decimals on position is
     already ~1/1000 of a tile - far finer than a pixel. Colours need even less.

  2. RE-WELD. The bake splits a vertex whenever its normal or colour differs,
     so meshes arrive with far more verts than tris (turtle: 12046 verts for
     6410 tris). After quantising, many of those splits collapse to identical
     vertices and can be merged, which shrinks the position/normal/colour
     arrays AND leaves the index buffer pointing at fewer distinct entries.

Geometry is never decimated - no triangle is removed, so silhouettes are
untouched. Run: python3 tools/optimize-models.py [--apply] [glob ...]
"""
import json, glob, os, sys

POS_DP, NRM_DP, COL_DP = 3, 3, 3

def optimise(path, apply=False):
    d = json.load(open(path))
    pos, nrm = d["positions"], d["normals"]
    col = d.get("colors")
    idx, groups = d["indices"], d["groups"]
    n = len(pos) // 3

    seen, remap, npos, nnrm, ncol = {}, [0] * n, [], [], []
    for i in range(n):
        p = (round(pos[i*3], POS_DP), round(pos[i*3+1], POS_DP), round(pos[i*3+2], POS_DP))
        q = (round(nrm[i*3], NRM_DP), round(nrm[i*3+1], NRM_DP), round(nrm[i*3+2], NRM_DP))
        c = (round(col[i*3], COL_DP), round(col[i*3+1], COL_DP), round(col[i*3+2], COL_DP)) if col else ()
        key = p + q + c
        j = seen.get(key)
        if j is None:
            j = len(npos) // 3
            seen[key] = j
            npos.extend(p); nnrm.extend(q)
            if col: ncol.extend(c)
        remap[i] = j

    d["positions"], d["normals"] = npos, nnrm
    if col: d["colors"] = ncol
    d["indices"] = [remap[i] for i in idx]
    d["groups"] = groups                      # triangle ranges are unchanged

    before = os.path.getsize(path)
    blob = json.dumps(d, separators=(",", ":"))
    after = len(blob.encode())
    if apply:
        open(path, "w").write(blob)
    return before, after, n, len(npos) // 3, len(idx) // 3

if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--apply"]
    apply = "--apply" in sys.argv
    pats = args or ["assets/models/*/*.json"]
    files = sorted(f for pat in pats for f in glob.glob(pat))
    tb = ta = 0
    for f in files:
        b, a, v0, v1, tris = optimise(f, apply)
        tb += b; ta += a
        print(f"  {f.split('/',2)[-1]:26} {b/1024:6.0f} -> {a/1024:6.0f} KB   verts {v0:6} -> {v1:6}   tris {tris}")
    print(f"\n  TOTAL {tb/1024/1024:.2f} MB -> {ta/1024/1024:.2f} MB  ({100*(tb-ta)/tb:.0f}% smaller)"
          + ("" if apply else "   [dry run - pass --apply to write]"))
