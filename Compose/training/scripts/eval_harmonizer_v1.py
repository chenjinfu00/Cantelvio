#!/usr/bin/env python3
"""Evaluate harmonizer v1 (melody -> chords) on its own and as the chord source for v3.1's accompaniment.

Sections (all by default):

  accuracy  held-out test pieces of the Lieder joint corpus (96 works, never seen by the harmonizer): chord
            accuracy against the AugmentedNet labels at beats, exact and by root / chord family, against the
            tonic triad and a textbook rule harmonizer (per beat the diatonic triad or V7 covering most melody
            time, primary chords preferred), given either the key signature (read as a major key: what the
            harmonizer sees too) or AugmentedNet's own local key (a reference no tool has at inference)
  tunes     three public-domain melodies (as in eval_four_pillar_v31_tasks): agreement with the human chords,
            and v3.1 accompaniments with the melody locked and no chords / the harmonizer's chords / the human
            chords (semitone clashes, strong-beat chord tones, doublings)
  analysis  (with --analyzer, not in the default sections) test songs aligned with the score database: chords
            read from every note of the score by harmonizer v2, from the melody only, by harmonizer v1, and by
            AIlegro's rule-based chord tracker, against AugmentedNet
  auditions one MIDI per tune and chord source (v3.1's own, the harmonizer's, human), seed 1, best of 8, in a
            folder next to the report (not in the default sections)
  lieder    test-split songs whose score aligns with the corpus: 8 real bars fed to v3.1, then 4 bars written
            with the real vocal line locked and no chords (v3.1 decides) / the harmonizer's chords (read from
            the melody of all 12 bars) / the AugmentedNet chords; v3.1 was trained on these songs, the
            harmonizer was not

    .venv-training/bin/python training/scripts/eval_harmonizer_v1.py \\
        --harmonizer training/runs/harmonizer-v1-20261003/weights.pt \\
        --output training/reports/harmonizer-v1-20261003.json
"""
from __future__ import annotations

import argparse
import json
import random
import time
import types
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

import numpy as np
import torch

import harmonizer_v1 as hz
from eval_four_pillar_v31_tasks import TUNES, Corpus, chord_tones, melody_metrics, real_bar, with_context
from four_pillar_codec import GROUPS
from four_pillar_v1_alignment import verified_bar_steps
from four_pillar_v31_midi import to_midi
from four_pillar_v31_sample import load as load_v31
from four_pillar_v31_tasks import Lock, TaskComposer
from four_pillar_v31_tonal import QUALITIES, QUALITY_INDEX, analyze, key_parts

ROOT = Path(__file__).resolve().parents[1]
Q = QUALITY_INDEX
MAJOR, MINOR = (0, 2, 4, 5, 7, 9, 11), (0, 2, 3, 5, 7, 8, 10)


# ====================================================================== baselines (given the true local key)
def diatonic_chords(tonic: int, mode: int) -> list[tuple[int, int, float]]:
    """(root, quality, prior bonus): diatonic triads and V7; minor uses the harmonic-minor V and vii°."""
    if mode == 0:
        triads = [(0, 'maj', .3), (2, 'min', 0), (4, 'min', 0), (5, 'maj', .2), (7, 'maj', .25), (9, 'min', .05),
                  (11, 'dim', 0), (7, 'dom7', .2)]
    else:
        triads = [(0, 'min', .3), (2, 'dim', 0), (3, 'maj', 0), (5, 'min', .2), (7, 'maj', .25), (8, 'maj', .05),
                  (11, 'dim', 0), (7, 'dom7', .2)]
    return [((tonic + degree) % 12, Q[name], bonus) for degree, name, bonus in triads]


