"""Independent output-signal checks for audio exported by the browser QA page.

Run with /opt/anaconda3/bin/python validation/check_wav.py file.wav ...
These measurements check signal integrity, not musical preference.
"""
import argparse
import json
from pathlib import Path

import numpy as np
from scipy.io import wavfile


def inspect(path):
    rate, raw = wavfile.read(path)
    if np.issubdtype(raw.dtype, np.integer):
        info = np.iinfo(raw.dtype)
        if raw.dtype == np.uint8:
            data = (raw.astype(float) - 128) / 128
        else:
            data = raw.astype(float) / (max(abs(info.min), info.max))
    else:
        data = raw.astype(float)
    if data.ndim == 1:
        data = data[:, None]
    finite = bool(np.isfinite(data).all())
    safe = np.nan_to_num(data)
    peak = float(np.max(np.abs(safe), initial=0))
    rms = float(np.sqrt(np.mean(safe**2))) if safe.size else 0
    db = lambda value: round(float(20 * np.log10(max(value, 1e-12))), 3)
    mono_energy = np.mean(safe**2, axis=1)
    block = max(1, round(rate * .1))
    envelope = np.array([np.sqrt(np.mean(mono_energy[i:i + block])) for i in range(0, len(safe), block)])
    active = np.flatnonzero(envelope > .001)
    body = envelope[active[0]:active[-1] + 1] if active.size else np.array([])
    tail_frames = min(len(safe), rate // 2)
    tail = safe[-tail_frames:] if tail_frames else np.zeros(1)
    return {
        "file": str(Path(path).resolve()), "sampleRate": rate,
        "channels": data.shape[1], "durationSeconds": round(len(data) / rate, 3),
        "allFinite": finite, "peakDbFS": db(peak), "rmsDbFS": db(rms),
        "clippedSampleCount": int(np.count_nonzero(np.abs(safe) >= .9999)),
        "dcOffsetPerChannel": [round(float(x), 8) for x in safe.mean(axis=0)],
        "channelRmsDbFS": [db(x) for x in np.sqrt(np.mean(safe**2, axis=0))],
        "tailLastHalfSecondPeakDbFS": db(float(np.max(np.abs(tail), initial=0))),
        "firstActiveSeconds": round(float(active[0] * block / rate), 3) if active.size else None,
        "lastActiveSeconds": round(float((active[-1] + 1) * block / rate), 3) if active.size else None,
        "internalQuietWindowRatio": round(float(np.mean(body < .0001)), 4) if body.size else None,
        "audibleSignal": bool(peak > .003),
        "integrityPass": bool(finite and peak > .003 and peak < .9999 and np.max(np.abs(safe.mean(axis=0))) < .01),
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("wav", nargs="+")
    parser.add_argument("--output")
    args = parser.parse_args()
    results = [inspect(path) for path in args.wav]
    text = json.dumps(results, ensure_ascii=False, indent=2)
    if args.output:
        Path(args.output).write_text(text + "\n")
    print(text)
