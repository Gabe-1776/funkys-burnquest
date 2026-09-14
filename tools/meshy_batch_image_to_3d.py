#!/usr/bin/env python3
"""Batch Meshy image-to-3D for funkys-burnquest isolates.

Feeds every 01-*.jpg under test-shots/meshy-isolates/<theme>/ to Meshy with the
same recipe as tools/meshy_image_to_3d.sh (smart-topology, textured, 8k polys),
writing GLBs to test-shots/meshy-out/<theme>/<prop>.glb.

Resumable: test-shots/meshy-out/meshy_state.json tracks submitted task ids, so a
rerun never double-submits. Completed GLBs are skipped. 00-theme-still.png and
anything not matching 01-*.jpg is never sent. Never prints the API key.

Usage: python3 tools/meshy_batch_image_to_3d.py [target_polycount=8000]
"""
import base64
import json
import os
import pathlib
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parents[1]
ISO = ROOT / "test-shots" / "meshy-isolates"
OUT = ROOT / "test-shots" / "meshy-out"
STATE = OUT / "meshy_state.json"
POLL_BUDGET_S = 3000  # stay under the 3600s job cap; rerun resumes
API = "https://api.meshy.ai/openapi/v1/image-to-3d"


def load_key():
    key = os.environ.get("MESHY_API_KEY")
    if key:
        return key
    envf = pathlib.Path(os.environ.get("MESHY_ENV", "~/.openclaw/workspace/.env.meshy")).expanduser()
    for line in envf.read_text().splitlines():
        if line.startswith("MESHY_API_KEY="):
            return line.split("=", 1)[1].strip().strip('"').strip("'")
    raise SystemExit("no MESHY_API_KEY found")


def request(url, key, body=None, tries=3):
    for attempt in range(tries):
        try:
            req = urllib.request.Request(
                url,
                data=json.dumps(body).encode() if body is not None else None,
                headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"} if body is not None
                else {"Authorization": "Bearer " + key},
            )
            with urllib.request.urlopen(req, timeout=60) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            if e.code in (429, 500, 502, 503) and attempt < tries - 1:
                time.sleep(15 * (attempt + 1))
                continue
            raise
        except (urllib.error.URLError, TimeoutError):
            if attempt < tries - 1:
                time.sleep(10)
                continue
            raise


def main():
    poly = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    key = load_key()
    OUT.mkdir(parents=True, exist_ok=True)
    state = {"tasks": {}}
    if STATE.exists():
        state = json.loads(STATE.read_text())
    tasks = state.setdefault("tasks", {})

    def tkey(theme, prop):
        return f"{theme}/{prop}"

    # 1. Inventory only. Meshy caps concurrent tasks (~10 on this plan), so
    #    submissions happen in waves inside the main loop as slots free up.
    #    State persists after every submit, so a rerun never double-submits.
    queue, pending, skipped = [], [], 0
    for theme_dir in sorted(p for p in ISO.iterdir() if p.is_dir()):
        theme = theme_dir.name
        for img in sorted(theme_dir.glob("01-*.jpg")):
            prop = img.stem[3:]  # strip "01-"
            out_glb = OUT / theme / f"{prop}.glb"
            k = tkey(theme, prop)
            if out_glb.exists():
                skipped += 1
                continue
            rec = tasks.get(k)
            if rec:
                pending.append((k, rec, out_glb))
            else:
                queue.append((k, img, out_glb))

    # 2. Submit in waves + poll until done, budget-capped.
    started = time.time()
    failures = []
    completed_now = []
    while (queue or pending) and time.time() - started < POLL_BUDGET_S:
        while queue:
            k, img, out_glb = queue[0]
            raw = img.read_bytes()
            data_uri = "data:image/jpeg;base64," + base64.b64encode(raw).decode()
            try:
                resp = request(API, key, body={
                    "image_url": data_uri,
                    "model_type": "smart-topology",
                    "ai_model": "meshy-t2",
                    "target_polycount": poly,
                    "should_texture": True,
                }, tries=1)
            except urllib.error.HTTPError as e:
                if e.code == 429:
                    print(f"RATE-LIMITED {k}: deferring, {len(pending)} in flight", flush=True)
                    break
                raise
            tid = resp.get("result") or resp.get("id")
            if not tid:
                print(f"SUBMIT-FAIL {k}: {resp}", flush=True)
                failures.append((k, "submit rejected"))
                queue.pop(0)
                continue
            rec = tasks[k] = {"id": tid, "status": "SUBMITTED", "poly": poly}
            STATE.write_text(json.dumps(state, indent=2))
            print(f"SUBMITTED {k} -> {tid}", flush=True)
            pending.append((k, rec, out_glb))
            queue.pop(0)
        still = []
        for k, rec, out_glb in pending:
            try:
                st = request(f"{API}/{rec['id']}", key)
            except Exception as e:  # transient network error: keep for next cycle
                print(f"POLL-ERR {k}: {e}", flush=True)
                still.append((k, rec, out_glb))
                continue
            status = st.get("status") or st.get("task_status") or ""
            rec["status"] = status
            if status in ("SUCCEEDED", "SUCCESS", "DONE"):
                url = (st.get("model_urls") or {}).get("glb") or st.get("model_url")
                if not url:
                    rec["status"] = "FAILED"
                    failures.append((k, "no glb url"))
                    print(f"FAILED {k}: no glb url", flush=True)
                    continue
                out_glb.parent.mkdir(parents=True, exist_ok=True)
                urllib.request.urlretrieve(url, out_glb)
                rec["bytes"] = out_glb.stat().st_size
                completed_now.append(k)
                print(f"DONE {k} -> {out_glb} ({rec['bytes']} bytes)", flush=True)
            elif status in ("FAILED", "CANCELED", "CANCELLED"):
                failures.append((k, status))
                print(f"FAILED {k}: {status}", flush=True)
            else:
                still.append((k, rec, out_glb))
        pending = still
        STATE.write_text(json.dumps(state, indent=2))
        if queue or pending:
            time.sleep(10)

    summary = {
        "poly": poly,
        "skipped_existing": skipped,
        "completed_this_run": completed_now,
        "pending": [k for k, _, _ in pending],
        "failed": failures,
        "state_file": str(STATE),
    }
    completed = [
        {"prop": k, "file": str(OUT / f"{k}.glb"), **({"bytes": r["bytes"]} if "bytes" in r else {})}
        for k, r in sorted(tasks.items()) if r.get("status") in ("SUCCEEDED", "SUCCESS", "DONE")
    ]
    summary["completed_all"] = completed
    print("SUMMARY " + json.dumps(summary), flush=True)
    STATE.write_text(json.dumps(state, indent=2))


if __name__ == "__main__":
    main()
