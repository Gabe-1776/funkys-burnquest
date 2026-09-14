#!/usr/bin/env python3
"""Multi-model vision review for Blender/3D asset iteration.

Why this exists: the working seat may have no vision, and a single reviewer's
score is noisy (measured 2026-09-09: five reviewers scored the same render
3, 4, 5, 5, 6). The reliable signal is AGREEMENT - what independent models
independently name as the top defect. This tool asks several vision models the
same question about the same images and tallies which defect areas they agree
on, so the fix list is evidence-ranked rather than one model's opinion.

Reviewer pick (measured 2026-09-09):
  glm      z-ai/glm-5.3-flash        most structured/specific, ~13-31 s
  haiku    anthropic/claude-haiku-4.5  nearly as good, ~4 s, best value
  opus     anthropic/claude-opus-5   sharpest single critique, ~15 s, premium $
  deepseek deepseek-v4.1-flash beta  control (this seat's own model)
  NOTE: openai/gpt-6-astra is NOT callable from the vulcan profile without
  `omp /login` (no OpenAI key in the harness agent.db) - verified 2026-09-09.
  deepseek-v4-flash-vision-exp returns reasoning-only (empty content).

Usage:
  python3 tools/vision-review.py --ref REF.png --mine MINE.png \
      [--question "..."] [--reviewers glm,haiku] [--json out.json]
"""
import argparse, base64, io, json, os, re, sys, time, urllib.request
from PIL import Image

OR_KEY = os.path.expanduser("~/.openrouter-funded-key")
DEEPSEEK_ENV = os.path.expanduser("~/.pi/pi.env")

REVIEWERS = {
    "glm":    ("z-ai/glm-5.3-flash", "openrouter"),
    "haiku":  ("anthropic/claude-haiku-4.5", "openrouter"),
    "gemini": ("google/gemini-3.5-flash", "openrouter"),
    "nova":   ("amazon/nova-pro-v1", "openrouter"),
    "ernie":  ("baidu/ernie-4.5-vl-424b-a47b", "openrouter"),
    "deepseek": ("deepseek-v4.1-flash-expires-on-0910", "deepseek"),
    # premium reviewer: sharpest critiques measured, ~15s, real money per call
    "opus":   ("anthropic/claude-opus-5", "openrouter"),
    # GPT family via the harness (openai-codex OAuth in the default profile).
    # NOTE the provider prefix: openai-codex/gpt-6-astra, NOT openai/gpt-6-astra
    # (the latter has no key and errors). thinking is pinned low for speed.
    "astra":  ("openai-codex/gpt-6-astra", "omp"),
    "luna":   ("openai-codex/gpt-5.6-luna", "omp"),
}

# defect areas we tally for agreement (regex, label)
AREAS = [
    (r"headlight|light housing|pop-?up|lamp", "headlights"),
    (r"wing|spoiler|aerofoil|rear deck", "wing"),
    (r"wheel|rim|spoke|dish|tyre|tire", "wheels"),
    (r"flame|livery|decal|graphic", "livery"),
    (r"silhouette|roofline|roof|cabin|windshield|wedge|proportion", "silhouette"),
    (r"fender|flare|arch|overfender", "fenders"),
    (r"hood|bonnet|panel|crease|bumper|fascia|splitter", "front/panels"),
    (r"stance|ride height|rake|profil", "stance"),
]

DEFAULT_Q = ("Image 1 = reference design. Image 2 = my Blender model of it. "
             "Score my model 1-10 for match. Then list the top 3 mismatches ranked by visual "
             "impact, each with one concrete fix. Be blunt, specific, max 140 words.")


def b64(path, width=560):
    im = Image.open(path).convert("RGB")
    im.thumbnail((width, width))
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=82)
    return base64.b64encode(buf.getvalue()).decode()


def deepseek_key():
    for line in open(DEEPSEEK_ENV):
        if line.startswith("DEEPSEEK_API_KEY="):
            return line.split("=", 1)[1].strip()
    return ""


