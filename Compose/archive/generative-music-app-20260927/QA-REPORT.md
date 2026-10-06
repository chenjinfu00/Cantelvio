# AIlegro demo — independent verification

**Status: local demo accepted, 2026-09-26.** No production deployment was performed. GPT-6 Sol implemented the app; GPT-6 Astra performed independent read-only code review; the parent agent checked the running browser, responsive layouts and exported audio.

## Functional evidence

- All **12 regression tests pass**. They exercise real frozen model inference, accompaniment parity, queue identities and revisions, scene/global-state preservation, independent mixing, cancellation and timing races.
- The parent observed **34 consecutive Auto + Melody bars** advancing through the advertised chords. A separate Hold/random-scene run reached 25 scheduled bars while keeping the current D-minor chord.
- All **35/35 local samples** decoded in the browser. The actual audio context ran, and Stop/Panic cancelled playback. No browser console warnings/errors were recorded in the final UI pass.
- Future-chord editing changed the selected second future slot to D♭/F, preserved the current and earlier future chord, and regenerated later predictions.
- Saving a modified Warm Piano pad, reloading and recalling it restored triple meter, Alberti accompaniment and high melody register. Live playback reached bar 2 in 3/4. The test snapshot was then removed with Restore preset.
- Random scene switching at mean interval 1 changed active scenes while preserving key, tempo and Melody On. English/Chinese switching and the small-screen chord editor were exercised.
- Astra compared all four scenes across four bar phases against the original expressive accompaniment planner (16 comparisons). Eight Hold bars preserved keys, ages and future identities with key walk enabled. Auto consumed the advertised UID.
- Final independent hash check: **57/57 copied files** match the vendor manifest; **14/14 original Tonnetz modules** match the frozen baseline. Original Tonnetz and model weights are unchanged.

## Issues found and repaired

1. Replaced the initial simplified accompaniment adapter with the unchanged expressive planner, retaining voice-leading, chord-tone and articulation behavior.
2. Separated lookahead planning from the audible/UI boundary. Queued scene gain changes and the visible current chord now commit at the scheduled start. The 100 ms planning cutoff is documented.
3. Isolated manual mixer changes so they do not cancel another voice's pending automation.
4. Added late-clock/inference-overrun protection to avoid collapsed catch-up attacks.
5. Live browser QA caught a native timer receiver bug that fake-clock tests missed. Explicit native timer wrappers fixed advancement; a regression test and sustained browser playback confirmed it.
6. Increased output calibration by 5 dB before the compressor/guard, trimmed sustained pad and synth-bass by 3 dB, and repeated audio measurements.
7. Compressed desktop/landscape spacing. Changed phone dialogs to full-width stacked controls after finding truncated option labels.

## Audio evidence

Ten deterministic four-bar WAVs were rendered through the **same models, planners and Web Audio adapter** used by the app, then downloaded and independently measured using `validation/check_wav.py`. Seed 41977, 92 BPM, C major, Melody On, two-second release tail; stereo 44.1 kHz, 12.435 seconds each.

| Final render | Peak dBFS | RMS dBFS |
|---|---:|---:|
| Warm Piano | -9.05 | -27.89 |
| Velvet Jazz | -8.92 | -25.04 |
| Indie Drive | -9.01 | -27.23 |
| Open Air | -12.15 | -24.04 |
| Velvet bass only | -12.68 | -28.18 |
| Warm melody only | -16.66 | -32.15 |
| Indie chords only | -13.37 | -34.47 |
| Indie, all gains 100% | -4.94 | -21.89 |
| Open Air, all gains 100% | -6.03 | -16.89 |
| Warm, Panic at 2 seconds | -12.31 | -35.45 |

All ten passed signal-integrity checks: finite, non-silent output, zero clipped samples, negligible DC offset, and a silent final half-second. Panic's final active 100 ms window ended at 2.1 seconds. Float-buffer metrics before WAV encoding also reported zero nonfinite/clipped samples. The generated performances are dynamic; these fixtures do not exhaust every possible setting.

