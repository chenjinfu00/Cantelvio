#!/usr/bin/env python3
"""Stream the three pinned classical score archives into an exact-notation candidate corpus.

No MIDI round trip, generated harmony labels, train/validation split, or model-weight
changes. Fractional quarter-note timing, written/sounding pitch, tuplets, meter,
score dynamics, part identity and available S3 texture roles are retained.
"""
import argparse
from collections import Counter, defaultdict
import csv
from fractions import Fraction
import gzip
import hashlib
from io import BytesIO, StringIO
import json
from pathlib import Path
import re
import sys
import tarfile
import xml.etree.ElementTree as ET
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'orchestra'))
import groups as G

SOURCES = ROOT / 'data/sources'
SOURCE_NAMES = ('OpenScore Orchestra / Hauptstimme', 'OpenScore String Quartets',
                'S3 Symbolic Symphony Set')
STEP = {'C': 0, 'D': 2, 'E': 4, 'F': 5, 'G': 7, 'A': 9, 'B': 11}
GROUP_WORDS = (
    (G.WOODWINDS, ('flute', 'piccolo', 'traverso', 'oboe', 'bassoon', 'clarinet',
                   'cor anglais', 'english horn', 'saxophone', 'recorder')),
    (G.BRASS, ('horn', 'trumpet', 'trombone', 'tuba', 'cornet', 'euphonium')),
    (G.PERC, ('timpani', 'percussion', 'triangle', 'cymbal', 'drum', 'tambourine',
              'gong', 'tam-tam', 'xylophone', 'glockenspiel', 'marimba', 'vibraphone')),
    (G.KEYS, ('harp', 'piano', 'celesta', 'organ', 'harpsichord', 'clavichord')),
    (G.HIGH, ('violin', 'viola', 'fiddle')),
    (G.LOW, ('violoncello', 'cello', 'contrabass', 'double bass', 'string bass')),
)
VOICE_WORDS = ('soprano', 'mezzo', 'contralto', 'countertenor', 'tenor', 'baritone',
               'bass voice', 'choir', 'chorus', 'singer', 'vocal', 'voice')


def tag(node):
    return node.tag.rsplit('}', 1)[-1]


def children(node, name):
    return [x for x in node if tag(x) == name] if node is not None else []


def child(node, name):
    return next(iter(children(node, name)), None)


def value(node, name, default=None):
    item = child(node, name)
    return item.text.strip() if item is not None and item.text else default


def as_fraction(value_):
    return Fraction(str(value_))


def fraction_text(value_):
    return str(value_)


def file_hash(path):
    digest = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def xml_from_mxl(data):
    with zipfile.ZipFile(BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.lower().endswith('.xml')
                 and not n.startswith('META-INF/')]
        if len(names) != 1:
            raise ValueError(f'expected one score XML in MXL, found {len(names)}')
        return z.read(names[0])


def part_group(name, sound, program):
    label = f'{name} {sound}'.casefold().replace('’', "'")
    if any(word in label for word in VOICE_WORDS):
        return None, 'vocal'
    for group, words in GROUP_WORDS:
        if any(word in label for word in words):
            return group, 'name'
    if program is not None and 1 <= program <= 128:
        result = G.group_of(program - 1, 60, False)
        # Generic string ensembles must be split note by note, not at C4.
        if G._PROGRAM.get(program - 1) == G.SPLIT:
            return None, 'split-by-pitch'
        return result, 'midi-program' if result is not None else 'unknown'
    return None, 'unknown'


def part_metadata(root):
    out = {}
    for entry in children(child(root, 'part-list'), 'score-part'):
        instrument = child(entry, 'score-instrument')
        midi = child(entry, 'midi-instrument')
        name = value(entry, 'part-name', '')
        sound = value(instrument, 'instrument-sound', '')
        program = value(midi, 'midi-program')
        group, mapping = part_group(name, sound, int(program) if program else None)
        out[entry.attrib['id']] = {'name': name, 'sound': sound,
                                    'program': int(program) if program else None,
                                    'group': G.GROUPS[group] if group is not None else None,
                                    'mapping': mapping,
                                    'midiUnpitched': value(midi, 'midi-unpitched')}
    return out


