# Musical Karaoke — audience singing and graphical summary

## Accepted scope

The latest user instruction explicitly expands Musical Karaoke from seven to eight pages. Add a separate penultimate summary after Isomorphic keyboard; preserve the final Authentic cadence. Keep the text-free cover, large sans-serif text, sparse English presenter cues, guided clicks and playable examples. Preserve the original /Kitaev presentation and the separate Tonnetz instrument.

## Implementation

1. Choir: remove the combined correct-answer demonstration. “Sing together” now runs one visual 3–2–1 count-in (2.4 seconds), followed directly by four 1.6-second audience-only cues. The entire 8.8-second media asset is silent. Notes and C → G → Am → F appear only after natural completion. Stopping or failed playback cannot reveal the answer. Individual voice practice remains exactly twice; individual sung-note buttons remain playable. Use a new asset filename to avoid a cached old demonstration.
2. Pages: cover → Choir → Process → Tonnetz → Shape of chords → Isomorphic keyboard → Tonnetz summary → Authentic cadence. Update displayed total and site metadata to eight.
3. Summary: chords are shapes; progressions are paths. Show C, G, Am and F as four clickable graph states, with Tonnetz-consistent upward major and downward minor triangles. The graph has normalized illustrative transition probabilities, not probabilities inferred from geometry or measured from music.
4. Model: first-order Markov chain, P(c_{t+1} | c_t), rendered with local KaTeX. “Autoregressive generation” describes sequential sampling conditioned on the current chord. Play path demonstrates C → G → Am → F → C; Next chord samples a transition and plays it. Full path completion permits advancing; stopping, a single chord and random sampling cannot skip the guided demonstration.

## Scientific basis

- [Towards a topological fingerprint of music](https://arxiv.org/abs/1602.00739): Tonnetz encodes harmonic relationships graphically.
- [Dive into Deep Learning: Sequence Models](https://www.d2l.ai/chapter_recurrent-neural-networks/sequence.html): autoregressive factorization and the first-order Markov assumption. General autoregressive models can use longer history; this slide deliberately uses a first-order example.

## Verification

- GPT-5.6 sol implemented the graph module and tests, then independently reviewed triangle orientation, probability normalization and terminology.
- Parent review separated the summary into page seven after the user's page-count clarification, simplified labels and corrected graph arrow endpoints to stay outside cards.
- Local browser review at 1280 × 720: Choir count-in and delayed answer, keyboard-to-summary-to-cadence navigation, graph sampling, interrupted and completed path, final cadence, page counters, formula and layout.
- New summary panels have no measured horizontal or vertical overflow; no KaTeX or browser console errors. Narrow viewport screenshots are not claimed.
- Audio PCM verification confirms the full together asset contains silence and exactly four audience cues with no played answer. Transition sampling and all existing geometry/register/audio lifecycle tests pass.
