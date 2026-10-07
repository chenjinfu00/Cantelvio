#!/usr/bin/env python3
"""Run AugmentedNet on MusicXML files and store the chords reduced to Cantelvio Compose's 40 qualities.

Same convention as training/scripts/build_joint_lieder.py (which reads AugmentedNet's analysis_automatic.rntxt for the
OpenScore Lieder): the Roman numeral is resolved in the local key with music21, root = rn.root(), pitch classes =
rn.pitchClasses, quality = the Cantelvio Compose quality whose interval set matches (or the best Jaccard match).
Output per score: JSON with chords [[offset_quarters, root_pc, quality, quality_match, key_tonic_pc, key_minor, rn]].
Run with the Python 3.9 / TensorFlow 2.5 environment (AugmentedNet's own), PYTHONPATH containing a mlflow stub.
"""
import json, os, sys, time, warnings
warnings.filterwarnings('ignore')
os.environ.setdefault('TF_CPP_MIN_LOG_LEVEL', '3')
import numpy as np
import pandas as pd
sys.path.insert(0, os.environ.get('AN_REPO', '/home/claude/an'))
from tensorflow import keras
from music21 import key as m21key, roman
from AugmentedNet import inference as I
from AugmentedNet.score_parser import parseScore
from AugmentedNet.input_representations import available_representations as availableInputs
from AugmentedNet.output_representations import available_representations as availableOutputs
from AugmentedNet.utils import padToSequenceLength, disableGPU

QUALITIES = json.load(open(os.environ['QUALITIES']))
QSETS = [frozenset(q['intervals']) for q in QUALITIES]


def quality_of(root, pcs):
    ints = frozenset((p - root) % 12 for p in pcs)
    if ints in QSETS:
        return QSETS.index(ints), 1.0
    best, score = 0, -1.0
    for i, q in enumerate(QSETS):
        s = len(ints & q) / len(ints | q) + (0.01 if len(q) == len(ints) else 0)
        if s > score:
            best, score = i, s
    return best, score


def key_of(token):
    return m21key.Key(token[0] + token[1:].replace('b', '-'))


def analyse(model, path):
    df = parseScore(path)
    inputs = [l.name.rsplit('_')[1] for l in model.inputs]
    encoded = [availableInputs[i](df) for i in inputs]
    layers = [l.name.split('/')[0] for l in model.outputs]
    seqlen = model.inputs[0].shape[1]
    model_inputs = [padToSequenceLength(i.array, seqlen, value=-1) for i in encoded]
    preds = [p.reshape(1, -1, p.shape[2]) for p in model.predict(model_inputs)]
    out = {}
    for name, pred in zip(layers, preds):
        out[name] = availableOutputs[name].decode(np.argmax(pred[0], axis=1).reshape(-1, 1))
    dfo = pd.DataFrame(out)
    n = len(dfo.index)
    off = np.full((n,), np.nan)
    off[:len(df.index)] = df.index
    dfo['offset'] = off
    chords = dfo.dropna()
    chords = chords[chords.HarmonicRhythm7 == 0]
    rows, cache = [], {}
    for a in chords.itertuples():
        key_token = a.LocalKey38
        rn2, _ = I.resolveRomanNumeralCosine(a.Bass35, a.Tenor35, a.Alto35, a.Soprano35, a.PitchClassSet121,
                                             key_token, a.RomanNumeral31, a.TonicizedKey38)
        ck = (rn2, key_token)
        if ck not in cache:
            try:
                k = key_of(key_token)
                rn = roman.RomanNumeral(rn2, k)
                root, pcs = rn.root().pitchClass, sorted(set(rn.pitchClasses))
                q, qs = quality_of(root, pcs)
                cache[ck] = (root, q, qs, k.tonic.pitchClass, int(k.mode == 'minor'))
            except Exception:
                cache[ck] = None
        if cache[ck] is None:
            continue
        root, q, qs, tonic, minor = cache[ck]
        rows.append([float(a.offset), root, q, round(qs, 3), tonic, minor, rn2])
    return rows


def main():
    src, dst = sys.argv[1], sys.argv[2]
    names = sys.argv[3:]
    os.makedirs(dst, exist_ok=True)
    disableGPU()
    model = keras.models.load_model(os.environ.get('AN_MODEL', '/home/claude/an/AugmentedNet.hdf5'))
    files = sorted(os.listdir(src)) if not names else names
    for f in files:
        out = os.path.join(dst, os.path.splitext(f)[0] + '.json')
        if os.path.exists(out):
            continue
        t = time.time()
        try:
            rows = analyse(model, os.path.join(src, f))
            json.dump({'file': f, 'chords': rows, 'seconds': round(time.time() - t, 1)}, open(out + '.tmp', 'w'))
        except Exception as e:  # keep going
            json.dump({'file': f, 'error': f'{type(e).__name__}: {str(e)[:200]}', 'chords': [],
                       'seconds': round(time.time() - t, 1)}, open(out + '.tmp', 'w'))
        os.replace(out + '.tmp', out)
        print(f, round(time.time() - t, 1), flush=True)


if __name__ == '__main__':
    main()
