#!/usr/bin/env python3
"""Generate funkys-burnquest game audio with Google Lyria 3 Pro via OpenRouter.

Essence (measured 2026-09-06 via gpt-audio + flux analysis of the original
tatamusic chiptune): ~120 BPM square/pulse NES-style chiptune, saw/square bass,
noise percussion, bright major, bouncy loopable motif. This generates a
RELAXED version (96 BPM, regular unhurried groove) plus the arcade SFX set.

Usage: python3 tools/gen_lyria_audio.py music|sfx|all
Output: assets/audio/lyria/<slug>_v1.mp3 (raw), never overwrites existing
files. Normalize with tools/normalize_audio.sh afterwards.
"""
import base64
import json
import os
import sys
import urllib.error
import urllib.request

KEY = open(os.path.expanduser("~/.openrouter-funded-key")).read().strip()
API = "https://openrouter.ai/api/v1/chat/completions"
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "assets", "audio", "lyria")
os.makedirs(OUT, exist_ok=True)

MUSIC_PROMPT = """Create an instrumental video game music loop for a cheerful, relaxed arcade
game (a Frogger-style crossing game). NO vocals, no words, no singing, no human
voices — pure instrumental chiptune.

Tempo: 96 BPM — a relaxed, REGULAR, unhurried steady groove. Deliberately
calmer than typical arcade music; players hear it for many minutes, so it must
never feel frantic or rushed.

Key: C major, bright and playful. Instrumentation: NES-style square-wave lead
playing a catchy 8-note melodic motif with small variations; a pulse-wave
harmony layer; a low buzzing square bass walking gently; noise-channel hats
and clicks; a soft triangle-wave kick. Classic chip timbre only — simple
waveforms, staccato notes, short decays, NO modern synth pads, NO real drums,
NO guitars.

Structure: one seamless ~16-bar loop of about 75-85 seconds whose end leads
cleanly back into its start (intro hook returns to the A motif). Bouncy and
cheerful but laid-back — medium-low energy throughout.

IMPORTANT: instrumental chiptune only. No existing songs, no artists, no
samples. Loop-friendly by construction."""

SFX_PROMPTS = {
    "hop": "Produce ONE isolated retro 8-bit arcade game sound effect: a single quick \"hop\" jump blip — one short rising square-wave chirp with a tiny click at the start, total duration about 0.15-0.25 seconds, playful, clean and dry. Output ONLY this one tiny effect and nothing else — no music, no melody, no other sounds, silence before and after.",
    "collect": "Produce ONE isolated cheerful 8-bit arcade \"collect point\" sound effect: four quick ascending bright square-wave notes in a major arpeggio with a little sparkle on top, total duration about 0.6-1.0 seconds, happy and clean. Output ONLY this one effect — no music, no other sounds, silence around it.",
    "success": "Produce ONE isolated triumphant 8-bit arcade \"level complete\" fanfare sound effect: a bright six-note ascending major jingle ending on a held high note with a shimmer, total duration about 1.5-2.0 seconds, joyful but not bombastic. Output ONLY this one effect — no music, no other sounds, silence around it.",
    "hit": "Produce ONE isolated 8-bit arcade \"hit / splat / lose a life\" sound effect: a short comical descending two-tone buzz (like a sad wah-wah), total duration about 0.8-1.2 seconds, dry and clear. Output ONLY this one effect — no music, no other sounds, silence around it.",
    "gameover": "Produce ONE isolated classic arcade \"game over\" sound effect: four descending minor notes in a gentle sad chiptune phrase ending with a low soft thud, total duration about 2-3 seconds. Output ONLY this one effect — no music, no other sounds, silence around it.",
}


def generate(prompt, slug, budget_s=600):
    out = os.path.join(OUT, slug + "_v1.mp3")
    if os.path.exists(out):
        print("SKIP (exists)", slug)
        return out
    body = {
        "model": "google/lyria-3-pro-preview",
        "modalities": ["text", "audio"],
        "audio": {"format": "mp3"},
        "stream": True,
        "messages": [{"role": "user", "content": prompt}],
    }
    req = urllib.request.Request(
        API,
        data=json.dumps(body).encode(),
        headers={"Authorization": "Bearer " + KEY, "Content-Type": "application/json"},
    )
    chunks, text = [], []
    with urllib.request.urlopen(req, timeout=budget_s) as r:
        for raw in r:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                break
            ev = json.loads(data)
            if ev.get("error"):
                print("ERR", slug, ev["error"], flush=True)
                continue
            delta = ((ev.get("choices") or [{}])[0].get("delta") or {} if ev.get("choices") else {})
            if isinstance(delta, dict):
                if delta.get("content"):
                    text.append(delta["content"])
                a = delta.get("audio")
                if isinstance(a, dict) and a.get("data"):
                    chunks.append(a["data"])
    raw_audio = b"".join(base64.b64decode(c) for c in chunks if c)
    if not raw_audio:
        raise RuntimeError("no audio for %s; text=%s" % (slug, "".join(text)[:300]))
    open(out, "wb").write(raw_audio)
    print("WROTE", slug, len(raw_audio), "bytes | model-note:", "".join(text)[:200], flush=True)
    return out


def main():
    job = sys.argv[1] if len(sys.argv) > 1 else "all"
    if job in ("music", "all"):
        generate(MUSIC_PROMPT, "burnquest-loop")
    if job in ("sfx", "all"):
        for slug, prompt in SFX_PROMPTS.items():
            generate(prompt, "sfx-" + slug)
    print("DONE")


if __name__ == "__main__":
    main()
