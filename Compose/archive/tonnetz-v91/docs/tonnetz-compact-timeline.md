# Compact Tonnetz performance strip — 2026-09-26

## Changes

- Reduce the timeline from 110 px to 56 px, with no separate Now/current heading.
- Show chord symbol, Roman numeral, and constituent notes on one line. Narrow layouts progressively hide notes and numerals while keeping all four chord symbols.
- Add start/stop and next-chord buttons on the left; style and 40–200 BPM controls on the right. The style selector stays in the accompaniment drawer on narrow phones.
- Reuse accompaniment state and committed lookahead for every quick action. Editing BPM does not lose focus when a chord changes.
- Keep the four labels stationary and readable throughout the bar; a slim segmented rhythm track travels left beneath them against the red playhead. This prevents the outgoing chord from disappearing near the end of the bar.
- Refresh the Tonnetz service-worker cache and workbench asset versions.

## Verification

- Stage: 42/42 tests passed; Site integration: 48/48 passed.
- Browser checked at 1280 × 720 and in a 390 × 700 phone viewport. The timeline measures 56 px in both; four chord symbols and the side controls fit.
- Quick next in Progression changes C → G and keeps the advertised Am → F → C queue.
- Quick start/stop produces and stops accompaniment; the local audio meter confirms nonzero output. Melody and accompaniment scheduling remain isolated by the existing tests.
- Typed quick BPM 110 and the drawer both show 110; changing the drawer slider to 111 updates the quick input. Quick Jazz selects the matching style in the drawer.
- Browser review caught and repaired end-of-bar clipping; the labels now remain in their own cells while the timing track moves.
- Only Tonnetz app assets, its version assertions, and this review note are included. Local audio-meter and viewport fixtures are excluded.
