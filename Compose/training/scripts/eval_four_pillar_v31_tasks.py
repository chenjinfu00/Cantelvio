#!/usr/bin/env python3
"""Evaluate the v3.1 parts and the AIlegro Score composition tasks (four_pillar_v31_parts / _tasks).

Sections (all by default):

  parts        what each part contributes: teacher-forced cross-entropy on real score windows with the planner
               (empty plans) or the reference bar removed, no retraining
  accompany    public-domain melodies (Ode to Joy, Twinkle Twinkle, Lightly Row; 8 bars, sung, piano accompaniment):
               locked melody with 1 / 8 / 32 candidates, locked melody + human chords, and with unison='before'
               (the piano may double the voice before it); semitone clashes with the accompaniment, strong-beat
               chord tones, doublings (any octave, and the exact pitch), notes per bar; real Lieder (voice vs
               piano) as the reference; one MIDI per condition for listening
  chords       melody-from-chords: strong-beat chord tones under locked vs the model's own chords
  orchestrate  real orchestral bars reduced to their distinct (onset, pitch) notes, re-assigned to groups by the
               model (8 real context bars fed first): share of notes given a group that played them, against the
               register of the context and chance; also with light doublings as AIlegro Score asks for them
  motif        restating the previous bar through the bank, synthetic full-texture and top-line references:
               Jaccard similarity of key-relative (onset, pitch) to the intended bar

Windows come from the training index (the project has no held-out split), so compare conditions, not absolute
values. This is decoding only: musical quality needs listening.

    .venv-training/bin/python training/scripts/eval_four_pillar_v31_tasks.py \\
        --checkpoint training/runs/four-pillar-v31-ready-20261001/weights.pt \\
        --output training/reports/four-pillar-v31-tasks-20261002.json
"""
from __future__ import annotations

import argparse
import bisect
import json
import random
import sqlite3
import time
import zlib
from collections import Counter
from fractions import Fraction as F
from pathlib import Path

import numpy as np
import torch

from four_pillar_codec import GROUPS
from four_pillar_v31_data import bar_notes, build_example, collate, lookup
from four_pillar_v31_midi import to_midi
from four_pillar_v31_model import ABS_UNPITCHED, DENSITY_BUCKETS, PITCH_NONE, REF_COUNT_NONE, REF_GROUP_NONE, SOURCE_NONE
from four_pillar_v31_sample import load
from four_pillar_v31_tasks import Lock, TaskComposer, reference_from_notes, transform_motif
from four_pillar_v31_tonal import QUALITIES, QUALITY_INDEX, analyze, key_parts, tonic_ref
from score_events_v2 import ScoreEvents

ROOT = Path(__file__).resolve().parents[1]
INDEX = ROOT / 'data/four-pillar-score-all-train-v1.sqlite'
Q = QUALITY_INDEX


# ====================================================================== shared
class Corpus:
    def __init__(self, path: Path = INDEX):
        self.db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)

    def rows(self, source):
        return self.db.execute('SELECT score_id, bars FROM scores WHERE source=? ORDER BY score_id', (source,)).fetchall()

    def score(self, sid):
        payload = self.db.execute('SELECT payload FROM scores WHERE score_id=?', (sid,)).fetchone()[0]
        return ScoreEvents.from_candidate(json.loads(zlib.decompress(payload)))

    def windows(self, source, count, rng, min_groups=1, context=8):
        rows, out, tries = self.rows(source), [], 0
        while len(out) < count and tries < count * 40:
            tries += 1
            sid, nbars = rng.choice(rows)
            if nbars < context + 2:
                continue
            score = self.score(sid)
            b = rng.randrange(context, len(score.measures))
            groups = {n.group for n in score.events if n.bar == b and n.pitch is not None and n.group in GROUPS
                      and n.group != 'percussion'}
            if len(groups) < min_groups or not score.measures[b].meter:
                continue
            out.append((sid, score, b))
        return out