def rule_harmonizer(arrays: dict) -> np.ndarray:
    """Per beat: the diatonic chord whose tones cover most melody time (onsets count double), primary chords
    preferred; a beat without melody keeps the previous chord."""
    n = len(arrays['bar'])
    level = np.asarray(arrays['level'])
    beats = [t for t in range(n) if level[t] <= 1] + [n]
    out = np.full(n, -1, np.int64)
    previous = None
    for a, b in zip(beats[:-1], beats[1:]):
        tonic, mode = int(arrays['key_tonic'][a]), int(arrays['key_mode'][a])
        if tonic < 0:
            continue
        weight = np.zeros(12)
        for t in range(a, b):
            p = int(arrays['mel_pitch'][t])
            if p >= 0:
                weight[p % 12] += 2. if arrays['mel_on'][t] else 1.
        best, best_score = previous, -1.
        if weight.sum() > 0:
            for root, quality, bonus in diatonic_chords(tonic, mode):
                tones = list(chord_tones(root, quality))
                score = weight[tones].sum() / weight.sum() + bonus
                if score > best_score:
                    best, best_score = quality * 12 + root, score
        elif best is None:
            best = (Q['maj'] if mode == 0 else Q['min']) * 12 + tonic
        out[a:b] = best
        previous = best
    return out


def tonic_baseline(arrays: dict) -> np.ndarray:
    tonic, mode = np.asarray(arrays['key_tonic']).astype(int), np.asarray(arrays['key_mode']).astype(int)
    return np.where(mode == 0, Q['maj'], Q['min']) * 12 + tonic


