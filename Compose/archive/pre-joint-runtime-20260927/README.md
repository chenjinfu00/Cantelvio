# AIlegro

**Independent project root:** this `AIlegro/` folder contains everything needed to run and modify the app. Start with [START_HERE.md](START_HERE.md) for the Chinese handoff guide and [AGENTS.md](AGENTS.md) for coding-agent context. You can copy the entire folder elsewhere; no sibling Tonnetz checkout is required.

A standalone, locally served performance workbench using the frozen Tonnetz v91 Harmony and Melody Transformer models. No account, network service, deployment, or new training is involved. The model files and sampled instruments are bundled. This app does not share transport, storage, audio context, or panic with Tonnetz.

Run with Node 20 or newer:

```sh
npm start
```

Open **http://127.0.0.1:4187/**. The server binds to loopback only. `PORT=4188 npm start` changes its port; the `HOST` override is deliberately opt-in. `npm test` runs the regression tests. No package installation is required.

## Training and project ownership

All future automatic-accompaniment, Harmony and Melody model development belongs to AIlegro. The separate sibling Tonnetz project retains its existing runtime for compatibility; Volta remains the score reader. Full local training scripts, data preparation, raw pinned OpenScore source archive, processed corpus, parameter checkpoints and evaluation tools are in [training/README.md](training/README.md). New training outputs go to `training/runs/` and do not replace runtime weights automatically.

## Playing

- **Play** creates/unlocks this app’s audio context within the user gesture, loads 35 local samples, then starts. Stop remains available during loading. The sound drawer reports actual decoded sample counts, failures and synthesis fallback. **Retry missing samples** retries only failed sample files, with a 12-second request timeout.
- **Hold** repeats the current harmony indefinitely; **Auto** consumes the committed future chords. **Changes → Every bar / Free** selects harmonic timing, independently of Hold/Auto. Every bar is the default. The chord chart shows eight real measures in two rows of four. Each chord block spans its committed beats; long holds continue across barlines, and the playhead follows the audible bar. Melody is **Off** on every fresh load. Melody Off cancels only melody audio and resets its decoder. A mixer mute does not disable inference.
- The three gain controls and three mutes operate independently. Master gain is separate. There is no crossfader pretending to blend two generators.
- Four scene pads change instruments, rhythm, texture, styles, four macros and relative mix. They preserve tempo, key, key walk, harmonic timing mode, master, mutes, Melody On/Off, Bass On/Off and already-committed chord choices. Tap a queued pad again to cancel while it remains uncommitted. Tap another to replace it. Stopped scene selection prepares sound without playing.
- Scene changes occur at the **next available bar**. Planning runs approximately 100 ms before its audio start to leave time for local inference. An action during that brief committed window affects the following available bar. The old current chord and active pad stay visible until the scheduled start; every chord already used inside the scheduled bar has a dashed outline and cannot be edited. In Free mode this can include several chord blocks; editable slots resume beyond the planned bar. This cutoff is deliberate, not a guarantee of responding to a last-millisecond pad tap.
- Save to active pad stores the current sound snapshot under `ailegro.scenes.v1` on this device. Restore preset restores the selected factory pad. Settings do not auto-play, and the next page load starts with default transport and Melody Off.
- **Tempo**, 40–200 BPM, changes on the next available bar. Select any of 24 major/minor keys; a new key starts on its tonic chord at the next available bar. Key Walk considers a neighboring key after 4/8/16/32 generated chord changes and may remain in the same key. Hold does not advance its sounding count.
- **Harmony T** explicitly regenerates not-yet-scheduled future slots, preserving the current chord and every chord already committed into the playing/scheduled bar. Melody T, density, feel and sound choices affect the next unscheduled bar. Changing a harmony condition/key-walk setting also explicitly rebuilds the future queue. Scene-driven Harmony T changes only affect newly appended predictions.
- Click an editable future chord block for Transformer candidates or root, quality and inversion controls. Every edit captures a stable UID and queue revision. An advance can preserve a still-future edit; a consumed, scheduled, rebuilt or superseded target is rejected. Earlier chord choices and durations remain unchanged; the edited target receives a new model-conditioned duration and later slots regenerate.
- The sound drawer offers instruments, five rhythms, eight accompaniment textures, four bass patterns, independent harmony/accompaniment/melody styles, melody rhythm, motif/arc/answer/arpeggio patterns, middle/high register, melody-to-harmony interaction, random scene mean interval (1–32 bars), and master level. Random changes sample once per bar with probability `1 / interval` and use the same scene transition rules.
- **Stop** and **Panic** cancel all this app’s scheduled voices and timer generations. Stop cancels all within-bar onsets and preserves the last actually heard chord; restarting replays that chord with its full committed duration. Unheard planned chords are not consumed. Panic affects only AIlegro. Ordinary window focus loss does not stop it. Audio suspension/interruption/page exit stops safely; a Play gesture resumes without catching up missed bars. Keep the tab visible for reliable timing; hidden-background continuity is not guaranteed.

