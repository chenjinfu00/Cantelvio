"""Audited MIDI membership and a lazy, exact-tick adapter for four-pillar v1.

The existing SymphonyNet six-group arrays are an *index* of accepted source
files, not the score representation: their merged groups and 1/12 grid lose
track identity and fine timing. The v1 adapter reads the original MIDI only
when a member is sampled. MIDI has no sourced harmony/form/role/tuplet marks;
those targets stay unknown. No historical local-MIDI archive is imported.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from bisect import bisect_right
from collections import Counter, defaultdict
from dataclasses import dataclass, replace
from fractions import Fraction
from pathlib import Path

import numpy as np

from score_events_v2 import Measure, NoteEvent, Part, ScoreEvents
from four_pillar_v1_codec import encode_dynamic_score
from four_pillar_trial_data import summarize_bars
from four_pillar_codec import (BAR, DYNAMICS, GROUPS, GROUP_BASE, NONE, ROLES,
                               ROLE_BASE, WEDGES, WEDGE_BASE, _Reader)
from four_pillar_trial_model import PLAN_BARS

ROOT = Path(__file__).resolve().parents[1]
ORCHESTRA = ROOT / 'orchestra'
PREPARED = ORCHESTRA / 'work/data'
RAW = ORCHESTRA / 'work/raw'
LOCAL = ROOT / 'data/MIDI-Library'


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as source:
        for chunk in iter(lambda: source.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def source_path(row: dict) -> Path:
    if row['source'] == 'SymphonyNet':
        root, relative = RAW, row['name']
    elif row['source'] == 'MIDI-Library':
        root, relative = LOCAL, row['name']
    else:
        raise ValueError('unknown MIDI source')
    path = root / relative
    if not path.resolve().is_relative_to(root.resolve()) or path.suffix.lower() not in ('.mid', '.midi'):
        raise ValueError('MIDI path escapes its curated source')
    return path


def _classical_family(name: str) -> str:
    stem = Path(name).stem.lower()
    stem = re.sub(r'_\((?:c|nc)\).*$', '', stem)
    stem = re.sub(r'_\[[^]]+\]$', '', stem)
    # Group named movements conservatively; this may group an entire opus,
    # which is preferable to leaking two movements across the split.
    stem = re.sub(r'_(?:[0-9]{1,2}|[ivx]{1,4})(?:-[0-9]{1,2})?$', '', stem)
    return 'classical/' + stem


def _prefix_fingerprint(bar: np.ndarray, pos: np.ndarray, pitch: np.ndarray,
                        drum: np.ndarray) -> str | None:
    """Conservative transposition-invariant aligned-prefix family cue.

    It joins versions for splitting, not as evidence that complete works match.
    Different intros, offsets or revoicings can still escape this check.
    """
    pitched = np.flatnonzero(drum == 0)[:64]
    if len(pitched) < 64:
        return None
    p = pitch[pitched].astype(np.int16)
    if len(np.unique(p)) < 9:
        return None
    b = bar[pitched].astype(np.int32)
    q = pos[pitched].astype(np.int16)
    if b[-1] - b[0] > 32:
        return None
    values = np.stack((b - b[0], q - q[0], p - p[0]), axis=1).astype('<i4')
    return hashlib.sha256(values.tobytes()).hexdigest()[:24]


def _symphony_fingerprints(pieces: list[dict]) -> list[str | None]:
    lengths = {key: int((PREPARED / ('notes.' + key + '.bin')).stat().st_size // size)
               for key, size in [('bar', 4), ('pos', 1), ('pitch', 1), ('drum', 1)]}
    if len(set(lengths.values())) != 1:
        raise ValueError('prepared note columns have inconsistent lengths')
    total = lengths['bar']
    cols = {key: np.memmap(PREPARED / ('notes.' + key + '.bin'), mode='r', dtype=dtype)
            for key, dtype in [('bar', '<i4'), ('pos', 'u1'), ('pitch', 'u1'), ('drum', 'u1')]}
    fingerprints = []
    for piece in pieces:
        start, count = int(piece['noteOffset']), int(piece['notes'])
        if start < 0 or count < 0 or start + count > total:
            raise ValueError('piece points outside prepared note arrays')
        end = min(start + count, start + 256)
        fingerprints.append(_prefix_fingerprint(*(cols[key][start:end]
                                                  for key in ('bar', 'pos', 'pitch', 'drum'))))
    return fingerprints


def build_manifest(*, check_files: bool = True) -> dict:
    prep = json.loads((PREPARED / 'prepare.json').read_text())
    pieces = json.loads((PREPARED / 'pieces.json').read_text())
    local = json.loads((LOCAL / 'manifest.json').read_text())
    if len(pieces) != prep['kept'] or len(local['files']) != local['count']:
        raise ValueError('MIDI inventory no longer matches its preparation manifest')
    fingerprints = _symphony_fingerprints(pieces)
    rows = []
    for piece, fingerprint in zip(pieces, fingerprints):
        name = piece['name']
        category = Path(name).parts[2]
        if category not in ('classical', 'contemporary'):
            raise ValueError('unrecognized SymphonyNet category')
        row = {'source': 'SymphonyNet', 'name': name, 'legacySplit': piece['split'],
               'notes': piece['notes'], 'bars': piece['bars'],
               'family': (_classical_family(name) if category == 'classical'
                          else 'contemporary/' + Path(name).stem),
               'prefix': fingerprint}
        rows.append(row)
    # The six-group experiment discarded performances outside its fixed 1/12
    # grid and meters outside its tiny vocabulary.  This exact-tick model can
    # use many of them.  Re-run the old acceptance test on the files absent
    # from pieces.json: parseable misses are precisely its duplicate removals.
    # No old rejection or duplicate is silently assumed to be new material.
    sys.path.insert(0, str(ORCHESTRA))
    from prepare import parse as old_grid_parse
    previously_accepted = {piece['name'] for piece in pieces}
    source_files = sorted((path for path in RAW.rglob('*')
                           if path.is_file() and path.suffix.lower() in ('.mid', '.midi')),
                          key=lambda path: str(path.relative_to(RAW)))
    if len(source_files) != prep['files']:
        raise ValueError('SymphonyNet source inventory no longer matches preparation')
    raw_name_hash = hashlib.sha256('\n'.join(str(path.relative_to(RAW)) for path in source_files)
                                   .encode()).hexdigest()
    recovered, rejected = Counter(), Counter()
    for path in source_files:
        name = str(path.relative_to(RAW))
        if name in previously_accepted:
            continue
        old_arrays, old_result = old_grid_parse(path)
        if old_arrays is not None:
            rejected['duplicate'] += 1
            continue
        reason = old_result
        category = Path(name).parts[2]
        if category not in ('classical', 'contemporary'):
            raise ValueError('unrecognized SymphonyNet category')
        row = {'source': 'SymphonyNet', 'name': name, 'legacySplit': None,
               'legacySkip': reason, 'notes': None, 'bars': None,
               'family': (_classical_family(name) if category == 'classical'
                          else 'contemporary/' + Path(name).stem),
               'prefix': None, 'familyId': 'audit'}
        try:
            score, _, _, _ = _load_midi_score(row)
            if len(score.measures) < 2:
                raise ValueError('fewer than two exact-tick bars')
            row['notes'], row['bars'] = len(score.events), len(score.measures)
        except (ValueError, OverflowError, IndexError) as error:
            rejected[reason + ': ' + str(error)] += 1
            continue
        del row['familyId']
        rows.append(row)
        recovered[reason] += 1
    for entry in local['files']:
        rows.append({'source': 'MIDI-Library', 'name': entry['file'], 'legacySplit': None,
                     'notes': None, 'bars': None,
                     'family': 'local/' + re.sub(r'^\d+\s*-\s*', '', Path(entry['file']).stem).lower(),
                     'prefix': None, 'sha256': entry['sha256']})
    if check_files:
        for row in rows:
            path = source_path(row)
            if not path.is_file():
                raise FileNotFoundError(path)
            if row['source'] == 'MIDI-Library' and sha256(path) != row['sha256']:
                raise ValueError(f'curated MIDI changed: {row["name"]}')
    # Union of named classical works and identical, musically dense prefixes.
    # Historical split stays in each row as provenance, but the user explicitly
    # chose an all-training corpus until independent future validation arrives.
    parent = list(range(len(rows)))

    def find(i: int) -> int:
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    def union(i: int, j: int):
        a, b = find(i), find(j)
        parent[max(a, b)] = min(a, b)

    by_family, by_prefix, by_hash = {}, {}, {}
    for i, row in enumerate(rows):
        for index, key in ((by_family, row['family']), (by_prefix, row['prefix']),
                           (by_hash, row.get('sha256'))):
            if key is None:
                continue
            if key in index:
                union(i, index[key])
            else:
                index[key] = i
    members = defaultdict(list)
    for i in range(len(rows)):
        members[find(i)].append(i)
    for group in members.values():
        identities = sorted(rows[i]['source'] + '/' + rows[i]['name'] for i in group)
        family = hashlib.sha256('\n'.join(identities).encode()).hexdigest()[:20]
        for i in group:
            rows[i]['split'], rows[i]['familyId'] = 'train', family
    counts = {source: dict(Counter(row['split'] for row in rows if row['source'] == source))
              for source in ('SymphonyNet', 'MIDI-Library')}
    if any(counts[source].get('train', 0) != sum(counts[source].values()) for source in counts):
        raise ValueError('all curated MIDI must be training-only')
    return {'schema': 'four-pillar-midi-all-train-v1',
            'purpose': 'private four-pillar v1 training only; independent future validation pending',
            'sourceHashes': {'preparedPieces': sha256(PREPARED / 'pieces.json'),
                             'preparedSummary': sha256(PREPARED / 'prepare.json'),
                             'curatedLocal': sha256(LOCAL / 'manifest.json'),
                             'rawNames': raw_name_hash},
            'recoveredFromOldGridRejects': dict(recovered),
            'stillRejected': dict(rejected),
            'rules': ['existing accepted SymphonyNet plus exact-tick salvage of old off-grid/meter/short rejects; old duplicate matches remain excluded',
                      'current 117-file curated MIDI-Library only; no historical local-MIDI archive',
                      'all accepted source files, including historical holdouts, are training-only by user choice',
                      'classical filename families and dense aligned-prefix matches are retained as provenance',
                      'original MIDI is read lazily; no lossy note-array export is treated as a score'],
            'counts': counts, 'families': len(members), 'rows': rows}


def verify_manifest(manifest: dict) -> None:
    """Fast source/inventory check against an already frozen, fully audited set."""
    if manifest.get('schema') != 'four-pillar-midi-all-train-v1':
        raise ValueError('unexpected MIDI membership schema')
    expected_hashes = {'preparedPieces': sha256(PREPARED / 'pieces.json'),
                       'preparedSummary': sha256(PREPARED / 'prepare.json'),
                       'curatedLocal': sha256(LOCAL / 'manifest.json')}
    source_files = sorted((path for path in RAW.rglob('*')
                           if path.is_file() and path.suffix.lower() in ('.mid', '.midi')),
                          key=lambda path: str(path.relative_to(RAW)))
    expected_hashes['rawNames'] = hashlib.sha256('\n'.join(
        str(path.relative_to(RAW)) for path in source_files).encode()).hexdigest()
    if manifest.get('sourceHashes') != expected_hashes:
        raise ValueError('MIDI source inventory or preparation changed')
    if len(source_files) != json.loads((PREPARED / 'prepare.json').read_text())['files']:
        raise ValueError('SymphonyNet raw source count changed')
    rows = manifest['rows']
    if len({(row['source'], row['name']) for row in rows}) != len(rows):
        raise ValueError('duplicate membership rows')
    actual_counts = {source: dict(Counter(row['split'] for row in rows
                                          if row['source'] == source))
                     for source in ('SymphonyNet', 'MIDI-Library')}
    if actual_counts != manifest['counts'] or any(row['split'] != 'train' for row in rows):
        raise ValueError('MIDI membership is not the approved all-training set')
    curated = {row['file']: row['sha256'] for row in json.loads(
        (LOCAL / 'manifest.json').read_text())['files']}
    if {row['name']: row['sha256'] for row in rows if row['source'] == 'MIDI-Library'} != curated:
        raise ValueError('curated MIDI membership changed')
    for row in rows:
        path = source_path(row)
        if not path.is_file():
            raise FileNotFoundError(path)
        if row['source'] == 'MIDI-Library' and sha256(path) != row['sha256']:
            raise ValueError('curated MIDI changed: ' + row['name'])


def _load_midi_score(row: dict) -> tuple[ScoreEvents, dict[int, int], tuple[bool, ...], tuple[float | None, ...]]:
    """Convert one accepted MIDI into exact-quarter-note events, preserving tracks.

    Bar metadata uses a 4/4 scaffold when the file lacks a time signature;
    callers must mask those synthetic bar targets. MIDI velocity and explicit
    tempo remain source sidecars until their v1 target heads are wired.
    """
    from symusic import Score
    from orchestra_midi_groups import group_of  # one adapter to the existing mapping

    path = source_path(row)
    score = Score(str(path))
    tpq = int(score.ticks_per_quarter)
    if tpq <= 0:
        raise ValueError('MIDI has invalid ticks per quarter')
    raw = []
    part_info = {}
    for ti, track in enumerate(score.tracks):
        for note in track.notes:
            pitch = int(note.pitch)
            group = group_of(int(track.program), pitch, bool(track.is_drum))
            if group is None or note.duration <= 0:
                continue
            part_id = f'track-{ti}-{group}'
            part_info.setdefault(part_id, (ti, int(track.program), group))
            raw.append((int(note.time), int(note.duration), pitch, int(note.velocity),
                        part_id, bool(track.is_drum), group))
    if not raw:
        raise ValueError('MIDI has no mapped notes')
    last_tick = max(t + d for t, d, *_ in raw)
    signatures = {int(s.time): (int(s.numerator), int(s.denominator))
                  for s in score.time_signatures if s.time >= 0}
    if 0 not in signatures:
        signatures[0] = (4, 4)
    ordered = sorted(signatures.items())
    starts, measures = [], []
    for si, (tick, meter) in enumerate(ordered):
        if tick >= last_tick:
            break
        end = ordered[si + 1][0] if si + 1 < len(ordered) else last_tick
        length = Fraction(meter[0] * 4 * tpq, meter[1])
        if length <= 0:
            raise ValueError('invalid MIDI time signature')
        cursor = Fraction(tick)
        while cursor < end:
            actual = min(length, end - cursor) if si + 1 < len(ordered) else length
            starts.append(cursor)
            measures.append(Measure(len(measures), cursor / tpq, actual / tpq,
                                    meter, actual != length, None))
            cursor += length
    if not measures:
        raise ValueError('MIDI has no measures')
    parts = tuple(Part(key, i, key, '', group, program, 'midi-gm')
                  for i, (key, (_, program, group)) in enumerate(sorted(
                      part_info.items(), key=lambda item: (item[1][0], item[0]))))
    events = []
    velocities = {}
    for source_index, (tick, duration, pitch, velocity, part, drum, group) in enumerate(raw):
        bar = bisect_right(starts, tick) - 1
        if bar < 0 or Fraction(tick) >= starts[bar] + measures[bar].duration * tpq:
            raise ValueError('MIDI note lies outside derived measure')
        events.append(NoteEvent(source_index, Fraction(tick, tpq), Fraction(duration, tpq),
                                bar, part, '1', '1', None if drum else pitch,
                                None, group, None, None, None, None, 0, False, drum))
        velocities[source_index] = velocity
    order = {part.id: part.index for part in parts}
    events.sort(key=lambda n: (n.onset, order[n.part], n.staff, n.voice,
                               -1 if n.pitch is None else n.pitch, n.source_index))
    first_explicit = min((int(s.time) for s in score.time_signatures), default=None)
    meter_known = tuple(first_explicit is not None and m.onset * tpq >= first_explicit
                        for m in measures)
    tempos = sorted((Fraction(int(t.time), tpq), float(t.qpm)) for t in score.tempos
                    if t.qpm > 0)
    tempo_times = [time for time, _ in tempos]
    bar_tempos = tuple((tempos[j][1] if (j := bisect_right(tempo_times, m.onset) - 1) >= 0
                        else None) for m in measures)
    result = ScoreEvents('midi:' + row['source'] + ':' + row['name'], row['source'], None,
                         None, None, row['familyId'], row.get('sha256'),
                         parts, tuple(measures), tuple(events))
    return result, velocities, meter_known, bar_tempos


def load_midi_score(row: dict) -> ScoreEvents:
    return _load_midi_score(row)[0]


def slice_score(score: ScoreEvents, first_bar: int, last_bar: int) -> ScoreEvents:
    if not 0 <= first_bar < last_bar <= len(score.measures):
        raise ValueError('invalid MIDI score slice')
    measures = tuple(replace(m, index=m.index - first_bar)
                     for m in score.measures[first_bar:last_bar])
    events = tuple(replace(n, bar=n.bar - first_bar)
                   for n in score.events if first_bar <= n.bar < last_bar)
    return replace(score, measures=measures, events=events)


def _mask_midi_notation(encoded, meter_known: tuple[bool, ...]):
    """MIDI does not tell us written pitch, tuplet spelling or score marks."""
    mask = list(encoded.loss_mask)
    for bar, (start, _) in enumerate(encoded.bar_spans):
        reader = _Reader(encoded.tokens)
        reader.i = start
        reader.expect(BAR)
        reader.fraction(); reader.fraction(); reader.uint(); reader.uint()
        if not meter_known[bar]:
            mask[start:reader.i] = [False] * (reader.i - start)
    for start, end in encoded.note_spans:
        reader = _Reader(encoded.tokens)
        reader.i = start + 2  # NOTE, VOICE_CHOICE
        reader.label(GROUPS, GROUP_BASE)
        reader.label(ROLES, ROLE_BASE)
        reader.pop()  # sounding pitch or UNPITCHED
        reader.fraction()  # MIDI note duration is known
        # Every following field is notation-only, unavailable in MIDI.
        mask[reader.i:end] = [False] * (end - reader.i)
    return replace(encoded, loss_mask=tuple(mask))


@dataclass
class MidiItem:
    score: ScoreEvents
    piece: None
    encoded: object
    summaries: np.ndarray
    bar_steps: tuple
    velocities: dict[int, int]
    meter_known: tuple[bool, ...]
    bar_tempos: tuple[float | None, ...]
    first_source_bar: int
    target_relative_bar: int


def midi_item_from_score(parsed, *, target_bar: int, history_bars: int = 32) -> MidiItem:
    score, velocities, meter_known, bar_tempos = parsed
    if not 1 <= target_bar < len(score.measures):
        raise ValueError('MIDI target needs at least one past bar')
    first = max(0, target_bar - history_bars)
    last = min(len(score.measures), target_bar + PLAN_BARS)
    excerpt = slice_score(score, first, last)
    encoded = _mask_midi_notation(encode_dynamic_score(excerpt), meter_known[first:last])
    return MidiItem(excerpt, None, encoded, summarize_bars(excerpt), (),
                    velocities, meter_known[first:last], bar_tempos[first:last],
                    first, target_bar - first)


def load_midi_item(row: dict, *, target_bar: int, history_bars: int = 32) -> MidiItem:
    return midi_item_from_score(_load_midi_score(row), target_bar=target_bar,
                                history_bars=history_bars)


def make_midi_example(item: MidiItem, *, context: int = 256):
    """Use only source-known targets; velocity attaches after its note is read."""
    import torch
    from four_pillar_v1_pilot_data import make_example

    bar = item.target_relative_bar
    inputs, targets = make_example(item, bar, context=context)
    start, _ = item.encoded.bar_spans[bar]
    steps = targets['event'].shape[1]
    velocity = torch.zeros(1, steps)
    velocity_known = torch.zeros(1, steps, dtype=torch.bool)
    by_source = {n.source_index: n for n in item.score.events}
    for (note_start, note_end), source_index in zip(item.encoded.note_spans,
                                                    item.encoded.source_indices):
        index = note_end - start
        if note_start >= start and 0 <= index < steps:
            velocity[0, index] = item.velocities[source_index] / 127.0
            velocity_known[0, index] = True
    targets['midi_velocity'] = velocity
    targets['midi_velocity_known'] = velocity_known
    previous = item.bar_tempos[bar - 1]
    if previous is not None:
        inputs['log_qpm'] = torch.tensor([float(np.log(previous))])
        inputs['tempo_known'] = torch.tensor([True])
    count = min(PLAN_BARS, len(item.score.measures) - bar)
    change = torch.zeros(1, PLAN_BARS)
    delta = torch.zeros(1, PLAN_BARS)
    known = torch.zeros(1, PLAN_BARS, dtype=torch.bool)
    prior = previous
    for offset in range(count):
        current = item.bar_tempos[bar + offset]
        if prior is not None and current is not None:
            delta[0, offset] = float(np.log(current / prior))
            change[0, offset] = float(abs(float(delta[0, offset])) > 1e-6)
            known[0, offset] = True
        prior = current
    targets.update(tempo_change=change, tempo_change_known=known,
                   tempo_delta=delta, tempo_delta_known=known)
    groups = ('woodwinds', 'brass', 'percussion', 'keys', 'high_strings', 'low_strings')
    activity = torch.zeros(1, PLAN_BARS, 6)
    activity_known = torch.zeros(1, PLAN_BARS, 6, dtype=torch.bool)
    for offset in range(count):
        activity_known[0, offset] = True
    for note in item.score.events:
        if bar <= note.bar < bar + count and note.group in groups:
            activity[0, note.bar - bar, groups.index(note.group)] = 1.0
    targets['group_activity'], targets['group_activity_known'] = activity, activity_known
    # If barlines were inferred from a MIDI with no explicit meter, form
    # summaries are useful as context but not a source-known planning target.
    for offset in range(count):
        if not item.meter_known[bar + offset]:
            targets['form_summary_known'][0, offset] = False
    return inputs, targets


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--check-files', action='store_true')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output already exists; preserve the frozen membership and choose a new path')
    manifest = build_manifest(check_files=args.check_files)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, separators=(',', ':')))
    print(json.dumps({'output': str(args.output), 'counts': manifest['counts'],
                      'families': manifest['families']}, ensure_ascii=False))


if __name__ == '__main__':
    main()
