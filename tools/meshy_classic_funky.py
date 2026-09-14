#!/usr/bin/env python3
"""Generate the classic playable character GLB from funky.png through Meshy.

The original 2D frog sprite (assets/images/funky.png) becomes a full 3D
character via Meshy Image-to-3D. char-motion.js handles the animation
(height-weighted vertex deform, no skeleton needed), so this is just the
mesh + texture - same pipeline as the coins but for a full character.

Usage:
  python3 tools/meshy_classic_funky.py --dry-run
  python3 tools/meshy_classic_funky.py
"""
import base64
import hashlib
import json
import os
import pathlib
import sys
import tempfile
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "images" / "funky.png"
OUT = ROOT / "test-shots" / "classic-funky"
STATE = OUT / "state.json"
DEST = ROOT / "assets" / "models" / "glb" / "fv" / "funky-classic.glb"
API = "https://api.meshy.ai/openapi/v1"
POLL_S = 15
BUDGET_S = 3000
COST = 30
REQUEST = {
    "model_type": "standard",
    "ai_model": "meshy-7",
    "should_texture": True,
    "texture_resolution": "2k",
    "enable_pbr": False,
    "should_remesh": True,
    "topology": "triangle",
    "target_polycount": 12000,
    "image_enhancement": False,
    "target_formats": ["glb"],
    "multi_view_thumbnails": True,
}


class Rejected(Exception):
    pass


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    env_file = pathlib.Path(os.environ.get(
        "MESHY_ENV", "~/.openclaw/workspace/.env.meshy")).expanduser()
    for line in env_file.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MESHY_API_KEY found")


def call(path, key, body=None):
    request = urllib.request.Request(
        API + path,
        data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + key,
                 "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(request, timeout=120) as response:
            return json.load(response)
    except urllib.error.HTTPError as error:
        message = f"HTTP {error.code} on {path}: {error.read().decode()[:400]}"
        if body is not None and 400 <= error.code < 500:
            raise Rejected(message)
        raise SystemExit(message)


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(state):
    OUT.mkdir(parents=True, exist_ok=True)
    temporary = STATE.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2) + "\n")
    temporary.replace(STATE)


def image_uri(path):
    return "data:image/png;base64," + base64.b64encode(path.read_bytes()).decode()


def valid_glb(blob):
    return (len(blob) > 20 and blob[:4] == b"glTF" and
            int.from_bytes(blob[8:12], "little") == len(blob))


def download(url, destination):
    with urllib.request.urlopen(url, timeout=600) as response:
        blob = response.read()
    if not valid_glb(blob):
        raise SystemExit(f"{destination.name}: not a complete GLB")
    destination.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=destination.parent, delete=False) as temporary:
        temporary.write(blob)
        temp_path = pathlib.Path(temporary.name)
    temp_path.replace(destination)
    return {
        "file": str(destination.relative_to(ROOT)),
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }


def main():
    if "--dry-run" in sys.argv:
        print(f"source: {SOURCE.relative_to(ROOT)} {SOURCE.stat().st_size} bytes")
        print(f"destination: {DEST.relative_to(ROOT)}")
        print(f"request: {json.dumps(REQUEST, sort_keys=True)}")
        print(f"estimated cost: {COST} credits")
        return
    if not SOURCE.exists():
        raise SystemExit(f"missing source image: {SOURCE}")
    key = load_key()
    state = load_state()
    digest = hashlib.sha256(SOURCE.read_bytes()).hexdigest()

    if state.get("status") == "SUCCEEDED" and DEST.exists() and state.get("source_sha256") == digest:
        print(f"already complete -> {DEST.relative_to(ROOT)}")
        return

    if not state.get("task_id"):
        if state.get("source_sha256") not in (None, digest):
            raise SystemExit("source image changed; preserve old candidate")
        if state.get("intent") and not state.get("task_id"):
            raise SystemExit("prior submit has no task id; reconcile first")
        body = dict(REQUEST, image_url=image_uri(SOURCE))
        state.update(
            intent=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            endpoint="/image-to-3d",
            source=str(SOURCE.relative_to(ROOT)),
            source_sha256=digest,
            request=REQUEST,
            estimated_credits=COST,
        )
        save_state(state)
        try:
            response = call("/image-to-3d", key, body)
        except Rejected as error:
            state.pop("intent", None)
            state.update(status="REJECTED", charged=False, error=str(error))
            save_state(state)
            raise SystemExit(str(error))
        state["task_id"] = response.get("result") or response.get("id")
        if not state["task_id"]:
            save_state(state)
            raise SystemExit("Meshy returned no task id")
        save_state(state)
        print(f"submitted {state['task_id']}", flush=True)
    else:
        print(f"resuming task {state['task_id']}", flush=True)

    deadline = time.time() + BUDGET_S
    while time.time() < deadline:
        result = call(f"/image-to-3d/{state['task_id']}", key)
        status = result.get("status")
        if status == "SUCCEEDED":
            state.update(
                status=status,
                completed=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                output=download(result["model_urls"]["glb"], DEST),
                thumbnail_url=result.get("thumbnail_url"),
                thumbnail_urls=result.get("thumbnail_urls"),
            )
            save_state(state)
            print(f"-> {state['output']['file']} ({state['output']['bytes']//1024} KB)")
            return
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            state.update(status=status, error=result.get("task_error"))
            save_state(state)
            raise SystemExit(f"{status}: {state.get('error')}")
        print(f"  pending {status} {result.get('progress', 0)}%", flush=True)
        time.sleep(POLL_S)
    raise SystemExit("task still running; rerun to resume")


if __name__ == "__main__":
    main()