English is the default. The language selector switches the interface to Chinese. There is no embedded Tonnetz keyboard, MIDI, recording/export in the performance page, dual engine, crossfade, or cloud synchronization. WAV export in the separate diagnostics page is solely for evaluating rendered fixtures.


## Free harmonic timing

**Auto + Every bar** retains the original one-chord-per-bar behavior. **Auto + Free** permits 1 or 2 beats, 1 bar or 2 bars per harmony: 1/2/4/8 beats in 4/4 and 1/2/3/6 in 3/4. The initial tonic starts with one bar. Hold overrides either timing mode indefinitely. Hold/Auto, Every bar/Free and meter changes apply on the next available real bar; Stop/Panic remain immediate.

The frozen Harmony Transformer still predicts the next chord. Its inversion-token probabilities are first summed by the 480 underlying chord identities. The duration policy uses maximum base-chord confidence, entropy normalized against that vocabulary, the chosen chord's probability relative to the maximum, and a tonic-resolution rule. Concentrated, well-supported forecasts tend toward longer holds; uncertain forecasts offer more short changes. A stable UID/chord-derived draw selects among the four musical lengths without consuming the harmony sampler's random sequence. **This is a musical duration policy conditioned on real Transformer probabilities, not a newly trained duration head.** The length is committed with its UID when previewed and never rerolls when the interface renders.

The real beat/bar clock keeps running through both internal changes and multi-bar holds. Accompaniment is replanned on the real bar grid and melody runs one causally connected decoder sequence per real bar, with its current/next harmony condition changing inside that sequence. Long holds continue the groove; they do not create silent waiting bars. The chart lays those same committed spans across eight measures, while `BAR n · beat/meter` remains the actual musical clock. Switching back to Every bar changes at the next real boundary and retimes queued durations without replacing chord identities. A meter change preserves the completed fraction of a bar-unit hold (rare fractional remaps round to the nearest sixteenth for legal decoder positions); beat-unit lengths remain literal beats.

Planning occurs about 100 ms before each real bar, including all its harmonic segments and notes. Every included future UID is locked and identified as scheduled in its accessible label. This preserves one consistent harmonic/melodic plan for that bar. An editor opened earlier cannot submit after its UID becomes scheduled. Mode/tempo/key/scene requests inside that cutoff use the following available bar. Scene randomness and scene/tempo/key application remain real-bar operations, never per-chord timers. Saved user scenes and existing local storage are not reset by this feature.

## Eight-bar chord chart

The chart contains two rows of four measures. The playhead moves across the top row with the audible clock. On the fifth measure, the old lower row becomes the upper row, and four newly predicted measures fill the lower row. Beat dividers and proportional chord widths expose internal changes; “continue” identifies a chord carried across a barline. Only the segment sounding in the current measure is highlighted.

The chart keeps real played/scheduled bar records and projects the same committed future queue that the audio planner consumes. It never pads an unfinished forecast with repeated invented chords. Queue inference fills the visible horizon in small asynchronous steps; a briefly striped unfinished measure means its forecast is preparing. New predictions use current melody feedback; already displayed choices stay committed until explicitly edited, regenerated, or retimed, so melody feedback does not retroactively rewrite the score.

Click a future block to change its chord or inversion and rebuild what follows. Stop/restart begins a fresh eight-measure view from the last heard chord. On narrow phones the two-row score scrolls horizontally to follow the playing measure without scrolling the whole page. Desktop and tablet layouts retain all eight measures when space allows.

## Four factory scenes

| Scene | Harmony / accompaniment / melody styles | Sound and texture |
|---|---|---|
| Warm Piano | pop / pop / pop | Sampled piano, syncopated comping, piano root/fifth bass |
| Velvet Jazz | jazz / jazz / jazz | Synthesized electric piano, swing comping, sampled walking bass, reed lead |
| Indie Drive | pop / rock / blues | Sampled electric guitar, eighth-note strums, sampled driving bass |
| Open Air | pop / pop / ambient | Synthesized pad, quarter-note blocks, synth bass pedal, bell melody |

The styles have distinct contracts: the Harmony model has no rock or ambient condition. Factory macro values match `PREPARATION.md`; these are arrangement settings, not separately trained style models.

## Implementation and testing

`src/session.js` owns session, scenes, committed queue and melody performer. `src/queue.js` owns UID/revision validation, committed durations, dynamic prediction options and a canonical cursor that advances only on actual audible onsets. Planning may extend the queue tail without consuming it. `src/chord-chart.js` projects those committed queue slots into beat-accurate measure spans, preserves immutable played/scheduled bars, and stops when its prepared horizon ends. `src/duration-policy.js` owns the transparent probability-conditioned duration policy. `src/transport.js` owns one clock, generation checks, sample-loading races, scheduling, the 100 ms planning window and audible start callbacks. `src/planner.js` wraps the **unchanged** v91 `buildBarEvents` planner and maps chord/note/bass roles to independent buses. Its timeline adapter retains the actual bar groove for each harmonic segment, crops old pitches at a change, and adds an internal harmony/bass rearticulation when the original groove would leave that new segment silent. Pedal bass sustains to the segment boundary. `src/melody-timeline.js` is a documented adaptation of frozen v91 `improvisation.js`: one decoder sequence per real bar, with chord/next-chord conditions updated within the bar and melodic durations bounded to the active segment. No original vendor file, weight, feature order or token contract changes. `src/audio.js` is a fresh DOM-independent sample/synthesis adapter with ramps, per-group cancellation, headroom, compressor and final soft saturation. New UI modules do not import the Tonnetz DOM/workbench/app controller.

