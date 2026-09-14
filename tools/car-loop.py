#!/usr/bin/env python3
"""One round of the build -> review -> (agent fixes) -> repeat loop.

Round = rebuild the car with a tag, run the fixed reviewer panel, and print a
machine-readable summary: per-reviewer scores, agreement tally, and each
reviewer's #1 ranked defect. The AGENT reads the summary and patches
tools/make_car.py for the next round - the loop is deliberately human(agent)-in
-the-middle so fixes are attributable, one top defect per round.

Usage: python3 tools/car-loop.py <round-tag>   e.g.  python3 tools/car-loop.py r1
"""
import json, re, subprocess, sys, os

ROOT = os.path.expanduser("~/Developer/funkys-burnquest")
TAG = sys.argv[1] if len(sys.argv) > 1 else "r1"
REF = os.path.join(ROOT, "test-shots/pipeline-car/01-meshy-isolate-34.jpg")
RENDER = os.path.join(ROOT, "test-shots/car/render-three-quarter-%s.png" % TAG)
JSON = os.path.join(ROOT, "test-shots/car/loop-%s.json" % TAG)

# 1. build
print(f"--- building {TAG} ---", flush=True)
r = subprocess.run(["/Applications/Blender.app/Contents/MacOS/Blender", "-b", "-t", "4",
                    "--python", os.path.join(ROOT, "tools/make_car.py"), "--", TAG],
                   capture_output=True, text=True, timeout=900)
for line in r.stdout.splitlines():
    if "CARSTATS" in line:
        print(line.strip())

# 2. review with the fixed panel
print(f"--- reviewing {TAG} (glm, astra, haiku) ---", flush=True)
subprocess.run(["python3", os.path.join(ROOT, "tools/vision-review.py"),
                "--ref", REF, "--mine", RENDER,
                "--reviewers", "glm,astra,haiku", "--json", JSON],
               timeout=900)

# 3. summary: scores, agreement, each reviewer's #1 item
d = json.load(open(JSON))
print(f"\n=== LOOP SUMMARY {TAG} ===")
for res in d["results"]:
    txt = res["text"]
    score = re.search(r"([0-9]+(?:\.[0-9])?)\s*/\s*10", txt)
    # first numbered/ranked defect line
    first = ""
    m = re.search(r"(?:^|\n)\s*(?:1[.)]|\*\*1[.)]?|#1)[^\n]{0,160}", txt)
    if m:
        first = m.group(0).strip().replace("\n", " ")[:150]
    print(f"  {res['reviewer']:28s} score={score.group(1) if score else '?':4s} | #1: {first}")
print("  agreement:", json.dumps(d["agreement"]))
