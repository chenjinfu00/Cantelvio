# Tonnetz accompaniment — independent bass and Rock

Date: 2026-09-26. Status: implemented and checked locally; not published.

## User-facing changes

- Remove the sole-model heading and redundant model copy from the main Harmony panel. Keep the existing folded attention/parameter inspection.
- Phone timeline shows chord symbols. Tap a chord to see its full symbol, notes, Roman numeral and key. Outside taps dismiss it.
- Wider screens measure each chord cell: show notes directly when they fit, omit the Roman numeral first if needed, and offer expansion only for cells that still cannot fit. Keyboard geometry stays fixed when the bottom sheet opens.
- Bass means an independent low voice, not a compulsory bass-guitar timbre. Choose electric bass, synth bass, piano left hand, or Off; set its balance independently of the accompaniment mix.
- Choosing a style restores that style’s rhythm, pattern and instrument defaults; all can then be overridden. Tempo, mix volume, Human feel and Phrase variation remain independently adjustable.

| Texture | Chord voice | Low voice | Arrangement |
|---|---|---|---|
| Pop | Acoustic piano | Electric bass | Syncopated chords, root/fifth motion and connective chord tones |
| Rock | Electric guitar | Electric bass | Alternating short/open strums and driving eighth-note bass |
| Jazz | Electric piano | Electric bass | Sparse swung comping and quarter-note walking bass |
| Classical | Acoustic piano | Piano left hand | Alberti figures and root/fifth bass |

## Musical behavior

The first bass note respects the displayed inversion. Upper voices occupy a separate register; extended voicings favor thirds, sevenths and color tones. Walking bass approaches the committed next chord’s bass by semitone without generating a different harmonic future. Rock preserves thirds/sevenths rather than turning every chord into a power chord.

Four-bar phrases vary stroke density, upper voicing, articulation and emphasis. Seeded per-note variation adds bounded timing, dynamics, duration and strum spread. Human feel and Phrase variation can be reduced to zero. This is a rule-based performance arranger over the existing learned harmony generator, not a recording of a human band or a newly trained performance model.

Both accompaniment voices use separate audio groups and preserve held melody notes. Notes are dispatched 40 ms early and started on the Web Audio clock; transport remains synchronized with sounding bars. Stop, manual chord changes and audio interruption cancel both accompaniment groups, including notes scheduled but not yet started. Late background callbacks are dropped instead of producing bursts.

## Sample provenance

Guitar and bass recordings are credited to **Karoryfer**, curated/edited by **N. P. Brosowsky**, from [tonejs-instruments](https://github.com/nbrosowsky/tonejs-instruments). Pinned source commit: `622c2f1c32c8cfce4158ddc3eb26e518ddef37e5`. Samples are distributed under [CC BY 3.0](https://creativecommons.org/licenses/by/3.0/). Nine bass files (3,159,084 bytes) and nine guitar files (924,264 bytes) are copied unchanged. Each local folder includes a source/hash manifest and attribution notice. Playback applies pitch shifting, filtering and envelopes; guitar also has mild saturation.

No Tone.js or smplr runtime was added; the existing Web Audio engine plays the samples. Sample loading has bounded timeouts and does not block audio readiness. Built-in voices sound while samples load or if they fail. The service worker includes all files for offline use after installation. Piano retains its existing Salamander attribution. The visible Sound credits section links the sources.

## Verification

- 63 automated tests passed, including all 2,172 chord inversions, musical phrase variation, walking-bass targets, independent audio groups, exact scheduled onsets, interruption/stop behavior, missing-sample fallback, asset hashes and offline coverage.
- Full Site production build passed locally.
- Browser checks at 1280×720, 1024×700 and 390×700: phone symbols expand to note names; tablet C/G/Am/F notes fit directly; no horizontal panel overflow; all four style buttons fit. Keyboard bounds unchanged when the sheet opens/closes (tablet top 14 px, height 648 px).
- Real browser audio: all nine guitar and nine bass samples decoded; sampled note counters increased; nonzero output measured for Rock, Pop, Jazz and Classical. Held melody survived stopping both accompaniment groups. Sliders updated their visible values and runtime controls.
- Layout checks used narrow browser frames, not physical iOS/Android devices. Musical taste and final loudness balance remain for the user to audition.

Local preview: http://127.0.0.1:4174/tonnetz/

Publication is still pending the previously requested explicit authorization after automatic approval review rejected the earlier production publish attempt. No deployment was attempted for this update.
