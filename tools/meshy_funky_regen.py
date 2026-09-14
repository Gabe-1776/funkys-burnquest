#!/usr/bin/env python3
"""Regenerate Funky from the locked isolate plates (test-shots/meshy-isolates/
funkyverse/funky/). The shipped model's bulging white eyes sit wider than the
spiral goggles; the new plates show goggles AS the eyes on a smooth head.

High quality, same as tools/meshy_character_rig.py's MODEL_REQ: meshy-7 ultra
+ 4k texture + 30k remesh. The output is an UNRIGGED mesh - rig it locally
with tools/rig_funky_meshy.py (FUNKY_SRC/FUNKY_OUT), which is what produced the
shipped fv/funky-rigged.glb.

Money safety, as tools/meshy_hazards.py: intent before every POST, task id
right after; a 4xx is REJECTED/charged:false; the key is never printed.

Usage:
  python3 tools/meshy_funky_regen.py --dry-run    # request + cost, no spend
  python3 tools/meshy_funky_regen.py              # run / resume
"""
import base64, hashlib, json, os, pathlib, subprocess, sys, tempfile, time
import urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO = ROOT / "test-shots" / "meshy-isolates"
OUT = ROOT / "test-shots" / "meshy-out" / "funkyverse" / "funky-v2"
STATE = OUT / "state.json"
API = "https://api.meshy.ai/openapi/v1"
POLL_S, BUDGET_S = 15, 2400

# Max 4 views; first is the primary (front). Same set the shipped model used.
VIEWS = ["funkyverse/funky/03-front.jpg", "funkyverse/funky/04-side.jpg",
         "funkyverse/funky/05-rear.jpg", "funkyverse/funky/01-34.jpg"]

REQ = {
    "ai_model": "meshy-7",
    "ultra_mode": True,            # Gabriel: "use high quality" - main character
    "should_texture": True,
    "texture_resolution": "4k",
    "enable_pbr": False,           # the game lights albedo; PBR maps unused
    "should_remesh": True,
    "topology": "triangle",
    "target_polycount": 30000,
    "image_enhancement": False,    # keep the exact plate look, no restyle
    "remove_lighting": True,
    "target_formats": ["glb"],
}
COST = 35


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    envf = pathlib.Path(os.environ.get("MESHY_ENV", "~/.openclaw/workspace/.env.meshy")).expanduser()
    for line in envf.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MESHY_API_KEY found")


class Rejected(Exception):
    """4xx at submit: no task created, nothing charged."""


def call(path, key, body=None):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        msg = f"HTTP {e.code} on {path}: {e.read().decode()[:300]}"
        if body is not None and 400 <= e.code < 500:
            raise Rejected(msg)
        raise SystemExit(msg)


def state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save(st):
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=2))
    tmp.replace(STATE)


def uri(rel):
    src = ISO / rel
    if not src.exists():
        raise SystemExit(f"missing plate: {src}")
    with tempfile.TemporaryDirectory() as td:
        out = pathlib.Path(td) / "v.jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "92",
                        "-Z", "1400", str(src), "--out", str(out)],
                       check=True, capture_output=True)
        return "data:image/jpeg;base64," + base64.b64encode(out.read_bytes()).decode()


def valid_glb(blob):
    return len(blob) > 20 and blob[:4] == b"glTF" and int.from_bytes(blob[8:12], "little") == len(blob)


def main():
    dry = "--dry-run" in sys.argv
    resubmit = "--resubmit" in sys.argv
    if dry:
        print("endpoint: /multi-image-to-3d")
        print("views:", VIEWS)
        print("request:", json.dumps(REQ))
        print(f"estimated cost: {COST} credits")
        print("request size: %.2f MB" % (sum(len(uri(v)) for v in VIEWS) / 1e6))
        return
    key = load_key()
    st = state()
    rec = st.setdefault("funky", {})
    if rec.get("status") == "SUCCEEDED" and (OUT / "funky.glb").exists():
        print("  funky: already done ->", rec["output"]["file"])
        return
    if rec.get("status") == "REJECTED" and not resubmit:
        raise SystemExit(f"funky: Meshy refused it earlier ({rec.get('error')}); "
                         "change the input then rerun with --resubmit")
    if rec.get("intent") and not rec.get("task_id") and not resubmit:
        raise SystemExit("funky: an earlier submit has no task id - it may or may not have "
                         "been charged. Check the Meshy dashboard, then --resubmit")
    if not rec.get("task_id"):
        body = dict(REQ, image_urls=[uri(v) for v in VIEWS])
        rec.update(intent=time.strftime("%Y-%m-%dT%H:%M:%S"), endpoint="/multi-image-to-3d",
                   views=VIEWS)
        save(st)
        try:
            r = call("/multi-image-to-3d", key, body)
        except Rejected as e:
            rec.pop("intent", None)
            rec.update(status="REJECTED", error=str(e), charged=False)
            save(st)
            raise SystemExit(f"  funky: {e}")
        rec["task_id"] = r.get("result") or r.get("id")
        save(st)
        print(f"  funky: submitted {rec['task_id']}", flush=True)
    t0 = time.time()
    while time.time() - t0 < BUDGET_S:
        s = call(f"/multi-image-to-3d/{rec['task_id']}", key)
        if s.get("status") == "SUCCEEDED":
            with urllib.request.urlopen(s["model_urls"]["glb"], timeout=600) as resp:
                blob = resp.read()
            if not valid_glb(blob):
                raise SystemExit("  funky: downloaded file is not a complete GLB")
            dest = OUT / "funky.glb"
            dest.write_bytes(blob)
            rec.update(status="SUCCEEDED",
                       output={"file": str(dest.relative_to(ROOT)), "bytes": len(blob),
                               "sha256": hashlib.sha256(blob).hexdigest()})
            save(st)
            print(f"  funky: -> {rec['output']['file']} ({len(blob)//1024} KB)", flush=True)
            return
        if s.get("status") in ("FAILED", "CANCELED", "EXPIRED"):
            rec.update(status=s["status"], error=s.get("task_error"))
            save(st)
            raise SystemExit(f"  funky: {s['status']} {s.get('task_error')}")
        print(f"  funky: {s.get('status')} {s.get('progress', 0)}%", flush=True)
        time.sleep(POLL_S)
    raise SystemExit("  funky: still running after %ds - rerun to keep polling" % BUDGET_S)


if __name__ == "__main__":
    main()
