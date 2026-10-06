#!/usr/bin/env python3
"""Read-only musical-content audit of the visible MIDI library."""

import json
from pathlib import Path

from symusic import Score


ROOT = Path(__file__).resolve().parents[1] / 'data' / 'MIDI-Library'


def describe(entry):
    score = Score(str(ROOT / entry['file']))
    tpq = score.ticks_per_quarter
    events = set()
    tracks = []
    max_end = 0
    for track in score.tracks:
        notes = track.notes.numpy()
        if not len(notes['time']):
            continue
        onsets = notes['time'] * 96 / tpq
        for onset, pitch in zip(onsets, notes['pitch']):
            events.add((round(float(onset)), int(pitch)))
        max_end = max(max_end, int((notes['time'] + notes['duration']).max()))
        tracks.append({'name': track.name[:60], 'program': track.program,
                       'notes': len(notes['time'])})
    return {'file': entry['file'], 'events': events, 'notes': sum(t['notes'] for t in tracks),
            'quarterLength': round(max_end / tpq, 1), 'tracks': tracks}


def main():
    manifest = json.loads((ROOT / 'manifest.json').read_text())
    rows = [describe(entry) for entry in manifest['files']]
    for row in rows:
        if int(row['file'][:3]) <= 36 or int(row['file'][:3]) in (50, 51, 145):
            print(json.dumps({k: v for k, v in row.items() if k != 'events'}, ensure_ascii=False))
    print('CONTENT OVERLAP >= 0.75 of smaller file:')
    for i, a in enumerate(rows):
        for b in rows[i + 1:]:
            small = min(len(a['events']), len(b['events']))
            if small < 60:
                continue
            intersection = len(a['events'] & b['events'])
            fraction = intersection / small
            if fraction >= 0.75:
                union = len(a['events'] | b['events'])
                print(f"{a['file'][:3]} {b['file'][:3]} small-contained={fraction:.3f} "
                      f"jaccard={intersection / union:.3f} common={intersection} "
                      f"sizes={len(a['events'])},{len(b['events'])}")


if __name__ == '__main__':
    main()