def measure_extent(measure, divisions):
    cursor = previous = extent = Fraction(0)
    for item in measure:
        kind = tag(item)
        if kind == 'attributes':
            divisions = int(value(item, 'divisions', divisions))
            if divisions <= 0:
                raise ValueError('nonpositive divisions')
        elif kind in ('backup', 'forward'):
            delta = as_fraction(value(item, 'duration', 0)) / divisions
            cursor += -delta if kind == 'backup' else delta
            if cursor < 0:
                raise ValueError('negative measure cursor')
            extent = max(extent, cursor)
        elif kind == 'note':
            duration = as_fraction(value(item, 'duration', 0)) / divisions
            if duration < 0:
                raise ValueError('negative note duration')
            on = previous if child(item, 'chord') is not None else cursor
            if child(item, 'chord') is None:
                previous = on
                cursor += duration
            extent = max(extent, on + duration, cursor)
    return extent, divisions


def timeline(parts):
    measures_by_part = [children(p, 'measure') for p in parts]
    counts = {len(m) for m in measures_by_part}
    if len(counts) != 1 or not counts or min(counts) == 0:
        raise ValueError(f'part measure counts differ: {sorted(counts)}')
    n = len(measures_by_part[0])
    meters, keys, lengths, starts, irregulars = [], [], [], [], []
    divisions = [1] * len(parts)
    meter, key, start = (4, 4), None, Fraction(0)
    for i in range(n):
        attrs = [child(measures[i], 'attributes') for measures in measures_by_part]
        for attr in attrs:
            time = child(attr, 'time')
            if time is not None and value(time, 'beats') and value(time, 'beat-type'):
                meter = (int(value(time, 'beats')), int(value(time, 'beat-type')))
                break
        for attr in attrs:
            k = child(attr, 'key')
            if k is not None and value(k, 'fifths') is not None:
                key = {'fifths': int(value(k, 'fifths')), 'mode': value(k, 'mode')}
                break
        if meter[0] <= 0 or meter[1] <= 0:
            raise ValueError('invalid time signature')
        extents = []
        for j, measures in enumerate(measures_by_part):
            extent, divisions[j] = measure_extent(measures[i], divisions[j])
            extents.append(extent)
        actual = max(extents)
        nominal = Fraction(4 * meter[0], meter[1])
        implicit = measures_by_part[0][i].attrib.get('implicit') == 'yes'
        # Long measures include cadenzas and encoded multi-measure rests. Keep
        # their observed length rather than silently shifting all later notes.
        irregular = actual > nominal
        length = actual if irregular or (0 < actual < nominal and (i == 0 or implicit)) else nominal
        starts.append(start)
        lengths.append(length)
        meters.append(meter)
        keys.append(key)
        irregulars.append(irregular)
        start += length
    return starts, lengths, meters, keys, irregulars


def pitch_of(note):
    pitch = child(note, 'pitch')
    if pitch is None:
        return None
    step = value(pitch, 'step')
    if step not in STEP:
        return None
    alter = as_fraction(value(pitch, 'alter', 0))
    if alter.denominator != 1:
        return None  # this model is 12-TET; retain a skip count, never round microtones
    return (int(value(pitch, 'octave')) + 1) * 12 + STEP[step] + int(alter)


