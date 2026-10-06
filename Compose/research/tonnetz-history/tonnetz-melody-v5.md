# Tonnetz melody v5: learned phrases and explicit motif memory

This revision keeps the browser's genuine autoregressive Transformer and its
melody-to-harmony affinity head, and adds an explicit two-bar motif reference.
Every pitch, rest and note duration is still selected from learned logits.
Phrase memory and a small number of musical constraints organize those choices;
this is not an imported pretrained music model or a claim of professional
composition quality.

## Architecture and performance

Four causal Transformer layers, eight attention heads per layer, width 96,
feed-forward width 224, 96-event bounded KV cache, 349,325 learned parameters.
The previous model used width 64, FF 160 and context 64. Two new categorical
inputs encode the remembered motif pitch and duration at the current position.
The reference is revoiced to the current root and key, without reading a future
melody. The next-chord condition only enters the pitch output; the affinity and
duration heads never receive it. Exported PyTorch probes verify all logits and
all 32 attention heads against JavaScript.

The first two bars state a motif, bars 3–4 answer and cadence, bars 5–6 develop,
and bars 7–8 return and cadence. This is a local phrase clock: enabling solo or
changing its style, rhythm, meter, key or register starts a fresh statement.
Changing the current or upcoming chord keeps the theme and adapts its reference.
A discontinuity in transport clears the old context. Ordinary accompaniment
switches retain the existing transport and solo lifecycle behavior.

Sampling permits prepared strong-beat tensions and stepwise passing notes.
A tension resolves on the next sounding event to a chord tone within two
semitones when one is playable; otherwise it uses the closest available chord
tone. An octave is the outer leap bound, with a softer penalty on larger leaps.
Short repeated-note motifs remain possible. Increasing repetition penalties and
an alternative-checked four-attack limit prevent accidental stuck notes.
Cadences descend toward a landing, lengthen the arrival, reserve a final-quarter
rest decision, and taper velocity and release. Ambient notes do not skip that
rest decision. Durations remain bounded by the current bar; ties across a future
editable chord boundary are intentionally not introduced in this revision.

## Data, licensing and representation

The synthetic set contains 4,500 independently seeded eight-bar phrases, with
newly generated two-bar themes, stylistic rhythms, answers, development and
returns. All 40 chord qualities and their valid inversions have training
coverage through the broad-harmony branch. A separate 300-phrase validation set
uses held-out harmonic templates and independent theme seeds. This is a limited
musical grammar, not an exhaustive model of any named style.

The additional real material is CC0 OpenScore/Lieder at commit
`38c5db510224d9facdc4b08d741fc788cfb58ea8`:
[repository](https://github.com/OpenScore/Lieder),
[CC0 license](https://creativecommons.org/publicdomain/zero/1.0/).
The public `MELODY-DATA-NOTICE.txt` records the attribution and limitations.
No lyrics or audio recordings are included. The extracted neutral records and
source parser are supplied for reproducibility.

The conservative source extraction retained 135 works (120 train / 15
validation). The training loader uses 899 eight-bar excerpts from 116 training
works and 150 excerpts from all 15 validation works. Work membership is fixed
before windows are extracted. The extractor also removes exact transposed
melody duplicates. Unsupported timing, changing meter/key and polyphonic vocal
parts are excluded. Piano-derived chord labels and major/minor mode are
estimates, not authoritative score annotations. Real excerpts are labeled
**classical only**; they do not provide real jazz, blues or pop training data.

Only eight contiguous full bars are used, so pickups do not shift the grid.
Onsets and durations are rounded to sixteenths; explicit gaps become rest tokens.
Repeated pitches preserve their separate attacks. Sustains crossing a bar are
segmented for the current playback contract. One octave translation is chosen
for the whole excerpt. Windows that cannot fit the two-octave model range are
rejected instead of folding individual notes across octaves. Long notes may be
segmented to the duration vocabulary. These are material representation limits.

## Training and evaluation

The reproducible run uses one CPU thread, seed 927511, 1,500 AdamW steps, batches
of 16 phrases and a cosine learning-rate schedule. Checkpoints are selected on
synthetic validation loss plus a 0.3-weighted real-validation loss. The 15 real
held-out works therefore form a **validation set, not an untouched test set**.
No human listening-preference study has been performed.

Detailed initial/final metrics, checkpoint-selection curve and provenance are
in `tonnetz-melody-training.json`. `tonnetz-melody-real-comparison.json` evaluates
v4 and v5 on identical first-64-event prefixes of the real validation excerpts.
`tonnetz-melody-rollout-comparison.json` reports free-running 60-phrase structural
and timing measurements with fixed seeds and progressions. Those metrics
measure rhythm/contour recurrence, tension handling, rests and repetition; they
are not perceptual quality scores. Classical contour recurrence can differ
from the other styles and must not be hidden behind an aggregate.
`tonnetz-melody-listening-examples.json` contains the exact generated events for
representative matched examples, including velocity and timing.

The selected checkpoint is step 1400. On the identical real validation
prefixes, v4 → v5 pitch cross-entropy is 3.341 → 2.043
(real-training unigram: 2.776); duration cross-entropy is
2.526 → 1.088. Pitch top-1 accuracy is
22.4% → 33.2%. These prediction improvements do not
establish listener preference. The final synthetic validation pitch CE is
0.803, compared with 3.264 at initialization.

The fixed 60-phrase rollout observed at most 4 identical consecutive attacks
in v5. Return-rhythm overlap and tension-resolution measurements are reported
per style in the JSON; they must not be treated as targets that guarantee musical
quality. Measured Node p95 inference was 2.6–5.2 ms per bar on this machine,
not a mobile-browser performance guarantee. The JavaScript weights are about
3.9 MB uncompressed, versus about 1.9 MB for v4.

## Reproduction

Use the existing project PyTorch environment; no Anaconda base installation is
needed. From the project root:

```sh
python scripts/prepare-tonnetz-openscore.py /path/to/pinned/OpenScore-Lieder scripts/data/tonnetz-openscore-cc0.json
python scripts/train-tonnetz-melody.py --steps 1500 --corpus scripts/data/tonnetz-openscore-cc0.json
python scripts/evaluate-tonnetz-melody.py --baseline-root /path/to/v4/checkout
node scripts/evaluate-tonnetz-melody-rollouts.mjs /path/to/v4/checkout
python tests/tonnetz/training-corpus.test.py
node --test tests/tonnetz/*.test.mjs
```

The Python commands above mean the selected PyTorch interpreter, not system
Python. The parser uses only the standard library. Training exports both the
checkpoint and JavaScript weights. The old checkout must contain its original
training script, checkpoint and runtime assets for honest baseline comparison.

## Integration boundaries

Changed runtime assets are the melody performer, decoder sampler and trained
weights. Existing audio scheduling, manual-note groups, Hold mode, accompaniment
options and UI are preserved. Solo-off cancels only the existing automatic-solo
group; scheduler generation guards remain intact. Tests cover upcoming-chord
causality, harmony feedback, motif conditioning, phrase resets, opening rests,
cadential breathing, repetition limits, 24-key playability and audio cancellation.
Browser listening and stress validation should still be performed before release.
