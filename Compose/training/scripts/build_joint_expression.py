#!/usr/bin/env python3
"""Extract exact score-note timing and notation for an experimental joint-model sidecar.

Reads the pinned CC0 .mxl archive in place; does not modify the existing
sixteenth-grid corpus. Coordinates are exact Fractions derived from MusicXML
divisions. The sidecar's vocabulary is learned from the *training* split only.
"""
import argparse
from collections import Counter, defaultdict
from fractions import Fraction
from io import BytesIO
import json
from pathlib import Path
import tarfile
import zipfile
import xml.etree.ElementTree as ET

import numpy as np
from joint_data import load_corpus

ROOT = Path(__file__).resolve().parents[1]
ROLES = ('R', 'B', 'M')
SLOTS = (16, 4, 4)
DYNAMICS = ('unknown', 'pppp', 'ppp', 'pp', 'p', 'mp', 'mf', 'f', 'ff', 'fff', 'ffff', 'sf', 'sfz', 'sffz', 'fp', 'rfz')
TRANSIENT_DYNAMICS = {'sf', 'sfz', 'sffz', 'fp', 'rfz'}


def children(node, tag):
    return [x for x in node if x.tag.rsplit('}', 1)[-1] == tag]


def child(node, tag):
    return next(iter(children(node, tag)), None)


def val(node, tag, default=None):
    x = child(node, tag) if node is not None else None
    return x.text if x is not None and x.text is not None else default


def frac(n, d=1):
    return Fraction(int(n), int(d))


def xml_from_mxl(data):
    with zipfile.ZipFile(BytesIO(data)) as z:
        names = [n for n in z.namelist() if n.lower().endswith('.xml') and not n.startswith('META-INF/')]
        if not names:
            raise ValueError('MXL contains no score XML')
        return ET.fromstring(z.read(names[0]))


def midi(note):
    p = child(note, 'pitch')
    if p is None:
        return None
    step = val(p, 'step')
    if step not in ('C', 'D', 'E', 'F', 'G', 'A', 'B'):
        return None
    return 12 * (int(val(p, 'octave', 4)) + 1) + {'C': 0, 'D': 2, 'E': 4, 'F': 5,
                                                     'G': 7, 'A': 9, 'B': 11}[step] + int(val(p, 'alter', 0))


def parse_part(part, starts):
    notes, directions = [], []
    divisions = 1
    for mi, measure in enumerate(children(part, 'measure')):
        if mi >= len(starts):
            break
        cursor = Fraction(0); previous = Fraction(0); base = starts[mi]
        for item in measure:
            tag = item.tag.rsplit('}', 1)[-1]
            if tag == 'attributes':
                divisions = int(val(item, 'divisions', divisions))
                if divisions <= 0:
                    raise ValueError('nonpositive MusicXML divisions')
            elif tag in ('backup', 'forward'):
                amount = frac(val(item, 'duration', 0), divisions)
                cursor += -amount if tag == 'backup' else amount
            elif tag == 'direction':
                at = base + cursor + frac(val(item, 'offset', 0), divisions)
                for dtype in children(item, 'direction-type'):
                    for d in children(dtype, 'dynamics'):
                        for mark in d:
                            name = mark.tag.rsplit('}', 1)[-1].lower()
                            if name in DYNAMICS:
                                directions.append((at, 'dynamic', name))
                    for w in children(dtype, 'wedge'):
                        kind = w.attrib.get('type', '')
                        if kind in ('crescendo', 'diminuendo', 'stop'):
                            directions.append((at, 'wedge', kind))
            elif tag == 'note':
                is_chord = child(item, 'chord') is not None
                at = previous if is_chord else cursor
                duration = frac(val(item, 'duration', 0), divisions)
                if not is_chord:
                    previous = at
                    cursor += duration
                pitch = midi(item)
                if pitch is None or duration <= 0 or not 0 <= pitch <= 127:
                    continue
                tm = child(item, 'time-modification')
                ratio = 'none' if tm is None else f"{val(tm, 'actual-notes', 1)}:{val(tm, 'normal-notes', 1)}"
                ties = {t.attrib.get('type') for t in children(item, 'tie')}
                accent = 0
                for notation in children(item, 'notations'):
                    for articulation in children(notation, 'articulations'):
                        for a in articulation:
                            name = a.tag.rsplit('}', 1)[-1]
                            accent = max(accent, 2 if name == 'strong-accent' else 1 if name == 'accent' else 0)
                notes.append({'on': base + at, 'dur': duration, 'pitch': pitch, 'ratio': ratio,
                              'accent': accent, 'tie_start': 'start' in ties, 'tie_stop': 'stop' in ties,
                              'voice': val(item, 'voice', '1')})
    # Merge notated ties before assigning the onset to a sixteenth step.
    notes.sort(key=lambda x: (x['on'], x['pitch']))
    merged, active = [], {}
    for n in notes:
        key = (n['voice'], n['pitch'])
        prev = active.get(key)
        if n['tie_stop'] and prev is not None:
            prev['dur'] += n['dur']
            if not n['tie_start']:
                active.pop(key)
            continue
        merged.append(n)
        if n['tie_start']:
            active[key] = n
    directions.sort(key=lambda x: x[0])
    d, wedge, di = 'unknown', 0, 0
    transient_at, transient = None, None
    for n in merged:
        while di < len(directions) and directions[di][0] <= n['on']:
            at, kind, value = directions[di]
            if kind == 'dynamic':
                if value in TRANSIENT_DYNAMICS:
                    transient_at, transient = at, value
                else:
                    d = value
            else:
                wedge = {'crescendo': 1, 'diminuendo': 2, 'stop': 0}[value]
            di += 1
        n['dynamic'], n['wedge'] = (transient if transient_at == n['on'] else d), wedge
    return merged


