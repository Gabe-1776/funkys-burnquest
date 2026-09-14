"""Meshy models for the three attackers, from Grok Build's plates.

Handoff: test-shots/meshy-isolates/CLAUDE-MESHY.md (2026-09-11). Bird and
alligator ship four angles, so they go through multi-image-to-3d; the snake has
a single plate and goes through image-to-3d.

NOTE ON THE HANDOFF: it says "Game still bakes to JSON (no GLB in the live
viewer)", and RECIPE-3d-pipeline-bakeoff.md says the game cannot load GLB. Both
are stale - ac1ece7 (2026-09-08) added the GLB loader, and cars, logs, Funky and
the portal all render from textured GLBs today. render3d's makeHazardMesh
already asks glbInstance('snake'|'bird'|'gator') first, so a GLB plus a
glb-dims entry swaps the placeholder with no gameplay change. Baking to JSON
would throw away the texture for nothing.

Money safety, as tools/meshy_character_rig.py: the submit intent is written
before every POST and the task id straight after, so a rerun polls instead of
paying twice; a 4xx at submit is recorded REJECTED/charged:false. The key is
never printed.

Usage:
  python3 tools/meshy_hazards.py --dry-run     # requests + cost, spends nothing
  python3 tools/meshy_hazards.py               # run / resume
"""
import base64, hashlib, json, os, pathlib, subprocess, sys, tempfile, time
import urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO = ROOT / "test-shots" / "meshy-isolates"
OUT = ROOT / "test-shots" / "meshy-out" / "hazards"
STATE = OUT / "state.json"
API = "https://api.meshy.ai/openapi/v1"
POLL_S, BUDGET_S = 15, 2400

# Meshy-7 with texture: 30 credits (multi-view or single). Ultra adds 5 and is
# not worth it at the size these render in game (a hazard is ~60px tall).
COMMON = {
    "ai_model": "meshy-7",
    "should_texture": True,
    "texture_resolution": "2k",
    "enable_pbr": False,
    "should_remesh": True,
    "topology": "triangle",
    "target_polycount": 12000,     # they are small on screen; Funky is 30k
    "image_enhancement": False,    # keep the faceted look, no restyle
    "remove_lighting": True,
    "target_formats": ["glb"],
}
JOBS = {
    "bird": {"views": ["shared/bird/03-front.jpg", "shared/bird/04-side.jpg",
                       "shared/bird/05-rear.jpg", "shared/bird/01-34.jpg"]},
    "alligator": {"views": ["shared/alligator/03-front.jpg", "shared/alligator/04-side.jpg",
                            "shared/alligator/05-rear.jpg", "shared/alligator/01-34.jpg"]},
    "snake": {"views": ["shared/01-snake.jpg"]},
    # The new Funky, from the plate set Grok Build marked "locked" - the
    # canonical character now. Four angles, same treatment as the hazards.
    "funky": {"views": ["funkyverse/funky/03-front.jpg", "funkyverse/funky/04-side.jpg",
                        "funkyverse/funky/05-rear.jpg", "funkyverse/funky/01-34.jpg"]},
}
COST = 30


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
    resubmit = sys.argv[sys.argv.index("--resubmit") + 1] if "--resubmit" in sys.argv else None
    if dry:
        for name, job in JOBS.items():
            ep = "/multi-image-to-3d" if len(job["views"]) > 1 else "/image-to-3d"
            print(f"{name:10s} {ep:20s} {len(job['views'])} view(s): {', '.join(job['views'])}")
        print("request:", json.dumps(COMMON))
        print(f"estimated cost: {COST * len(JOBS)} credits ({len(JOBS)} x {COST})")
        for name, job in JOBS.items():
            size = sum(len(uri(v)) for v in job["views"]) / 1e6
            print(f"  {name}: request size %.2f MB" % size)
        return
    key = load_key()
    st = state()
    for name, job in JOBS.items():
        rec = st.setdefault(name, {})
        if rec.get("status") == "SUCCEEDED" and (OUT / f"{name}.glb").exists():
            print(f"  {name}: already done -> {rec['output']['file']}")
            continue
        if rec.get("status") == "REJECTED" and resubmit != name:
            raise SystemExit(f"{name}: Meshy refused it earlier ({rec.get('error')}); "
                             f"change the input then rerun with --resubmit {name}")
        if rec.get("intent") and not rec.get("task_id") and resubmit != name:
            raise SystemExit(f"{name}: an earlier submit has no task id - it may or may not have "
                             f"been charged. Check the Meshy dashboard, then --resubmit {name}")
        multi = len(job["views"]) > 1
        path = "/multi-image-to-3d" if multi else "/image-to-3d"
        if not rec.get("task_id"):
            body = dict(COMMON)
            if multi:
                body["image_urls"] = [uri(v) for v in job["views"]]
            else:
                body["image_url"] = uri(job["views"][0])
            rec.update(intent=time.strftime("%Y-%m-%dT%H:%M:%S"), endpoint=path, views=job["views"])
            save(st)
            try:
                r = call(path, key, body)
            except Rejected as e:
                rec.pop("intent", None)
                rec.update(status="REJECTED", error=str(e), charged=False)
                save(st)
                raise SystemExit(f"  {name}: {e}")
            rec["task_id"] = r.get("result") or r.get("id")
            save(st)
            print(f"  {name}: submitted {rec['task_id']}", flush=True)
        t0 = time.time()
        while time.time() - t0 < BUDGET_S:
            s = call(f"{path}/{rec['task_id']}", key)
            if s.get("status") == "SUCCEEDED":
                with urllib.request.urlopen(s["model_urls"]["glb"], timeout=600) as resp:
                    blob = resp.read()
                if not valid_glb(blob):
                    raise SystemExit(f"  {name}: downloaded file is not a complete GLB")
                dest = OUT / f"{name}.glb"
                dest.write_bytes(blob)
                rec.update(status="SUCCEEDED",
                           output={"file": str(dest.relative_to(ROOT)), "bytes": len(blob),
                                   "sha256": hashlib.sha256(blob).hexdigest()})
                save(st)
                print(f"  {name}: -> {rec['output']['file']} ({len(blob)//1024} KB)", flush=True)
                break
            if s.get("status") in ("FAILED", "CANCELED", "EXPIRED"):
                rec.update(status=s["status"], error=s.get("task_error"))
                save(st)
                raise SystemExit(f"  {name}: {s['status']} {s.get('task_error')}")
            print(f"  {name}: {s.get('status')} {s.get('progress', 0)}%", flush=True)
            time.sleep(POLL_S)
        else:
            raise SystemExit(f"  {name}: still running after {BUDGET_S}s - rerun to keep polling")
    print("DONE", json.dumps({k: v.get("task_id") for k, v in st.items()}))


if __name__ == "__main__":
    main()
