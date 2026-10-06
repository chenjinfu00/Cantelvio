# AIlegro project context

Read `START_HERE.md` and `README.md` for the current product and architecture. This folder is the self-contained project root. Work here; no sibling Tonnetz checkout is required. `PREPARATION.md` and `SOURCE_BASELINE.json` are historical references, not current task instructions. The user's current request takes precedence.

## Project ownership

Automatic accompaniment, Harmony/Melody training and model improvements now belong to this project. Read `training/README.md` before training work. Tonnetz and Volta are sibling projects; Tonnetz's existing runtime is intentionally retained, not a target for automatic backports. Use `.venv-training/bin/python` on this machine. Stage new model exports in `training/runs/`, then verify compatibility before deliberately replacing runtime weights.

## Product principles

- Spell the name **AIlegro** (capital A, capital I).
- Keep a clear, compact performance interface with readable labels and usable touch targets. Default language is English with a Chinese option.
- This app is a music performance console without the Tonnetz keyboard. Preserve independent Chords, Bass and Melody controls.
- Preserve both Every bar and Free timing unless the user requests a change.
- The chord chart has two rows of four real measures. Widths represent actual beats. After the upper row finishes, promote the lower row and append four new measures.
- UI predictions must agree with what is played. Preserve earlier committed slots when editing a future chord, and regenerate only the affected suffix. Scheduled chords are locked.

## Timing and model contracts

- Use the audio clock for audible state and the playhead. The scheduling counter can lead playback; do not use it as the current visible measure.
- Rendering and audible-onset callbacks must not perform fresh model inference. Keep forecast preparation bounded and asynchronous.
- Stop/Panic must invalidate pending audio and onset callbacks. Restart from the last actually heard chord, with fresh chart history.
- Melody context follows real musical bars and the current/next harmony within them. Holds must continue the groove.
- Weight tensors, vocabulary ordering, feature encoding and decoder contracts must remain compatible when changing model code. Preserve provenance and license notices; update manifests deliberately when those assets change.
- Distinguish model training from duration policy, musical rules, scheduling and UI changes. These are small experimental models; do not claim listening quality from tests alone.

## Development and validation

- Plain ES modules, Node >=20, no external npm dependencies. `npm start`; default local URL is `http://127.0.0.1:4187/`. Use `PORT=4188 npm start` if occupied.
- `npm test` runs the automated suite. Run the independent chart scripts listed explicitly in `START_HERE.md` when changing the chord chart or planning.
- Run checks appropriate to the change. Audio/transport changes need a real browser check; visual changes need desktop, tablet and phone inspection. `/qa/` offers repeatable Web Audio renders.
- Preserve user-authored saved scene data. A browser mute is different from disabling melody generation.
- Keep `README.md` and verification notes aligned with actual behavior; retain older evidence as historical results rather than rewriting it as new testing.
