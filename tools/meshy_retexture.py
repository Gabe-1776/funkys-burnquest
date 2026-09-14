#!/usr/bin/env python3
"""Repaint an existing Meshy asset without regenerating its geometry.

Why: measured with tools/extract-glb-texture.py, the funkyverse turtle's source
texture is 94% a single flat lime and the taxi's is 93% a single flat gold -
Meshy never produced the reference's two-tone shell pattern or the taxi's black
checker stripe. The BAKE was faithful; the source was flat. Retexture keeps the
mesh (so every alignment and scale fix still holds) and only repaints it, which
is cheaper than a fresh image-to-3D and cannot regress the silhouette.

Resumable: state lives beside the image-to-3D state so a rerun never
double-submits. Never prints the API key.

Usage: python3 tools/meshy_retexture.py [name ...]      (default: all below)
"""
import json, os, pathlib, sys, time, urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
OUT = ROOT / "test-shots" / "meshy-out"
SRC_STATE = OUT / "meshy_state.json"
STATE = OUT / "retexture_state.json"
API = "https://api.meshy.ai/openapi/v1/retexture"
POLL_BUDGET_S = 1800

# Prompts describe what the REFERENCE PLATE shows and the source texture lacks.
JOBS = {
    "funkyverse/turtle": (
        "voxel toy turtle built from plastic bricks. Domed shell in medium "
        "grass green with a bold pattern of darker forest-green pixel blocks "
        "across it. Clearly lighter yellow-green lime skin on the head, the "
        "four stubby legs and the flat belly plate, so shell and skin read as "
        "two distinct greens. Black pixel eyes with a small white highlight. "
        "Matte toy plastic, flat colours, hard pixel edges, no gradients."),
    "funkyverse/taxi": (
        "voxel toy taxi cab built from plastic bricks. Bright saturated taxi "
        "yellow body. A bold black and white checkerboard stripe running "
        "along both flanks below the windows. Black windscreen and side "
        "windows. A small yellow TAXI sign box on the roof with black "
        "lettering. Light grey chrome bumpers and grille, black tyres with "
        "grey hubs. Matte toy plastic, flat colours, hard pixel edges."),
}


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    envf = pathlib.Path(os.environ.get("MESHY_ENV", "~/.openclaw/workspace/.env.meshy")).expanduser()
    for line in envf.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MESHY_API_KEY found")


def call(url, key, payload=None, method=None):
    data = json.dumps(payload).encode() if payload is not None else None
    req = urllib.request.Request(url, data=data, method=method or ("POST" if data else "GET"),
                                 headers={"Authorization": f"Bearer {key}",
                                          "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())
    except urllib.error.HTTPError as e:
        body = e.read().decode()[:400]
        raise SystemExit(f"HTTP {e.code} on {url.rsplit('/', 1)[-1]}: {body}")


def main(only):
    key = load_key()
    src = json.loads(SRC_STATE.read_text())["tasks"]
    state = json.loads(STATE.read_text()) if STATE.exists() else {"tasks": {}}
    names = [n for n in JOBS if not only or any(o in n for o in only)]

    for n in names:
        rec = state["tasks"].get(n, {})
        if rec.get("status") == "SUCCEEDED" and rec.get("bytes"):
            print(f"  {n:22} already done, skipping"); continue
        if not rec.get("id"):
            r = call(API, key, {
                "input_task_id": src[n]["id"],
                "text_style_prompt": JOBS[n],
                "enable_original_uv": True,
                "enable_pbr": False,
            })
            rec = {"id": r["result"] if isinstance(r.get("result"), str) else r.get("result", r).get("id"),
                   "status": "PENDING"}
            state["tasks"][n] = rec
            STATE.write_text(json.dumps(state, indent=2))
            print(f"  {n:22} submitted {rec['id']}")

    t0 = time.time()
    while time.time() - t0 < POLL_BUDGET_S:
        pending = [n for n in names if state["tasks"][n].get("status") not in ("SUCCEEDED", "FAILED")]
        if not pending:
            break
        for n in pending:
            tid = state["tasks"][n]["id"]
            r = call(f"{API}/{tid}", key)
            st = r.get("status")
            state["tasks"][n]["status"] = st
            if st == "SUCCEEDED":
                url = (r.get("model_urls") or {}).get("glb")
                dest = OUT / (n + ".glb")
                dest.parent.mkdir(parents=True, exist_ok=True)
                with urllib.request.urlopen(url, timeout=300) as resp:
                    blob = resp.read()
                dest.write_bytes(blob)
                state["tasks"][n]["bytes"] = len(blob)
                print(f"  {n:22} SUCCEEDED -> {dest.relative_to(ROOT)} ({len(blob)//1024} KB)")
            elif st == "FAILED":
                print(f"  {n:22} FAILED: {r.get('task_error')}")
            else:
                print(f"  {n:22} {st} {r.get('progress', 0)}%")
        STATE.write_text(json.dumps(state, indent=2))
        if any(state["tasks"][n].get("status") not in ("SUCCEEDED", "FAILED") for n in names):
            time.sleep(15)
    STATE.write_text(json.dumps(state, indent=2))


if __name__ == "__main__":
    main([a for a in sys.argv[1:] if not a.startswith("-")])
