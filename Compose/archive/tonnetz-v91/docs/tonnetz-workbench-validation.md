# Tonnetz accompaniment workbench — review record

Date: 2026-09-26

## Delivered scope

- GPT-5.6 Sol implemented the accompaniment/audio bridge, harmony drawer, and interactive learning material; the parent agent reviewed and corrected integration issues.
- A separate bottom pull-up accompaniment drawer contains style, rhythm, pitch pattern, instrument, BPM, volume, temperature, harmony generation, chord choices, and educational content. Existing keyboard settings remain separate.
- Pop, jazz, and classical presets; five rhythms, six patterns, five accompaniment voices; 40–200 BPM.
- Hold chord, eight preset progressions plus authentic cadence, and automatic generation using Markov 1, Markov 2, or the existing tiny Transformer. All 33 model chords, four palettes, manual probability-row selection, temperature, parameters, and actual attention are available.
- The learning section includes the chromatic circle and fifths on that same circle, a 12-note period cell, a tiling of the plane, pure/equal-tempered fifths, edge intervals, and transposable chord shapes.
- English default with Chinese/English switching through the existing settings drawer. Choir is excluded. MusicalKaraoke and Kitaev are unchanged.

## Automated checks

- 36 workbench checks passed: scheduler timing and cancellation, audio ownership, interrupted/closed AudioContext recovery, nonblocking sample loading, interval and lattice geometry, learning lifecycle, progressions/cadence, model distributions, bilingual copy, drawer integration, and service-worker scope.
- Site integration suite: 42 passed, including the original six English/Chinese checks; cache-version assertions updated to the new assets.
- Original presentation regression suite: 75 passed, including its comprehensive Markov model checks. Copied harmony model files retain the deployed implementation.
- Reproduce the new checks from the staging project with `npm test`; in the Site checkout run `node --test tests/tonnetz/*.test.mjs`.

## Browser checks

Reviewed locally in the Codex in-app browser at 1280×720 and inside a 390×700 mobile-sized frame.

- Accompaniment generates nonzero Web Audio output; the temporary analyser reads actual destination audio, not just animation.
- Melody and accompaniment sound simultaneously. Stopping accompaniment leaves a sustained melody note active and audible in the analyser.
- Manual chord selection previews the selected chord and preserves Hold mode; Start loops it. Temperature changes update probabilities; Transformer head controls update the displayed causal attention matrix.
- The fifths path starts real notes and advances highlighting. Hiding the panel cancels its previews.
- Bottom drawer opens and closes by drag and click. Fixed an inherited edge-swipe handler that initially opened the settings drawer during an accompaniment swipe.
- Fixed root scrolling that could move the instrument off-screen, mobile title truncation, stale scroll position when changing tabs, and a preview voice overlapping a newly started accompaniment.
- Checked independent menus, readable mobile controls, scrolling within the drawer, English/Chinese switching, and no browser console errors in the reviewed final UI.

## Practical limits

- A real iPhone/iPad touch and speaker test was not performed; mobile layout was checked at the stated browser dimensions.
- Piano samples are same-origin with a built-in synthesized fallback. Existing optional orchestral melody soundfonts retain their existing external provider.
- Generative probabilities and the tiny Transformer's synthetic training phrases are educational models, disclosed in the interface; they are not estimates trained on a commercial music corpus.
- Temporary QA pages and analyser instrumentation are not part of the deployment.
