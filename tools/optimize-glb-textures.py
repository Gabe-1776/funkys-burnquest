#!/usr/bin/env python3
"""Downscale embedded GLB baseColor textures (Meshy atlases).

Same rationale as tools/optimize-assets.sh for 2D sprites: on screen a car is
a couple hundred CSS px, so a 2048/4096 atlas is far past what the game can
show. Oversized JPEGs also blow GPU upload budgets on Windows/Android and make
fresh-browser first load crawl on every device.

Unlike tools/glb_retouch.py (which pads a re-encode into the OLD byte budget so
bufferView offsets stay put), this REBUILDS the BIN chunk so the file actually
shrinks. Geometry, skins, and animation bufferViews are copied byte-for-byte.

Run from repo root:
  python3 tools/optimize-glb-textures.py              # dry run
  python3 tools/optimize-glb-textures.py --apply      # rewrite in place
  python3 tools/optimize-glb-textures.py --apply --max 512
"""
from __future__ import annotations

import argparse
import glob
import io
import json
import os
import struct
import sys

from PIL import Image

JSON_CHUNK = 0x4E4F534A
BIN_CHUNK = 0x004E4942


def load_glb(path):
    data = open(path, "rb").read()
    if data[:4] != b"glTF":
        raise SystemExit(f"{path}: not a GLB")
    off = 12
    js = None
    binc = None
    while off < len(data):
        ln, ty = struct.unpack_from("<II", data, off)
        chunk = data[off + 8 : off + 8 + ln]
        if ty == JSON_CHUNK:
            js = json.loads(chunk)
        elif ty == BIN_CHUNK:
            binc = chunk
        pad = (4 - (ln % 4)) % 4
        off += 8 + ln + pad
    if js is None or binc is None:
        raise SystemExit(f"{path}: missing JSON or BIN chunk")
    return js, binc


def align4(n):
    return (n + 3) & ~3


def encode_image(im: Image.Image, mime: str, quality: int = 85) -> bytes:
    buf = io.BytesIO()
    if mime == "image/png" or (im.mode == "RGBA"):
        if im.mode not in ("RGB", "RGBA"):
            im = im.convert("RGBA")
        im.save(buf, format="PNG", optimize=True)
        return buf.getvalue(), "image/png"
    if im.mode != "RGB":
        im = im.convert("RGB")
    im.save(buf, format="JPEG", quality=quality, subsampling=0, optimize=True)
    return buf.getvalue(), "image/jpeg"


def resize_max(im: Image.Image, max_edge: int) -> Image.Image:
    w, h = im.size
    big = max(w, h)
    if big <= max_edge:
        return im
    scale = max_edge / float(big)
    nw = max(1, int(round(w * scale)))
    nh = max(1, int(round(h * scale)))
    return im.resize((nw, nh), Image.Resampling.LANCZOS)


def rebuild(js, binc, max_edge: int, quality: int):
    """Return (new_js, new_bin, report_rows) or (None, None, []) if nothing changed."""
    images = js.get("images") or []
    if not images:
        return None, None, []

    views = [dict(v) for v in js["bufferViews"]]
    # Identify which bufferViews are image payloads.
    image_view_idxs = {}
    for i, im in enumerate(images):
        if "bufferView" not in im:
            continue  # uri-based; leave alone
        image_view_idxs[im["bufferView"]] = i

    new_blobs = []  # parallel to views: bytes for each view in order of rebuild
    report = []
    changed = False

    # First pass: prepare replacement bytes for image views; mark others for copy.
    replacements = {}  # view_idx -> (bytes, mime)
    for vidx, img_i in image_view_idxs.items():
        bv = views[vidx]
        start = bv.get("byteOffset", 0)
        length = bv["byteLength"]
        raw = binc[start : start + length]
        mime = images[img_i].get("mimeType") or "image/jpeg"
        try:
            im = Image.open(io.BytesIO(raw))
            im.load()
        except Exception as e:
            report.append(f"image[{img_i}] skip (decode failed: {e})")
            continue
        before = im.size
        im2 = resize_max(im, max_edge)
        # Coins / tiny PNGs: only rewrite if we actually resized.
        if im2.size == before and max(before) <= max_edge:
            # Still recompress JPEG if it's absurdly large for its dims? skip.
            report.append(f"image[{img_i}] keep {before[0]}x{before[1]} ({mime})")
            continue
        blob, out_mime = encode_image(im2, mime, quality=quality)
        replacements[vidx] = (blob, out_mime)
        changed = True
        report.append(
            f"image[{img_i}] {before[0]}x{before[1]} -> {im2.size[0]}x{im2.size[1]}  "
            f"{length} -> {len(blob)} bytes ({out_mime})"
        )

    if not changed:
        return None, None, report

    # Rebuild BIN: pack every bufferView in index order with 4-byte alignment.
    # Accessors keep their relative byteOffset into their bufferView.
    out = bytearray()
    new_views = []
    for i, bv in enumerate(views):
        if i in replacements:
            blob, out_mime = replacements[i]
            # Update matching image mimeType.
            for im in images:
                if im.get("bufferView") == i:
                    im["mimeType"] = out_mime
        else:
            start = bv.get("byteOffset", 0)
            length = bv["byteLength"]
            blob = binc[start : start + length]

        # byteStride views must stay contiguous as originally laid out — we copy
        # the exact slice, so stride semantics are preserved.
        pad = (4 - (len(blob) % 4)) % 4
        offset = len(out)
        out.extend(blob)
        out.extend(b"\x00" * pad)
        nbv = dict(bv)
        nbv["byteOffset"] = offset
        nbv["byteLength"] = len(blob)
        # buffer field stays 0
        new_views.append(nbv)

    new_js = json.loads(json.dumps(js))  # deep copy via json
    new_js["bufferViews"] = new_views
    new_js["images"] = images  # mime updates
    # Re-apply mime onto deep copy
    for i, im in enumerate(js.get("images") or []):
        if "bufferView" in im and im["bufferView"] in replacements:
            new_js["images"][i]["mimeType"] = replacements[im["bufferView"]][1]
    if not new_js.get("buffers"):
        new_js["buffers"] = [{"byteLength": len(out)}]
    else:
        new_js["buffers"] = [dict(new_js["buffers"][0])]
        new_js["buffers"][0]["byteLength"] = len(out)

    return new_js, bytes(out), report


