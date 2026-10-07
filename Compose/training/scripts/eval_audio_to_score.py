#!/usr/bin/env python3
"""Evaluate audio_to_score.py on simulated transcriptions of real scores (no audio model involved).

Each score of the Cantelvio Compose score database (the Lieder test split, voice + piano, and string quartets) is
"performed" and "transcribed" by a simulation, then turned back into a score and compared with the original:

  performance    a tempo that drifts beat by beat (log-tempo AR(1)) with a final ritardando, onset jitter
                 (chords keep a common onset), notes released early by up to 20% with noisy offsets; grace notes
                 played as short notes before their principal
  transcription  MuScriptor-like errors per note: missed (6%), an octave or twelfth ghost (4%), a wrong
                 neighbouring pitch (2%), a long note split in two at a chunk boundary (2%), another or a spurious
                 instrument label (4%), plus very short blips (3% of the note count) and extra harmony-like notes
                 of normal length (2%); no two notes of one instrument on the same pitch at once
  beats          the true beats (quarters, dotted quarters in compound metre) with 12 ms jitter and the true
                 downbeats; the hard-beats condition also drops 3% of the beats and adds 1% spurious ones
  passage work   --fast-errors adds a condition in which notes less than 150 ms from another onset of their
                 instrument are transcribed worse: missed 12%, wrong neighbour 4%, 12 ms more onset jitter

Metrics, against the score's pitched non-grace notes from the first full bar's downbeat (quarters) and pitch,
instrument-agnostic like mir_eval's note F1: precision, recall, F1 of (position, pitch), the share of matched
notes with the right duration, and how many notes each cleanup step removed or added. Variants: no cleanup, the
rules, rules + Cantelvio Compose's harmonic-analysis model, and (when its weights are present) + Cantelvio Compose's note filler.
Runs (six or more consecutive notes of one voice, each a triplet eighth or shorter, steps of at most a fourth)
are also scored on their own: recall, notes found at a wrong position (same pitch within a beat's quarter: a
rhythm error), at the right position with a wrong pitch (within a whole tone), or not at all.

    .venv-training/bin/python training/scripts/eval_audio_to_score.py --output training/reports/audio-to-score-<date>.json
"""
from __future__ import annotations

import argparse
import bisect
import json
import math
import sqlite3
import sys
import time
import zlib
from collections import Counter, defaultdict
from fractions import Fraction as F
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import audio_to_score as a2s  # noqa: E402
from score_events_v2 import ScoreEvents  # noqa: E402

ROOT = Path(__file__).resolve().parents[1]
SCORES = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'
COMPOUND = {(6, 8), (9, 8), (12, 8)}
SOUND_GROUPS = (('voice', 'voice'), ('keyboard.piano', 'acoustic_piano'), ('keyboard.organ', 'organ'),
                ('strings.violin', 'violin'), ('strings.viola', 'viola'), ('strings.cello', 'cello'),
                ('strings.contrabass', 'contrabass'), ('wind.flutes', 'flutes'), ('wind.reed.oboe', 'oboe'),
                ('wind.reed.clarinet', 'clarinet'), ('wind.reed.bassoon', 'bassoon'),
                ('brass.french-horn', 'french_horn'), ('brass.trumpet', 'trumpet'), ('brass.trombone', 'trombone'),
                ('brass.tuba', 'tuba'), ('drum.timpani', 'timpani'), ('pluck.harp', 'orchestral_harp'))
GROUP_FALLBACK = {'keys': 'acoustic_piano', 'high_strings': 'violin', 'low_strings': 'cello',
                  'woodwinds': 'flutes', 'brass': 'french_horn'}


def muscriptor_group(part) -> str:
    sound = (part.sound or '').lower()
    for prefix, group in SOUND_GROUPS:
        if sound.startswith(prefix):
            return group
    return GROUP_FALLBACK.get(part.group or '', 'acoustic_piano')