def real_bar(vocab, score, bar, analysis):
    """Feed events of a real bar (chords before notes, repeated chords dropped later) and its SourceNotes."""
    notes = bar_notes(score, bar, [n for n in score.events if n.bar == bar], vocab, 0, False, {}, {}, Counter())
    length, rows = score.measures[bar].duration, []
    for offset, root, quality in analysis['chords'].get(bar, ()):
        if offset < length:
            rows.append((offset, 0, 0, {'kind': 'chord', 'onset': lookup(vocab, offset)[0], 'root': root % 12,
                                        'quality': quality}))
    for i, n in enumerate(notes):
        rows.append((n.position, 1, i, {'kind': 'note', 'onset': lookup(vocab, n.position)[0], 'group': n.group,
                                        'identity': n.identity, 'pitch': n.pitch, 'duration': n.duration_index,
                                        'velocity': n.velocity or 80, 'dynamic': n.dynamic, 'accent': n.accent,
                                        'wedge': n.wedge, 'drum': n.drum if n.pitch == ABS_UNPITCHED else None}))
    rows.sort(key=lambda r: (float(r[0]), r[1], r[2]))
    return [r[3] for r in rows], notes


def with_context(model, vocab, score, analysis, first, last, seed):
    keys = analysis['keys']
    composer = TaskComposer(model, vocab, seed=seed, key=key_parts(keys[first]))
    for b in range(first, last):
        events, _ = real_bar(vocab, score, b, analysis)
        cleaned, chord = [], composer.state.chord
        for e in events:
            if e['kind'] == 'chord':
                if chord == (e['root'], e['quality']):
                    continue
                chord = (e['root'], e['quality'])
            cleaned.append(e)
        m = score.measures[b]
        try:
            composer.feed_bar(cleaned, length=m.duration, meter=tuple(m.meter) if m.meter else (4, 4),
                              key=key_parts(keys[b]))
        except ValueError:
            return None
    return composer


def chord_tones(root, quality):
    return {(root + i) % 12 for i in QUALITIES[quality]['intervals']}


def mean(rows, key):
    return round(float(np.mean([r[key] for r in rows])), 4)


