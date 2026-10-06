#!/usr/bin/env python3
"""Standard MIDI file from four_pillar_v31_sample output, for listening (never imported by training).

Every voice gets a General MIDI program from its group and median pitch (woodwinds: flute, oboe,
clarinet, bassoon; brass: trumpet, horn, trombone, tuba; keys: piano; high strings: violin, viola;
low strings: cello, double bass; pitched percussion: timpani). Voices with the same program share a
track and a channel (at most 15 programs, so every program keeps its own channel); unpitched notes go
to the drum channel with their drum keys. Keys and chord changes are written as markers. The sounding
pitches are written unchanged; exact fractions are rounded to 960 ticks per quarter.
"""
from __future__ import annotations

import argparse
import json
import statistics
from fractions import Fraction
from pathlib import Path

TPQ = 960
DRUM_CHANNEL = 9
# group -> ((lowest median pitch, GM program 0-127, name), ...), first match wins
PROGRAMS = {
    'woodwinds': ((72, 73, 'Flute'), (60, 68, 'Oboe'), (50, 71, 'Clarinet'), (0, 70, 'Bassoon')),
    'brass': ((67, 56, 'Trumpet'), (52, 60, 'French horn'), (41, 57, 'Trombone'), (0, 58, 'Tuba')),
    'keys': ((0, 0, 'Piano'),),
    'high_strings': ((62, 40, 'Violin'), (0, 41, 'Viola')),
    'low_strings': ((45, 42, 'Cello'), (0, 43, 'Double bass')),
    'percussion': ((0, 47, 'Timpani'),),
    None: ((0, 52, 'Voice'),),
}


def vlq(value: int) -> bytes:
    """MIDI variable-length quantity."""
    out = [value & 0x7F]
    value >>= 7
    while value:
        out.append(0x80 | (value & 0x7F))
        value >>= 7
    return bytes(reversed(out))


def meta(kind: int, payload: bytes) -> bytes:
    return bytes([0xFF, kind]) + vlq(len(payload)) + payload


def chunk(events) -> bytes:
    """events: (tick, order, message); sorted by tick, then order (note-offs before note-ons)."""
    data, now = bytearray(), 0
    for tick, _, message in sorted(events, key=lambda e: (e[0], e[1])):
        data += vlq(tick - now) + message
        now = tick
    data += vlq(0) + meta(0x2F, b'')
    return b'MTrk' + len(data).to_bytes(4, 'big') + bytes(data)


def program_for(group, pitches) -> tuple[int, str]:
    median = statistics.median(pitches) if pitches else 60
    for low, program, name in PROGRAMS.get(group, PROGRAMS[None]):
        if median >= low:
            return program, name
    raise AssertionError('every program table ends at 0')


def untangle(notes):
    """notes [(on, off, key, velocity)] on one channel: a repeated key cuts the earlier note instead of
    letting its note-off silence the later one."""
    notes, last = sorted(notes), {}
    out = []
    for on, off, key, velocity in notes:
        if key in last:
            previous = last[key]
            if out[previous][1] > on:
                if out[previous][0] == on:          # same key, same onset: keep the louder, longer note
                    out[previous] = (on, max(off, out[previous][1]), key, max(velocity, out[previous][3]))
                    continue
                out[previous] = (out[previous][0], on, key, out[previous][3])
        last[key] = len(out)
        out.append((on, off, key, velocity))
    return out


def to_midi(audition: dict, tempo: float) -> tuple[bytes, dict]:
    tick = lambda quarters: round(quarters * TPQ)  # noqa: E731
    conductor = [(0, 0, meta(0x03, b'AIlegro v3.1')),
                 (0, 1, meta(0x51, round(60_000_000 / tempo).to_bytes(3, 'big')))]
    voices, drums, start, meter, key = {}, [], Fraction(0), None, None
    for bar in audition['bars']:
        here = tick(start)
        if tuple(bar['meter']) != meter:
            meter = tuple(bar['meter'])
            numerator, denominator = int(meter[0]), int(meter[1])
            power = denominator.bit_length() - 1 if denominator > 0 and denominator & (denominator - 1) == 0 else 2
            conductor.append((here, 2, meta(0x58, bytes([numerator, power, 24, 8]))))
        if bar['key']['name'] != key:
            key = bar['key']['name']
            conductor.append((here, 3, meta(0x06, key.encode())))
        for chord in bar['chords']:
            conductor.append((tick(start + Fraction(chord['onset'])), 4, meta(0x06, chord['name'].encode())))
        for n in bar['notes']:
            on = start + Fraction(n['onset'])
            first = tick(on)
            last = max(tick(on + Fraction(n['duration'])), first + 1)
            velocity = max(1, min(127, int(n['velocity'])))
            if n['pitch'] is None:
                drums.append((first, last, int(n['drum']), velocity))
            else:
                voices.setdefault((n['group'], n['voice']), []).append((first, last, int(n['pitch']), velocity))
        start += Fraction(bar['length'])
    programs: dict[int, dict] = {}
    for (group, voice), notes in sorted(voices.items(), key=lambda item: item[0][1]):
        program, name = program_for(group, [n[2] for n in notes])
        entry = programs.setdefault(program, {'name': name, 'voices': [], 'notes': []})
        entry['voices'].append(voice)
        entry['notes'] += notes
    channels = [c for c in range(16) if c != DRUM_CHANNEL]
    if len(programs) > len(channels):
        raise ValueError('more programs than melodic MIDI channels')
    tracks = [chunk(conductor)]
    summary = {'tracks': [], 'notes': 0, 'seconds': round(float(start) * 60 / tempo, 1)}
    for channel, (program, entry) in zip(channels, sorted(programs.items())):
        events = [(0, -2, meta(0x03, entry['name'].encode())), (0, -1, bytes([0xC0 | channel, program]))]
        for on, off, pitch, velocity in untangle(entry['notes']):
            events += [(on, 1, bytes([0x90 | channel, pitch, velocity])), (off, 0, bytes([0x80 | channel, pitch, 64]))]
        tracks.append(chunk(events))
        summary['tracks'].append({'name': entry['name'], 'program': program, 'channel': channel,
                                  'voices': entry['voices'], 'notes': len(entry['notes'])})
        summary['notes'] += len(entry['notes'])
    if drums:
        events = [(0, -2, meta(0x03, b'Percussion'))]
        for on, off, drum, velocity in untangle(drums):
            events += [(on, 1, bytes([0x90 | DRUM_CHANNEL, drum, velocity])),
                       (off, 0, bytes([0x80 | DRUM_CHANNEL, drum, 64]))]
        tracks.append(chunk(events))
        summary['tracks'].append({'name': 'Percussion', 'channel': DRUM_CHANNEL, 'notes': len(drums)})
        summary['notes'] += len(drums)
    header = b'MThd' + (6).to_bytes(4, 'big') + (1).to_bytes(2, 'big') + len(tracks).to_bytes(2, 'big') \
        + TPQ.to_bytes(2, 'big')
    return header + b''.join(tracks), summary


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--input', type=Path, required=True, help='JSON written by four_pillar_v31_sample.py')
    parser.add_argument('--output', type=Path, required=True)
    parser.add_argument('--tempo', type=float, default=92., help='quarter notes per minute (as given to the sampler)')
    args = parser.parse_args()
    if not args.tempo > 0:
        parser.error('tempo must be positive')
    data, summary = to_midi(json.loads(args.input.read_text()), args.tempo)
    args.output.write_bytes(data)
    print(json.dumps({'output': str(args.output), **summary}, ensure_ascii=False))


if __name__ == '__main__':
    main()
