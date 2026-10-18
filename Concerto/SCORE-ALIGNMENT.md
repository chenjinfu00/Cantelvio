# Chopin Op.21/I — printed score positions

The published Finley MIDI is an expressive performance, not a quantized score. Its 385 four-quarter time grids must not be used as printed bar numbers. The mapped movement has 348 complete printed bars and a five-sixteenth pickup. Playback events, controllers and tempo messages remain unchanged.

## Source and reproduction

Primary symbolic reference: Fryderyk Chopin Institute digital first edition, Breitkopf & Härtel (Leipzig, 1836), https://chopinscores.org/krn/021-1a-BH-001.krn . The downloaded encoding stays in the ignored local alignment directory; only the derived timing map is published. Its SHA-256 is recorded inside the map. The supplied Polish National Edition two-piano PDF is the visual reference; opening, solo entries/rests, fermata/cadenza and ending were checked against it. Selected detailed PDF checks cover pages 13, 17, 26, 29, 30, 32, 33 and 48.

`Concerto/scripts/build_score_alignment.py` reads that source, the exact published MIDI, and uses Verovio 6.3.0 and Music21 10.5.0 to extract the notation. NumPy/SciPy/Numba provide the bounded DTW and matching pass. Use a project-local environment; do not install these into the base interpreter. In this checkout the prepared environment is `Concerto/local/alignment-20261018/venv/`.

Run the builder with `--refresh` to regenerate symbolic caches, or without it to reuse verified input caches. `--source /absolute/path/021-1a-BH-001.krn` and `--work-dir /absolute/path/to/scratch` select explicit local inputs. There are no implicit downloads. The builder reconstructs the performance event data through the browser's actual MIDI parser, checks the two input identities and writes `site/concerto/assets/chopin-op21-alignment.json`. Rebuilding with the prepared cache reproduced SHA-256 `2cca6887b5a5c01a27ada6a43070ba8a40f11b7dee0dd6e5046cd0edef09b8d1`.

## Mapping and limits

Register/onset features provide a coarse alignment. Pitch-specific note attacks are then matched against the piano or orchestra according to each cue note. A weighted monotone chain prefers supported downbeats over ambiguous repeated tones. The reference has 3,929 attack groups; 3,779 matched and 3,712 enter the monotone chain. Explicitly audited attacks cover the pickup, first bars, piano entry, written fermata/cadenza, solo ending and final orchestral chord. Quarter-note boundaries interpolate between aligned attacks; they are not a new quantized MIDI or a claim of independent acoustic following accuracy.

- Pickup F5 / A-flat4 / B-flat4: MIDI quarter coordinates 0.975 / 1.208333333 / 1.841666667, displayed as pickup quarter beats 3.75 / 4 / 4.75.
- First complete bar 1: C5 at MIDI 2.05. Bar 2 begins at 5.666666667.
- Solo entry: printed bar 71 at MIDI 259.3.
- Bar 148 contains the written fermata/cadenza. Its note chain is explicitly anchored; the UI displays free time here.
- Bar 214 begins with a solo quarter rest. The orchestral downbeat is retained before the piano enters.
- Solo ending: bar 337 at MIDI 1486.508333333. The orchestral tail continues.
- Final chord: bar 348 at MIDI 1530.258333333; the held chord ends at 1534.258333333. The remaining MIDI release tail never becomes bar 349.

`alignment.mjs` applies the map only to the matching source MIDI. Start 0 includes the original leading setup and pickup; start 1 starts the first complete printed bar. Old saved MIDI-grid starts migrate once to score numbering, preserving PDF/page/tempo/volume. Unknown files retain explicitly labelled MIDI grids. The map changes display and seek positions; it does not alter the separate experimental microphone follower or add automatic PDF page turns.

Acceptance: `node --test site/tests/concerto*.test.mjs` includes source attacks, all 348 bars and quarter boundaries, old volume-100 settings migration, invalid-map failures, cadenza/tail behavior, and full event scheduling from eight mapped starts. Full site tests and deployment evidence are recorded under `site/reports/concerto-web-20261018/`.