# ====================================================================== parts
def section_parts(model, vocab, corpus, windows=96):
    """Teacher-forced cross-entropy with parts switched off (their inputs set to the trained 'none' values). Chord
    targets as in training: AugmentedNet for the Lieder the joint corpus aligns, ChordTracker otherwise (until
    2026-10-04 the Lieder windows here had ChordTracker chords, which the model is not trained to predict for aligned
    Lieder; `bySource` gives both)."""
    from four_pillar_v2_examples import SourceLabels
    labels = SourceLabels()
    rng, examples, sources = random.Random(20261002), [], []
    for source, n in (('Lieder', windows // 2), ('classical-scores', windows - windows // 2)):
        rows, picked = corpus.rows(source), 0
        while picked < n:
            sid, _ = rng.choice(rows)
            score = corpus.score(sid)
            if not score.measures:
                continue
            try:
                ex = build_example(score, rng.randrange(len(score.measures)), vocab, source=source,
                                   rng=random.Random(rng.random()), labels=labels, drop_controls=False)
            except (ValueError, IndexError, OverflowError, KeyError):
                continue
            examples.append(ex)
            sources.append(source)
            picked += 1
    k = len(vocab)

    def variant(batch, name):
        b = dict(batch)
        if 'planner' in name:
            b['bar_plan_index'] = torch.full_like(batch['bar_plan_index'], -1)
        if 'reference' in name:
            for key, value in (('rf_next', k), ('rf_here', k), ('rf_remain', REF_COUNT_NONE), ('rf_group', REF_GROUP_NONE),
                               ('rf_pitch', PITCH_NONE), ('rf_duration', k)):
                b[key] = torch.full_like(batch[key], value)
            b['rf_pcs'] = torch.zeros_like(batch['rf_pcs'])
        if name == 'controls':
            b['ctrl_groups'] = torch.zeros_like(batch['ctrl_groups'])
            b['ctrl_density'] = torch.full_like(batch['ctrl_density'], DENSITY_BUCKETS)
            b['ctrl_source'] = torch.full_like(batch['ctrl_source'], SOURCE_NONE)
        return b

    names = ('full', 'planner', 'reference', 'planner+reference', 'controls')
    attrs = ('kind', 'onset', 'chord_root', 'chord_quality', 'group', 'voice', 'pitch', 'duration')
    sums = {v: {a: [0., 0] for a in attrs} for v in names}
    per_source = {s: {a: [0., 0] for a in attrs} for s in ('Lieder', 'classical-scores')}
    with torch.no_grad():
        for i in range(0, len(examples), 8):
            batch = collate(examples[i:i + 8], k)
            for v in names:
                out = model(variant(batch, v))
                for a in attrs:
                    known = batch['kn_' + a]
                    if int(known.sum()):
                        ce = torch.nn.functional.cross_entropy(out[a][known].float(), batch['tg_' + a][known],
                                                               reduction='none')
                        finite = torch.isfinite(ce)
                        sums[v][a][0] += float(ce[finite].sum())
                        sums[v][a][1] += int(finite.sum())
                        if v == 'full':          # the same values split by the window's source
                            rows = known.nonzero()[:, 0]
                            for j, s in enumerate(sources[i:i + 8]):
                                mine = (rows == j) & finite
                                per_source[s][a][0] += float(ce[mine].sum())
                                per_source[s][a][1] += int(mine.sum())
    table = {v: {a: round(s / max(1, c), 4) for a, (s, c) in sums[v].items()} for v in names}
    for v in names:
        table[v]['notes'] = round(sum(table[v][a] for a in ('kind', 'onset', 'group', 'voice', 'pitch', 'duration')), 4)
    by_source = {s: {a: round(x / max(1, c), 4) for a, (x, c) in acc.items()} for s, acc in per_source.items()}
    return {'windows': len(examples), 'chordTargets': 'AugmentedNet for aligned Lieder, ChordTracker otherwise',
            'removed': table, 'bySource': by_source}


# ====================================================================== accompaniment
def _bars(*rows):
    return [[(F(o), p, F(d)) for o, p, d in row] for row in rows]


ODE = [[(o, p + 12, d) for o, p, d in bar] for bar in _bars(
    [(0, 66, 1), (1, 66, 1), (2, 67, 1), (3, 69, 1)], [(0, 69, 1), (1, 67, 1), (2, 66, 1), (3, 64, 1)],
    [(0, 62, 1), (1, 62, 1), (2, 64, 1), (3, 66, 1)], [(0, 66, F(3, 2)), (F(3, 2), 64, F(1, 2)), (2, 64, 2)],
    [(0, 66, 1), (1, 66, 1), (2, 67, 1), (3, 69, 1)], [(0, 69, 1), (1, 67, 1), (2, 66, 1), (3, 64, 1)],
    [(0, 62, 1), (1, 62, 1), (2, 64, 1), (3, 66, 1)], [(0, 64, F(3, 2)), (F(3, 2), 62, F(1, 2)), (2, 62, 2)])]
TUNES = {
    'ode-to-joy': (ODE, [[(0, 2, Q['maj'])], [(0, 9, Q['dom7'])], [(0, 2, Q['maj'])], [(0, 2, Q['maj']), (2, 9, Q['maj'])],
                         [(0, 2, Q['maj'])], [(0, 9, Q['dom7'])], [(0, 2, Q['maj'])],
                         [(0, 9, Q['dom7']), (2, 2, Q['maj'])]], (2, 0)),
    'twinkle': (_bars([(0, 72, 1), (1, 72, 1), (2, 79, 1), (3, 79, 1)], [(0, 81, 1), (1, 81, 1), (2, 79, 2)],
                      [(0, 77, 1), (1, 77, 1), (2, 76, 1), (3, 76, 1)], [(0, 74, 1), (1, 74, 1), (2, 72, 2)],
                      [(0, 79, 1), (1, 79, 1), (2, 77, 1), (3, 77, 1)], [(0, 76, 1), (1, 76, 1), (2, 74, 2)],
                      [(0, 79, 1), (1, 79, 1), (2, 77, 1), (3, 77, 1)], [(0, 76, 1), (1, 76, 1), (2, 74, 2)]),
                [[(0, 0, Q['maj'])], [(0, 5, Q['maj']), (2, 0, Q['maj'])], [(0, 5, Q['maj']), (2, 0, Q['maj'])],
                 [(0, 7, Q['maj']), (2, 0, Q['maj'])], [(0, 0, Q['maj']), (2, 5, Q['maj'])],
                 [(0, 0, Q['maj']), (2, 7, Q['maj'])], [(0, 0, Q['maj']), (2, 5, Q['maj'])],
                 [(0, 0, Q['maj']), (2, 7, Q['maj'])]], (0, 0)),
    'lightly-row': (_bars([(0, 79, 1), (1, 76, 1), (2, 76, 2)], [(0, 77, 1), (1, 74, 1), (2, 74, 2)],
                          [(0, 72, 1), (1, 74, 1), (2, 76, 1), (3, 77, 1)], [(0, 79, 1), (1, 79, 1), (2, 79, 2)],
                          [(0, 79, 1), (1, 76, 1), (2, 76, 2)], [(0, 77, 1), (1, 74, 1), (2, 74, 2)],
                          [(0, 72, 1), (1, 76, 1), (2, 79, 1), (3, 79, 1)], [(0, 72, 4)]),
                    [[(0, 0, Q['maj'])], [(0, 7, Q['dom7'])], [(0, 0, Q['maj'])], [(0, 0, Q['maj'])], [(0, 0, Q['maj'])],
                     [(0, 7, Q['dom7'])], [(0, 0, Q['maj']), (2, 7, Q['dom7'])], [(0, 0, Q['maj'])]], (0, 0)),
}


def melody_metrics(melody, bars):
    acc, chords, t0 = [], [], F(0)
    for bar in bars:
        for n in bar['notes']:
            if not n.get('locked') and n['pitch'] is not None:
                acc.append((t0 + F(n['onset']), t0 + F(n['onset']) + F(n['duration']), n['pitch']))
        chords += [(t0 + F(c['onset']), c['root'], c['quality']) for c in bar['chords']]
        t0 += F(bar['length'])
    clash = doubled = unison = strong = tone = total = 0
    for b, bar in enumerate(melody):
        for o, p, _ in bar:
            t = 4 * b + o
            sounding = [q for a, e, q in acc if a <= t < e]
            total += 1
            clash += any((q - p) % 12 in (1, 11) for q in sounding)
            doubled += any((q - p) % 12 == 0 for q in sounding)
            unison += p in sounding
            if o in (0, 2):
                strong += 1
                current = [c for c in chords if c[0] <= t]
                tone += bool(current) and p % 12 in chord_tones(current[-1][1], current[-1][2])
    return {'clash': clash / total, 'doubled': doubled / total, 'unison': unison / total,
            'chordTone': tone / max(1, strong), 'accompanimentNotesPerBar': len(acc) / len(bars)}


def accompany(model, vocab, tune, seed, candidates, with_chords, unison='after'):
    melody, chords, key = TUNES[tune]
    composer, bars, score, count = TaskComposer(model, vocab, seed=seed, key=key), [], 0., 0
    for b, bar in enumerate(melody):
        locks = [Lock(onset=o, pitch=p, duration=d, group=6, identity=('voice', '1', '1'), dynamic=0) for o, p, d in bar]
        kwargs = dict(groups=('keys',), locks=locks, chords=tuple(chords[b]) if with_chords else (), temperature=.9,
                      top_p=.95, tempo=92., unison=unison)
        res = composer.best_of(candidates, **kwargs) if candidates > 1 else composer.next_bar_locked(**kwargs)
        bars.append(res)
        score += res['lockScore']
        count += len(bar)
    return bars, score / count


def lieder_reference(corpus, scores=60):
    rng = random.Random(1)
    stats = {'clash': [0, 0], 'doubled': [0, 0], 'unison': [0, 0], 'chordTone': [0, 0]}
    for sid, _ in rng.sample(corpus.rows('Lieder'), scores):
        score = corpus.score(sid)
        voice = [n for n in score.events if n.group is None and n.pitch is not None and not n.grace]
        piano = [n for n in score.events if n.group == 'keys' and n.pitch is not None and not n.grace]
        if not voice or not piano:
            continue
        analysis = analyze(score, 'Lieder')
        spans = sorted((score.measures[bar].onset + o, r, qy) for bar, changes in analysis['chords'].items()
                       for o, r, qy in changes)
        starts = [s[0] for s in spans]
        for v in voice:
            sounding = [p.pitch for p in piano if p.onset <= v.onset < p.onset + p.duration]
            for key in ('clash', 'doubled', 'unison'):
                stats[key][1] += 1
            stats['clash'][0] += any((q - v.pitch) % 12 in (1, 11) for q in sounding)
            stats['doubled'][0] += any((q - v.pitch) % 12 == 0 for q in sounding)
            stats['unison'][0] += v.pitch in sounding
            m = score.measures[v.bar]
            if v.onset - m.onset in (0, 2) and tuple(m.meter or ()) == (4, 4):
                j = bisect.bisect_right(starts, v.onset) - 1
                if j >= 0:
                    stats['chordTone'][1] += 1
                    stats['chordTone'][0] += v.pitch % 12 in chord_tones(spans[j][1], spans[j][2])
    return {k: round(a / max(1, b), 4) for k, (a, b) in stats.items()} | {'voiceNotes': stats['clash'][1]}


def section_accompany(model, vocab, corpus, audition: Path | None, seeds=6):
    conditions = {'melody locked': (1, False, 'after'), 'melody locked, best of 8': (8, False, 'after'),
                  'melody locked, best of 32': (32, False, 'after'), 'melody + chords locked': (1, True, 'after'),
                  'melody + chords locked, best of 8': (8, True, 'after'),
                  'melody locked, piano may double the voice first': (1, False, 'before'),
                  'melody locked, piano may double the voice first, best of 8': (8, False, 'before')}
    table = {}
    for name, (k, with_chords, unison) in conditions.items():
        rows, started = [], time.time()
        for tune in TUNES:
            for seed in range(1, seeds + 1 if k < 32 else min(seeds, 4) + 1):
                bars, logp = accompany(model, vocab, tune, seed, k, with_chords, unison)
                rows.append(dict(melody_metrics(TUNES[tune][0], bars), logp=logp))
                if audition is not None and seed == 1:
                    data = {'schema': 'v31-event-audition-2', 'bars': bars, 'qualityValidated': False}
                    slug = name.replace(' ', '-').replace(',', '').replace('+', 'and')
                    (audition / f'{tune}--{slug}.mid').write_bytes(to_midi(json.loads(json.dumps(data, default=str)),
                                                                           84.)[0])
        table[name] = {key: mean(rows, key) for key in rows[0]} | {
            'pieces': len(rows), 'secondsPerPiece': round((time.time() - started) / len(rows), 2)}
        print('accompany', name, table[name], flush=True)
    table['real Lieder (voice vs piano)'] = lieder_reference(corpus)
    return table


# ====================================================================== chords
def section_chords(model, vocab, seeds=6):
    prog = [[(0, 0, Q['maj'])], [(0, 5, Q['maj']), (2, 0, Q['maj'])], [(0, 5, Q['maj']), (2, 0, Q['maj'])],
            [(0, 7, Q['dom7']), (2, 0, Q['maj'])], [(0, 9, Q['min'])], [(0, 2, Q['min7']), (2, 7, Q['dom7'])],
            [(0, 0, Q['maj']), (2, 5, Q['maj'])], [(0, 7, Q['dom7']), (2, 0, Q['maj'])]]
    out = {}
    for label, locked in (('locked chords', True), ('the model\'s own chords', False)):
        tone = total = 0
        for seed in range(seeds):
            c = TaskComposer(model, vocab, seed=seed, key=(0, 0))
            for b in range(8):
                bar = c.next_bar_locked(groups=('woodwinds', 'keys'), chords=tuple(prog[b]) if locked else (),
                                        temperature=.9, top_p=.95)
                changes = [(F(x['onset']), x['root'], x['quality']) for x in bar['chords']]
                for n in bar['notes']:
                    if n['pitch'] is None or F(n['onset']) not in (0, 2):
                        continue
                    current = [x for x in changes if x[0] <= F(n['onset'])]
                    if current:
                        total += 1
                        tone += n['pitch'] % 12 in chord_tones(current[-1][1], current[-1][2])
        out[label] = {'strongBeatChordTones': round(tone / max(1, total), 4), 'notes': total}
    return out


# ====================================================================== orchestration
def section_orchestrate(model, vocab, corpus, windows=40):
    rows = {}
    for label, request_groups, doublings in (('groups not requested', False, False), ('groups requested', True, False),
                                             ('groups requested, light doublings (AIlegro Score)', True, True)):
        rng, hits = random.Random(4), Counter()
        for sid, score, b in corpus.windows('classical-scores', windows, rng, min_groups=3):
            analysis = analyze(score, 'classical-scores', None, b - 8, b)
            composer = with_context(model, vocab, score, analysis, b - 8, b, seed=1)
            if composer is None:
                continue
            _, notes = real_bar(vocab, score, b, analysis)
            reduction = {}
            for x in notes:
                if x.pitch == ABS_UNPITCHED or x.group >= 6 or GROUPS[x.group] == 'percussion':
                    continue
                e = reduction.setdefault((x.position, x.pitch), {'groups': set(), 'duration': 0})
                e['groups'].add(x.group)
                e['duration'] = max(e['duration'], vocab.value(x.duration_index))
            if not reduction:
                continue
            allowed = sorted({g for e in reduction.values() for g in e['groups']})
            context = [x for c in range(b - 8, b) for x in real_bar(vocab, score, c, analysis)[1]
                       if x.pitch != ABS_UNPITCHED and x.group in allowed]
            by_octave = {}
            for x in context:
                by_octave.setdefault(x.pitch // 12, Counter())[x.group] += 1
            locks = [Lock(onset=pos, pitch=p, duration=e['duration'], tag=(pos, p)) for (pos, p), e in reduction.items()]
            m = score.measures[b]
            spans = [(lk.onset, lk.onset + lk.duration, lk.pitch % 12) for lk in locks]
            sounding = lambda pos, g, p: p is not None and any(a <= pos < e and p % 12 == pc for a, e, pc in spans)  # noqa: E731
            bar = composer.next_bar_locked(length=m.duration, meter=tuple(m.meter), key=key_parts(analysis['keys'][b]),
                                           groups=[GROUPS[g] for g in allowed], locks=locks, free_notes=doublings,
                                           max_notes=len(locks) // 2, free_filter=sounding if doublings else None,
                                           chords=tuple(analysis['chords'].get(b, ())), request_groups=request_groups)
            hits['groupsUsedShare'] += len({n['group'] for n in bar['notes']}) / len(allowed)
            hits['bars'] += 1
            hits['doublings'] += sum(not n.get('locked') for n in bar['notes'])
            for note in (n for n in bar['notes'] if n.get('locked')):
                truth = reduction[note['tag']]['groups']
                hits['model'] += GROUPS.index(note['group']) in truth
                near = by_octave.get(note['pitch'] // 12)
                hits['register'] += (near.most_common(1)[0][0] if near else rng.choice(allowed)) in truth
                hits['chance'] += rng.choice(allowed) in truth
                hits['notes'] += 1
        rows[label] = {'model': round(hits['model'] / hits['notes'], 4),
                       'registerOfContext': round(hits['register'] / hits['notes'], 4),
                       'chance': round(hits['chance'] / hits['notes'], 4),
                       'groupsUsedPerBar': round(hits['groupsUsedShare'] / hits['bars'], 4),
                       'doublingsPerBar': round(hits['doublings'] / hits['bars'], 2),
                       'notes': hits['notes'], 'bars': hits['bars']}
        print('orchestrate', label, rows[label], flush=True)
    return rows


# ====================================================================== motif references
def _items(notes, tonic):
    base = tonic_ref(tonic)
    return {(F(n['onset']), n['pitch'] - base) for n in notes if n['pitch'] is not None}


def _jaccard(a, b):
    return len(a & b) / max(1, len(a | b))


def _top(notes):
    best = {}
    for n in notes:
        if n['pitch'] is not None and (F(n['onset']) not in best or n['pitch'] > best[F(n['onset'])]['pitch']):
            best[F(n['onset'])] = n
    return list(best.values())


def section_motif(model, vocab, corpus, windows=40):
    rng = random.Random(9)
    scores = {k: [] for k in ('restate: bank reference', 'restate: none', 'sequence +1: synthetic full texture',
                              'sequence +1: none', 'sequence +1: synthetic top line', 'invert: synthetic top line',
                              'invert: top line + lower accompaniment', 'invert: none', 'fragment: synthetic full texture',
                              'diminish: synthetic full texture')}
    for source in ('Lieder', 'classical-scores'):
        for sid, score, b in corpus.windows(source, windows // 2, rng):
            analysis = analyze(score, source, None, b - 8, b)
            base = with_context(model, vocab, score, analysis, b - 8, b, seed=2)
            m_prev = score.measures[b - 1]
            if base is None or m_prev.duration != score.measures[b].duration:
                continue
            tonic, mode = key_parts(analysis['keys'][b - 1])
            _, prev = real_bar(vocab, score, b - 1, analysis)
            notes = [{'onset': x.position, 'duration': vocab.value(x.duration_index),
                      'pitch': None if x.pitch == ABS_UNPITCHED else x.pitch, 'group': x.group} for x in prev]
            if len([x for x in notes if x['pitch'] is not None]) < 3:
                continue
            length = m_prev.duration
            kwargs = dict(length=length, meter=tuple(m_prev.meter), key=(tonic, mode),
                          groups=sorted({GROUPS[x['group']] for x in notes if x['group'] < 6}) or list(GROUPS))

            def run(reference, seed, target, top=False):
                bar = base.fork(seed).next_bar_locked(reference=reference, **kwargs)
                written = _top(bar['notes']) if top else bar['notes']
                return _jaccard(_items(written, tonic), _items(target, tonic))

            def synthetic(ns):
                return reference_from_notes(ns, vocab, tonic=tonic, length=length)

            scores['restate: bank reference'].append(run(base.bar_index - 1, 5, notes))
            scores['restate: none'].append(run(None, 5, notes))
            seq = transform_motif(notes, length, tonic=tonic, mode=mode, how='sequence', steps=1)[0]
            scores['sequence +1: synthetic full texture'].append(run(synthetic(seq), 6, seq))
            scores['sequence +1: none'].append(run(None, 6, seq))
            top = _top(notes)
            top_seq = transform_motif(top, length, tonic=tonic, mode=mode, how='sequence', steps=1)[0]
            scores['sequence +1: synthetic top line'].append(run(synthetic(top_seq), 7, top_seq, top=True))
            inv = transform_motif(top, length, tonic=tonic, mode=mode, how='invert')[0]
            low = min(n['pitch'] for n in inv if n['pitch'] is not None)
            rest = [n for n in notes if n not in top and (n['pitch'] is None or n['pitch'] < low)]
            scores['invert: synthetic top line'].append(run(synthetic(inv), 7, inv, top=True))
            scores['invert: top line + lower accompaniment'].append(run(synthetic(inv + rest), 7, inv, top=True))
            scores['invert: none'].append(run(None, 7, inv, top=True))
            for how in ('fragment', 'diminish'):
                full = transform_motif(notes, length, tonic=tonic, mode=mode, how=how, steps=-1 if how == 'fragment' else 0)[0]
                scores[f'{how}: synthetic full texture'].append(run(synthetic(full), 8, _top(full), top=True))
    return {k: round(float(np.mean(v)), 4) for k, v in scores.items() if v} | {'windows': len(scores['restate: none'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--checkpoint', type=Path, default=ROOT / 'runs/four-pillar-v31-ready-20261001/weights.pt')
    parser.add_argument('--output', type=Path, required=True, help='JSON report (refuses to overwrite)')
    parser.add_argument('--audition', type=Path, help='directory for listening MIDI (default: next to the report)')
    parser.add_argument('--sections', default='parts,accompany,chords,orchestrate,motif')
    parser.add_argument('--threads', type=int, default=2)
    args = parser.parse_args()
    if args.output.exists():
        raise SystemExit(f'{args.output} exists')
    torch.set_num_threads(args.threads)
    model, vocab, weights = load(args.checkpoint)
    corpus = Corpus()
    audition = args.audition or args.output.with_suffix('')
    audition.mkdir(parents=True, exist_ok=True)
    report = {'schema': 'four-pillar-v31-tasks-eval-1', 'checkpointStep': weights['step'],
              'note': 'training-set windows (no held-out split): compare conditions; listen to the MIDI files'}
    started = time.time()
    for section in args.sections.split(','):
        t = time.time()
        if section == 'parts':
            report['parts'] = section_parts(model, vocab, corpus)
        elif section == 'accompany':
            report['accompany'] = section_accompany(model, vocab, corpus, audition)
        elif section == 'chords':
            report['melodyFromChords'] = section_chords(model, vocab)
        elif section == 'orchestrate':
            report['orchestrate'] = section_orchestrate(model, vocab, corpus)
        elif section == 'motif':
            report['motif'] = section_motif(model, vocab, corpus)
        else:
            raise SystemExit(f'unknown section {section}')
        print(section, 'done in', round(time.time() - t), 's', flush=True)
    report['seconds'] = round(time.time() - started)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, indent=1, ensure_ascii=False))
    print(json.dumps({'output': str(args.output), 'audition': str(audition), 'seconds': report['seconds']}))


if __name__ == '__main__':
    main()
