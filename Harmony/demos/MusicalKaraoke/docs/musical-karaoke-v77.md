# Musical Karaoke — live-audio recovery

The reported symptom was audible recorded Choir clips, followed by animation without sound from the Tonnetz page onward. The browser was not identified, so the exact device-specific output failure could not be reproduced from the report alone.

The audio code did have two concrete compatibility gaps: it resumed only `suspended` contexts, ignoring WebKit's `interrupted` state, and Tonnetz's visual timers could finish successfully while a context was no longer running. Recorded media and synthesized audio also left the browser to choose different audio-session categories.

The fix requests the optional `playback` audio-session category for both recorded voices and live music. Tonnetz now reuses the piano player's audio context, without waiting for piano sample downloads. Both suspended and interrupted contexts resume on a user gesture, closed contexts are recreated, and a non-running output prevents a guided step from completing. An interruption during live playback stops scheduled sounds/cues and leaves the step retryable.

Validation: 69 tests pass, including interrupted-context recovery, failure to resume, closed-context rebuilding, shared-context preparation without downloading piano assets, partial-chord cleanup, mid-play interruption and cancellation. Local browser checks use a temporary analyser to verify nonzero generated audio signal rather than relying solely on animation. Device speaker output still requires user confirmation; no microphone or recording permission is requested.

References used:

- [MDN: BaseAudioContext state](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/state)
- [MDN: AudioSession type](https://developer.mozilla.org/en-US/docs/Web/API/AudioSession/type)

## Parent verification and publication

The parent reviewed GPT-5.6 sol's changes and verified recorded-answer playback followed by Tonnetz in a same-origin iframe matching the production embedding. Tonnetz output peak measured 0.0547; a piano C chord measured 0.0789 in the local analyser. These confirm generated digital signal, not the user's physical speaker output.

Version 77 deployment succeeded at 2026-09-24T22:21:53.602299+00:00.
Source commit: `45754d2603a96bdfe11dbebf374a3e532e96dbc8`.
Version: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_2413ab82ae908191ba180222731b0b60`.
Deployment: `appgdep_6ab5a26af3648191863c753a80914f2e`.
Public entry: https://www.aigimon.com/MusicalKaraoke .

An initial approval-service quota failure prevented the first source sync. After the user's explicit request to publish, the normal approval path succeeded; no approval check was bypassed.