`npm test` covers future edit identity/revisions, stop-during-loading and stale callbacks, suspended/late clocks, scene quantization and global/queue preservation, Hold/Auto/key-walk behavior, mix independence and melody reset, exact frozen accompaniment event parity, finite bounded events, real Harmony inference and real Melody inference, staged sounding-lane transitions, inversion-aggregated duration evidence, short/long commitments, true-bar/chord progress separation, every-bar/free/Hold transitions, mid-bar stop cancellation, full scheduled-slot edit locking, 3/4 and meter remapping, pedal sustain, single-harmony melody parity, integer/fractional short-segment melody masks, score-span mapping, forecast exhaustion and four-bar chart rollover. The current suite has 29 tests, including a check that regenerating an unscheduled tail never moves model inference into audible-onset callbacks.

**http://127.0.0.1:4187/qa/** renders reproducible four-bar clips through the same models, planners and audio adapter in `OfflineAudioContext`. It offers Every bar or Free, each factory scene, isolated voices, full mix, all-gains-high stress, and scheduled Panic. Render metadata lists the real bar and beat of every harmonic segment, including segments of a longer hold. The page reports actual float-buffer peak, RMS, clipping, nonfinite samples, DC and last-250-ms tail peak, and provides WAV playback/download. Each render uses C major, Melody On, Auto, seed 41977 by default, 92 BPM and a two-second release tail. Offline metrics do not prove subjective listening quality or live-device timing. Browser/independent audio results, where present, are in `QA-REPORT.md`.

## Model limitations and provenance

Weights, vocabulary, feature order and metadata are frozen to Tonnetz v91, source commit `b6bc3e7aefa4f415408566957b7b1918d32a31af`. `VENDOR_MANIFEST.json` records SHA-256 for every copied module and sound asset. `SOURCE_BASELINE.json` and `PREPARATION.md` remain historical preparation snapshots; neither is rewritten to claim implementation or deployment. The bundled Tonnetz runtime remains unchanged. Local project directories and training ownership were reorganized as recorded in `PROJECT-REORGANIZATION.md`; the online deployment is unchanged.

Harmony has 204,391 trainable parameters and was trained on 4,800 authored synthetic harmonic phrases, with 512 validation phrases. Melody has 349,325 parameters and was trained on synthetic material plus a limited set of CC0 OpenScore/Lieder classical vocal excerpts. Validation was used for checkpoint selection, not an independent listener study. These are small experimental models: metrics and browser responsiveness do not establish professional composition quality or universal style coverage.

All inference and audio happen locally in the browser. The static server receives only local asset requests. Saved scene settings stay in the browser. There is no analytics, service worker, account or upload.

## Credits and licenses

Sample families are carried forward with their source attribution and conservative CC BY 3.0 treatment; retain their notices and manifests when redistributing:

- [Piano notice](media/piano/NOTICE.txt)
- [Electric bass notice](media/bass/NOTICE.txt)
- [Electric guitar notice](media/guitar/NOTICE.txt)
- [Melody training data notice](vendor/MELODY-DATA-NOTICE.txt) (CC0 training excerpts; separate from the sampled instrument license chain)

Electric piano, pad, strings, lead, reed, organ, bell and plucked colors are synthesized. Piano, electric bass and electric guitar use sampled buffers when available; missing buffers fall back explicitly to synthesis. The adapter is independent code; the original Tonnetz audio/DOM app is not copied.

## Browser review note

The first live browser pass caught a timer receiver issue that pure fake-clock tests could not expose: calling the native browser timer as a `Transport` method could bind it to the wrong receiver. Default timers now call `globalThis.setTimeout`/`globalThis.clearTimeout` through explicit wrappers. A fresh live browser pass then reached bar 2 in Auto with Melody On and consumed the advertised next chord. The drawer’s clock, scheduled-bar count, active frame/voices and last-stop reason remain visible diagnostics for interruption reports.

The first four-scene audio fixtures retained more than 13 dB of peak headroom but played conservatively quietly. Calibration adds 5 dB before the existing compressor and soft safety guard, while the sustained pad and synth-bass voices receive a 3 dB trim to reduce their RMS advantage over decaying samples. The visible master and independent scene faders retain their meaning; this is fixed instrument/output calibration, not automatic loudness normalization. Final measured levels belong in the independent QA report.
