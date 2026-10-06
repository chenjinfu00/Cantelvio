"""Original formant-synthesized rehearsal voices, not recordings of singers.

Run with the existing chopin-op21-accompanist Conda environment.
No downloaded recordings, speech services, or additional packages are used.
"""
from pathlib import Path
import json
import numpy as np
import soundfile as sf

OUT = Path(__file__).resolve().parents[1] / "public/media/karaoke"
SR = 44100
RNG = np.random.default_rng(260923)
FORMANTS = {
    "ah": [(730, 120, 1.0), (1090, 160, .63), (2440, 230, .20)],
    "oo": [(300, 100, 1.0), (870, 130, .30), (2240, 230, .06)],
    "mm": [(250, 120, 1.0), (1100, 140, .09), (2200, 260, .025)],
    "doo": [(350, 100, 1.0), (900, 130, .26), (2200, 230, .07)],
}


def voice(midi, duration, vowel, seed_phase=0.0):
    """Harmonic glottal source with vowel spectral envelopes and soft breath."""
    t = np.arange(round(duration * SR)) / SR
    base = 440 * 2 ** ((midi - 69) / 12)
    result = np.zeros_like(t)
    for detune, phase_shift in [(-.018, .3), (0, 0), (.021, 1.5)]:
        vibrato = .0025 * np.sin(2 * np.pi * 5.0 * t + phase_shift)
        vibrato *= np.minimum(t / .35, 1)
        frequency = base * 2 ** (detune / 12) * (1 + vibrato)
        phase = 2 * np.pi * np.cumsum(frequency) / SR + seed_phase
        singer = np.zeros_like(t)
        for harmonic in range(1, min(70, int(7000 / base))):
            hz = harmonic * base
            weight = .10 / harmonic ** 1.8
            for centre, width, gain in FORMANTS[vowel]:
                weight += gain * np.exp(-.5 * ((hz - centre) / width) ** 2) / harmonic ** .45
            singer += weight * np.sin(harmonic * phase + .08 * harmonic)
        result += singer / 3
    envelope = np.minimum(t / .10, 1) * np.minimum((duration - t) / .20, 1)
    envelope = np.clip(envelope, 0, 1) ** 1.4
    if vowel == "doo":
        envelope *= 1 - .45 * np.minimum(t / duration, 1)
        result += RNG.normal(0, .035, len(t)) * np.exp(-((t - .035) / .018) ** 2)
    breath = RNG.normal(0, .004, len(t))
    result = (result + breath) * envelope
    result /= max(float(np.max(np.abs(result))), 1e-9)
    return result * .36


def cue(time, duration, label, midis=None, vowel=None, **extras):
    return dict(time=time, duration=duration, label=label,
                midis=midis or [], vowel=vowel, **extras)


def render(duration, events):
    signal = np.zeros(round(duration * SR))
    for event in events:
        if not event.get("midis"):
            continue
        vowels = event.get("vowels") or [event.get("vowel") or "ah"] * len(event["midis"])
        for midi, vowel in zip(event["midis"], vowels):
            sample = voice(midi, event["duration"], vowel)
            start = round(event["time"] * SR)
            end = min(start + len(sample), len(signal))
            signal[start:end] += sample[:end-start] / np.sqrt(len(event["midis"]))
    # A little fixed room tail remains inside the clip, without filling response gaps.
    dry = signal.copy()
    for delay, level in [(.027, .12), (.053, .07)]:
        n = round(delay * SR)
        signal[n:] += dry[:-n] * level
    peak = float(np.max(np.abs(signal)))
    if peak > .70:
        signal *= .70 / peak
    return signal