Evidence: `validation/audio-results.json`, `validation/browser-audio-metrics.txt`, and `validation/audio/*.wav`.

## Responsive evidence

- **1366×900 desktop** and **1180×820 iPad landscape**: all main performance controls fit in one viewport; settings button ends at y=705 in landscape.
- **820×1180 iPad portrait**: main controls fit without horizontal overflow; settings ends at y=1001.
- **390×844 and 320×740 phones**: natural vertical scrolling, no horizontal overflow/outside controls. Settings and chord editing use full-width stacked inputs, retain 44 px touch targets, and remain operable.
- Drawer overlays the page. Saved screenshots are in `previews/ailegro-demo-*.png`. Viewport overrides were reset after testing; playback is stopped in the delivered page.

## Limits

These are browser viewport simulations, **not physical iPad/Safari, multitouch or Bluetooth-latency tests**. Audio signal checks and code review verify output and engineering behavior, not a subjective listening preference or professional composition quality. The two small frozen experimental models were reused, not retrained. Background-tab timing is not guaranteed; interrupted playback stops safely and requires Play to resume.

## Update: Free harmonic timing — 2026-09-27

Accepted locally after GPT-6 Sol implementation, GPT-6 Astra independent review and parent browser/audio verification. The main transport now offers **Changes → Every bar / Free** alongside Hold/Auto. Every bar remains the default. Free commits 1/2 beats or 1/2 bars from a transparent duration policy conditioned on the frozen Harmony Transformer's inversion-aggregated distribution. This is not a newly trained duration head.

Evidence and fixes:

- **26/26 final tests pass.** Added coverage for model-dependent duration probabilities, committed short/long timing, real bar versus chord progress, mode changes, every scheduled edit lock, Stop/restart at internal onsets, meter remapping, tonal replacement and prefetch safety after live edits.
- **64/64 frozen melody fixtures** retain exact event hashes and decoder context counts with one harmony per bar. Astra additionally verified 16 complete Every-bar session outputs against the previous implementation, including RNG order.
- Parent independently ran **256 Free bars** over four styles and 3/4 + 4/4: every configuration produced internal chord changes and multi-bar holds, with finite positive events inside the correct bar. Maximum observed plan time was 37 ms on this computer; this is not an iPad performance claim.
- Browser trace: Am held through bars 17–18; bar 19 changed from Dm on beats 1–2 to Gsus4/C on beats 3–4; C held through bars 20–21. The bar counter retained the musical meter throughout. Switching back to Every bar produced Cadd9, Em, Am and Dm on successive bars 39–42. Hold displayed “Held · ∞” and retained C before resuming Auto.
- Latest three-beat + swing-melody browser run reached bar 12 with no console warning/error. Free/Auto are selected in the delivered preview, playback stopped; a fresh page still defaults to Hold/Every bar.
- Fixed a pedal-bass gap after an internal change; fixed bar-unit progress across 3/4↔4/4 meter changes. Review found and repaired two short-remainder melody duration-mask crashes. Independent review then passed 12,000 integer-timeline cases and 1,872 fractional-timing bars.
- Four actual Free-mode browser WAV renders passed independent signal checks: Warm peak/RMS −8.84/−27.24 dBFS; Velvet −9.31/−24.97; Indie −8.60/−26.74; Air −11.86/−23.98. All had zero clipping, finite signal, negligible DC and silent release tails. Each render decoded 35/35 samples.
- iPad landscape simulation 1180×820 fits the new control and durations; settings ends at y=722. Phone 390×844 shows a full-width Changes selector with no horizontal overflow. Viewport overrides were reset. Original saved pads were preserved.
- Final hash verification: all 57 vendor files and 14 original Tonnetz modules still match the frozen manifests. No deployment.

