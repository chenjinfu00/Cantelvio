# Tonnetz: tonal Transformer, broad chord vocabulary and inversions

Implemented 26 September 2026. Scope: `/tonnetz/`; the presentation remains unchanged.

## Interaction

- Keep only Transformer in Harmony. Retain accompaniment rhythm, pattern, instrument, BPM and temperature controls.
- Choose one of 24 major/minor keys with the arrow beside the key button. The unlit button holds this key fixed. Lighting it enables generated harmony and a slower key random walk.
- Default walk interval: one opportunity every 8 generated chord changes; selectable 4, 8, 16 or 32. Holding a chord and reading/opening the interface do not advance this clock. An opportunity may stay in the same key.
- Key neighbors: same key, dominant, subdominant, relative and parallel key, with base weights 0.30/0.22/0.22/0.21/0.05. Multiply by `0.6 + 0.4 × common-tone fraction` with the preceding chord and normalize. This is a separate explicit stochastic tonal process, not a hidden Markov chord model.
- Commit chord and key together in the three upcoming timeline slots. Consuming a slot plays exactly its advertised chord/key. Parameter edits deliberately replace the future; render reads do not reroll it.
- The chord library filters by root, family and inversion. Selecting a chord holds it, with its actual displayed bass. Tapping a timeline slot reveals its full symbol, tones and key without advancing it. This preserves the compact four-slot phone dock for long slash symbols.
- The workbench remains an overlay: opening it does not move or resize the keyboard. English is default; Chinese remains available through Settings.

## Vocabulary and voicing

40 quality templates across all 12 pitch-class roots give **480 base symbols** and **2,172 chord-tone bass/inversion variants**. This includes major/minor/diminished/augmented/suspended/power chords; sixths; major, minor, dominant, minor-major, half-diminished and fully diminished sevenths; added tones; ninths, elevenths, thirteenths; and common altered dominants.

This is a broad finite vocabulary, not every possible pitch-class set, polychord, microtonal chord or arbitrary non-chord pedal bass. Neapolitan sixths are ordinary major triads on the flattened supertonic with their third in the bass. Enharmonically equivalent symbols can represent distinct harmonic functions. Canonical internal pitch-class IDs are separate from correctly spelled display tones (e.g. A/C♯).

The selected slash bass is strictly the lowest MIDI pitch. All chord tones are voiced, with an efficient register/voice-leading search rather than factorial permutations. Accompaniment bass stays at or above MIDI 36 even when an already-low inversion is selected. Choosing another inversion of the same root/quality does not satisfy the existing “must change harmony” generation constraint; manual library selection still allows it.

## Learned model

A causal, pre-normalized Transformer with learned root, quality, inversion, mode, style and positional embeddings:

| Property | Value |
|---|---:|
| Residual blocks | 4 |
| Attention heads per block | 8 |
| Hidden width / head width | 64 / 8 |
| Feed-forward width | 192 |
| Context | 24 previous chords |
| Trainable parameters | 204,391 |
| Harmony output | 480 classes |
| Conditional inversion output | up to 7 classes |

Each block contains masked scaled dot-product self-attention, output projection, residual paths, LayerNorm and a GELU feed-forward network. The inversion head conditions on both final history representation and candidate chord identity. Root input/output is relative to the selected key; transposing the entire history and key transposes the probability distribution exactly.

Inference uses the exported learned weights locally in the browser. Probabilities combine learned base-chord logits and conditional inversion probabilities, a disclosed soft `−0.12 × out-of-key tones` decoding bias, and the user temperature; the current base harmony is excluded. There is no Markov chord prior mixed into logits. Every other supported inversion remains available in every style. Attention inspection exposes each of the 32 actual head matrices.

Architecture references: [Attention Is All You Need](https://arxiv.org/abs/1706.03762) and [PyTorch TransformerEncoderLayer](https://docs.pytorch.org/docs/stable/generated/torch.nn.TransformerEncoderLayer.html). The implementation uses explicit projections so every head is inspectable and browser inference can be checked against training inference.

## Training and limitations

Training uses an **original synthetic harmonic phrase grammar**, not recordings or a real-song corpus. It includes major/minor phrase templates, stylistic chord qualities, secondary dominants, diminished approaches, Neapolitan sixths and coverage examples. These hand-authored training frequencies are not empirical corpus frequencies and cannot establish professional compositional quality.

- Seed 926734; 4,800 training phrases; 512 validation phrases. All 2,172 chord/inversion variants are asserted to occur as training targets after related dominant or ii-chord preparations; validation omits the systematic coverage prefixes. Training metrics use a 512-phrase subset.
- Validation uses held-out degree templates and disjoint exact sequences, while sharing the overall harmonic grammar.
- AdamW, learning rate 0.0016 with cosine decay, dropout 0.08, label smoothing 0.025, gradient clipping; 1,600 steps, batch 32.
- Select the best validation checkpoint: step 200. Later checkpoints overfit this grammar; they are not deployed.
- Validation base-chord cross-entropy 3.100083 vs unigram baseline 4.305644; perplexity 22.199798; top-1 26.33%. Conditional inversion top-1 67.63% (a root-heavy distribution).
- Metrics refer to the learned model on synthetic validation phrases before decoding constraints. They do not measure real music, subjective pleasantness or the combined key-walk system.
- Rare extended inversions have much less training support than root position or first inversion. They are selectable and have valid probabilities, but broad availability is not evidence of equal musical fluency.
- Relative encoding gives transposition coverage without claiming independent training data for every absolute key. Key walking is an authored process; pivot-chord modulation planning is not learned here.
- Authored progression presets transpose their original chord qualities; selecting a minor home key does not rewrite those authored arrangements as minor progressions.

Reproduction: run `scripts/train-tonnetz-transformer.py` with PyTorch in the existing `tonnetz-karaoke/.venv-harmony-training` environment. Quality order in `scripts/tonnetz-chord-qualities.json` is the token contract. `docs/tonnetz-transformer-training.json` stores the training curve and metrics. Browser weights include three independent PyTorch parity probes.

## Verification

- All 56 Node tests pass; the complete Site builds successfully. Tests cover every voicing/bass, finite normalized probabilities, no repeated base harmony, exact key transposition equivariance, history/mode/temperature sensitivity, synthetic validation improvement, PyTorch parity, all 32 causal attention heads and slow committed key lookahead.
- Desktop and 390 × 700 phone UI checks cover major/minor selection, fixed/lit key states, actual fourth-change modulation, first/third inversions, audible preview/accompaniment output, keyboard playing during accompaniment and stable keyboard dimensions under the overlay.
- Service worker cache updated to v34 with the new model/vocabulary/tonality assets. The obsolete Tonnetz tiny model is removed; presentation assets are unchanged.
