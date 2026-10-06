#!/usr/bin/env python3
"""Small MIDI test set for the orchestral pipeline (no downloads needed).

- real scores from the music21 corpus (string quartets, chorales) written as MIDI;
- synthetic "orchestral" pieces: a chord progression voiced over many GM programs
  (winds, brass, harp, strings, ensemble strings, timpani and a drum kit), with meter
  and tempo changes, unison doublings and some notes outside the piano range.

  python training/orchestra/tests/make_test_midis.py <output folder> [--synthetic 24] [--scores 16]
"""
import argparse, random
from pathlib import Path


def synthetic(path, seed):
    from symusic import Score, Track, Note, Tempo, TimeSignature
    rng = random.Random(seed)
    tpq = 480
    s = Score(tpq)
    meters = rng.choice([[(4, 4)], [(3, 4)], [(6, 8)], [(4, 4), (3, 4)], [(2, 4), (4, 4)]])
    bars, t, sig_events = [], 0, []
    n_bars = rng.randint(12, 40)
    for b in range(n_bars):
        num, den = meters[(b * len(meters)) // n_bars]
        if not sig_events or sig_events[-1][1:] != (num, den):
            sig_events.append((t, num, den))
        L = num * 4 * tpq // den
        bars.append((t, L)); t += L
    for (tt, num, den) in sig_events:
        s.time_signatures.append(TimeSignature(tt, num, den))
    s.tempos.append(Tempo(0, rng.choice([60.0, 90.0, 120.0, 144.0])))
    s.tempos.append(Tempo(bars[n_bars // 2][0], rng.choice([72.0, 100.0, 132.0])))
    key = rng.randrange(12)
    prog_sets = [(73, 'flute', 72), (68, 'oboe', 67), (71, 'clarinet', 62), (70, 'bassoon', 48), (60, 'horn', 57),
                 (56, 'trumpet', 67), (57, 'trombone', 50), (58, 'tuba', 38), (46, 'harp', 60), (40, 'violin', 72),
                 (40, 'violin2', 69), (41, 'viola', 60), (42, 'cello', 48), (43, 'bass', 36), (48, 'strings', 60), (47, 'timpani', 45)]
    chosen = rng.sample(prog_sets, rng.randint(4, len(prog_sets)))
    chords = [[0, 4, 7], [5, 9, 12], [7, 11, 14], [9, 12, 16], [2, 5, 9]]
    tracks = {}
    for prog, name, center in chosen:
        tracks[name] = Track(name, prog, False)
    drums = Track('drums', 0, True) if rng.random() < 0.6 else None
    for b, (start, L) in enumerate(bars):
        ch = chords[rng.randrange(len(chords))] if b % 2 == 0 else ch
        step = tpq // 2 if rng.random() < 0.5 else tpq
        for prog, name, center in chosen:
            if rng.random() < 0.25:
                continue          # this instrument rests in this bar
            tr = tracks[name]
            t = start
            while t < start + L:
                pc = (key + ch[rng.randrange(3)]) % 12
                pitch = center - 6 + (pc - (center - 6)) % 12
                dur = step if name not in ('violin', 'flute') else max(tpq // 4, step // 2)
                tr.notes.append(Note(t, dur, pitch, rng.randint(50, 110)))
                if name == 'violin2' and rng.random() < 0.5:            # unison doubling with violin I
                    tracks.get('violin', tr).notes.append(Note(t, dur, pitch, 80))
                t += dur
        if drums is not None:
            for k in range(L // tpq):
                drums.notes.append(Note(start + k * tpq, tpq // 4, 36 if k % 2 == 0 else 38, 90))
            drums.notes.append(Note(start, tpq, 49 if b % 4 == 0 else 42, 70))
    # a couple of notes outside the piano range and a synth effect (both dropped)
    if 'flute' in tracks:
        tracks['flute'].notes.append(Note(0, tpq, 115, 60))
    fx = Track('fx', 100, False); fx.notes.append(Note(0, tpq, 60, 60))
    for tr in list(tracks.values()) + ([drums] if drums else []) + [fx]:
        tr.notes.sort(key=lambda n: (n.time, n.pitch))
        s.tracks.append(tr)
    s.dump_midi(str(path))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', type=Path); ap.add_argument('--synthetic', type=int, default=24); ap.add_argument('--scores', type=int, default=16)
    a = ap.parse_args(); a.out.mkdir(parents=True, exist_ok=True)
    for i in range(a.synthetic):
        synthetic(a.out / f'synthetic-{i:03d}.mid', 1000 + i)
    if a.scores:
        from music21 import corpus
        paths = []
        for composer in ('beethoven', 'mozart', 'haydn', 'bach'):
            paths += [p for p in corpus.getComposer(composer) if str(p).endswith(('.mxl', '.xml', '.krn'))][:max(1, a.scores // 4)]
        for i, p in enumerate(paths[:a.scores]):
            try:
                corpus.parse(p).write('midi', fp=str(a.out / f'score-{i:03d}.mid'))
            except Exception as e:
                print('skip', p, type(e).__name__)
    (a.out / 'broken.mid').write_bytes(b'not a midi file')
    print(len(list(a.out.glob('*.mid'))), 'files')


if __name__ == '__main__':
    main()
