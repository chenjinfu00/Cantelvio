# Two-row harmony player — acceptance

User request (2026-09-27): replace the four-chord lane with an iReal Pro-like player showing two rows of four real measures each. A playhead moves right through the top row. After four measures, the lower row moves up and four new preview measures appear. Within-measure chord changes must be clear. GPT-6 Luna implements; parent independently reviews.

## Display contract

- Exactly eight measures in two rows, four measures per row. Real measure numbers and local beat divisions support both 4/4 and 3/4.
- Chord spans are placed proportionally at actual onset/end beats, not evenly sized regardless of duration. A continued chord is distinguished from a fresh attack and can continue across measure/row boundaries.
- Playhead uses audible transport frame and audio clock, stays synchronized through tempo changes, and is not advanced by the scheduling lookahead.
- Rows advance at actual measures 5, 9, 13... Bottom-row chords shown before advancement become the same upper-row chords, except an explicit edit/parameter change that reflows the future.
- Past/current scheduled bars are frozen from actual plans; canonical queue alone cannot reconstruct consumed past chords. The lower row is genuine forecast used by future playback, never illustrative filler.
- Future chords retain UID/revision editing. Already scheduled chords, current chord and past chords cannot be overwritten. Edits preserve earlier commitments and rebuild later measures.
- Hold, Every bar, Free, tempo/meter/key changes, Stop/Panic/restart and scenes remain coherent. Old four-card lane is removed.

## Performance / layout

- No Transformer inference inside render or audible onset callbacks. Forecast tail uses bounded asynchronous prefetch with stale-generation cancellation and an honest temporary preparing state if required.
- Archive and prefetch are bounded; forecast creation must not cause catch-up bursts or audio interruption.
- Four-bar rollover respects reduced motion. Desktop and iPad text is readable with no overlap. Narrow screens may use chart scrolling; do not shrink dense one-beat chord labels to illegibility.
- Preserve saved pads and all original vendor/weight/Tonnetz files. No deployment.

## Evidence

- Pure chart mapping: short chords, long holds, continuation, 3/4, row boundary, partial progress and mixed meter histories.
- Forecast/playback correspondence through at least two four-bar rollovers.
- Editing, stale prefetch and Stop/restart safety, including pending key replacement.
- Existing 26 tests plus meaningful new regression coverage.
- Live browser pointer, row rollover, editing and audio-clock checks; desktop/iPad/phone screenshots; no console errors.