Additional evidence: `validation/FREE-RHYTHM-ACCEPTANCE.md`, `validation/melody-free-parity.json`, `validation/free-rhythm-simulation.json`, `validation/free-browser-beat-trace.json`, `validation/every-bar-browser-trace.json`, `validation/free-audio-results.json`, `validation/free-browser-audio-metrics.txt`, `validation/audio/*-free-full-41977.wav`, and `previews/ailegro-free-*.png`.


## Update: Two-row eight-measure chord chart — 2026-09-27

Implemented by the explicitly requested **GPT-6 Luna**, then independently reviewed and repaired by the parent. Accepted locally at `http://127.0.0.1:4187/`. Both Every bar and Free timing remain available.

- The former four-card lane is now a real measure chart: two rows × four bars, beat-proportional chord spans, continuation labels, visible beat dividers, current-segment highlight and a moving playhead. At each four-bar boundary the lower row moves to the upper row and the next four bars are prepared.
- **29/29 tests pass**, plus all seven independent pure chart checks. The parent's independent session oracle compared **96 actual bars** with previously advertised UID/chord/start/duration spans across Every bar/Free and 3/4/4/4, including **20 four-bar promotions**, then verified four mode/meter transitions.
- Independent asynchronous/edit checks pass: bounded visible-horizon preparation, no model inference in rendering or synchronous audible-onset callbacks, edited chord preserves the earlier prefix, stale prefetch cancels on key replacement, played history survives regeneration, and interruptions clear old chart history. A sample initial horizon prepared eight slots in approximately 40 ms on this computer; this is not a mobile-device performance guarantee.
- Actual browser trace: **32 beat observations**, **241 stable forecast-span comparisons**, and page transitions from bars 5–12 to 9–16 to 13–20. Prepared partial bars can gain additional spans, while their existing spans remain unchanged. The pointer stays on the upper row and resets to its left edge on promotion. No browser warning/error was recorded.
- In a second live run, bars 17 and 19 visibly contained internal changes: Dm for one beat → G/B for three beats, then G/B continuation for one beat → C for two beats → F for one beat. Continuations across neighboring measures were shown separately from new attacks.
- Future editing through the real UI successfully selected **D♭maj9♯11/G** and rebuilt the later forecast. A three-voice playback run reached 29 scheduled bars, decoded **35/35** samples and reported seven active voices with no interruption or console error. The sound engine and frozen model assets were not changed by this chart work.
- Parent review fixed forecast-vs-actual precedence, exhausted-tail fabrication, Every-bar initial cursor, missing-UID fallback, Hold-to-Auto projection, old history after interrupted playback, pointer row selection and exact measure positioning. Final UI repairs make beat lines visible over chord blocks, keep keyboard focus during refresh and restrict highlighting to the current measure.
- Responsive viewport checks: **1366×900 desktop**, **1180×820 iPad landscape**, **820×1180 iPad portrait**, **390×844 and 320×740 phones**. No document horizontal overflow or clipped chord labels in tested states. Landscape settings ends at y=817; portrait settings ends at y=1141. Narrow phones retain a 920 px two-row chart inside an independently scrollable container.
- Phone follow trace spans eight consecutive bar starts, including two row promotions. The chart's horizontal scroll followed the current measure while page `scrollY` stayed exactly **865** throughout, with one highlighted sounding segment and two rows throughout.
- All **57 vendor files** still match the frozen manifest. User-authored saved scene pads were preserved. Temporary viewport overrides were reset and playback was stopped in the delivered page.

These are browser viewport simulations, not physical iPad/Safari or touch-latency tests. No model retraining or deployment occurred in this update.

Evidence: `validation/CHORD-CHART-ACCEPTANCE.md`, `validation/check-chord-chart.mjs`, `validation/check-chart-session.mjs`, `validation/chart-session-result.json`, `validation/check-chart-edits.mjs`, `validation/chart-edit-result.json`, `validation/chart-browser-trace.json`, `validation/chart-browser-result.json`, `validation/chart-phone-follow.json`, and `previews/ailegro-chart-*.png`.
