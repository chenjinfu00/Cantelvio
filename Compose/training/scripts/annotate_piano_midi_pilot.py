#!/usr/bin/env python3
"""Build a review-only joint-model annotation from matching piano MIDI/MusicXML.

The ordinary Mutopia Op.10 No.1 score has no independent melody or chord labels.
MusicXML supplies notation, while MIDI supplies matching note events. Neither
missing field is fabricated merely to pass an existing training-data filter.
"""
import argparse
from collections import Counter, defaultdict
from fractions import Fraction
import hashlib
import json
from pathlib import Path
import sys
import xml.etree.ElementTree as ET

from symusic import Score

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from build_joint_expression import children, parse_part  # noqa: E402

QUALITIES = json.loads((ROOT / 'data/chord-qualities.json').read_text())
NAMES = ('C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B')


def sha256(path):
    h = hashlib.sha256()
    with path.open('rb') as f:
        for block in iter(lambda: f.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def harmony_candidates(events, bar):
    weights = Counter()
    for e in events:
        if e['bar'] == bar:
            weights[e['pitch'] % 12] += 1 + min(float(Fraction(e['notatedDurationQuarter'])), 2) * .12
    if not weights:
        return []
    bass = [e for e in events if e['bar'] == bar and e['candidateRole'] == 'B']
    bass_pc = min(bass, key=lambda e: (e['startTick'], e['pitch']))['pitch'] % 12 if bass else None
    total = sum(weights.values())
    ranked = []
    for root in range(12):
        for quality in QUALITIES:
            pcs = {(root + interval) % 12 for interval in quality['intervals']}
            coverage = sum(v for pc, v in weights.items() if pc in pcs) / total
            completeness = len(pcs & weights.keys()) / len(pcs)
            score = coverage + .22 * completeness - .05 * max(0, len(pcs) - 3)
            if root == bass_pc:
                score += .06
            ranked.append({'label': NAMES[root] + quality['suffix'], 'root': root,
                           'quality': quality['id'], 'coverage': round(coverage, 4),
                           'completeness': round(completeness, 4), 'score': round(score, 4)})
    return sorted(ranked, key=lambda c: c['score'], reverse=True)[:3]


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('midi', type=Path)
    ap.add_argument('musicxml', type=Path)
    ap.add_argument('output', type=Path)
    a = ap.parse_args()
    if a.output.exists():
        ap.error('candidate output exists; choose a new name rather than overwriting it')
    score = Score(str(a.midi))
    parts = children(ET.parse(a.musicxml).getroot(), 'part')
    if len(score.tracks) != 2 or len(parts) != 2:
        raise ValueError('expected the original two-staff piano score')
    if [(t.name.strip().lower(), int(t.program)) for t in score.tracks] != [('up', 0), ('down', 0)]:
        raise ValueError('MIDI tracks are not the reviewed piano up/down pair')
    if not score.time_signatures or any((int(t.time), int(t.numerator), int(t.denominator)) != (0, 4, 4)
                                        for t in score.time_signatures):
        raise ValueError('the reviewed source must be wholly 4/4')
    bar_count = len(children(parts[0], 'measure'))
    if any(len(children(p, 'measure')) != bar_count for p in parts):
        raise ValueError('score parts have different measure counts')
    starts = [Fraction(4 * i) for i in range(bar_count)]
    notation = [parse_part(p, starts) for p in parts]
    tpq = score.ticks_per_quarter
    events = []
    for track_index, (track, notes) in enumerate(zip(score.tracks, notation)):
        lookup = defaultdict(list)
        for note in notes:
            lookup[(note['on'], note['pitch'])].append(note)
        if len(track.notes) != len(notes):
            raise ValueError(f'track {track_index}: MIDI/MusicXML note counts differ')
        for note_index, midi_note in enumerate(track.notes):
            onset = Fraction(int(midi_note.time), tpq)
            key = (onset, int(midi_note.pitch))
            if not lookup[key]:
                raise ValueError(f'track {track_index}: no exact score note at {key}')
            score_note = lookup[key].pop(0)
            if (onset * 4).denominator != 1:
                raise ValueError('off-sixteenth onset needs separate alignment')
            step = int(onset * 4)
            events.append({'track': track_index, 'noteIndex': note_index,
                           'pitch': int(midi_note.pitch), 'startTick': int(midi_note.time),
                           'durationTick': int(midi_note.duration), 'velocity': int(midi_note.velocity),
                           'step': step, 'bar': step // 16, 'onsetQuarter': str(onset),
                           'midiDurationQuarter': str(Fraction(int(midi_note.duration), tpq)),
                           'notatedDurationQuarter': str(score_note['dur']),
                           'explicitTuplet': score_note['ratio'],
                           'notatedDynamic': (None if score_note['dynamic'] == 'unknown' else score_note['dynamic']),
                           'accent': score_note['accent'], 'wedge': score_note['wedge']})
        if any(lookup.values()):
            raise ValueError(f'track {track_index}: unmatched MusicXML notes')
    events.sort(key=lambda e: (e['startTick'], e['track'], e['pitch'], e['noteIndex']))
    total_steps = bar_count * 16
    down = [i for i, e in enumerate(events) if e['track'] == 1]
    selected_bass = []
    for step in range(total_steps):
        tick = step * tpq // 4
        active = [i for i in down if events[i]['startTick'] <= tick < events[i]['startTick'] + events[i]['durationTick']]
        selected_bass.append(min(active, key=lambda i: (events[i]['pitch'], events[i]['startTick'])) if active else None)
    bass_notes = set(i for i in selected_bass if i is not None)
    for i, event in enumerate(events):
        event['candidateRole'] = 'B' if i in bass_notes else 'R'
        event['roleProvenance'] = 'lowest_sounding_lower_staff' if i in bass_notes else 'piano_accompaniment'
    accompaniment = [e for e in events if e['candidateRole'] == 'R']
    onsets = Counter(e['step'] for e in accompaniment)
    coarse = []
    for step, bass in enumerate(selected_bass):
        tick = step * tpq // 4
        rhythm = ('multi_onset' if onsets[step] >= 2 else 'one_onset' if onsets[step] == 1 else
                  'hold' if any(e['startTick'] <= tick < e['startTick'] + e['durationTick'] for e in accompaniment)
                  else 'rest')
        previous = selected_bass[step - 1] if step else None
        coarse.append({'step': step, 'bar': step // 16, 'pos': step % 16, 'R': rhythm,
                       'B': ({'state': 'rest'} if bass is None else {'state': 'hold'} if bass == previous else
                             {'state': 'onset', 'pitch': events[bass]['pitch']}),
                       'M': {'state': 'unknown'}})
    harmony = []
    for bar in range(bar_count):
        candidates = harmony_candidates(events, bar)
        top = candidates[0] if candidates else None
        gap = round(top['score'] - candidates[1]['score'], 4) if len(candidates) > 1 else 0
        status = ('plausible' if top and top['coverage'] >= .90 and top['completeness'] == 1 and gap >= .06
                  else 'needs_review')
        harmony.append({'bar': bar + 1, 'status': status, 'scoreGap': gap,
                        'candidates': candidates, 'acceptedTrainingLabel': None})
    report = {'schema': 'ailegro-score-aligned-piano-candidate-v1', 'status': 'candidate_not_training_ready',
              'source': {'midi': str(a.midi), 'midiSha256': sha256(a.midi),
                         'musicxml': str(a.musicxml), 'musicxmlSha256': sha256(a.musicxml),
                         'ticksPerQuarter': tpq, 'meter': '4/4', 'barCount': bar_count,
                         'tempoQpm': float(score.tempos[0].qpm),
                         'sourceKeySignature': 'C major; local changes not analyzed',
                         'workFamily': 'chopin-op10-no01'},
              'evidence': {'exactScoreMidiNoteMatches': len(events), 'unmatchedScoreNotes': 0,
                           'unmatchedMidiNotes': 0, 'scoreTupletMarks': sum(e['explicitTuplet'] != 'none' for e in events),
                           'knownScoreDynamics': sum(e['notatedDynamic'] is not None for e in events)},
              'knownFieldPolicy': {'M': 'unknown_not_rest', 'H': 'candidate_only',
                                   'sourcePitchOnsetNotationDuration': 'observed',
                                   'explicitTuplet': 'observed_none', 'scoreDynamic': 'unknown'},
              'eventCounts': dict(Counter(e['candidateRole'] for e in events)),
              'harmony': harmony, 'events': events, 'coarseSteps': coarse}
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(report, ensure_ascii=False, indent=1) + '\n')
    print(json.dumps({'output': str(a.output), 'bars': bar_count, 'events': len(events),
                      'R/B': report['eventCounts'], 'plausibleChordBars': sum(h['status'] == 'plausible' for h in harmony),
                      'scoreMidiMatches': report['evidence']['exactScoreMidiNoteMatches']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
