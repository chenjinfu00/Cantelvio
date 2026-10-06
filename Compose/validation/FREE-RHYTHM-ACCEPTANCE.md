# Flexible harmony timing — acceptance

User intent: retain one chord per bar and add an alternative automatic rhythm that can change inside a bar or prolong the current chord over several bars. Existing Transformer predictions must inform the result.

## Invariants

- Every bar is the default and preserves previous sound/timing. Hold remains an indefinite manual hold in both automatic rhythm modes.
- Free timing is expressed in musical beats, independent of tempo. Four-beat and three-beat meters are both respected. Bar and beat displays count actual meter, not chord changes.
- Chord selection still uses the frozen Transformer. Duration is a transparent scheduling policy conditioned on its prediction distribution, not a claim that the frozen model learned duration labels.
- Preview durations are committed and visible. The advertised next chord occurs at the advertised time. Current plus three future chords remain editable with the existing UID/revision protection.
- A held chord continues its accompaniment and melody each bar. A mid-bar change updates the harmony and melody without restarting the meter/groove or leaving silent holes.
- Mode/tempo/meter/key changes, queued scenes, stop/restart, late clocks and stale editor interactions remain safe. Scene randomization is still measured per real bar.
- Preserve model weights, vendor baseline and production Tonnetz. No deployment requested.

## Verification

- Deterministic short and multi-bar durations; measured sensitivity to different Transformer distributions.
- Every-bar parity with previous scheduler and planner.
- Event note/beat bounds and harmony conditioning on both sides of an internal change; melody context remains sequential.
- Long holds cross bar boundaries without skipped accompaniment; phase does not reset at changes.
- Queue edit changes selected/later future data and preserves earlier timing commitments.
- Audible/UI start alignment; cancelled callbacks cannot advance after Stop.
- Browser play in each timing mode, current/future duration labels and progress, desktop/tablet/phone control fit.
