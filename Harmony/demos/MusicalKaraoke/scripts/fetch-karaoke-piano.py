"""Bundle a pinned, unmodified subset of the publicly licensed Salamander samples."""
from pathlib import Path
import hashlib
import json
import urllib.request

COMMIT = "efd8296360f9526e379bfbe5c1698ff54d6a1d34"
BASE = f"https://raw.githubusercontent.com/Tonejs/audio/{COMMIT}/salamander/"
OUT = Path(__file__).resolve().parents[1] / "public/media/karaoke/piano"
OUT.mkdir(parents=True, exist_ok=True)
samples = []
for midi in range(36, 85, 3):
    name = ["C", "Ds", "Fs", "A"][(midi % 12) // 3] + str(midi // 12 - 1)
    filename = name + ".mp3"
    with urllib.request.urlopen(BASE + filename, timeout=30) as response:
        data = response.read()
    if len(data) < 10000 or data.startswith(b"<"):
        raise ValueError(f"Invalid sample: {filename}")
    (OUT / filename).write_bytes(data)
    samples.append({"midi": midi, "src": filename, "bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
with urllib.request.urlopen(BASE + "README", timeout=30) as response:
    (OUT / "SOURCE-README.txt").write_bytes(response.read())
(OUT / "manifest.json").write_text(json.dumps({
    "name": "Salamander Grand Piano", "author": "Alexander Holm",
    "repository": "https://github.com/Tonejs/audio/tree/" + COMMIT + "/salamander",
    "commit": COMMIT, "sourceLicense": "CC BY 3.0",
    "licenseUrl": "https://creativecommons.org/licenses/by/3.0/",
    "authorPublicDomainStatement": "https://rytmenpinne.wordpress.com/sounds-and-such/salamander-grandpiano/",
    "modifications": "Unmodified MP3 subset. Runtime resampling, gain, and release envelope only.",
    "samples": samples
}, indent=2) + "\n")
print(f"Bundled {len(samples)} piano samples, {sum(s['bytes'] for s in samples)/1048576:.2f} MiB")