def score_events(root, role_intervals=None):
    parts = children(root, 'part')
    if not parts:
        raise ValueError('score has no parts')
    metadata = part_metadata(root)
    starts, lengths, meters, keys, irregulars = timeline(parts)
    events, issues = [], Counter()
    for part in parts:
        part_id = part.attrib.get('id')
        if part_id not in metadata:
            raise ValueError(f'part {part_id} absent from part-list')
        info = metadata[part_id]
        divisions, transpose = 1, 0
        directions, notes = [], []
        for mi, measure in enumerate(children(part, 'measure')):
            cursor = previous = Fraction(0)
            for item in measure:
                kind = tag(item)
                if kind == 'attributes':
                    divisions = int(value(item, 'divisions', divisions))
                    trans = child(item, 'transpose')
                    if trans is not None:
                        transpose = int(value(trans, 'chromatic', 0)) + 12 * int(value(trans, 'octave-change', 0))
                elif kind in ('backup', 'forward'):
                    delta = as_fraction(value(item, 'duration', 0)) / divisions
                    cursor += -delta if kind == 'backup' else delta
                elif kind == 'direction':
                    at = starts[mi] + cursor + as_fraction(value(item, 'offset', 0)) / divisions
                    for dtype in children(item, 'direction-type'):
                        for dynamics in children(dtype, 'dynamics'):
                            for mark in dynamics:
                                directions.append((at, 'dynamic', tag(mark).lower()))
                        for wedge in children(dtype, 'wedge'):
                            directions.append((at, 'wedge', wedge.attrib.get('type')))
                elif kind == 'note':
                    duration = as_fraction(value(item, 'duration', 0)) / divisions
                    on = previous if child(item, 'chord') is not None else cursor
                    if child(item, 'chord') is None:
                        previous = on
                        cursor += duration
                    if child(item, 'rest') is not None:
                        continue
                    written = pitch_of(item)
                    unpitched = child(item, 'unpitched') is not None
                    if written is None and not unpitched:
                        issues['unsupported pitch'] += 1
                        continue
                    sounding = written + transpose if written is not None else None
                    if sounding is not None and not 0 <= sounding <= 127:
                        issues['out-of-MIDI-range pitch'] += 1
                        continue
                    ratio = child(item, 'time-modification')
                    tuplet = None if ratio is None else f"{value(ratio, 'actual-notes', 1)}:{value(ratio, 'normal-notes', 1)}"
                    ties = {x.attrib.get('type') for x in children(item, 'tie')}
                    accent = 0
                    for notation in children(item, 'notations'):
                        for articulation in children(notation, 'articulations'):
                            for mark in articulation:
                                accent = max(accent, 2 if tag(mark) == 'strong-accent' else
                                             1 if tag(mark) == 'accent' else 0)
                    group = info['group']
                    if info['mapping'] == 'split-by-pitch' and sounding is not None:
                        group = G.GROUPS[G.HIGH if sounding >= G.SPLIT_PITCH else G.LOW]
                    note = {'part': part_id, 'bar': mi, 'on': starts[mi] + on, 'dur': duration,
                            'writtenPitch': written, 'pitch': sounding, 'group': group,
                            'voice': value(item, 'voice', '1'), 'staff': value(item, 'staff', '1'),
                            'tuplet': tuplet, 'accent': accent,
                            'grace': child(item, 'grace') is not None,
                            'unpitched': unpitched, 'tieStart': 'start' in ties,
                            'tieStop': 'stop' in ties}
                    notes.append(note)
        directions.sort(key=lambda x: x[0])
        notes.sort(key=lambda x: (x['on'], x['voice'], x['staff'], x['pitch'] if x['pitch'] is not None else -1))
        active, merged = {}, []
        for note in notes:
            tie_key = (note['voice'], note['staff'], note['pitch'])
            prior = active.get(tie_key)
            if note['tieStop'] and prior is not None:
                prior['dur'] += note['dur']
                if not note['tieStart']:
                    active.pop(tie_key)
                issues['merged ties'] += 1
                continue
            if note['tieStop']:
                issues['orphan tie stop'] += 1
            merged.append(note)
            if note['tieStart']:
                active[tie_key] = note
        dynamic, wedge, direction_index = None, None, 0
        roles = (role_intervals or {}).get(re.sub(r'\W+', '', info['name'].casefold()), [])
        for note in merged:
            while direction_index < len(directions) and directions[direction_index][0] <= note['on']:
                _, kind, mark = directions[direction_index]
                if kind == 'dynamic':
                    dynamic = mark
                else:
                    wedge = None if mark == 'stop' else mark
                direction_index += 1
            note['dynamic'], note['wedge'] = dynamic, wedge
            note['role'] = next((label for begin, end, label in roles
                                 if begin <= note['on'] < end), None)
            if note['grace']:
                issues['grace notes'] += 1
            events.append(note)
    events.sort(key=lambda x: (x['on'], x['part'], x['pitch'] if x['pitch'] is not None else -1))
    out = []
    for note in events:
        out.append({key: fraction_text(val) if key in ('on', 'dur') else val
                    for key, val in note.items() if key not in ('tieStart', 'tieStop')})
    measures = [{'number': i + 1, 'on': str(starts[i]), 'dur': str(lengths[i]),
                 'meter': list(meters[i]), 'key': keys[i], 'irregular': irregulars[i]}
                for i in range(len(starts))]
    return list(metadata.items()), measures, out, dict(issues)