def write_glb(path, js, binc):
    js_bytes = json.dumps(js, separators=(",", ":")).encode("utf-8")
    js_pad = (4 - (len(js_bytes) % 4)) % 4
    js_bytes = js_bytes + (b" " * js_pad)  # glTF pads JSON with spaces

    bin_pad = (4 - (len(binc) % 4)) % 4
    bin_bytes = binc + (b"\x00" * bin_pad)

    total = 12 + 8 + len(js_bytes) + 8 + len(bin_bytes)
    out = bytearray()
    out += struct.pack("<4sII", b"glTF", 2, total)
    out += struct.pack("<II", len(js_bytes), JSON_CHUNK)
    out += js_bytes
    out += struct.pack("<II", len(bin_bytes), BIN_CHUNK)
    out += bin_bytes
    assert len(out) == total
    tmp = path + ".tmp"
    open(tmp, "wb").write(out)
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--apply", action="store_true", help="rewrite GLBs in place (default is dry run)")
    ap.add_argument("--max", type=int, default=512, help="max texture edge in px (default 512)")
    ap.add_argument("--quality", type=int, default=85, help="JPEG quality for re-encode (default 85)")
    ap.add_argument("globs", nargs="*", help="optional path globs (default: assets/models/glb/*/*.glb)")
    args = ap.parse_args()

    pats = args.globs or ["assets/models/glb/*/*.glb"]
    files = sorted({f for pat in pats for f in glob.glob(pat)})
    if not files:
        print("no GLBs matched", file=sys.stderr)
        sys.exit(1)

    total_before = total_after = 0
    n_changed = 0
    for path in files:
        before = os.path.getsize(path)
        js, binc = load_glb(path)
        new_js, new_bin, report = rebuild(js, binc, args.max, args.quality)
        if new_js is None:
            total_before += before
            total_after += before
            why = "; ".join(report) if report else "no images / already <= max"
            print(f"  KEEP  {path}  ({before/1024:.0f} KB)  [{why}]")
            continue
        # Estimate size without writing on dry run
        js_bytes = json.dumps(new_js, separators=(",", ":")).encode("utf-8")
        js_pad = (4 - (len(js_bytes) % 4)) % 4
        bin_pad = (4 - (len(new_bin) % 4)) % 4
        after = 12 + 8 + len(js_bytes) + js_pad + 8 + len(new_bin) + bin_pad
        total_before += before
        total_after += after
        n_changed += 1
        detail = "; ".join(report)
        print(f"  {'WRITE' if args.apply else 'WOULD'} {path}  {before/1024:.0f} -> {after/1024:.0f} KB  ({detail})")
        if args.apply:
            write_glb(path, new_js, new_bin)
            # verify round-trip load + image size
            js2, b2 = load_glb(path)
            imdef = js2["images"][0]
            bv = js2["bufferViews"][imdef["bufferView"]]
            raw = b2[bv.get("byteOffset", 0) : bv.get("byteOffset", 0) + bv["byteLength"]]
            im = Image.open(io.BytesIO(raw))
            assert max(im.size) <= args.max, (path, im.size)

    print(
        f"\n  TOTAL {total_before/1024/1024:.2f} MB -> {total_after/1024/1024:.2f} MB  "
        f"({100 * (total_before - total_after) / max(total_before, 1):.0f}% smaller), "
        f"{n_changed} file(s) changed"
        + ("" if args.apply else "   [dry run — pass --apply to write]")
    )


if __name__ == "__main__":
    main()
