#!/usr/bin/env python3
"""Map a GLB's mesh geometry into its UV atlas.

A Meshy atlas is a scatter of unrelated islands - you cannot find "the hood" by
looking at the texture, because the hood's pixels are not contiguous and are not
next to the roof. The only reliable way to edit one PART of a baked asset is to
select the TRIANGLES that form it (by position and normal, in model space) and
rasterise just those triangles' UV footprints into a mask.

Provides:
    load(glb)                 -> (gltf json, binary chunk)
    primitives(js, bin)       -> [{pos, nrm, uv, idx}] as numpy arrays
    bounds(prims)             -> model-space min/max
    mask_for(prims, size, fn) -> uint8 mask, 255 where a selected triangle lands

`fn(centroid, normal, bbox)` decides whether a triangle is in the selection.
"""
import json, struct, sys
import numpy as np

COMP = {5120: 'i1', 5121: 'u1', 5122: 'i2', 5123: 'u2', 5125: 'u4', 5126: 'f4'}
NCOMP = {'SCALAR': 1, 'VEC2': 2, 'VEC3': 3, 'VEC4': 4}


def load(path):
    d = open(path, 'rb').read()
    off, js, binc = 12, None, None
    while off < len(d):
        ln, ty = struct.unpack_from('<II', d, off)
        chunk = d[off + 8: off + 8 + ln]
        if ty == 0x4E4F534A:
            js = json.loads(chunk)
        elif ty == 0x004E4942:
            binc = chunk
        off += 8 + ln + ((4 - ln % 4) % 4 if ln % 4 else 0)
    return js, binc


def _read(js, binc, idx):
    acc = js['accessors'][idx]
    bv = js['bufferViews'][acc['bufferView']]
    base = bv.get('byteOffset', 0) + acc.get('byteOffset', 0)
    n = acc['count']
    nc = NCOMP[acc['type']]
    dt = np.dtype('<' + COMP[acc['componentType']])
    stride = bv.get('byteStride') or (nc * dt.itemsize)
    if stride == nc * dt.itemsize:
        a = np.frombuffer(binc, dtype=dt, count=n * nc, offset=base)
        return a.reshape(n, nc).astype(np.float64 if dt.kind == 'f' else np.int64)
    out = np.empty((n, nc), dtype=np.float64 if dt.kind == 'f' else np.int64)
    for i in range(n):
        out[i] = np.frombuffer(binc, dtype=dt, count=nc, offset=base + i * stride)
    return out


def primitives(js, binc):
    prims = []
    for mesh in js.get('meshes', []):
        for p in mesh.get('primitives', []):
            at = p['attributes']
            if 'POSITION' not in at or 'TEXCOORD_0' not in at:
                continue
            prims.append({
                'pos': _read(js, binc, at['POSITION']),
                'nrm': _read(js, binc, at['NORMAL']) if 'NORMAL' in at else None,
                'uv': _read(js, binc, at['TEXCOORD_0']),
                'idx': _read(js, binc, p['indices']).ravel().astype(np.int64),
            })
    return prims


def bounds(prims):
    allp = np.vstack([p['pos'] for p in prims])
    return allp.min(axis=0), allp.max(axis=0)


def _fill_tri(mask, tri_uv, size):
    """Rasterise one UV triangle. Padded by a pixel so seams do not leak."""
    w = h = size
    xs = tri_uv[:, 0] * w
    # NO V FLIP. glTF's UV origin is the TOP-LEFT of the image and GLTFLoader
    # sets texture.flipY = false, so v maps straight to the pixel row. Writing
    # the usual (1 - v) mirrored every mask vertically, which scattered it
    # across unrelated islands of a Meshy atlas - selecting ALL 8541 triangles
    # of the car still left most of the model unpainted, which is what exposed
    # it. Test any change here by selecting everything: the model must go fully
    # covered.
    ys = tri_uv[:, 1] * h
    x0 = max(int(np.floor(xs.min())) - 1, 0)
    x1 = min(int(np.ceil(xs.max())) + 1, w - 1)
    y0 = max(int(np.floor(ys.min())) - 1, 0)
    y1 = min(int(np.ceil(ys.max())) + 1, h - 1)
    if x1 < x0 or y1 < y0:
        return
    yy, xx = np.mgrid[y0:y1 + 1, x0:x1 + 1]
    px, py = xx + 0.5, yy + 0.5
    ax, ay = xs[0], ys[0]
    bx, by = xs[1], ys[1]
    cx, cy = xs[2], ys[2]
    den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
    if abs(den) < 1e-12:
        return
    l1 = ((by - cy) * (px - cx) + (cx - bx) * (py - cy)) / den
    l2 = ((cy - ay) * (px - cx) + (ax - cx) * (py - cy)) / den
    l3 = 1 - l1 - l2
    eps = -0.03                              # slight bleed to cover seams
    inside = (l1 >= eps) & (l2 >= eps) & (l3 >= eps)
    mask[y0:y1 + 1, x0:x1 + 1][inside] = 255


def mask_for(prims, size, select):
    """select(centroid_xyz, normal_xyz, (lo, hi)) -> bool"""
    lo, hi = bounds(prims)
    mask = np.zeros((size, size), dtype=np.uint8)
    picked = total = 0
    for p in prims:
        pos, uv, idx = p['pos'], p['uv'], p['idx']
        nrm = p['nrm']
        for t in range(0, len(idx) - 2, 3):
            i, j, k = idx[t], idx[t + 1], idx[t + 2]
            total += 1
            c = (pos[i] + pos[j] + pos[k]) / 3.0
            if nrm is not None:
                n = (nrm[i] + nrm[j] + nrm[k]) / 3.0
                ln = np.linalg.norm(n)
                n = n / ln if ln > 1e-9 else np.array([0.0, 1.0, 0.0])
            else:
                n = np.cross(pos[j] - pos[i], pos[k] - pos[i])
                ln = np.linalg.norm(n)
                n = n / ln if ln > 1e-9 else np.array([0.0, 1.0, 0.0])
            if select(c, n, (lo, hi)):
                _fill_tri(mask, uv[[i, j, k]], size)
                picked += 1
    return mask, picked, total


if __name__ == '__main__':
    js, binc = load(sys.argv[1])
    prims = primitives(js, binc)
    lo, hi = bounds(prims)
    print('primitives:', len(prims))
    print('vertices  :', sum(len(p['pos']) for p in prims))
    print('triangles :', sum(len(p['idx']) // 3 for p in prims))
    print('bbox lo   :', np.round(lo, 4))
    print('bbox hi   :', np.round(hi, 4))
    print('size      :', np.round(hi - lo, 4))
