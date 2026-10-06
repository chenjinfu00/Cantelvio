#!/usr/bin/env python3
"""Twelve-tone equal-temperament transposition leaves the old joint tokens unchanged.

R/H/B/M are encoded relative to a window reference key and pitch base. Shifting
the entire score by an integer number of semitones, including its key and chord
roots, is therefore already shared across all 12 keys. Repeating these shifted
windows in old-model training would duplicate identical examples. This test is
the guardrail for the frozen foundation; a future six-group arranger with
absolute register features needs genuine transposition augmentation separately.
"""
from pathlib import Path
import sys
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'scripts'))
from joint_data import load_corpus, piece_windows, encode_window  # noqa: E402


def shifted(piece, semitones):
    arrays = {name: values.copy() for name, values in piece['arrays'].items()}
    for name in ('key_tonic', 'ch_root'):
        values = arrays[name].astype(np.int16)
        arrays[name] = np.where(values >= 0, (values + semitones) % 12, values).astype(piece['arrays'][name].dtype)
    for name in ('bass_pitch', 'mel_pitch'):
        values = arrays[name].astype(np.int16)
        arrays[name] = np.where(values >= 0, values + semitones, values).astype(piece['arrays'][name].dtype)
    return {'meta': piece['meta'], 'arrays': arrays}


def check_corpus(path):
    checked = 0
    for piece in load_corpus(path):
        windows = piece_windows(piece)
        if not windows:
            continue
        a, b = windows[0]
        pitches = np.concatenate([piece['arrays'][name][a:b] for name in ('bass_pitch', 'mel_pitch')])
        pitches = pitches[pitches >= 0]
        if not len(pitches) or pitches.min() < 6 or pitches.max() > 121:
            continue
        original = encode_window(piece, a, b)
        for semitones in range(-6, 6):
            moved = encode_window(shifted(piece, semitones), a, b)
            for name, value in original.items():
                if isinstance(value, np.ndarray):
                    assert np.array_equal(value, moved[name]), (path, name, semitones)
                elif name not in ('info',):
                    assert value == moved[name], (path, name, semitones)
            assert moved['info']['bassBase'] == (None if original['info']['bassBase'] is None else original['info']['bassBase'] + semitones)
            assert moved['info']['melodyBase'] == (None if original['info']['melodyBase'] is None else original['info']['melodyBase'] + semitones)
        checked += 1
        if checked == 8:
            break
    assert checked == 8, f'not enough eligible pieces in {path}'
    return checked


if __name__ == '__main__':
    counts = [check_corpus(ROOT / 'data/joint' / name) for name in ('lieder-joint.npz', 'synthetic-joint.npz')]
    print(f'Equal-temperament transposition: {sum(counts)} windows × 12 shifts, all old-model training fields identical')
