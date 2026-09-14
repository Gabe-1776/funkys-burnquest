#!/usr/bin/env python3
"""Funky, rigged and animated through Meshy - the pipeline from Gabriel's X
bookmarks (0xRishi, 2026-09-06): reference images -> Meshy multi-view model ->
Meshy auto-rig -> preset animation clips -> three.js AnimationMixer.

Why: the shipped Funky is one unrigged bake, so no amount of vertex deform
(char-motion.js) can swing an arm or a leg. A skeleton can.

Inputs are Grok Build's concept-4 reference set (test-shots/character/, see its
README): front, side, back and three-quarter views of the voxel frog. They are
all the same idle pose, so they are submitted together as one multi-view job,
and Meshy is asked for an A-pose, which is what auto-rig wants.

Stages, each resumable (state in OUT/state.json):
  model  POST /multi-image-to-3d   meshy-7 + ultra + texture   35 credits
  rig    POST /rigging             (input_task_id = model)      5 credits
  anims  POST /animations          one per ACTION               3 credits each

Money safety, per ~/knowledge/game-dev/ASSET-PIPELINE.md:
  - the submit INTENT is written before every POST and the task id right
    after, so a rerun polls the known task instead of paying for it twice;
  - an intent with no task id is an ambiguous submit (the POST may or may not
    have landed). That stops the run; pass --resubmit <stage> to override.
  - never prints the API key.

Usage:
  python3 tools/meshy_character_rig.py --dry-run   # request + cost, no spend
  python3 tools/meshy_character_rig.py             # run / resume all stages
"""
import base64, hashlib, json, os, pathlib, subprocess, sys, tempfile, time
import urllib.error, urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
REF = ROOT / "test-shots" / "character"
OUT = ROOT / "test-shots" / "meshy-out" / "funkyverse" / "funky-rig"
STATE = OUT / "state.json"
API = "https://api.meshy.ai/openapi/v1"
VIEWS = ["funky-c4-front.png", "funky-c4-side.png", "funky-c4-back.png",
         "funky-c4-threequarter.png"]
# Preset ids from GET /animations/library (free), 2026-09-11.
ACTIONS = {
    466: "jump",        # Regular Jump - scrubbed across each 200ms hop
    417: "hop",         # Hop with Arms Raised - alternative hop
    0:   "idle",        # Idle
    591: "dance",       # Hip Hop Dance - the portal celebration
}
COST = {"model": 35, "rig": 5, "anim": 3}
POLL_S, BUDGET_S = 15, 3600

