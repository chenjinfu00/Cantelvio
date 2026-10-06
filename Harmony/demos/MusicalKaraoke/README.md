# Kitaev → Tonnetz · local demo

This folder contains two separate 16:9 browser presentations and a local copy of the Tonnetz instrument with rehearsal controls. The original eleven-slide explanation remains unchanged. The seven-page Musical Karaoke is published at https://www.aigimon.com/MusicalKaraoke. Its Tchaikovsky and Mendelssohn rehearsal entries and assets are omitted from the new publication. The original presentation remains at https://www.aigimon.com/Kitaev.

## Run

```sh
npm start
```

Open `http://127.0.0.1:4173/` for the original eleven-page explanation, or `http://127.0.0.1:4173/karaoke/` for the new seven-page musical karaoke. In Musical Karaoke, blank left-click, the right arrow and Space perform the next prescribed step. Audio must finish before the next reveal; a completed page can then advance. Blank right-click and the left arrow revisit the preceding page. `F` toggles fullscreen, and the square button stops the current demonstration without completing it. The original deck retains ordinary page navigation.

The seven pages are an illustrated cover, Choir, Process, Tonnetz, Shape of chords, Isomorphic keyboard, and Authentic cadence. Three participants learn anonymous four-note parts, are checked by the presenter, then sing together before the notes and C–G–Am–F harmony are revealed. Progressions, chord shapes and keyboard modes appear in sequence. The Tonnetz develops from a chromatic circle through fifths to a 12-note cell and its translations. Bundled formant-synthesized vowel clips follow `public/media/karaoke/manifest.json`, and their cues follow audio `currentTime`. No microphone is requested. See [the current execution specification](docs/guided-seven-slide-execution.md), [voice asset notes](docs/karaoke-assets.md), and [sound-source review](docs/sound-source-review.md).

The original eleven-page deck’s live demo slide opens either rehearsal directly:

- `/tonnetz/?demo=melody` — Classic layout, black-and-white skin, Tchaikovsky solo-entry excerpt (~54 seconds).
- `/tonnetz/?demo=harmony` — Harmonic layout, deep-sea skin, Mendelssohn opening theme (~59 seconds at rehearsal tempo).

Both rehearsals return to `/#demo`. Bundled concerto excerpts use score-derived synthesized audio and matched guides. Play along removes your part; Listen plays the reference. See [source and excerpt notes](docs/concerto-excerpts.md). Importing a local audio file switches to free play and disables the unmatched practice guide; imported audio never leaves the device.

## Verify

```sh
npm test
```

The tests verify both presentation page contracts, chord pitch classes and concrete coordinates, tuning endpoints, voice assets and cue timing, cancellation races, the application U/V basis, the two exported layout snapshots, both rehearsal paths, local KaTeX, and the absence of service-worker registration in this development copy.

No external font is required. Musical Karaoke uses 17 bundled Salamander piano samples for notes, chords and progressions, synthesized vowel recordings for the choir, and oscillators for exact tuning comparisons. The original instrument retains its own voices and optional network SoundFonts. Piano provenance and credits are bundled beside the samples.

## Original eleven-page revision

The bottom bar shows the current page out of eleven; repeated footer titles are omitted. All formulas use locally bundled KaTeX 0.18.7. A separate title cover opens the presentation, followed by the Majorana solution of the Kitaev model with its original reference. Chord shapes are enlarged; six progression buttons show only Roman numerals and chord symbols, with chord labels above the diagrams. Periodicity is explained in four steps and the keyboard comparison is titled Isomorphic keyboard. The coda links to AIgimon and its public Tonnetz instrument.

See [the current specification](docs/current-demo.md). KaTeX assets and fonts are already bundled in `public/vendor/katex/`; to regenerate them after installing or updating dependencies, run `node scripts/vendor-katex.mjs`. Tests also validate the deck's LaTeX and local font files.

## Publication

The hosted copy is mounted at `/Kitaev` in the existing AIgimon Site (version 59). Only `app/Kitaev/` and `public/Kitaev/` were added to that checkout. The deployed source commit is `9267339291b3fa4e15451275b2a4697e8d5b4056`. The existing public Tonnetz application is unchanged.

`stage-aigimon.mjs` copies public runtime assets, makes subdirectory links explicit, and limits service-worker cleanup to this presentation’s own scope. Local scores, temporary source files, and source PDFs are not part of the publication.

The current Musical Karaoke release is Site version 72, source commit `ad405d37ad2a48f518f197ec4b1dd51ecc2d09e6`. See [guided validation](docs/guided-seven-slide-validation.md). `stage-musical-karaoke.mjs` adds only `app/MusicalKaraoke/` and `public/MusicalKaraoke/`, with an explicit runtime allowlist and a sound-engine page stripped of concerto controls. See [the publication record](docs/musical-karaoke-publication.md).
