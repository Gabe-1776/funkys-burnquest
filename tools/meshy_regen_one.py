#!/usr/bin/env python3
"""Regenerate ONE asset from its reference plate, when the mesh itself is bad.

The funkyverse taxi came back from the batch run as broken geometry: rendered
flank-on (tools/zoom-render.js) the body is hollow, the side panels are floating
fragments and the wheels are jagged clusters - you can see straight through the
car. No amount of recolouring fixes that, and it is why the model reads as a
gold pickup from the game's top-down camera.

Differences from tools/meshy_batch_image_to_3d.py, both aimed at solid bodies:
  symmetry_mode "on"  - a car is bilaterally symmetric; this alone removes most
                        of the one-sided fragment artefacts
  higher polycount    - decimation is off now (see bake_meshy_props.py), and the
                        whole visible board measures ~15k tris, so there is room

Never prints the API key. Writes to <out>.glb only on success, so a failed run
cannot destroy the asset currently in use.

Usage: python3 tools/meshy_regen_one.py <theme>/<prop> [polycount]
"""
import base64, json, os, pathlib, sys, time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO = ROOT / "test-shots" / "meshy-isolates"
OUT = ROOT / "test-shots" / "meshy-out"
API = "https://api.meshy.ai/openapi/v1/image-to-3d"
BUDGET_S = 2400


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    envf = pathlib.Path(os.environ.get("MESHY_ENV", "~/.openclaw/workspace/.env.meshy")).expanduser()
    for line in envf.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MESHY_API_KEY found")


def call(url, key, body=None):
    req = urllib.request.Request(
        url, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=90) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code}: {e.read().decode()[:300]}")


def main():
    target = sys.argv[1]
    poly = int(sys.argv[2]) if len(sys.argv) > 2 else 15000   # meshy-t2 caps at 15000
    theme, prop = target.split("/")
    img = ISO / theme / f"01-{prop}.jpg"
    if not img.exists():
        raise SystemExit(f"no reference plate at {img}")
    key = load_key()

    uri = "data:image/jpeg;base64," + base64.b64encode(img.read_bytes()).decode()
    r = call(API, key, {
        "image_url": uri,
        "model_type": os.environ.get("MESHY_TOPO", "smart-topology"),
        "ai_model": os.environ.get("MESHY_MODEL", "meshy-t2"),
        "target_polycount": poly,
        "should_texture": True,
        "symmetry_mode": "on",
    })
    tid = r.get("result") or r.get("id")
    print(f"  {target} submitted {tid} (poly={poly}, symmetry=on)", flush=True)

    t0 = time.time()
    while time.time() - t0 < BUDGET_S:
        s = call(f"{API}/{tid}", key)
        st = s.get("status")
        if st == "SUCCEEDED":
            url = (s.get("model_urls") or {}).get("glb")
            with urllib.request.urlopen(url, timeout=300) as resp:
                blob = resp.read()
            dest = OUT / theme / f"{prop}.glb"
            dest.write_bytes(blob)
            print(f"  {target} SUCCEEDED -> {dest.relative_to(ROOT)} ({len(blob)//1024} KB)")
            return
        if st == "FAILED":
            raise SystemExit(f"  {target} FAILED: {s.get('task_error')}")
        print(f"  {target} {st} {s.get('progress', 0)}%", flush=True)
        time.sleep(15)
    raise SystemExit("  timed out; rerun to resubmit")


if __name__ == "__main__":
    main()
