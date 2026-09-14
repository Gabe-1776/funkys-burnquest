#!/usr/bin/env python3
"""Generate the eight non-KSTO campaign coins through Meshy Image-to-3D.

Each campaign's canonical assets/coins/<id>.png is submitted unchanged. State is
persisted before and immediately after every paid POST, so reruns poll known task
IDs and never silently resubmit an ambiguous request.

Usage:
  python3 tools/meshy_coins.py --dry-run
  python3 tools/meshy_coins.py
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
SOURCE = ROOT / "assets" / "coins"
OUT = ROOT / "test-shots" / "coins" / "meshy"
STATE = OUT / "state.json"
API = "https://api.meshy.ai/openapi/v1"
COINS = ("heal", "pbr", "snippy", "snipling", "lbug", "love", "bender", "yen")
POLL_S = 15
BUDGET_S = 3000
COST_PER_COIN = 30
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
    """A 4xx submit response: the request was refused and no task was created."""


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
        raise SystemExit(f"{destination.name}: downloaded file is not a complete GLB")
    OUT.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=OUT, delete=False) as temporary:
        temporary.write(blob)
        temp_path = pathlib.Path(temporary.name)
    temp_path.replace(destination)
    return {
        "file": str(destination.relative_to(ROOT)),
        "bytes": len(blob),
        "sha256": hashlib.sha256(blob).hexdigest(),
    }


def submit_all(state, key):
    for coin in COINS:
        source = SOURCE / f"{coin}.png"
        if not source.exists():
            raise SystemExit(f"missing source image: {source}")
        digest = hashlib.sha256(source.read_bytes()).hexdigest()
        record = state.setdefault(coin, {})
        destination = OUT / f"{coin}.glb"
        if (record.get("status") == "SUCCEEDED" and destination.exists() and
                record.get("source_sha256") == digest):
            print(f"  {coin}: already complete -> {destination.relative_to(ROOT)}")
            continue
        if record.get("source_sha256") not in (None, digest):
            raise SystemExit(f"{coin}: source image changed; preserve the old candidate and start a new version")
        if record.get("intent") and not record.get("task_id"):
            raise SystemExit(f"{coin}: prior submit has no task id; reconcile it before resubmitting")
        if record.get("task_id"):
            print(f"  {coin}: resuming task {record['task_id']}")
            continue
        body = dict(REQUEST, image_url=image_uri(source))
        record.update(
            intent=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            endpoint="/image-to-3d",
            source=str(source.relative_to(ROOT)),
            source_sha256=digest,
            request=REQUEST,
            estimated_credits=COST_PER_COIN,
        )
        save_state(state)
        try:
            response = call("/image-to-3d", key, body)
        except Rejected as error:
            record.pop("intent", None)
            record.update(status="REJECTED", charged=False, error=str(error))
            save_state(state)
            raise SystemExit(f"{coin}: {error}")
        record["task_id"] = response.get("result") or response.get("id")
        if not record["task_id"]:
            save_state(state)
            raise SystemExit(f"{coin}: Meshy accepted the POST but returned no task id")
        save_state(state)
        print(f"  {coin}: submitted {record['task_id']}", flush=True)


def poll_all(state, key):
    deadline = time.time() + BUDGET_S
    while time.time() < deadline:
        pending = []
        for coin in COINS:
            record = state[coin]
            destination = OUT / f"{coin}.glb"
            if record.get("status") == "SUCCEEDED" and destination.exists():
                continue
            result = call(f"/image-to-3d/{record['task_id']}", key)
            status = result.get("status")
            if status == "SUCCEEDED":
                record.update(
                    status=status,
                    completed=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                    output=download(result["model_urls"]["glb"], destination),
                    thumbnail_url=result.get("thumbnail_url"),
                    thumbnail_urls=result.get("thumbnail_urls"),
                )
                save_state(state)
                print(f"  {coin}: -> {record['output']['file']} ({record['output']['bytes']//1024} KB)", flush=True)
            elif status in ("FAILED", "CANCELED", "EXPIRED"):
                record.update(status=status, error=result.get("task_error"))
                save_state(state)
                raise SystemExit(f"{coin}: {status}: {record.get('error')}")
            else:
                pending.append(f"{coin}:{status}:{result.get('progress', 0)}%")
        if not pending:
            return
        print("  pending " + " ".join(pending), flush=True)
        time.sleep(POLL_S)
    raise SystemExit("Meshy tasks still running; rerun this command to resume polling")


def main():
    if "--dry-run" in sys.argv:
        print("coins:", ", ".join(COINS))
        print("request:", json.dumps(REQUEST, sort_keys=True))
        print(f"estimated cost: {len(COINS) * COST_PER_COIN} credits "
              f"({len(COINS)} x {COST_PER_COIN})")
        for coin in COINS:
            source = SOURCE / f"{coin}.png"
            print(f"  {coin}: {source.relative_to(ROOT)} {source.stat().st_size} bytes "
                  f"sha256={hashlib.sha256(source.read_bytes()).hexdigest()[:16]}")
        return
    key = load_key()
    state = load_state()
    submit_all(state, key)
    poll_all(state, key)
    print("DONE", json.dumps({coin: state[coin]["task_id"] for coin in COINS}))


if __name__ == "__main__":
    main()