def score_paths(paths: dict[str, np.ndarray], y: np.ndarray, beat: np.ndarray, hits: dict) -> None:
    for name, path in paths.items():
        row = hits.setdefault(name, Counter())
        ok = beat & (y >= 0)
        row['beats'] += int(ok.sum())
        row['exact'] += int((path == y)[ok].sum())
        row['root'] += int((path % 12 == y % 12)[ok].sum())
        same_family = (path % 12 == y % 12) & (hz.FAMILY[np.maximum(path, 0) // 12] == hz.FAMILY[np.maximum(y, 0) // 12])
        row['family'] += int(same_family[ok].sum())


def section_accuracy(model, info, pieces) -> dict:
    hits = {}
    for piece in pieces:
        if piece['meta']['split'] != 'test':
            continue
        arrays = piece['arrays']
        y = hz.targets(arrays, 0, len(arrays['bar']))
        beat = np.asarray(arrays['level']) <= 1
        logp = hz.posteriors(model, arrays)
        signature = np.asarray(arrays['keysig']).astype(int)
        major = dict(arrays, key_tonic=np.where(signature < 12, signature, -1), key_mode=np.zeros_like(signature))
        paths = {'harmonizer': hz.viterbi(logp, arrays['level'], np.asarray(info['changeLogp']),
                                          info.get('viterbiPenalty', 1.)),
                 'harmonizer (argmax per step)': logp.argmax(-1),
                 'rule harmonizer (key signature as major key)': rule_harmonizer(major),
                 'tonic triad (key signature as major key)': tonic_baseline(major),
                 'rule harmonizer (true local key, reference)': rule_harmonizer(arrays),
                 'tonic triad (true local key, reference)': tonic_baseline(arrays)}
        score_paths(paths, y, beat, hits)
    return {name: {'exact': round(r['exact'] / r['beats'], 4), 'root': round(r['root'] / r['beats'], 4),
                   'family': round(r['family'] / r['beats'], 4), 'beats': r['beats']} for name, r in hits.items()}


# ====================================================================== harmonic analysis (all notes)
def section_analysis(analyzer, analyzer_info, harmonizer, harmonizer_info) -> dict:
    """Test songs aligned with the score database: chords read from every note of the score (harmonizer v2) or
    from the melody only, and AIlegro's rule-based chord tracker over every note, against AugmentedNet."""
    from four_pillar_v31_tonal import NoteTable, track_chords, track_keys
    corpus = Corpus()
    pieces = hz.load_pieces(texture=True)
    hits, used = {}, 0
    for piece in pieces:
        arrays = piece['arrays']
        if piece['meta']['split'] != 'test' or not arrays['tex_known']:
            continue
        score = corpus.score(piece['meta']['scoreId'])
        starts = verified_bar_steps(score, piece)
        n = len(arrays['bar'])
        y = hz.targets(arrays, 0, n)
        beat = np.asarray(arrays['level']) <= 1
        change2 = np.asarray(analyzer_info['changeLogp'])
        paths = {
            'analysis model, all notes': hz.viterbi(hz.posteriors(analyzer, arrays), arrays['level'], change2,
                                                    analyzer_info.get('viterbiPenalty', 1.)),
            'analysis model, melody only': hz.viterbi(hz.posteriors(analyzer, {**arrays, 'tex_known': 0}),
                                                      arrays['level'], change2,
                                                      analyzer_info.get('viterbiPenalty', 1.)),
            'harmonizer v1, melody only': hz.viterbi(hz.posteriors(harmonizer, arrays), arrays['level'],
                                                     np.asarray(harmonizer_info['changeLogp']),
                                                     harmonizer_info.get('viterbiPenalty', 1.)),
        }
        table = NoteTable(score)
        found = track_chords(score, track_keys(score, table), 0, len(score.measures) - 1, table)
        tracker = np.full(n, -1, np.int64)
        for bar, changes in found.items():
            for offset, root, quality in changes:
                step = starts[bar] + int(round(float(offset) * 4))
                if 0 <= step < n:
                    tracker[step] = int(quality) * 12 + int(root) % 12
        current = -1
        for t in range(n):                     # a change holds until the next one
            current = tracker[t] if tracker[t] >= 0 else current
            tracker[t] = current
        paths['chord tracker (rules), all notes'] = tracker
        score_paths(paths, y, beat, hits)
        used += 1
    return {'pieces': used} | {name: {'exact': round(r['exact'] / r['beats'], 4), 'root': round(r['root'] / r['beats'], 4),
                                      'family': round(r['family'] / r['beats'], 4), 'beats': r['beats']}
                               for name, r in hits.items()}


# ====================================================================== tunes
def tune_chords(model, info, tune):
    melody, human, (tonic, _) = TUNES[tune]
    notes = [(4 * b + o, d, p) for b, bar in enumerate(melody) for o, p, d in bar]
    fifths = (tonic * 7 + 5) % 12 - 5                  # the major key signature of the tune
    changes, path = hz.harmonize(model, info, notes, [(F(4), (4, 4), fifths)] * len(melody))
    chords = [tuple((F(o), r, q) for o, r, q in changes.get(b, ())) for b in range(len(melody))]
    # agreement per beat with the human chords
    agree = total = 0
    for b, bar_chords in enumerate(human):
        for beat in range(4):
            mine = path[16 * b + 4 * beat]
            current = [c for c in bar_chords if c[0] <= beat] or None
            if current is None:      # the human chord of the previous bar holds
                current = [human[b - 1][-1]] if b else None
            if current:
                root, quality = current[-1][1], current[-1][2]
                total += 1
                agree += int(mine == quality * 12 + root)
    return chords, agree / max(total, 1)


def accompany(v31, vocab, tune, seed, candidates, chords):
    melody, _, key = TUNES[tune]
    composer, bars = TaskComposer(v31, vocab, seed=seed, key=key), []
    for b, bar in enumerate(melody):
        locks = [Lock(onset=o, pitch=p, duration=d, group=6, identity=('voice', '1', '1'), dynamic=0) for o, p, d in bar]
        kwargs = dict(groups=('keys',), locks=locks, chords=chords[b] if chords else (), temperature=.9, top_p=.95,
                      tempo=92.)
        bars.append(composer.best_of(candidates, **kwargs) if candidates > 1 else composer.next_bar_locked(**kwargs))
    return bars


def section_tunes(model, info, v31, vocab, seeds=4) -> dict:
    out = {'chords': {}, 'accompaniment': {}}
    predicted = {}
    for tune in TUNES:
        chords, agreement = tune_chords(model, info, tune)
        predicted[tune] = chords
        out['chords'][tune] = {'agreementWithHumanChordsPerBeat': round(agreement, 4),
                               'bars': [[f"{o}:{hz_name(r, q)}" for o, r, q in bar] for bar in chords]}
    conditions = {'melody locked': (1, None), 'melody locked, best of 8': (8, None),
                  'melody + harmonizer chords': (1, 'model'), 'melody + harmonizer chords, best of 8': (8, 'model'),
                  'melody + human chords': (1, 'human'), 'melody + human chords, best of 8': (8, 'human')}
    for name, (k, source) in conditions.items():
        rows, started = [], time.time()
        for tune in TUNES:
            melody, human, _ = TUNES[tune]
            chords = None if source is None else predicted[tune] if source == 'model' else [tuple(c) for c in human]
            for seed in range(1, seeds + 1):
                bars = accompany(v31, vocab, tune, seed, k, chords)
                rows.append(melody_metrics(melody, bars))
        out['accompaniment'][name] = {key: round(float(np.mean([r[key] for r in rows])), 4) for key in rows[0]} | {
            'pieces': len(rows), 'secondsPerPiece': round((time.time() - started) / len(rows), 2)}
        print('tunes', name, out['accompaniment'][name], flush=True)
    return out


def hz_name(root: int, quality: int) -> str:
    names = ('C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B')
    return names[root] + QUALITIES[quality]['suffix']


def write_auditions(model, info, v31, vocab, out: Path, candidates=8) -> list[str]:
    """One MIDI per tune and chord source (seed 1, best of `candidates`): v3.1's own chords, the harmonizer's,
    the human chords."""
    out.mkdir(parents=True, exist_ok=True)
    written = []
    for tune in TUNES:
        melody, human, _ = TUNES[tune]
        sources = {'v31-chords': None, 'harmonizer-chords': tune_chords(model, info, tune)[0],
                   'human-chords': [tuple(c) for c in human]}
        for name, chords in sources.items():
            bars = accompany(v31, vocab, tune, 1, candidates, chords)
            data = {'schema': 'v31-event-audition-2', 'bars': bars, 'qualityValidated': False}
            path = out / f'{tune}--{name}-best-of-{candidates}.mid'
            path.write_bytes(to_midi(json.loads(json.dumps(data, default=str)), 84.)[0])
            written.append(path.name)
    return written


# ====================================================================== real Lieder
def lieder_windows(pieces, corpus, rng, count):
    """(piece, score, starts, target bar) for test songs aligned with the score database."""
    out = []
    candidates = [p for p in pieces if p['meta']['split'] == 'test']
    rng.shuffle(candidates)
    for piece in candidates:
        if len(out) >= count:
            break
        try:
            score = corpus.score(piece['meta']['scoreId'])
            starts = verified_bar_steps(score, piece)
        except (TypeError, ValueError):
            continue
        arrays = piece['arrays']
        n_bars = len(score.measures)
        options = []
        for b in range(8, n_bars - 4):
            a, e = starts[b - 8], (starts[b + 4] if b + 4 < n_bars else len(arrays['bar']))
            if (np.asarray(arrays['meter'][a:e]) < 0).any() or (np.asarray(arrays['ch_root'][a:e]) < 0).any():
                continue
            if any(not score.measures[c].meter for c in range(b - 8, b + 4)):
                continue
            vocal = [x for x in score.events if b <= x.bar < b + 4 and x.group is None and x.pitch is not None]
            if len(vocal) >= 8:
                options.append(b)
        if options:
            out.append((piece, score, starts, rng.choice(options)))
    return out


def vocal_notes(score, first: int, last: int):
    """The first vocal part's notes in bars first..last-1 (onset relative to bar `first`)."""
    vocal = [p for p in score.parts if p.group is None]
    if not vocal:
        return []
    part, t0 = vocal[0].id, score.measures[first].onset
    return [(x.onset - t0, x.duration, x.pitch) for x in score.events
            if x.part == part and first <= x.bar < last and x.pitch is not None and x.duration > 0
            and not getattr(x, 'grace', False)]


def window_metrics(score, b, bars, arrays, starts, initial):
    """Clashes, strong-beat chord tones, doublings of the vocal notes against the written accompaniment, and
    agreement of the chords in effect (`initial`: the chord in effect before bar b) with the AugmentedNet labels
    at beats."""
    acc, t0 = [], score.measures[b].onset
    chords = [] if initial is None else [(F(-1), initial[0], initial[1])]
    for k, bar in enumerate(bars):
        onset = score.measures[b + k].onset - t0
        for x in bar['notes']:
            if not x.get('locked') and x['pitch'] is not None:
                acc.append((onset + F(x['onset']), onset + F(x['onset']) + F(x['duration']), x['pitch']))
        chords += [(onset + F(c['onset']), c['root'], c['quality']) for c in bar['chords']]
    m = Counter()
    for t, _, p in vocal_notes(score, b, b + 4):
        sounding = [q for a, e, q in acc if a <= t < e]
        m['notes'] += 1
        m['clash'] += any((q - p) % 12 in (1, 11) for q in sounding)
        m['doubled'] += any((q - p) % 12 == 0 for q in sounding)
        m['unison'] += p in sounding
        step = starts[b] + int(round(t * 4))
        if step < len(arrays['level']) and arrays['level'][step] <= 1:
            current = [c for c in chords if c[0] <= t]
            if current:
                m['strong'] += 1
                m['chordTone'] += p % 12 in chord_tones(current[-1][1], current[-1][2])
    end = starts[b + 4] if b + 4 < len(starts) else len(arrays['bar'])
    for step in range(starts[b], end):
        if arrays['level'][step] > 1:
            continue
        t = F(step - starts[b], 4)
        current = [c for c in chords if c[0] <= t]
        label = hz.targets(arrays, step, step + 1)[0]
        if current and label >= 0:
            m['beats'] += 1
            m['agree'] += current[-1][2] * 12 + current[-1][1] == label
            m['agreeRoot'] += current[-1][1] == label % 12
    return m


def section_lieder(model, info, v31, vocab, pieces, count=80, candidates=4) -> dict:
    corpus = Corpus()
    rng = random.Random(7)
    totals = {name: Counter() for name in ('no chords (v3.1 decides)', 'harmonizer chords', 'AugmentedNet chords')}
    used = 0
    started = time.time()
    for piece, score, starts, b in lieder_windows(pieces, corpus, rng, count):
        labels = types.SimpleNamespace(joint={score.score_id: piece}, alignment={})
        analysis = analyze(score, 'Lieder', labels, b - 8, b + 3)
        if analysis.get('chordSource') != 'augmentednet':
            continue
        base = with_context(v31, vocab, score, analysis, b - 8, b, seed=3)
        if base is None:
            continue
        melody = vocal_notes(score, b - 8, b + 4)
        bar_shapes = [(score.measures[c].duration, tuple(score.measures[c].meter),
                       (score.measures[c].key or {}).get('fifths')) for c in range(b - 8, b + 4)]
        predicted, path = hz.harmonize(model, info, melody, bar_shapes)
        first = [(F(o), r, q) for o, r, q in predicted.get(8, ())]
        start_class = int(path[starts[b] - starts[b - 8]])
        start_chord = (start_class % 12, start_class // 12)
        if (not first or first[0][0] != 0) and start_chord != base.state.chord:
            first.insert(0, (F(0), *start_chord))     # the harmonizer's chord in effect at the first written bar
        predicted[8] = first
        locked_by = {'no chords (v3.1 decides)': lambda k: (),
                     'harmonizer chords': lambda k: tuple(predicted.get(8 + k, ())),
                     'AugmentedNet chords': lambda k: tuple(analysis['chords'].get(b + k, ()))}
        for name, chords_of in locked_by.items():
            composer = base.fork(11)
            bars = []
            for k in range(4):
                bar = b + k
                _, notes = real_bar(vocab, score, bar, analysis)
                locks = [Lock(onset=x.position, pitch=x.pitch, duration=vocab.value(x.duration_index), group=6,
                              identity=x.identity, velocity=x.velocity or 80, dynamic=x.dynamic, accent=x.accent,
                              wedge=x.wedge) for x in notes if x.group == 6 and x.pitch is not None]
                groups = sorted({GROUPS[x.group] for x in notes if x.group < 6 and GROUPS[x.group] != 'percussion'})
                m = score.measures[bar]
                bars.append(composer.best_of(candidates, length=m.duration, meter=tuple(m.meter),
                                             key=key_parts(analysis['keys'][bar]), groups=groups or ['keys'],
                                             locks=locks, chords=chords_of(k), temperature=.9, top_p=.95))
            totals[name] += window_metrics(score, b, bars, piece['arrays'], starts, base.state.chord)
        used += 1
    out = {}
    for name, m in totals.items():
        out[name] = {'clash': round(m['clash'] / max(m['notes'], 1), 4), 'doubled': round(m['doubled'] / max(m['notes'], 1), 4),
                     'unison': round(m['unison'] / max(m['notes'], 1), 4),
                     'chordTone': round(m['chordTone'] / max(m['strong'], 1), 4),
                     'agreeWithAugmentedNet': round(m['agree'] / max(m['beats'], 1), 4),
                     'agreeRootWithAugmentedNet': round(m['agreeRoot'] / max(m['beats'], 1), 4),
                     'vocalNotes': m['notes']}
        print('lieder', name, out[name], flush=True)
    return {'windows': used, 'candidates': candidates, 'seconds': round(time.time() - started), 'conditions': out}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--harmonizer', type=Path, required=True)
    parser.add_argument('--analyzer', type=Path, help='harmonizer v2 weights (texture) for the analysis section')
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'runs/four-pillar-v31-ready-20261001/weights.pt')
    parser.add_argument('--output', type=Path, required=True, help='JSON report (refuses to overwrite)')
    parser.add_argument('--sections', default='accuracy,tunes,lieder')
    parser.add_argument('--lieder-windows', type=int, default=60)
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f'{args.output} exists')
    torch.set_num_threads(args.threads)
    model, info = hz.load(args.harmonizer)
    pieces = hz.load_pieces()
    report = {'schema': 'harmonizer-v1-eval-1', 'harmonizer': str(args.harmonizer), 'harmonizerStep': info.get('step'),
              'parameters': info.get('parameters'), 'validation': info.get('validation')}
    started = time.time()
    v31 = vocab = None
    for section in args.sections.split(','):
        t = time.time()
        if section == 'accuracy':
            report['accuracy'] = section_accuracy(model, info, pieces)
            print('accuracy', json.dumps(report['accuracy']), flush=True)
        elif section == 'analysis':
            if args.analyzer is None:
                raise SystemExit('--analyzer is required for the analysis section')
            analyzer, analyzer_info = hz.load(args.analyzer)
            report['analysis'] = section_analysis(analyzer, analyzer_info, model, info)
            report['analyzer'] = {'path': str(args.analyzer), 'step': analyzer_info.get('step'),
                                  'parameters': analyzer_info.get('parameters'),
                                  'validation': analyzer_info.get('validation')}
            print('analysis', json.dumps(report['analysis']), flush=True)
        else:
            if v31 is None:
                v31, vocab, _ = load_v31(args.checkpoint)
            if section == 'tunes':
                report['tunes'] = section_tunes(model, info, v31, vocab)
            elif section == 'lieder':
                report['lieder'] = section_lieder(model, info, v31, vocab, pieces, args.lieder_windows)
            elif section == 'auditions':
                report['auditions'] = write_auditions(model, info, v31, vocab, args.output.with_suffix(''))
            else:
                raise SystemExit(f'unknown section {section}')
        print(section, 'done in', round(time.time() - t), 's', flush=True)
    report['seconds'] = round(time.time() - started)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
