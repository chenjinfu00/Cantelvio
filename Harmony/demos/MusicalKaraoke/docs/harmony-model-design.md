# Harmony model design

The “Harmony as a graph” page contains three small teaching models. They are designed to make musical dependencies inspectable in a browser. They are not statistical claims about concert practice, streaming catalogues or listener preference.

## Shared vocabulary and presets

All models use the same 33 chord tokens. The vocabulary includes the diatonic triads used elsewhere in the deck, modal mixture, C minor harmony, common seventh and ninth chords, the Neapolitan `D♭/F`, leading-tone `Bø7` and `Bdim7`, applied diminished sevenths, and the secondary dominants `A7`, `D7` and `E7`. Pitch classes are stored with C = 0. `D♭/F` has the pitch classes D♭–F–A♭ and an explicit F bass.

Each preset is a mask over that vocabulary plus a temperature and a Transformer prior-blend value:

| Preset | Character | Temperature | Prior blend |
| --- | --- | ---: | ---: |
| Pop | diatonic loops and modal colour | 0.82 | 0.18 |
| Classical | functional cadence, mixture, Neapolitan and applied dominants | 0.72 | 0.28 |
| Jazz | sevenths, ninths, ii–V motion and chromatic approaches | 0.92 | 0.16 |
| Chromatic | all 33 tokens | 1.04 | 0.22 |

The palette mask is applied before temperature. A strict generation rule then sets the current chord's probability to zero and renormalizes: every generated step must change harmony. Temperature is applied after this no-repeat mask. The returned distribution contains every enabled chord, including zero-probability entries, and is the exact distribution passed to the sampler.

## Authored Markov models

The first-order model reads only the last chord:

\[
P(c_{t+1}\mid c_t).
\]

Its sparse rows are authored musical choices. There is no universal smoothing across the graph. Small approach edges make every enabled chord reachable within its preset, while the larger weights retain familiar resolutions. In particular, `D♭/F` puts 92% of its untempered mass on `G7` or `G`; `Bø7` and `Bdim7` put at least 90% on `C` or `Cm`; `E7`, `A7`, `D7` and `F♯dim7` put at least 90% on their intended resolution families. The common-tone `Cdim7` primarily returns to C. The borrowed path A♭ → B♭ → C is explicit.

The second-order model uses an authored row when the final pair is listed:

\[
P(c_{t+1}\mid c_{t-1},c_t).
\]

For example, `F → G` offers both `Em` and `A♭`, while `Dm → G` strongly favours C. If a pair has no authored row, the model falls back to the first-order row for the last chord. It never reads an earlier token.

For both Markov models, disabled destinations are removed and the remaining row is normalized. The current chord is then hard-masked and the row is renormalized. Temperature is applied as

\[
p'_i=\frac{p_i^{1/T}}{\sum_j p_j^{1/T}},
\]

and that normalized row is returned to the UI and sampler.

## Tiny causal Transformer

The Transformer is trained offline and runs entirely in browser JavaScript. Its architecture is intentionally small:

- context length: 8 chord tokens;
- token and learned position embeddings: 24 dimensions;
- one pre-normalized causal self-attention block;
- 2 attention heads of 12 dimensions each;
- 48-dimensional feed-forward layer with tanh-approximate GELU;
- residual connections and a final layer normalization;
- 6,729 trainable parameters and a 33-token output projection.

For each head, attention is calculated by scaled dot product:

\[
A=\operatorname{softmax}\!\left(\frac{QK^\top}{\sqrt{12}}+M\right),
\]

where the causal mask `M` is zero on and below the diagonal and negative infinity above it. The page receives the two `T × T` matrices from the same forward pass that produced the next-chord logits. Future cells are exactly zero and every permitted row sums to one. These matrices show attention weights between input positions; they are not next-chord probabilities.

The model was trained with a fixed seed using AdamW on 117 original synthetic teaching phrases. No recording, score corpus, performance log or external composition was used. The phrases encode diatonic motion, functional cadences, applied dominants, modal mixture, minor harmony, diminished approaches, Neapolitan motion and jazz extensions. Cadential arrivals continue into new authored phrases instead of being repeated as padding, which avoids teaching artificial tonic loops. Every ninth deterministic continuation variant is held out for validation. The exported build records 638 training examples, training perplexity 1.419972 and validation perplexity 2.951462 after 350 epochs.

Browser inference first applies the selected vocabulary mask to the Transformer softmax and renormalizes it. It then blends that distribution with the masked first-order teaching prior:

\[
p_{\mathrm{mix}}=(1-\lambda)p_{\mathrm{Transformer}}+\lambda p_{\mathrm{prior}}.
\]

The preset-specific `λ` appears in the parameter panel. After the blend, the current chord is assigned exactly zero probability and the remaining mass is renormalized; if numerical underflow removed all remaining mass, a palette-local authored fallback supplies only non-current alternatives. Temperature is applied last. The final normalized values are both displayed and sampled, so palette filtering, the disclosed prior, the mandatory chord change and temperature cannot diverge from playback. Attention still comes directly from the raw Transformer forward pass; the output constraint does not alter its matrices.

## Voicing

`voiceChord` enumerates compact pitch-class-complete voicings between MIDI 48 and 79. It scores register, span and bidirectional nearest-note motion from the preceding voicing. The explicit slash bass for `D♭/F` is a hard constraint. Other chords prefer root position when voice-leading costs are otherwise similar. This is a pragmatic playback voicer, not a full species-counterpoint engine.

## Reproducibility and checks

Run the trainer only in the project-specific environment; the environment and PyTorch installation are development inputs and are never part of the published site:

```sh
.venv-harmony-training/bin/python scripts/train-harmony-transformer.py \
  --output public/karaoke/tiny-transformer.js
```

The generated module contains rounded weights, training metadata, and one Python parity probe. The JavaScript tests reproduce that forward pass and compare every logit and attention cell. Additional checks cover normalized full-preset distributions, exact Markov memory, earlier-prefix sensitivity in the Transformer, causal attention rows, preset reachability, functional resolution mass, sampling boundaries, pitch-class-complete compact voicings, the Neapolitan bass, and seeded sequence generation. An exhaustive runtime check covers every vocabulary token × preset × model combination and verifies that the current chord has zero final mass, including both sampler boundaries. Seeded generation therefore has 0% immediate repeats by construction; this is a presentation constraint rather than a learned musical law.
