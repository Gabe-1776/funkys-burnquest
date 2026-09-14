#!/usr/bin/env bash
# Meshy image-to-3D → GLB. Never prints the API key.
# Usage:
#   tools/meshy_image_to_3d.sh <image.jpg> <out.glb> [target_polycount]
# Env: MESHY_API_KEY from ~/.openclaw/workspace/.env.meshy
set -euo pipefail
IMG="${1:?image path}"
OUT="${2:?out.glb}"
POLY="${3:-8000}"
ENVF="${MESHY_ENV:-$HOME/.openclaw/workspace/.env.meshy}"
# shellcheck disable=SC1090
set -a; source "$ENVF"; set +a
: "${MESHY_API_KEY:?missing MESHY_API_KEY}"
python3 - "$IMG" "$OUT" "$POLY" <<'PY'
import json, os, sys, time, base64, urllib.request, pathlib
img, out, poly = sys.argv[1], sys.argv[2], int(sys.argv[3])
key = os.environ["MESHY_API_KEY"]
raw = pathlib.Path(img).read_bytes()
mime = "image/jpeg" if img.lower().endswith((".jpg",".jpeg")) else "image/png"
data_uri = "data:%s;base64,%s" % (mime, base64.b64encode(raw).decode())
body = json.dumps({
    "image_url": data_uri,
    "model_type": "smart-topology",
    "ai_model": "meshy-t2",
    "target_polycount": poly,
    "should_texture": True,
}).encode()
req = urllib.request.Request(
    "https://api.meshy.ai/openapi/v1/image-to-3d",
    data=body,
    headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"},
    method="POST",
)
with urllib.request.urlopen(req, timeout=60) as r:
    task = json.load(r)
tid = task.get("result") or task.get("id")
if not tid:
    raise SystemExit("no task id: %s" % task)
print("MESHY_TASK", tid)
status = ""
model_url = None
for i in range(90):
    req = urllib.request.Request(
        "https://api.meshy.ai/openapi/v1/image-to-3d/" + tid,
        headers={"Authorization": "Bearer " + key},
    )
    with urllib.request.urlopen(req, timeout=60) as r:
        st = json.load(r)
    status = st.get("status") or st.get("task_status") or ""
    prog = st.get("progress", "")
    print("poll", i, status, prog)
    if status in ("SUCCEEDED", "SUCCESS", "DONE"):
        model_url = (st.get("model_urls") or {}).get("glb") or st.get("model_url")
        break
    if status in ("FAILED", "CANCELED", "CANCELLED"):
        raise SystemExit("meshy failed: %s" % st)
    time.sleep(8)
if not model_url:
    raise SystemExit("no glb url after polls, last status=%s" % status)
pathlib.Path(out).parent.mkdir(parents=True, exist_ok=True)
urllib.request.urlretrieve(model_url, out)
print("WROTE", out, "bytes", pathlib.Path(out).stat().st_size)
PY
