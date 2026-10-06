#!/usr/bin/env python3
"""Extract explicit score tempo and numeric dynamics without inventing missing labels.

Produces a separate candidate sidecar. It never changes the deployed model, the
existing joint expression vocabulary, or any prior train/validation/test split.
"""

import argparse
from collections import defaultdict
from fractions import Fraction
import gzip
import hashlib
from io import BytesIO
import json
import math
from pathlib import Path
import tarfile
import xml.etree.ElementTree as ET
import zipfile


ROOT = Path(__file__).resolve().parents[1]
SOURCES = ROOT / 'data/sources'
QUARTERS = {'whole': 4, 'half': 2, 'quarter': 1, 'eighth': .5,
            '16th': .25, '32nd': .125, '64th': .0625}


def tag(node):
    return node.tag.rsplit('}', 1)[-1]


def children(node, name):
    return [x for x in node if tag(x) == name] if node is not None else []


def child(node, name):
    return next(iter(children(node, name)), None)


def value(node, name, default=None):
    item = child(node, name)
    return item.text.strip() if item is not None and item.text else default


def numeric(raw):
    try:
        result = float(raw)
    except (TypeError, ValueError):
        return None
    return result if math.isfinite(result) and result > 0 else None


def metronome_qpm(direction):
    for dtype in children(direction, 'direction-type'):
        for metro in children(dtype, 'metronome'):
            beats = children(metro, 'beat-unit')
            per_minute = numeric(value(metro, 'per-minute'))
            if len(beats) != 1 or per_minute is None:
                continue
            unit = QUARTERS.get((beats[0].text or '').strip())
            if unit is None:
                continue
            dots = len(children(metro, 'beat-unit-dot'))
            return per_minute * unit * sum(.5 ** i for i in range(dots + 1))
    return None


def score_xml(data, name):
    if name.endswith('.mxl'):
        with zipfile.ZipFile(BytesIO(data)) as zipped:
            candidates = [n for n in zipped.namelist()
                          if n.lower().endswith('.xml') and not n.startswith('META-INF/')]
            if not candidates:
                raise ValueError('MXL has no score XML')
            return ET.fromstring(zipped.read(candidates[0]))
    return ET.fromstring(data)


def scan_score(root):
    raw, unparsed_metronomes, word_directions = [], 0, 0
    for part in children(root, 'part'):
        part_id = part.attrib.get('id', '')
        divisions = 1
        for bar, measure in enumerate(children(part, 'measure')):
            cursor = Fraction(0)
            for item in measure:
                kind = tag(item)
                if kind == 'attributes':
                    divisions = int(value(item, 'divisions', divisions))
                    if divisions <= 0:
                        raise ValueError('nonpositive divisions')
                elif kind in ('backup', 'forward'):
                    delta = Fraction(value(item, 'duration', 0)) / divisions
                    cursor += -delta if kind == 'backup' else delta
                elif kind == 'note':
                    if child(item, 'chord') is None:
                        cursor += Fraction(value(item, 'duration', 0)) / divisions
                elif kind in ('direction', 'sound'):
                    offset = cursor
                    if kind == 'direction':
                        offset += Fraction(value(item, 'offset', 0)) / divisions
                        for dtype in children(item, 'direction-type'):
                            word_directions += len(children(dtype, 'words'))
                    if offset < 0:
                        continue
                    sounds = children(item, 'sound') if kind == 'direction' else [item]
                    found_sound_tempo = False
                    for sound in sounds:
                        qpm = numeric(sound.attrib.get('tempo'))
                        if qpm is not None:
                            raw.append(('tempo-qpm', bar, str(offset), round(qpm, 6), 'sound', part_id))
                            found_sound_tempo = True
                        dynamic = numeric(sound.attrib.get('dynamics'))
                        if dynamic is not None:
                            # MusicXML sound dynamics is a performance percentage,
                            # not an original MIDI velocity or a printed p/f mark.
                            raw.append(('sound-dynamics', bar, str(offset), round(dynamic, 6),
                                        'sound', part_id))
                    if kind == 'direction' and not found_sound_tempo:
                        qpm = metronome_qpm(item)
                        if qpm is not None:
                            raw.append(('tempo-qpm', bar, str(offset), round(qpm, 6),
                                        'metronome', part_id))
                    if kind == 'direction' and not found_sound_tempo and qpm is None:
                        unparsed_metronomes += sum(len(children(dtype, 'metronome'))
                                                   for dtype in children(item, 'direction-type'))
    grouped = defaultdict(set)
    for kind, bar, offset, amount, origin, part_id in raw:
        grouped[(kind, bar, offset, amount, origin)].add(part_id)
    events = [{'kind': kind, 'bar': bar, 'offsetQuarter': offset, 'value': amount,
               'source': origin, 'parts': sorted(parts)}
              for (kind, bar, offset, amount, origin), parts in grouped.items()]
    events.sort(key=lambda e: (e['bar'], Fraction(e['offsetQuarter']), e['kind'], e['value']))
    at = defaultdict(set)
    for event in events:
        if event['kind'] == 'tempo-qpm':
            at[(event['bar'], event['offsetQuarter'])].add(event['value'])
    conflict_positions = sum(len(tempos) > 1 for tempos in at.values())
    return events, {'unparsedMetronomes': unparsed_metronomes,
                    'wordDirections': word_directions,
                    'conflictingTempoPositions': conflict_positions}