def call_omp(model, img_paths, question, timeout):
    """GPT-family review through the harness (needs openai-codex OAuth)."""
    import subprocess
    args = ["omp", "--model", model, "--thinking", "low", "-p", "--no-session",
            "--hide-thinking", "--max-time", str(int(timeout))]
    args += ["@" + p for p in img_paths]
    args.append(question)
    t0 = time.time()
    out = subprocess.run(args, capture_output=True, text=True, timeout=timeout + 30).stdout
    # strip the harness preamble lines
    lines = [l for l in out.splitlines() if not l.startswith("Working...")]
    return {"reviewer": model, "model": model, "seconds": round(time.time() - t0, 1),
            "tokens": 0, "text": "\n".join(lines).strip()}


def call(reviewer, imgs_b64, question, max_tokens=900, timeout=180):
    model, provider = REVIEWERS[reviewer]
    if provider == "omp":
        return call_omp(model, [IMGS[0], IMGS[1]], question, timeout)
    if provider == "openrouter":
        url = "https://openrouter.ai/api/v1/chat/completions"
        key = open(OR_KEY).read().strip()
    else:
        url = "https://api.deepseek.com/chat/completions"
        key = deepseek_key()
    content = [{"type": "image_url", "image_url": {"url": "data:image/jpeg;base64," + b}}
               for b in imgs_b64]
    content.append({"type": "text", "text": question})
    body = {"model": model, "messages": [{"role": "user", "content": content}],
            "max_tokens": max_tokens}
    if provider == "deepseek":
        body["thinking"] = {"type": "disabled"}
    req = urllib.request.Request(url, data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + key, "Content-Type": "application/json"})
    t0 = time.time()
    d = json.load(urllib.request.urlopen(req, timeout=timeout))
    dt = time.time() - t0
    msg = d["choices"][0]["message"]
    txt = (msg.get("content") or "").strip()
    if not txt:  # reasoning-only responses (GLM/others) - keep it visible
        txt = "[reasoning-only] " + (msg.get("reasoning_content") or msg.get("reasoning") or "")[:1200]
    return {"reviewer": reviewer, "model": model, "seconds": round(dt, 1),
            "tokens": d.get("usage", {}).get("total_tokens", 0), "text": txt}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--ref", required=True)
    ap.add_argument("--mine", required=True)
    ap.add_argument("--question", default=DEFAULT_Q)
    ap.add_argument("--reviewers", default="glm,haiku,deepseek")
    ap.add_argument("--repeat", type=int, default=1,
                    help="samples per reviewer; single samples are unstable "
                         "(measured: same model+image, two runs, different #1 defect)")
    ap.add_argument("--json", default="")
    args = ap.parse_args()

    global IMGS
    IMGS = [args.ref, args.mine]
    imgs = [b64(args.ref), b64(args.mine)]
    names = [r.strip() for r in args.reviewers.split(",") if r.strip()]
    results = []
    for name in names:
        if name not in REVIEWERS:
            print(f"[skip] unknown reviewer {name}", file=sys.stderr)
            continue
        for sample in range(args.repeat):
            try:
                r = call(name, imgs, args.question)
                r["sample"] = sample
                results.append(r)
                tag = f" sample {sample + 1}/{args.repeat}" if args.repeat > 1 else ""
                print(f"\n===== {r['reviewer']} ({r['model']}){tag}  {r['seconds']}s, {r['tokens']} tok =====")
                print(r["text"][:1400])
            except Exception as e:
                print(f"\n===== {name}  FAILED: {str(e)[:160]}")

    # agreement tally: how many reviewers independently named each defect area
    tally = {}
    for r in results:
        low = r["text"].lower()
        for pat, label in AREAS:
            if re.search(pat, low):
                tally[label] = tally.get(label, 0) + 1
    ranked = sorted(tally.items(), key=lambda kv: -kv[1])
    total = len(results)
    print(f"\n--- AGREEMENT ({total} judgments) ---")
    for label, n in ranked:
        print(f"  {n}/{total}  ({100 * n // max(total, 1)}%)  {label}")
    stable = [l for l, n in ranked if n * 2 >= total]      # named by >=50%
    print(f"\nSTABLE SET (>=50% of judgments): {', '.join(stable) if stable else 'none'}")
    if args.json:
        with open(args.json, "w") as f:
            json.dump({"results": results, "agreement": tally}, f, indent=1)
        print(f"\nsaved {args.json}")


if __name__ == "__main__":
    main()
