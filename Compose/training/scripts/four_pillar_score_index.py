"""Small random-access index for all selected Lieder and classical scores.

It stores compressed score records, not another copy of the source archives.
The original work/split and exact notation remain attached to every item.
"""
from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import tarfile
import xml.etree.ElementTree as ET
import zlib
from collections import Counter
from pathlib import Path

from four_pillar_midi_data import ROOT, sha256
from prepare_classical_scores import (as_fraction, child, children, score_events,
                                      tag, value, xml_from_mxl)
from score_events_v2 import ScoreEvents

CLASSICAL = ROOT / 'data/classical-score-v1'
JOINT = ROOT / 'data/joint/lieder-joint.json'
LIEDER = ROOT / 'data/sources/OpenScore-Lieder-38c5db5.tar.gz'
MIDI_MEMBERSHIP = ROOT / 'data/four-pillar-midi-all-train-v1.json'


def repair_overlong_backups(root: ET.Element) -> list[dict]:
    """Clamp impossible MusicXML voice rewinds in memory, never in the archive.

    A backup that rewinds before the start of its own measure is invalid.  The
    least assumptive recovery is to start that voice at beat zero; advancing
    later voices or notes would invent musical timing instead.
    """
    repairs = []
    for part in children(root, 'part'):
        divisions = 1
        for measure in children(part, 'measure'):
            cursor = previous = 0
            for item in measure:
                kind = tag(item)
                if kind == 'attributes':
                    divisions = int(value(item, 'divisions', divisions))
                    if divisions <= 0:
                        raise ValueError('nonpositive divisions')
                elif kind in ('backup', 'forward'):
                    raw_duration = as_fraction(value(item, 'duration', 0))
                    delta = raw_duration / divisions
                    if kind == 'backup' and delta > cursor:
                        corrected = cursor * divisions
                        if corrected.denominator != 1:
                            raise ValueError('backup repair is not representable in divisions')
                        duration_node = child(item, 'duration')
                        if duration_node is None:
                            raise ValueError('backup without duration')
                        duration_node.text = str(corrected.numerator)
                        repairs.append({'part': part.attrib.get('id'),
                                        'measure': measure.attrib.get('number'),
                                        'original': str(raw_duration),
                                        'corrected': str(corrected.numerator)})
                        delta = cursor
                    cursor += -delta if kind == 'backup' else delta
                elif kind == 'note':
                    duration = as_fraction(value(item, 'duration', 0)) / divisions
                    if child(item, 'chord') is None:
                        previous = cursor
                        cursor += duration
    return repairs


def open_index(path: Path):
    db = sqlite3.connect(f'file:{path}?mode=ro', uri=True)
    return db


def get_score(db, score_id: str) -> ScoreEvents:
    record = db.execute('SELECT payload FROM scores WHERE score_id=?', (score_id,)).fetchone()
    if record is None:
        raise KeyError(score_id)
    return ScoreEvents.from_candidate(json.loads(zlib.decompress(record[0])))


def index_rows(db, *, source: str, split: str) -> list[tuple[str, int]]:
    return db.execute('SELECT score_id, bars FROM scores WHERE source=? AND split=? ORDER BY score_id',
                      (source, split)).fetchall()