def score_events(xml, piece):
    A = piece['arrays']; N = len(A['bar'])
    bars = A['bar'].astype(int)
    barstarts = [i for i in range(N) if i == 0 or bars[i] != bars[i - 1]]
    starts = [Fraction(i, 4) for i in barstarts]
    parts = children(xml, 'part')
    if len(parts) < 2:
        raise ValueError('score has fewer than two parts')
    parsed = [parse_part(p, starts) for p in parts]
    if any(len(children(p, 'measure')) != len(starts) for p in parts):
        raise ValueError('MusicXML/old-corpus bar count mismatch')
    out = []
    for pi, notes in enumerate(parsed):
        at_pitches = defaultdict(list)
        for n in notes:
            at_pitches[n['on']].append(n['pitch'])
        for n in notes:
            # The old melody is a top-note skyline; the bottom accompaniment
            # staff's lowest note at an onset is its bass approximation.
            if pi == 0:
                if n['pitch'] != max(at_pitches[n['on']]):
                    continue
                role = 2
            elif pi == len(parts) - 1:
                role = 1 if n['pitch'] == min(at_pitches[n['on']]) else 0
            else:
                role = 0
            x = n['on'] * 4
            step = int(x)
            if step < 0 or step >= N or bars[step] < 0 or int(A['meter'][step]) < 0:
                continue
            out.append((step, role, n['pitch'], str(x - step), str(n['dur']), n['ratio'],
                        n['dynamic'], n['accent'], n['wedge']))
    out.sort(key=lambda e: (e[0], e[1], Fraction(e[3]), e[2]))
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--archive', type=Path, default=ROOT / 'data/sources/OpenScore-Lieder-38c5db5.tar.gz')
    ap.add_argument('--lieder', type=Path, default=ROOT / 'data/joint/lieder-joint.npz')
    ap.add_argument('--output', type=Path, required=True)
    ap.add_argument('--limit', type=int, default=0, help='smoke-test at most N pieces; never use for full training')
    a = ap.parse_args()
    if a.output.exists() or a.output.with_suffix('.json').exists():
        ap.error('output already exists; choose a fresh path')
    pieces = load_corpus(a.lieder)
    lookup = {p['meta']['workId']: p for p in pieces if p['meta'].get('chordToneCoverage', 0) >= 0.6}
    rows, records, offsets = [], [], [0]
    failures = Counter()
    with tarfile.open(a.archive, 'r:gz') as tar:
        for member in tar:
            if not member.isfile() or not member.name.endswith('.mxl'):
                continue
            name = member.name.split('/scores/', 1)
            if len(name) != 2:
                continue
            work = str(Path(name[1]).parent)
            piece = lookup.get(work)
            if piece is None or Path(member.name).stem != piece['meta']['scoreId']:
                continue
            try:
                xml = xml_from_mxl(tar.extractfile(member).read())
                ev = score_events(xml, piece)
                if not ev:
                    raise ValueError('no aligned events')
            except (ET.ParseError, ValueError, KeyError, IndexError, zipfile.BadZipFile) as e:
                failures[type(e).__name__ + ':' + str(e)[:80]] += 1
                continue
            rows.extend(ev)
            m = piece['meta']
            records.append({'workId': work, 'scoreId': m['scoreId'], 'split': m['split'],
                            'steps': len(piece['arrays']['bar']), 'eventOffset': offsets[-1], 'events': len(ev)})
            offsets.append(len(rows))
            if len(records) % 100 == 0:
                print(json.dumps({'pieces': len(records), 'events': len(rows)}), flush=True)
            if a.limit and len(records) >= a.limit:
                break
    if not records:
        raise RuntimeError(f'no aligned pieces; failures={dict(failures)}')
    # A train-only vocabulary prevents validation/test notation leaking into the fit.
    train = [rows[r['eventOffset']:r['eventOffset'] + r['events']] for r in records if r['split'] == 'train']
    train_rows = [e for chunk in train for e in chunk]
    vocab = {}
    for field, index in (('sub', 3), ('dur', 4), ('ratio', 5)):
        observed = {e[index] for e in train_rows}
        key = (lambda x: Fraction(x)) if field != 'ratio' else (lambda x: (x != 'none', x))
        vocab[field] = ['<UNK>'] + sorted(observed, key=key)
    vocab['dynamic'] = list(DYNAMICS)
    vocab['pitch'] = list(range(128))
    maps = {k: {str(v): i for i, v in enumerate(vs)} for k, vs in vocab.items()}
    fields = np.zeros((len(rows), 9), np.int32)
    unknown = Counter()
    for i, e in enumerate(rows):
        step, role, pitch, sub, dur, ratio, dynamic, accent, wedge = e
        coded = []
        for key, value in (('sub', sub), ('dur', dur), ('ratio', ratio), ('dynamic', dynamic)):
            known = str(value) in maps[key]
            idx = maps[key].get(str(value), 0)
            unknown[key] += int(not known)
            coded.append(idx)
        fields[i] = (step, role, pitch, *coded, accent, wedge)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(a.output, offsets=np.asarray(offsets, np.int64), events=fields)
    manifest = {'version': 1, 'source': str(a.archive), 'baseCorpus': str(a.lieder),
                'limited': bool(a.limit), 'roles': ROLES, 'slots': SLOTS, 'vocab': vocab,
                'records': records, 'failures': dict(failures), 'unknown': dict(unknown),
                'eventFields': ['step', 'role', 'pitch', 'sub', 'dur', 'ratio', 'dynamic', 'accent', 'wedge']}
    a.output.with_suffix('.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=1))
    print(json.dumps({'pieces': len(records), 'events': len(rows), 'failures': dict(failures),
                      'unknown': dict(unknown), 'output': str(a.output)}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