def identity(source, member):
    path = Path(member)
    parts = path.parts
    if source == SOURCE_NAMES[0]:
        i = parts.index('data')
        composer, work = parts[i + 1:i + 3]
        movement = parts[i + 3] if len(parts) > i + 4 else '1'
        # Same four movements appear in S3. Keep the S3 score/role version.
        overlap = composer.startswith('Beethoven') and work.startswith('Symphony_No.9')
        return composer, work, movement, overlap
    if source == SOURCE_NAMES[1]:
        i = parts.index('scores')
        return parts[i + 1], parts[i + 2], path.stem, False
    code = path.parent.name
    meta = {'be': ('Beethoven,_Ludwig_van', 'Symphony_No.9,_Op.125'),
            'dv': ('Dvorak,_Antonin', 'Symphony_No.9'),
            'mo': ('Mozart,_Wolfgang_Amadeus', 'Symphony_No.41'),
            'tc': ('Tchaikovsky,_Pyotr', 'Symphony_No.6')}
    composer, work = meta[code[:2]]
    return composer, work, code[2:], False


def source_members(source, tar):
    for member in tar:
        if not member.isfile():
            continue
        name = member.name
        if source == SOURCE_NAMES[0] and '/data/' in name and name.endswith('.mxl') and not name.endswith('_melody.mxl'):
            yield member
        elif source == SOURCE_NAMES[1] and '/scores/' in name and name.endswith('.mxl'):
            yield member
        elif source == SOURCE_NAMES[2] and name.endswith('/sheet.xml'):
            yield member


def role_files(tar):
    roles = defaultdict(lambda: defaultdict(list))
    for member in tar:
        if not member.isfile() or '/annotations/orchestral_texture/' not in member.name or not member.name.endswith('.csv'):
            continue
        piece = Path(member.name).parts[-4]
        part = re.sub(r'\W+', '', Path(member.name).stem.casefold())
        content = tar.extractfile(member).read().decode('utf-8-sig')
        for row in csv.DictReader(StringIO(content)):
            try:
                begin, end = as_fraction(row['onset']), as_fraction(row['offset'])
            except (ValueError, KeyError):
                continue
            if begin < end:
                roles[piece][part].append((begin, end, row['role']))
    return roles


def summary_of(parts, measures, notes, issues):
    groups = Counter(n['group'] for n in notes if n['group'] is not None)
    tuplets = Counter(n['tuplet'] for n in notes if n['tuplet'])
    meters = Counter(f"{m['meter'][0]}/{m['meter'][1]}" for m in measures)
    pitched = [n for n in notes if n['pitch'] is not None and not n['grace']]
    mapped = sum(n['group'] is not None for n in pitched)
    vocal = sum(info['mapping'] == 'vocal' for _, info in parts)
    irregular = sum(m['irregular'] for m in measures)
    return {'parts': len(parts), 'measures': len(measures), 'notes': len(notes),
            'pitchedNotes': len(pitched), 'mappedPitchedNotes': mapped,
            'knownDynamics': sum(n['dynamic'] is not None for n in notes),
            'roleLabeledNotes': sum(n['role'] is not None for n in notes),
            'vocalParts': vocal, 'irregularMeasures': irregular,
            'groups': dict(groups), 'tuplets': dict(tuplets),
            'meters': dict(meters), 'issues': issues,
            'sixGroupCandidate': len(measures) >= 8 and mapped >= 80 and vocal == 0 and irregular == 0}


