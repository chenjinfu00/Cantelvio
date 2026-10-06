#!/usr/bin/env python3
"""Conservative, opt-in MIDI recovery leaves the legacy parser unchanged."""
import hashlib
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from prepare import parse


def write_score(path, *, bars=12, notes_per_bar=10, shift=0, qpm=120, meter=(4, 4)):
    from symusic import Note, Score, Tempo, TimeSignature, Track

    tpq = 480
    num, den = meter
    bar_ticks = num * 4 * tpq // den
    score = Score(tpq)
    score.tempos.append(Tempo(0, qpm))
    score.time_signatures.append(TimeSignature(0, num, den))
    track = Track('violin', 40, False)
    for bar in range(bars):
        for i in range(notes_per_bar):
            t = bar * bar_ticks + i * bar_ticks // notes_per_bar + shift
            track.notes.append(Note(t, 40, 60 + i % 5, 80))
    score.tracks.append(track)
    score.dump_midi(str(path))


def main():
    with tempfile.TemporaryDirectory() as folder:
        root = Path(folder)
        gentle = root / 'gentle.mid'
        write_score(gentle, shift=12)
        original = hashlib.sha256(gentle.read_bytes()).hexdigest()
        assert parse(gentle)[1] == 'not on grid'
        arrays, info = parse(gentle, recover=True)
        assert arrays is not None and info['recovery'] == 'onsets rounded'
        assert info['roundMeanMs'] < 15 and info['roundP95Ms'] < 35
        assert hashlib.sha256(gentle.read_bytes()).hexdigest() == original

        expressive = root / 'expressive.mid'
        write_score(expressive, shift=12, qpm=30)
        assert parse(expressive, recover=True)[1] == 'not on grid'

        short = root / 'short.mid'
        write_score(short, notes_per_bar=6)
        assert parse(short)[1] == 'too few notes'
        assert parse(short, recover=True)[1]['recovery'] == 'short piece'

        fragment = root / 'fragment.mid'
        write_score(fragment, bars=4, notes_per_bar=18)
        assert parse(fragment, recover=True)[1] == 'too short'

        long_meter = root / 'long-meter.mid'
        write_score(long_meter, meter=(12, 4))
        assert parse(long_meter, recover=True)[1] == 'unusable meter'
    print('opt-in recovery tests passed')


if __name__ == '__main__':
    main()
