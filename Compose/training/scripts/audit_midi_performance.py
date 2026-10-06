#!/usr/bin/env python3
"""Record explicit MIDI tempo meta-events; implicit 120 BPM is never a label."""

import argparse
from collections import Counter
import gzip
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


def vlq(data, pos):
    number = 0
    for _ in range(4):
        if pos >= len(data):
            raise ValueError('truncated variable-length quantity')
        byte = data[pos]
        pos += 1
        number = (number << 7) | (byte & 0x7f)
        if not byte & 0x80:
            return number, pos
    raise ValueError('variable-length quantity exceeds four bytes')


def tempo_events(data):
    """Return (ticks per quarter, [(tick, quarter notes per minute)])."""
    if data[:4] != b'MThd' or len(data) < 14:
        raise ValueError('missing MIDI header')
    header_len = int.from_bytes(data[4:8], 'big')
    if header_len < 6 or 8 + header_len > len(data):
        raise ValueError('invalid MIDI header length')
    tracks = int.from_bytes(data[10:12], 'big')
    tpq = int.from_bytes(data[12:14], 'big')
    if tpq == 0 or tpq & 0x8000:
        raise ValueError('SMPTE or invalid MIDI division')
    pos, tempos = 8 + header_len, []
    for _ in range(tracks):
        if data[pos:pos + 4] != b'MTrk' or pos + 8 > len(data):
            raise ValueError('missing MIDI track')
        size = int.from_bytes(data[pos + 4:pos + 8], 'big')
        pos += 8
        track = data[pos:pos + size]
        if len(track) != size:
            raise ValueError('truncated MIDI track')
        pos += size
        index = tick = 0
        running = None
        while index < size:
            delta, index = vlq(track, index)
            tick += delta
            if index >= size:
                raise ValueError('missing MIDI event')
            status = track[index]
            if status >= 0x80:
                index += 1
                if status < 0xf0:
                    running = status
            else:
                if running is None:
                    raise ValueError('missing MIDI running status')
                status = running
            if status == 0xff:
                if index >= size:
                    raise ValueError('truncated MIDI meta event')
                kind = track[index]
                index += 1
                length, index = vlq(track, index)
                payload = track[index:index + length]
                if len(payload) != length:
                    raise ValueError('truncated MIDI meta payload')
                index += length
                if kind == 0x51 and length == 3:
                    microseconds = int.from_bytes(payload, 'big')
                    if microseconds:
                        tempos.append((tick, round(60000000 / microseconds, 6)))
            elif status in (0xf0, 0xf7):
                length, index = vlq(track, index)
                index += length
            elif 0x80 <= status <= 0xef:
                index += 1 if (status & 0xf0) in (0xc0, 0xd0) else 2
            else:
                raise ValueError(f'unsupported MIDI event status {status:02x}')
            if index > size:
                raise ValueError('truncated MIDI event payload')
    return tpq, sorted(set(tempos))


def inputs():
    pieces = json.loads((ROOT / 'orchestra/work/data/pieces.json').read_text())
    for row in pieces:
        yield 'SymphonyNet', row['name'], ROOT / 'orchestra/work/raw' / row['name']
    library = json.loads((ROOT / 'data/MIDI-Library/manifest.json').read_text())
    for row in library['files']:
        yield 'MIDI-Library', row['file'], ROOT / 'data/MIDI-Library' / row['file']


def audit(output):
    if output.exists():
        raise FileExistsError(f'will not replace MIDI tempo evidence: {output}')
    output.parent.mkdir(parents=True, exist_ok=True)
    counts = {}
    with gzip.open(output, 'wt', encoding='utf-8') as stream:
        for source, name, path in inputs():
            if not path.is_file():
                raise FileNotFoundError(path)
            counter = counts.setdefault(source, Counter())
            counter['files'] += 1
            try:
                tpq, events = tempo_events(path.read_bytes())
                row = {'source': source, 'name': name, 'ticksPerQuarter': tpq,
                       'explicitTempoEvents': [{'tick': tick, 'qpm': qpm} for tick, qpm in events]}
                counter['withExplicitTempo'] += bool(events)
                counter['withExplicitTempoChanges'] += len({qpm for _, qpm in events}) > 1
                counter['events'] += len(events)
            except ValueError as error:
                row = {'source': source, 'name': name, 'error': str(error)}
                counter['parseErrors'] += 1
            stream.write(json.dumps(row, ensure_ascii=False, separators=(',', ':')) + '\n')
    summary = {'schema': 'ailegro-midi-tempo-evidence-v1',
               'notes': [
                   'Only explicit MIDI FF 51 tempo meta-events are counted.',
                   'A MIDI without a tempo event has unknown source tempo; 120 BPM is a playback default.',
                   'Existing SymphonyNet bar tempo buckets and note velocity buckets are unchanged.',
                   'MIDI velocity is not equivalent to a score dynamic mark or calibrated acoustic loudness.',
               ], 'sources': {key: dict(value) for key, value in counts.items()}}
    output.with_name('midi-tempo-audit.json').write_text(json.dumps(summary, ensure_ascii=False, indent=2) + '\n')
    print(json.dumps(summary['sources'], ensure_ascii=False, indent=2))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--output', type=Path, default=ROOT / 'data/performance-labels-v1/midi-tempo-evidence.jsonl.gz')
    args = ap.parse_args()
    audit(args.output)
