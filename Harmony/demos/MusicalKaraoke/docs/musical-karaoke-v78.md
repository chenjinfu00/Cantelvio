# Musical Karaoke — manual harmony and temperature

On Harmony as a graph, the presenter can choose a displayed next-chord node. The selected chord plays with the existing piano and voice-leading logic, then appends to the current history. Each model uses that updated history for its next prediction. The current chord remains excluded from the candidates.

The current chord continues as a repeating piano arpeggio while the presenter considers the next transition. Manual transitions and Next chord switch the loop to the new harmony. Play 8 temporarily takes over the audio, then the loop follows the final chord. Stop, leaving the slide, or hiding the page ends the loop.

The Temperature slider adjusts all three models. Lower values concentrate probability on the strongest transitions; higher values broaden the distribution. It controls both the visible probabilities and automatic sampling, including all eight steps of Play 8. Switching models retains the chosen temperature; changing palettes loads that palette's preset temperature.

Graph controls support keyboard activation, and the slider supports keyboard adjustment. Interactions stay on the current slide. Play 8 temporarily locks the controls to keep the audible phrase and displayed model state aligned. The repeating arpeggio leaves the controls available.

The eight-slide structure and the version 77 audio-recovery changes are preserved.

A right-side invitation reads “If you want to play some melody, please visit” followed by the red link “aigimon.ai/tonnetz”, pointing to https://www.aigimon.com/tonnetz/.

## Validation

GPT-5.6 sol implemented the changes; the parent independently reviewed the lifecycle and UI. All 72 tests pass, including temperature effects in all three models, the no-repeat mask, and cancellation while the arpeggio awaits piano preparation.

Local browser checks verified manual C to F to G history, keyboard activation with retained focus, continuous slider dragging, model switching with the temperature retained, and the complete eight-chord Transformer attention matrix without clipping. Piano playback instrumentation recorded repeated F-chord notes while controls remained usable, and Play 8 resumed an arpeggio on its final chord. Stop kept the note count unchanged even after temperature adjustment; Next chord restarted playback; navigating to the final slide stopped it. The new controls and link were also inspected in a 390-pixel iframe for narrow-screen layout. Temporary QA pages and instrumentation are excluded from publication.

## Publication

Version 78 succeeded at 2026-09-24T22:48:40.123628+00:00.
Source commit: `06d32f7109eea8e1227b6aaa770a49d32cdf0040`.
Version: `appgprj_6ab0f9d1162481919aab5aee39f0a28b~appgver_29c3fb41509481919529b3ccc159b2f6`.
Deployment: `appgdep_6ab5a8b268bc8191ad3edb1d3902acfc`.
Public entry: https://www.aigimon.com/MusicalKaraoke .