def sha256(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(8 * 1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def sources():
    lieder = json.loads((ROOT / 'data/joint/lieder-joint.json').read_text())
    accepted = {r['scoreId']: r for r in lieder['records'] if not r.get('reject')}
    if len(accepted) != lieder['kept']:
        raise ValueError('Lieder accepted score IDs are not unique')
    lieder_spec = json.loads((SOURCES / 'SOURCE.json').read_text())
    yield 'OpenScore Lieder', SOURCES / lieder_spec['archive'], lieder_spec['sha256'], accepted
    catalog = json.loads((ROOT / 'data/classical-score-v1/catalog.json').read_text())
    pinned = json.loads((SOURCES / 'CLASSICAL-CORPORA.json').read_text())['corpora']
    for spec in pinned:
        selected = {r['archiveMember']: r for r in catalog
                    if r['status'] == 'candidate' and r['source'] == spec['name']}
        yield spec['name'], SOURCES / spec['archive'], spec['sha256'], selected


def prepare(output):
    if output.exists():
        raise FileExistsError(f'candidate directory already exists: {output}')
    output.mkdir(parents=True)
    stats = {}
    with gzip.open(output / 'score-events.jsonl.gz', 'wt', encoding='utf-8', compresslevel=6) as result:
        for source, archive, expected_sha, selected in sources():
            if sha256(archive) != expected_sha:
                raise ValueError(f'source archive hash differs: {archive}')
            seen, tally = set(), Counter()
            with tarfile.open(archive, 'r:gz') as tar:
                for member in tar:
                    if not member.isfile():
                        continue
                    if source == 'OpenScore Lieder' and not member.name.endswith('.mxl'):
                        continue
                    key = Path(member.name).stem if source == 'OpenScore Lieder' else member.name
                    if key not in selected:
                        continue
                    if source == 'OpenScore Lieder':
                        work_id = member.name.split('/scores/', 1)[-1].rsplit('/', 1)[0]
                        if work_id != selected[key]['workId']:
                            continue
                    if key in seen:
                        raise ValueError(f'duplicate selected archive member: {key}')
                    seen.add(key)
                    info = selected[key]
                    root = score_xml(tar.extractfile(member).read(), member.name)
                    events, issues = scan_score(root)
                    tempos = [e for e in events if e['kind'] == 'tempo-qpm']
                    dynamics = [e for e in events if e['kind'] == 'sound-dynamics']
                    record = {'scoreId': info['scoreId'], 'source': source,
                              'archiveMember': member.name, 'events': events,
                              'diagnostics': issues}
                    if source == 'OpenScore Lieder':
                        record['workId'], record['split'] = info['workId'], info['split']
                    else:
                        record['compositionKey'] = info['compositionKey']
                        record['split'] = None
                    result.write(json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n')
                    tally['scores'] += 1
                    tally['scoresWithNumericTempo'] += bool(tempos)
                    tally['scoresWithTempoChanges'] += len({e['value'] for e in tempos}) > 1
                    tally['scoresWithSoundDynamics'] += bool(dynamics)
                    tally['tempoEvents'] += len(tempos)
                    tally['soundDynamicsEvents'] += len(dynamics)
                    tally['conflictingTempoPositions'] += issues['conflictingTempoPositions']
                    tally['unparsedMetronomes'] += issues['unparsedMetronomes']
                    tally['wordDirections'] += issues['wordDirections']
            if seen != selected.keys():
                raise ValueError(f'{source}: missing {len(selected.keys() - seen)} selected scores')
            stats[source] = dict(tally)
            print(json.dumps({'source': source, **stats[source]}, ensure_ascii=False), flush=True)
    audit = {'schema': 'ailegro-performance-labels-v1', 'status': 'candidate only; not used by existing trainers',
             'eventCoordinates': 'zero-based source measure index and rational quarter-note offset',
             'sourceCounts': stats,
             'notes': [
                 'Only explicit numeric MusicXML sound tempo or numeric metronome marks are tempo labels.',
                 'No numeric tempo means missing label, never an invented 120 BPM target.',
                 'sound-dynamics values are MusicXML performance percentages, not MIDI velocities.',
                 'Printed dynamics and wedges remain in lieder-expression-v1 and classical-score-v1.',
                 'Classical scores have no approved train/validation/test split and cannot train the current model yet.',
             ]}
    (output / 'audit.json').write_text(json.dumps(audit, ensure_ascii=False, indent=2) + '\n')


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path, default=ROOT / 'data/performance-labels-v1')
    args = ap.parse_args()
    prepare(args.output)