def prepare(output, limit=0):
    if output.exists():
        raise FileExistsError(f'output exists: {output}')
    source_manifest = json.loads((SOURCES / 'CLASSICAL-CORPORA.json').read_text())
    by_name = {row['name']: row for row in source_manifest['corpora']}
    output.mkdir(parents=True)
    catalog, failures = [], []
    written = 0
    next_progress = 25
    with (output / 'scores.jsonl.gz').open('wb') as raw:
        with gzip.GzipFile(fileobj=raw, mode='wb', filename='', mtime=0) as zipped:
            for source in SOURCE_NAMES:
                spec = by_name[source]
                archive = SOURCES / spec['archive']
                if file_hash(archive) != spec['sha256']:
                    raise ValueError(f'archive SHA-256 mismatch: {archive}')
                with tarfile.open(archive, 'r:gz') as tar:
                    roles = role_files(tar) if source == SOURCE_NAMES[2] else {}
                with tarfile.open(archive, 'r:gz') as tar:
                    for member in source_members(source, tar):
                        composer, work, movement, duplicate = identity(source, member.name)
                        score_id = f'{source}:{member.name}'
                        if duplicate:
                            catalog.append({'scoreId': score_id, 'status': 'duplicate-source-version',
                                            'duplicateOf': f'S3 be{int(movement)}',
                                            'compositionKey': f'{composer}/{work}'})
                            continue
                        try:
                            data = tar.extractfile(member).read()
                            xml = xml_from_mxl(data) if member.name.endswith('.mxl') else data
                            root = ET.fromstring(xml)
                            piece_roles = roles.get(Path(member.name).parent.name, {})
                            parts, measures, notes, issues = score_events(root, piece_roles)
                            if not notes or len(measures) < 2:
                                raise ValueError('empty or one-measure score')
                            stats = summary_of(parts, measures, notes, issues)
                            record = {'scoreId': score_id, 'source': source,
                                      'archiveMember': member.name, 'composer': composer,
                                      'work': work, 'movement': movement,
                                      'compositionKey': f'{composer}/{work}',
                                      'scoreSha256': hashlib.sha256(data).hexdigest(),
                                      'parts': [{'id': pid, **info} for pid, info in parts],
                                      'measures': measures, 'notes': notes}
                            zipped.write((json.dumps(record, ensure_ascii=False, separators=(',', ':')) + '\n').encode())
                            catalog.append({'scoreId': score_id, 'status': 'candidate',
                                            'source': source, 'archiveMember': member.name,
                                            'composer': composer, 'work': work, 'movement': movement,
                                            'compositionKey': record['compositionKey'],
                                            'scoreSha256': record['scoreSha256'], **stats})
                            written += 1
                        except (ET.ParseError, zipfile.BadZipFile, ValueError, KeyError, IndexError) as error:
                            failures.append({'scoreId': score_id, 'reason': f'{type(error).__name__}: {error}'})
                        if written >= next_progress:
                            print(json.dumps({'prepared': written, 'failed': len(failures)}), flush=True)
                            next_progress += 25
                        if limit and written >= limit:
                            break
                if limit and written >= limit:
                    break
    (output / 'catalog.json').write_text(json.dumps(catalog, ensure_ascii=False, indent=1))
    status = Counter(row['status'] for row in catalog)
    by_source = Counter(row['source'] for row in catalog if row['status'] == 'candidate')
    summary = {'schemaVersion': 1, 'status': 'exact-notation training candidates; not yet wired into a trainer',
               'sourceManifest': 'training/data/sources/CLASSICAL-CORPORA.json',
               'sources': dict(by_source), 'candidateScores': written,
               'statusCounts': dict(status), 'failures': failures,
               'sixGroupCandidates': sum(row.get('sixGroupCandidate', False) for row in catalog),
               'totalNotes': sum(row.get('notes', 0) for row in catalog),
               'knownDynamicNotes': sum(row.get('knownDynamics', 0) for row in catalog),
               'roleLabeledNotes': sum(row.get('roleLabeledNotes', 0) for row in catalog),
               'irregularMeasures': sum(row.get('irregularMeasures', 0) for row in catalog),
               'tuplets': dict(sum((Counter(row.get('tuplets', {})) for row in catalog), Counter())),
               'meters': dict(sum((Counter(row.get('meters', {})) for row in catalog), Counter())),
               'qualityNotes': [
                   'Score annotations and score-only licenses remain distinct.',
                   'A deterministic composition-level train/validation/test split is intentionally not assigned: existing SymphonyNet MIDI contains overlapping works, requiring cross-corpus leakage review.',
                   'Missing dynamic and role labels are null, not filled with fabricated targets.',
                   'Grace notes and unpitched notes are preserved but need task-specific handling.',
                   'The current four-track backbone and six-group classifier do not read this schema directly.'
               ]}
    (output / 'prepare.json').write_text(json.dumps(summary, ensure_ascii=False, indent=1))
    print(json.dumps({k: summary[k] for k in ('candidateScores', 'sixGroupCandidates', 'totalNotes', 'knownDynamicNotes', 'roleLabeledNotes')}, ensure_ascii=False), flush=True)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--limit', type=int, default=0, help='smoke test, not a training corpus')
    args = ap.parse_args()
    prepare(args.output, args.limit)


if __name__ == '__main__':
    main()
