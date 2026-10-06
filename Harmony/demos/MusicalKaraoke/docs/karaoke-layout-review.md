# Karaoke layout review — 2026-09-23

## Reproduced before the fix

The user's embedded browser viewport was **919 × 804 CSS px**. The old stage was 909 × 511 px, while its children retained fixed pixel sizes. The existing `max-width: 900px` and `max-height: 820px` rules did not account for the stage's actual size.

All ten slides were inspected in that viewport. Slides 1–2 fitted, but these failures were visible:

| Slide | Observed failure |
| --- | --- |
| 3 | The comfortable-octave prompt fell below the clipped stage. |
| 4 | The final chord buttons were clipped; the common-tone controls overlapped the chord diagram. |
| 5 | The lower row of progression buttons was clipped. |
| 6 | The pure-fifths formula was clipped below its numerator. |
| 7 | The C/D chord controls were clipped; the Harmonic title and fact overlapped. |
| 8 | The voice disclosure overlapped Replay; the rehearsal links were clipped. |
| 9 | Diagram labels and both reveal buttons were clipped; the citation overlapped the diagram. |
| 10 | The cadence diagram covered links and overlapped Thank you. |

Earlier checks at larger desktop dimensions did not cover this actual embedded viewport. This follow-up therefore checks rendered geometry as well as screenshots.

## Scope and implementation

GPT-5.6 sol implemented a 1440 × 810 logical canvas that fits the measured stage container through `ResizeObserver`. The previous viewport-height overrides and 900px layout switch were removed. Text and controls now scale together. Narrow windows at 680px or below use a readable, scrollable layout.

The chord and keyboard headings now have dedicated caption rows. Diagram heights leave room for their controls and source links. The narrow keyboard cards have explicit rows for headings, diagrams, controls, and the fact. The optional exact-solution formulas were enlarged.

Exactly ten slides, existing English copy, sans-serif styling, KaTeX, actual music interactions, navigation, and links remain. The original separate presentation and instrument files match their previous SHA-256 hashes. No deployment.

## Follow-up verification

- All ten slides were visually reviewed at the actual **919 × 804** embedded viewport. The failures listed above are fixed.
- All ten slide boundaries were checked at **900 × 650, 901 × 650, 1000 × 650, 1280 × 720, 1366 × 768, and 1440 × 900**. No checked controls, prompts, formulas, or links extended outside the stage. The stage and navigation fitted every viewport.
- The former 900/901 boundary uses the same smoothly scaled composition.
- At **640 × 800**, content can scroll instead of being clipped. The keyboard fact was visually verified below its controls.
- Expanded fifth answer, both tuning formulas, optional exact solution, choir countdown, and the longest five-chord progression were checked. No new content collisions appeared in those states.
- Remaining raw container-intersection reports were visually reviewed: keyboard SVG whitespace shares space with its heading/fact, and the choir count sits in unused header space. Neither covers visible labels or controls.
- The scaled harmonic keyboard played and highlighted **D / F♯ / A**. Progression playback, choir start, navigation cancellation, and blank left/right click navigation still worked. No warning/error console entries were reported in the final browser check.
- The focused canvas-fit tests and existing suite passed: **23/23**. Browser geometry and screenshots supplement those tests; the tests alone do not establish visual correctness.

The narrow-window scroll reset passed: scrolling page 7 down by 689px and then clicking Next returned page 8 to scroll position 0, with its heading visible at 32px. The temporary viewport override was cleared after review.