def load_score(db, sid: str) -> ScoreEvents:
    payload = db.execute('SELECT payload FROM scores WHERE score_id=?', (sid,)).fetchone()[0]
    return ScoreEvents.from_candidate(json.loads(zlib.decompress(payload)))


def full(m) -> bool:
    return bool(m.meter) and m.duration == F(m.meter[0] * 4, m.meter[1])


def excerpt(score: ScoreEvents, bars: int, start: int = 0):
    """Measures and pitched events of `bars` bars from bar `start` (notes that start in them), and the anchor: the
    first full bar's downbeat (the first downbeat the simulated beat tracker reports)."""
    measures = score.measures[start:start + bars]
    begin, end = measures[0].onset, measures[-1].onset + measures[-1].duration
    events = [e for e in score.events if e.pitch is not None and not e.unpitched and begin <= e.onset < end]
    anchor = next(m.onset for m in measures if full(m))
    return measures, events, anchor, end


def simulate(score: ScoreEvents, bars: int, rng: np.random.Generator, hard_beats: bool = False,
             fast_errors: bool = False, start: int = 0):
    """(transcription document, truth set of (position from anchor, pitch), truth durations, metre) for `bars`
    bars from bar `start`."""
    measures, events, anchor, end = excerpt(score, bars, start)
    meter = tuple(measures[-1].meter or (4, 4))
    beat_q = F(3, 2) if meter in COMPOUND else F(1)
    # tempo map: beat times on the score's beat grid (counted from the first full bar's downbeat, so a pickup of
    # half a beat starts half a beat after the first tracked beat)
    start_q = anchor - beat_q * math.ceil((anchor - measures[0].onset) / beat_q)
    n_beats = int(math.ceil((end - start_q) / beat_q)) + 2
    qpm = rng.uniform(60, 110) if beat_q == 1 else rng.uniform(45, 70) * 1.5
    seconds_per_beat = 60. / qpm * float(beat_q)
    walk, times = 0., [0.5]
    for k in range(n_beats):
        walk = .85 * walk + rng.normal(0, .035)
        rit = 1 + .25 * max(0, k - (n_beats - 8)) / 8
        times.append(times[-1] + seconds_per_beat * math.exp(walk) * rit)
    times = np.array(times)

    def seconds(q: F) -> float:
        b = float((q - start_q) / beat_q)
        k = min(max(int(math.floor(b)), 0), len(times) - 2)
        return float(times[k] + (b - k) * (times[k + 1] - times[k]))

    parts = {p.id: muscriptor_group(p) for p in score.parts}
    groups_present = sorted(set(parts.values()))
    notes = []
    chord_jitter = {}
    for e in events:
        group = parts.get(e.part, 'acoustic_piano')
        if e.grace:
            t = seconds(e.onset) - .07
            notes.append([t, t + .06, e.pitch, group])
            continue
        base = chord_jitter.setdefault(e.onset, rng.normal(0, .018))
        t0 = seconds(e.onset) + base + rng.normal(0, .007)
        span = seconds(e.onset + e.duration) - seconds(e.onset)
        t1 = t0 + max(.06, span * rng.uniform(.8, 1.) + rng.normal(0, .03))
        notes.append([t0, t1, e.pitch, group])
    # passage work: notes close to another onset of their instrument (not a chord)
    fast = set()
    if fast_errors:
        onsets = defaultdict(list)
        for t0, _, _, group in notes:
            onsets[group].append(t0)
        for group in onsets:
            onsets[group].sort()
        for k, (t0, _, _, group) in enumerate(notes):
            times_g = onsets[group]
            j = bisect.bisect_left(times_g, t0 - .15)
            if any(.03 < abs(t - t0) < .15 for t in times_g[j:bisect.bisect_right(times_g, t0 + .15)]):
                fast.add(k)
    # transcription errors
    out = []
    for k, (t0, t1, pitch, group) in enumerate(notes):
        missed, slipped = (.12, .16) if k in fast else (.06, .08)
        r = rng.random()
        if r < missed:
            continue                                                   # missed
        if r < slipped:
            pitch += int(rng.choice((-1, 1)))                          # wrong neighbour
        if k in fast:
            shift = rng.normal(0, .012)
            t0, t1 = t0 + shift, t1 + shift
        if rng.random() < .04:
            other = [g for g in groups_present if g != group] + ['string_ensemble', 'organ']
            group = str(rng.choice(other))
        if t1 - t0 > 1.2 and rng.random() < .02:
            cut = t0 + (t1 - t0) * rng.uniform(.3, .7)
            out.append([t0, cut, pitch, group])
            out.append([cut + .01, t1, pitch, group])
        else:
            out.append([t0, t1, pitch, group])
        if rng.random() < .04:
            ghost = pitch + (19 if rng.random() < .25 else 12)
            out.append([t0 + rng.normal(0, .01), t0 + (t1 - t0) * rng.uniform(.1, .4), ghost, group])
    count = len(notes)
    span_end = max(n[1] for n in notes)
    for _ in range(int(.03 * count)):
        ref = notes[int(rng.integers(len(notes)))]
        t = rng.uniform(0, span_end)
        out.append([t, t + rng.uniform(.02, .08), int(ref[2] + rng.integers(-7, 8)), ref[3]])
    for _ in range(int(.02 * count)):
        ref = notes[int(rng.integers(len(notes)))]
        t = ref[0] + rng.normal(0, .02)
        out.append([t, t + rng.uniform(.1, .5), int(ref[2] + rng.choice((-7, -5, -4, -3, 3, 4, 5, 7))), ref[3]])
    # one instrument cannot hold the same pitch twice at once
    out.sort(key=lambda n: (n[3], n[2], n[0]))
    clean = []
    for n in out:
        if clean and clean[-1][3] == n[3] and clean[-1][2] == n[2] and n[0] < clean[-1][1]:
            clean[-1][1] = max(clean[-1][1], n[1])
            continue
        clean.append(n)
    clean.sort(key=lambda n: (n[0], n[2]))
    # beats and downbeats
    beats = [seconds(start_q + k * beat_q) + rng.normal(0, .012) for k in range(n_beats)
             if start_q + k * beat_q <= end]
    downbeats = [seconds(m.onset) for m in measures if full(m)]
    if hard_beats:
        beats = [b for b in beats if rng.random() > .03]
        extra = [beats[k] + (beats[k + 1] - beats[k]) * rng.uniform(.4, .6)
                 for k in range(len(beats) - 1) if rng.random() < .01]
        beats = sorted(beats + extra)
    doc = {'schema': a2s.SCHEMA, 'audio': f'{score.score_id}.wav',
           'notes': [[round(a, 4), round(b, 4), int(p), g] for a, b, p, g in clean],
           'beats': [round(b, 4) for b in beats], 'downbeats': [round(d, 4) for d in downbeats]}
    truth, durations = set(), {}
    for e in events:
        if not e.grace:
            key = ((e.onset - anchor) / beat_q, e.pitch)          # in beats from the first tracked downbeat
            truth.add(key)
            durations[key] = e.duration / beat_q
    return doc, truth, durations, meter


