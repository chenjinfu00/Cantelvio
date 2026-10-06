# AIlegro local demo acceptance

The production Tonnetz baseline remains unchanged. This demo must use the real
frozen Harmony and Melody models and a separate audio context/session. No deploy
is part of this request. The reviewer records observed results in QA-REPORT.md.

## Functional checks

- First Play produces output after the audio permission/user gesture; loading
  failure is visible and can be retried. Stop/Panic while loading cannot start
  delayed music. Repeated Play never creates two clocks.
- Hold keeps the current chord and accompaniment. Auto consumes the advertised
  future queue at boundaries. Tempo changes affect subsequent bars, never cause
  catch-up notes or multiple clocks.
- Scene pads set parameters immediately while stopped; during playback they
  queue, replace, cancel, and commit at the next bar. They preserve global key,
  tempo and Melody On/Off. Saved scenes can be recalled after reload.
- Chords, Bass and Melody level/mute are independent. Muting chords leaves bass
  audible. Melody Off clears future melody and context without stopping other
  voices. Every offered instrument and texture yields a supported event/voice.
- Future edits use UID/revision. Earlier advertised chords remain fixed and later
  chords recompute. Editing an elapsed or stale slot cannot overwrite a new slot.
- All 24 keys, key walk, both temperatures, density, feel and random-scene rate
  are connected to the generator/transport. No old model picker or keyboard.
- English/Chinese switching updates controls. Drawer overlays content without
  pushing the deck. Escape, close and Stop have coherent editing behavior.
- Ordinary focus changes do not stop audio. Context interruption and pagehide
  cancel scheduling and require a deliberate restart without a catch-up burst.

## Browser/sound evidence

- Desktop 1366×900; iPad landscape 1180×820; portrait 820×1180; narrow 390px and
  320px. Inspect overlap, body overflow, modal access and minimum 44px controls.
  These are viewport simulations, not iPad hardware validation.
- Offline recordings use the same audio engine as playback and visible QA
  controls. Four scene mixes plus separate voices: finite output, no clipping,
  reasonable DC offset, audible melody/bass/chords, complete end tail.
- Independently inspect downloaded WAV files with validation/check_wav.py.
  Signal integrity and musical event checks do not establish listener preference.
- Check console errors, asset readiness and actual running audio status through
  user-visible diagnostics, not undocumented browser globals.
