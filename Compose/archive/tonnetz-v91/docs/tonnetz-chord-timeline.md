# Four-chord accompaniment timeline

2026-09-26

The keyboard now has a persistent lower timeline showing the current chord and the next three bars. Chord blocks move left against a fixed red playhead. A fixed Now label keeps the sounding chord readable even as its block exits. The drawer may be collapsed while the timeline remains visible. Learn and instrument settings retain their unobstructed views.

Desktop blocks show chord symbols, Roman numerals, and pitch-class contents. The narrow-screen layout keeps symbols and Roman numerals readable. The beat counter follows the sounding meter; reduced-motion preferences retain a stationary chord strip.

## Playback contract

- Hold repeats the chosen chord. Progressions wrap at their actual lengths, including the seven-bar preset and three-bar cadence.
- Generators commit three future choices using virtual history. The player consumes exactly those choices, appending one new prediction per boundary. Lookahead never changes the history of chords already heard.
- Manual selection, a model/palette/temperature change, or a mode switch rebuilds the future. Generate next consumes the displayed next chord in Generate mode.
- Transport progress reads the accompaniment scheduler's actual bar start and duration. Pending BPM or meter changes apply to the next bar. Manual chord replacement restarts the current bar; Stop cancels animation and resets the progress line.

## Validation

- 42 staging tests passed, including six new behavioral checks for queue consumption, virtual-history isolation, all three real models across every palette, meter/tempo timing, manual replacement, stalled callbacks, and restart.
- Reviewed in the local browser at 1280×720 and in a 390×700 mobile frame, both with the drawer open and closed.
- Verified live leftward transforms, manual Generate next consuming the advertised queue, current chord updates during playback, and a pending change from four beats at 92 BPM to three beats at 200 BPM.
- Browser audio analyser confirmed nonzero accompaniment output. Stop removed accompaniment voices and returned timeline progress to zero. No browser console errors were observed.
- QA pages and analyser instrumentation are excluded from publication.