def run_truth(score: ScoreEvents, bars: int) -> set:
    """Keys (beats from the anchor, pitch) of the notes in runs: six or more consecutive single notes of one voice,
    each at most a triplet eighth apart and long, moving by at most five semitones."""
    measures, events, anchor, _ = excerpt(score, bars)
    beat_q = F(3, 2) if tuple(measures[-1].meter or (4, 4)) in COMPOUND else F(1)
    voices = defaultdict(list)
    for e in events:
        if not e.grace:
            voices[e.voice_id].append(e)
    keys = set()
    for line in voices.values():
        chord_size = Counter(e.onset for e in line)
        line = sorted((e for e in line if chord_size[e.onset] == 1), key=lambda e: e.onset)
        run: list = []

        def flush():
            if len(run) >= 6:
                keys.update(((e.onset - anchor) / beat_q, e.pitch) for e in run)
            run.clear()

        for e in line:
            if run and not (0 < (e.onset - run[-1].onset) / beat_q <= F(1, 3) and abs(e.pitch - run[-1].pitch) <= 5
                            and run[-1].duration / beat_q <= F(1, 3)):
                flush()
            run.append(e)
        flush()
    return keys


def compare(score: a2s.Score, truth: set, durations: dict, runs: set | frozenset = frozenset()) -> dict:
    """Notes kept by the pipeline against the truth, both in beats from the first tracked downbeat (so 4/4 with
    triplets and 12/8 compare alike; the metre itself is reported separately); run notes also on their own."""
    anchor = score.downbeat
    kept = {}
    for n in score.notes:
        if not n.removed:
            kept[((n.on - anchor) / score.beat_quarters, n.pitch)] = n.dur / score.beat_quarters
    hits = [k for k in kept if k in truth]
    right_duration = sum(kept[k] == durations[k] for k in hits)
    pitches = defaultdict(set)
    for pos, pitch in kept:
        pitches[pos].add(pitch)
    run = Counter()
    for pos, pitch in runs:
        if (pos, pitch) in kept:
            run['hit'] += 1
        elif any((pos + F(d, 24), pitch) in kept for d in range(-6, 7) if d):
            run['shifted'] += 1
        elif any(abs(q - pitch) <= 2 for q in pitches.get(pos, ())):
            run['pitch'] += 1
        else:
            run['missing'] += 1
    return {'truth': len(truth), 'kept': len(kept), 'hits': len(hits), 'durations': right_duration,
            'runTruth': len(runs), 'runHits': run['hit'], 'runShifted': run['shifted'], 'runPitch': run['pitch'],
            'runMissing': run['missing']}