MODEL_REQ = {
    "ai_model": "meshy-7",
    "ultra_mode": True,            # Gabriel: "meshy high quality"
    "should_texture": True,
    "texture_resolution": "4k",    # same 30-credit tier as 2k on meshy-7
    "enable_pbr": False,           # the game lights albedo; PBR maps unused
    "should_remesh": True,         # a phone must draw it: 30k, not 300k+
    "topology": "triangle",
    "target_polycount": 30000,
    "pose_mode": "a-pose",         # what auto-rig expects
    "image_enhancement": False,    # keep the exact voxel look, no restyle
    "remove_lighting": True,
    "target_formats": ["glb"],
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


class Rejected(Exception):
    """Meshy answered a submit with 4xx: no task was created, nothing charged."""


def call(path, key, body=None):
    req = urllib.request.Request(
        API + path, data=json.dumps(body).encode() if body is not None else None,
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        msg = f"HTTP {e.code} on {path}: {e.read().decode()[:400]}"
        if body is not None and 400 <= e.code < 500:
            raise Rejected(msg)
        raise SystemExit(msg)


def load_state():
    return json.loads(STATE.read_text()) if STATE.exists() else {}


def save_state(st):
    OUT.mkdir(parents=True, exist_ok=True)
    tmp = STATE.with_suffix(".tmp")
    tmp.write_text(json.dumps(st, indent=2))
    tmp.replace(STATE)


def jpeg_uri(png):
    # 1024px JPEG keeps the request ~4x smaller than raw PNG data URIs.
    with tempfile.TemporaryDirectory() as td:
        out = pathlib.Path(td) / "v.jpg"
        subprocess.run(["sips", "-s", "format", "jpeg", "-s", "formatOptions", "92",
                        "-Z", "1024", str(png), "--out", str(out)],
                       check=True, capture_output=True)
        return "data:image/jpeg;base64," + base64.b64encode(out.read_bytes()).decode()


def valid_glb(blob):
    return len(blob) > 20 and blob[:4] == b"glTF" and \
        int.from_bytes(blob[8:12], "little") == len(blob)


def fetch(url, dest):
    with urllib.request.urlopen(url, timeout=600) as r:
        blob = r.read()
    if not valid_glb(blob):
        raise SystemExit(f"downloaded file is not a complete GLB: {dest.name}")
    dest.write_bytes(blob)
    return {"file": str(dest.relative_to(ROOT)), "bytes": len(blob),
            "sha256": hashlib.sha256(blob).hexdigest()}


def run_stage(st, name, path, body, key, resubmit):
    """Submit once, then poll. Returns the finished task JSON."""
    rec = st.setdefault(name, {})
    if rec.get("status") == "REJECTED" and resubmit != name:
        raise SystemExit(f"{name}: Meshy refused this request earlier ({rec.get('error')}); "
                         f"change the input, then rerun with --resubmit {name}.")
    if rec.get("intent") and not rec.get("task_id") and resubmit != name:
        raise SystemExit(f"{name}: an earlier submit has no recorded task id - it may "
                         f"or may not have been charged. Check the Meshy dashboard, "
                         f"then rerun with --resubmit {name}.")
    if not rec.get("task_id"):
        rec.update(intent=time.strftime("%Y-%m-%dT%H:%M:%S"), endpoint=path)
        save_state(st)
        try:
            r = call(path, key, body)
        except Rejected as e:
            # A definite refusal, not an ambiguous submit: record it so a rerun
            # is not blocked by the "may have been charged" guard. 2026-09-11:
            # /rigging answered 422 "Pose estimation failed" for voxel Funky.
            rec.pop("intent", None)
            rec.update(status="REJECTED", error=str(e), charged=False)
            save_state(st)
            raise SystemExit(f"  {name}: {e}")
        rec["task_id"] = r.get("result") or r.get("id")
        save_state(st)
        print(f"  {name}: submitted {rec['task_id']}", flush=True)
    t0 = time.time()
    while time.time() - t0 < BUDGET_S:
        s = call(f"{path}/{rec['task_id']}", key)
        status = s.get("status")
        if status == "SUCCEEDED":
            rec["status"] = status
            save_state(st)
            return s
        if status in ("FAILED", "CANCELED", "EXPIRED"):
            rec["status"] = status
            rec["error"] = s.get("task_error")
            save_state(st)
            raise SystemExit(f"  {name}: {status} {s.get('task_error')}")
        print(f"  {name}: {status} {s.get('progress', 0)}%", flush=True)
        time.sleep(POLL_S)
    raise SystemExit(f"  {name}: still running after {BUDGET_S}s - rerun to keep polling")


def main():
    args = sys.argv[1:]
    dry = "--dry-run" in args
    resubmit = args[args.index("--resubmit") + 1] if "--resubmit" in args else None
    missing = [v for v in VIEWS if not (REF / v).exists()]
    if missing:
        raise SystemExit(f"missing reference views: {missing}")
    total = COST["model"] + COST["rig"] + COST["anim"] * len(ACTIONS)
    if dry:
        print("model request:", json.dumps(MODEL_REQ))
        print("views:", VIEWS)
        print("actions:", ACTIONS)
        print(f"estimated cost: {total} credits "
              f"(model {COST['model']} + rig {COST['rig']} + {len(ACTIONS)} x {COST['anim']})")
        uris = [jpeg_uri(REF / v) for v in VIEWS]
        print("request size: %.2f MB" % (sum(len(u) for u in uris) / 1e6))
        return
    key = load_key()
    st = load_state()

    # --- model -------------------------------------------------------------
    if st.get("model", {}).get("status") != "SUCCEEDED" or not (OUT / "model.glb").exists():
        body = dict(MODEL_REQ, image_urls=[jpeg_uri(REF / v) for v in VIEWS])
        s = run_stage(st, "model", "/multi-image-to-3d", body, key, resubmit)
        st["model"]["output"] = fetch(s["model_urls"]["glb"], OUT / "model.glb")
        save_state(st)
        print("  model: ->", st["model"]["output"]["file"], flush=True)

    # --- rig ---------------------------------------------------------------
    if st.get("rig", {}).get("status") != "SUCCEEDED" or not (OUT / "rigged.glb").exists():
        s = run_stage(st, "rig", "/rigging",
                      {"input_task_id": st["model"]["task_id"], "height_meters": 1.4},
                      key, resubmit)
        res = s.get("result") or {}
        st["rig"]["output"] = fetch(res["rigged_character_glb_url"], OUT / "rigged.glb")
        basic = res.get("basic_animations") or {}
        for kind in ("walking", "running"):
            u = basic.get(f"{kind}_glb_url")
            if u:
                st["rig"][kind] = fetch(u, OUT / f"anim-{kind}.glb")
        save_state(st)
        print("  rig: ->", st["rig"]["output"]["file"], flush=True)

    # --- animations --------------------------------------------------------
    for aid, label in ACTIONS.items():
        stage = f"anim-{label}"
        if st.get(stage, {}).get("status") == "SUCCEEDED" and (OUT / f"{stage}.glb").exists():
            continue
        s = run_stage(st, stage, "/animations",
                      {"rig_task_id": st["rig"]["task_id"], "action_id": aid},
                      key, resubmit)
        res = s.get("result") or {}
        st[stage]["output"] = fetch(res["animation_glb_url"], OUT / f"{stage}.glb")
        save_state(st)
        print(f"  {stage}: ->", st[stage]["output"]["file"], flush=True)

    print("DONE", json.dumps({k: v.get("task_id") for k, v in st.items()}), flush=True)


if __name__ == "__main__":
    main()
