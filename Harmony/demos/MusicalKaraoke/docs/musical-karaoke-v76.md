# Musical Karaoke — richer harmony generation

## User-approved presentation structure

Eight pages remain: cover → Choir → Tonnetz → Shape of chords → Process → Isomorphic keyboard → Harmony as a graph → Authentic cadence. Process follows the lattice/chord explanations and immediately precedes the keyboard. Existing Choir practice, audience-only singing, and audible “The answer” stay unchanged.

## Process

Keep the original six sequentially unlocked examples and add:

- F → G → A♭ → B♭ → C; IV → V → ♭VI → ♭VII → I.
- F → G → Em → Am → Dm → G → C; IV → V → iii → vi → ii → V → I.

The last example spans two grid cells. All seven chord diagrams in its playback strip must remain visible. Do not reduce the whole slide font to fit; reserve three rows for eight buttons and use compact diagrams. Clicking plays the current demonstration before unlocking the next one.

## Three generators on one page

Model tabs select a first-order Markov chain, a second-order Markov chain conditioned on the previous two chords, and a small causal Transformer. The graph summarizes the current chord and likely continuations. The probabilities shown must be the probabilities actually sampled, including any palette filtering, temperature, or disclosed harmony prior. Display omitted probability mass explicitly when showing only the strongest candidates.

Every generated step must change chord. Mask the current token to zero, renormalize the remaining probabilities, and display exactly that constrained distribution; preserve raw attention weights. This applies to all three models.

A “New palette” action changes the available chords and corresponding parameter preset. Styles: Pop, Classical, Jazz, Chromatic; the last includes all vocabulary. The chord/parameter panel should be inspectable and playable. Include all chords used earlier, Neapolitan D♭/F, leading-tone Bø7/Bdim7, applied diminished sevenths, secondary dominants, common major/minor/dominant sevenths and selected ninths. The UI stays in English with large sans-serif text, sparse explanation and local LaTeX.

For the Transformer, display the actual causal attention matrices from the same forward pass used for prediction. Distinguish attention weights from next-chord probabilities. Show model dimensions, context length, parameter/preset values and training provenance in the parameter panel. Do not present an authored teaching model as one trained on real performance data. Numerical and training details belong in harmony-model-design.md.

## Musical and model rationale

Treat transition probabilities as authored musical choices, not empirical laws. Prioritize functional resolution while retaining stylistic alternatives: D♭/F tends toward G/G7, leading-tone sevenths toward tonic, E7 toward Am, A7 toward Dm, D7 or F♯dim7 toward G. Voice chords in a stable register and favor small movements. The design supports exploration rather than claiming every random output must be attractive.

Sources read for this revision:

- [NiceChord: Neapolitan Chord](https://nicechord.com/post/neapolitan-chord/): ♭II major triad, commonly in first inversion; C-key spelling D♭–F–A♭.
- [Open Music Theory: Neapolitan sixth](https://viva.pressbooks.pub/openmusictheory/chapter/bii6/): predominant function and resolution toward dominant.
- [Open Music Theory: Seventh chords](https://viva.pressbooks.pub/openmusictheory/chapter/seventh-chords/): leading-tone half-diminished seventh in major and fully diminished seventh with raised leading tone in harmonic minor.
- [Vaswani et al., Attention Is All You Need](https://arxiv.org/abs/1706.03762): scaled QK dot products, causal masking, multi-head attention, feed-forward sublayers and residual connections.

## Acceptance

- Correct page order, eight pages, eight Process examples; no overflow or hidden final row.
- All expanded chord labels have playable, correctly spelled pitch-class sets; Neapolitan bass is F.
- Every distribution is finite, nonnegative and normalized. Preset availability and displayed probabilities match actual sampling.
- Identical last chord with different preceding chord changes second-order probabilities; earlier context can change Transformer output.
- Attention has zero future mass; each allowed row sums to one. Validate browser inference against training/runtime reference.
- Clicking, replaying, stopping, model changes and page changes do not leave sounds running or advance hidden steps.
- Inspect graph, parameter panel, chord palette and full 8-token attention view in the browser before publishing.

## Completed validation (2026-09-25)

GPT-5.6 sol implemented the model engine and explorer; the parent reviewed musical reachability, voicing, the actual attention implementation and UI integration. Review corrections included reachable diminished/secondary-dominant chords, a hard F bass for D♭/F, removing artificial repeated-tonic training samples, and a hard no-adjacent-repeat sampling constraint.

All 62 automated checks pass. These include all 33 current-chord states × four palettes × three models, normalized output, exact Markov memory, causal attention, and JavaScript/Python numerical parity. Independent seeded exploration of 1,728 generated transitions found zero adjacent repeats; this is a behavioral check, not a claim that every random phrase is a finished composition. Retraining reproduces the exported weights byte for byte.

Local browser review at 1280 × 720 covered the two added Process examples, the seven-diagram strip, Process → Isomorphic keyboard navigation, all model tabs and palette switches, an eight-token attention matrix and both heads, the 33-chord parameter drawer, playing D♭/F as a new seed, full eight-chord playback, and Stop before completion. Stopping retains only sounded chords and leaves the guided step incomplete. No browser errors or KaTeX errors were reported. The matrix, probability bars and history were rearranged after visual review to avoid overlap. Parameter details intentionally scroll inside their drawer.

The shipped Transformer has one causal block, two heads, eight-token context and 6,729 parameters, trained on 117 authored synthetic phrases. It is a transparent teaching model with a disclosed functional-harmony prior, not a model trained on a large music corpus.

## Publication record

Published version 76 successfully on 2026-09-24 at 22:03:19 UTC (2026-09-25 local).

- Source commit: `44bf7c1d0645d93e600a38601300f82ec0913342`
- Version ID: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_b26531cb6a488191a23ac374c227ad81`
- Deployment ID: `appgdep_6ab59e10b7488191b57f1c11fe62bd8d`
- Public entry: https://www.aigimon.com/MusicalKaraoke
- Native origin: https://ai-haowan-guide.chenjinfu.chatgpt.site/MusicalKaraoke

The Site audience remains public. The original Kitaev deck and standalone Tonnetz instrument were not changed.