def metre_name(meter) -> str:
    return f'{meter[0]}/{meter[1]}'


def summarize(rows: list[dict]) -> dict:
    t = sum(r['truth'] for r in rows)
    k = sum(r['kept'] for r in rows)
    h = sum(r['hits'] for r in rows)
    d = sum(r['durations'] for r in rows)
    p, r = h / max(k, 1), h / max(t, 1)
    rt = sum(r.get('runTruth', 0) for r in rows)
    runs = {'notes': rt, **{name: round(sum(r.get(key, 0) for r in rows) / max(rt, 1), 4)
                            for name, key in (('recall', 'runHits'), ('shifted', 'runShifted'),
                                              ('wrongPitch', 'runPitch'), ('missing', 'runMissing'))}}
    return {'pieces': len(rows), 'truthNotes': t, 'keptNotes': k, 'precision': round(p, 4), 'recall': round(r, 4),
            'f1': round(2 * p * r / max(p + r, 1e-9), 4), 'durationAccuracy': round(d / max(h, 1), 4),
            'metreAccuracy': round(sum(r['metre'] for r in rows) / max(len(rows), 1), 4), 'runs': runs}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--lieder', type=int, default=30, help='Lieder test-split songs')
    parser.add_argument('--quartets', type=int, default=10, help='string quartet movements')
    parser.add_argument('--bars', type=int, default=24)
    parser.add_argument('--seed', type=int, default=1)
    parser.add_argument('--analyzer', default=None, help='harmonic-analysis weights (default: harmonizer v2)')
    parser.add_argument('--filler', default=None, help="note-filler weights (default: note filler v1; 'none' = skip)")
    parser.add_argument('--examples', type=Path, help='folder for a few MusicXML results')
    parser.add_argument('--fast-errors', action='store_true',
                        help='also a condition in which passage work is transcribed worse (see the docstring)')
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f'{args.output} exists')
    import harmonizer_v1 as hz
    model = a2s.load_chords_model(args.analyzer)
    filler = a2s.load_filler(args.filler)
    db = sqlite3.connect(f'file:{SCORES}?mode=ro', uri=True)
    rng = np.random.default_rng(args.seed)
    lieder = [p['meta']['scoreId'] for p in hz.load_pieces() if p['meta']['split'] == 'test']
    rng.shuffle(lieder)
    quartets = [sid for sid, in db.execute("SELECT score_id FROM scores WHERE source='classical-scores' "
                                            "AND score_id LIKE '%StringQuartets%' ORDER BY score_id")]
    rng.shuffle(quartets)
    sets = {'lieder': lieder[:args.lieder], 'quartets': quartets[:args.quartets]}
    variants = {'no cleanup': dict(keep_all=True), 'rules': dict(), 'rules + harmony model': dict(chords=True)}
    if filler is not None:
        variants['rules + harmony model + note filler'] = dict(chords=True, filler=True)
    best = list(variants)[-1]
    results, removed, added, t0 = defaultdict(list), defaultdict(Counter), defaultdict(Counter), time.time()
    examples = Counter()
    for name, ids in sets.items():
        conditions = [('', False, False), (' (hard beats)', True, False)]
        if args.fast_errors:
            conditions.append((' (fast-passage errors)', False, True))
        for label, hard, fast in conditions:
            for sid in ids:
                score_events = load_score(db, sid)
                if len(score_events.measures) < 8:
                    continue
                tag = 'fast' if fast else hard
                piece_rng = np.random.default_rng(zlib.crc32(f'{sid}:{args.seed}:{tag}'.encode()))
                doc, truth, durations, meter = simulate(score_events, args.bars, piece_rng, hard_beats=hard,
                                                        fast_errors=fast)
                runs = run_truth(score_events, args.bars)
                for variant, opts in variants.items():
                    score = a2s.transcription_to_score(doc, keep_all=opts.get('keep_all', False),
                                                       chords_model=model if opts.get('chords') else None,
                                                       filler=filler if opts.get('filler') else None)
                    key = f'{name}{label} / {variant}'
                    row = compare(score, truth, durations, runs)
                    row['metre'] = score.report['metre'] == metre_name(meter) or (
                        meter == (2, 2) and score.report['metre'] == '4/4')
                    results[key].append(row)
                    removed[key].update(score.report['removed'])
                    added[key].update(score.report['added'])
                    if args.examples and not label and variant == best and examples[name] < 2:
                        args.examples.mkdir(parents=True, exist_ok=True)
                        stem = f'{name}-{examples[name] + 1}-{sid.rsplit("/", 1)[-1].split(".")[0]}'
                        (args.examples / f'{stem}.musicxml').write_text(a2s.musicxml(score))
                        (args.examples / f'{stem}.notes.json').write_text(json.dumps(doc))
                        examples[name] += 1
            print(name, label.strip() or 'normal', 'done', round(time.time() - t0), 's', flush=True)
    report = {'schema': 'audio-to-score-eval-1', 'bars': args.bars, 'seed': args.seed,
              'harmonyModel': bool(model), 'noteFiller': filler is not None and {
                  'threshold': filler.threshold, 'step': filler.info.get('step')},
              'simulation': __doc__.split('Metrics')[0].strip(),
              'results': {k: summarize(v) | {'removed': dict(removed[k]), 'added': dict(+added[k])}
                          for k, v in results.items()},
              'seconds': round(time.time() - t0)}
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=1))
    for k, v in report['results'].items():
        print(f'{k:62s} P {v["precision"]:.3f} R {v["recall"]:.3f} F1 {v["f1"]:.3f} dur {v["durationAccuracy"]:.3f} '
              f'metre {v["metreAccuracy"]:.2f} runs R {v["runs"]["recall"]:.3f} (shifted {v["runs"]["shifted"]:.3f}, '
              f'pitch {v["runs"]["wrongPitch"]:.3f}, missing {v["runs"]["missing"]:.3f}) removed {v["removed"]} '
              f'added {v["added"]}')


if __name__ == '__main__':
    main()
