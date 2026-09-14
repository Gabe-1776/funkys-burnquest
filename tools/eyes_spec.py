#!/usr/bin/env python3
"""Call Astra (low thinking) as the EYES and return a parsed spec JSON.

Handles the failure modes measured on this task:
  - harness preamble lines before the JSON ("Working...")
  - stray non-numeric tokens inside numbers (seen: "0. nineteenth")
  - trailing commas / // comments
On a parse failure it retries ONCE, feeding the exact error + snippet back to
the model so it regenerates a clean document. Still all-low thinking - the
retry is a repair, not a different configuration.

Usage: eyes_spec.py <out_spec.json> <prompt_file> <image...> [--model M] [--thinking T]

Eyes model defaults to Astra low; any harness model works, e.g.
  --model claude-opus-5  (Anthropic OAuth, no OpenRouter credits needed)
  --model openai-codex/gpt-5.6-luna
"""
import argparse, json, os, re, subprocess, sys

DEFAULT_MODEL = "openai-codex/gpt-6-astra"
DEFAULT_THINK = "low"


def run_eyes(prompt, imgs, extra="", model=DEFAULT_MODEL, think=DEFAULT_THINK):
    args = ["omp", "--model", model, "--thinking", think, "-p", "--no-session",
            "--hide-thinking", "--max-time", "300"]
    args += ["@" + os.path.abspath(p) for p in imgs]
    args.append(prompt + ("\n\n" + extra if extra else ""))
    out = subprocess.run(args, capture_output=True, text=True, timeout=360).stdout
    return out


REQUIRED = ("body_loft", "cabin_loft", "glass_loft", "wheels", "flares", "wing",
            "front", "rear", "flames", "materials")


ALIASES = {
    "body": "body_loft", "cabin": "cabin_loft", "glass": "glass_loft",
    "fenders": "flares", "arches": "flares", "nose": "front", "tail": "rear",
    "hood": None, "skirts": None, "side_skirt": None, "sideSkirt": None,
    "mirrors": None, "ride_height": None, "stance": None, "schema": None,
    "units": None, "proportions": None, "lights": None,
}
DEFAULT_MATERIALS = {"body": [0.46, 0.003, 0.19], "flame_o": [1, 0.31, 0.008],
                     "flame_p": [0.43, 0.004, 0.16], "glass": [0.045, 0.004, 0.062],
                     "chrome": [0.73, 0.77, 0.83], "tyre": [0.012, 0.01, 0.015],
                     "cyan": [0.008, 0.64, 0.85], "tail": [0.85, 0.004, 0.035]}


def normalize(spec):
    """Accept semantically-equivalent output (measured: Opus renames keys and
    emits {x,w,z0,z1} dict rows). The EYES is being judged on its numbers, not
    on its ability to resist annotating JSON."""
    out = {}
    for k, v in spec.items():
        key = ALIASES.get(k, k)
        if key:
            out.setdefault(key, v)
    for loft in ("body_loft", "cabin_loft", "glass_loft"):
        rows = out.get(loft)
        if isinstance(rows, list):
            fixed = []
            for r in rows:
                if isinstance(r, dict):
                    w = r.get("w", r.get("halfWidth", r.get("width")))
                    z0 = r.get("z0", r.get("floorZ", r.get("bottomZ")))
                    z1 = r.get("z1", r.get("beltlineZ", r.get("topZ", r.get("z1"))))
                    fixed.append([r.get("x"), w, z0, z1])
                else:
                    fixed.append(r)
            out[loft] = fixed
    out.setdefault("flames", [])
    out.setdefault("materials", DEFAULT_MATERIALS)
    return out


def validate(spec):
    """The contract is fixed - keys AND value shapes. A model that renames keys
    or emits dict rows instead of arrays is not usable as eyes."""
    missing = [k for k in REQUIRED if k not in spec]
    if missing:
        raise ValueError("missing required keys: %s (got: %s)" % (", ".join(missing), ", ".join(list(spec)[:12])))
    for loft in ("body_loft", "cabin_loft", "glass_loft"):
        rows = spec[loft]
        if not isinstance(rows, list) or not rows:
            raise ValueError(f"{loft} must be a non-empty array of [x,w,z0,z1] rows")
        bad = [r for r in rows if not (isinstance(r, list) and len(r) == 4)]
        if bad:
            raise ValueError(f"{loft} rows must be 4-number ARRAYS like [-0.5,0.199,0.079,0.124]; got e.g. {json.dumps(bad[0])[:90]}")
    w = spec["wing"]
    if w:
        for k in ("pylon_x", "pylon_h", "pylon_w", "main", "upper", "endplate"):
            if k not in w:
                raise ValueError(f"wing.{k} missing")
    for k in ("x_front", "x_rear", "radius", "width", "dish_depth", "spokes"):
        if k not in spec["wheels"]:
            raise ValueError(f"wheels.{k} missing")
    return spec


def extract(txt):
    s = txt.find("{")
    e = txt.rfind("}") + 1
    if s < 0 or e <= s:
        raise ValueError("no JSON object found in eyes output")
    raw = txt[s:e]
    raw = re.sub(r"//[^\n]*", "", raw)
    raw = re.sub(r",\s*([}\]])", r"\1", raw)
    return raw, json.loads(raw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("out_spec")
    ap.add_argument("prompt_file")
    ap.add_argument("images", nargs="+")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--thinking", default=DEFAULT_THINK)
    a = ap.parse_args()
    out_path, prompt_file, imgs = a.out_spec, a.prompt_file, a.images
    prompt = open(prompt_file).read()

    txt = run_eyes(prompt, imgs, model=a.model, think=a.thinking)
    try:
        raw, spec = extract(txt)
        spec = normalize(spec)
    except Exception as err:
        snippet = ""
        m = re.search(r"char (\d+)", str(err))
        if m:
            i = int(m.group(1))
            snippet = txt[max(0, i - 40):i + 40]
        print(f"  [repair] first JSON invalid ({err}); retrying with feedback")
        txt = run_eyes(prompt, imgs, model=a.model, think=a.thinking,
                       extra=f"YOUR PREVIOUS OUTPUT FAILED TO PARSE: {err}\n"
                       f"Offending region: ...{snippet}...\n"
                       f"Output ONLY valid minified JSON this time - every number must be a "
                       f"plain decimal like 0.19, never a word.")
        raw, spec = extract(txt)

    try:
        validate(spec)
    except Exception as err:
        print(f"  [repair] schema invalid ({err}); retrying with feedback")
        txt = run_eyes(prompt, imgs, model=a.model, think=a.thinking,
                       extra=f"YOUR PREVIOUS OUTPUT USED THE WRONG SCHEMA: {err}\n"
                             f"Re-output using EXACTLY the keys in the prompt's JSON skeleton, "
                             f"no renames, no nesting changes, minified single line.")
        raw, spec = extract(txt)
        spec = normalize(spec)
        try:
            validate(spec)
        except Exception as err2:
            print(f"  FATAL: eyes model cannot hold the contract after a repair retry: {err2}")
            return 3

    score = spec.pop("score", None)
    with open(out_path, "w") as f:
        json.dump(spec, f, indent=1)
    print(f"  spec parsed -> {out_path}" +
          (f" | eyes scored previous render {score}/10" if score is not None else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