def build(path: Path, *, midi_membership: Path = MIDI_MEMBERSHIP) -> dict:
    if path.exists():
        raise FileExistsError(path)
    midi = json.loads(midi_membership.read_text())
    if midi.get('schema') != 'four-pillar-midi-all-train-v1' or any(
            row['split'] != 'train' for row in midi['rows']):
        raise ValueError('score index requires the approved training-only MIDI membership')
    catalog = json.loads((CLASSICAL / 'catalog.json').read_text())
    accepted = {row['scoreId']: row for row in catalog if row.get('status') == 'candidate'}
    parent = path.parent
    parent.mkdir(parents=True, exist_ok=True)
    db = sqlite3.connect(path)
    try:
        db.execute('CREATE TABLE scores (score_id TEXT PRIMARY KEY, source TEXT NOT NULL, '
                   'split TEXT NOT NULL, composition_key TEXT NOT NULL, bars INTEGER NOT NULL, '
                   'payload BLOB NOT NULL)')
        db.execute('CREATE INDEX by_source_split ON scores(source, split)')
        def add(record: dict, source: str, split: str, key: str):
            score = ScoreEvents.from_candidate(record)
            db.execute('INSERT INTO scores VALUES (?,?,?,?,?,?)',
                       (score.score_id, source, split, key, len(score.measures),
                        zlib.compress(json.dumps(record, ensure_ascii=False,
                                                 separators=(',', ':')).encode(), 6)))

        # Preserve the legacy split in the original metadata; the user has
        # explicitly chosen to use every currently selected song for training.
        old_meta = json.loads(JOINT.read_text())
        selected = {('OpenScore-Lieder/scores/' + r['workId'] + '/' + r['scoreId'] + '.mxl'): r
                    for r in old_meta['records'] if r.get('reject') is None}
        seen = set()
        failures = []
        repaired = []
        with tarfile.open(LIEDER, 'r:gz') as tar:
            for member in tar:
                row = selected.get(member.name)
                if row is None:
                    continue
                stream = tar.extractfile(member)
                if stream is None:
                    raise ValueError('missing score archive member: ' + member.name)
                try:
                    root = ET.fromstring(xml_from_mxl(stream.read()))
                    corrections = repair_overlong_backups(root)
                    parts, measures, notes, _ = score_events(root)
                    record = {'scoreId': row['scoreId'], 'source': 'OpenScore Lieder',
                              'compositionKey': row['workId'],
                              'parts': [dict(id=identity, **info) for identity, info in parts],
                              'measures': measures, 'notes': notes}
                    add(record, 'Lieder', 'train', row['workId'])
                    if corrections:
                        repaired.append({'scoreId': row['scoreId'], 'corrections': corrections})
                except (ValueError, ET.ParseError) as error:
                    failures.append({'scoreId': row['scoreId'], 'member': member.name,
                                     'error': str(error)})
                seen.add(member.name)
        if seen != set(selected):
            raise ValueError(f'{len(set(selected) - seen)} Lieder source scores missing')
        with gzip.open(CLASSICAL / 'scores.jsonl.gz', 'rt') as source:
            for line in source:
                record = json.loads(line)
                row = accepted.get(record['scoreId'])
                if row is None:
                    continue
                if row['scoreSha256'] != record['scoreSha256']:
                    raise ValueError('classical score changed after catalog')
                key = row['compositionKey']
                add(record, 'classical-scores', 'train', key)
        summary = {source: dict(Counter(split for (split,) in db.execute(
                       'SELECT split FROM scores WHERE source=?', (source,))))
                   for source in ('Lieder', 'classical-scores')}
        if sum(summary['Lieder'].values()) + len(failures) != old_meta['kept'] or sum(summary['classical-scores'].values()) != len(accepted):
            raise ValueError('not every accepted score entered the index')
        if any(summary[source].get('train', 0) != sum(summary[source].values()) for source in summary):
            raise ValueError('score index is not training-only')
        metadata = {'schema': 'four-pillar-score-all-train-v1', 'counts': summary,
                    'liederFailures': failures, 'liederRepairs': repaired,
                    'sourceHashes': {'liederArchive': sha256(LIEDER),
                                     'liederJoint': sha256(JOINT),
                                     'classicalCatalog': sha256(CLASSICAL / 'catalog.json'),
                                     'classicalScores': sha256(CLASSICAL / 'scores.jsonl.gz'),
                                     'classicalOverlap': sha256(CLASSICAL / 'overlap-audit.json'),
                                     'midiMembership': sha256(midi_membership)},
                    'rules': ['all selected Lieder scores enter training after minimal in-memory XML correction; failed IDs are listed',
                              'all 303 valid classical score candidates enter training',
                              'historical score and MIDI split labels are provenance only',
                              'there is no internal validation until an independent corpus arrives']}
        db.execute('CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
        db.execute('INSERT INTO metadata VALUES (?,?)', ('manifest', json.dumps(metadata, ensure_ascii=False)))
        db.commit()
        return metadata
    except BaseException:
        db.close()
        path.unlink(missing_ok=True)
        raise
    finally:
        db.close()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output', type=Path,
                        default=ROOT / 'data/four-pillar-score-all-train-v1.sqlite')
    args = parser.parse_args()
    result = build(args.output)
    print(json.dumps({'path': str(args.output), **result}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