def singing_parts():
    """Three four-note lines, two practice rounds, then the collective response."""
    parts = [[48, 47, 48, 48], [52, 50, 52, 53], [55, 55, 57, 57]]
    chords = ["C", "G", "Am", "F"]
    beat, step = .8, 1.6
    specs = {}
    def count_in(start, label, **extras):
        return [cue(round(start + beat * i, 4), beat, f"{label} · {3-i}", kind="count", **extras) for i in range(3)]
    for part_index, midis in enumerate(parts):
        part = str(part_index + 1)
        practice = []
        for repeat in range(2):
            start = repeat * 8.8
            label = f"Voice {part} · Practice {repeat+1}/2"
            practice.extend(count_in(start, label, voice=part))
            for i, midi in enumerate(midis):
                practice.append(cue(round(start + 2.4 + i * step, 4), 1.4, label,
                                    [midi], "ah", voice=part, step=i, round=repeat+1, kind="practice"))
        specs[f"part-{part}-practice"] = (17.6, practice)
    # A visual count-in followed only by the audience's four-note response.
    # The answer is never sung by the instrument before the reveal.
    together = count_in(0, "All together")
    for i in range(4):
        together.append(cue(round(2.4 + i * step, 4), step, "Sing together",
                            step=i, kind="response"))
    specs["parts-together"] = (8.8, together)
    # The revealed answer is a separate, audible three-part demonstration.
    answer = [cue(round(i * step, 4), 1.4, f"The answer · {name}",
                  [part[i] for part in parts], "ah", step=i, kind="answer")
              for i, name in enumerate(chords)]
    specs["parts-answer"] = (6.4, answer)
    return specs


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    manifest = {
        "version": 1, "sampleRate": SR,
        "description": "Original formant synthesis. Synthetic singing demonstrations, not human recordings.",
        "generator": "scripts/build-karaoke-voices.py", "clips": {}
    }
    specs = {
        "hum": (2.8, [cue(0, 2.6, "Hum", [48], "mm")]),
        "ah": (2.2, [cue(0, 2.0, "AH", [48], "ah")]),
        "oo": (2.2, [cue(0, 2.0, "OO", [52], "oo")]),
        "doo": (1.6, [cue(0, 1.4, "DOO", [55], "doo")]),
        "mm": (2.2, [cue(0, 2.0, "MM", [55], "mm")]),
        "call": (5.2, [cue(0, .65, "C", [48], "doo"),
                       cue(.8, .65, "D", [50], "doo"),
                       cue(1.6, .65, "E", [52], "doo"),
                       cue(2.5, 2.7, "Your turn", [], None, kind="response")]),
        "choir": (24.0, [cue(0, 1, "3", kind="count"),
                         cue(1, 1, "2", kind="count"),
                         cue(2, 1, "1", kind="count"),
                         cue(3, 2.7, "AH · C", [48], "ah"),
                         cue(6, 2.7, "OO · E", [52], "oo"),
                         cue(9, 2.7, "MM · G", [55], "mm"),
                         cue(12, 3.7, "Together", [48, 52, 55], "choir", vowels=["ah", "oo", "mm"]),
                         cue(16, 1.6, "Together", [48, 52, 55], "choir", vowels=["ah", "oo", "mm"]),
                         cue(18, 1.6, "Together", [48, 52, 55], "choir", vowels=["ah", "oo", "mm"]),
                         cue(20, 4, "Your turn", [], None, kind="response")])
    }
    specs.update(singing_parts())
    for midi in [47, 48, 50, 52, 53, 55, 57]:
        specs[f"voice-note-{midi}"] = (1.4, [cue(0, 1.25, "Voice", [midi], "ah", kind="note")])
    for stem, (duration, events) in specs.items():
        signal = render(duration, events)
        filename = "parts-together-audience.wav" if stem == "parts-together" else f"{stem}.wav"
        sf.write(OUT / filename, signal, SR, subtype="PCM_16")
        manifest["clips"][stem] = dict(src=filename, duration=duration, cues=events)
        assert np.all(np.isfinite(signal)) and np.max(np.abs(signal)) <= .71
        assert all(x["time"] + x["duration"] <= duration + 1e-8 for x in events)
    (OUT / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print(f"Generated {len(specs)} local clips in {OUT}")


if __name__ == "__main__":
    main()
