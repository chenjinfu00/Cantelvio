# Cantelvio Compose project context

Read `START_HERE.md` and `README.md` for the current product and architecture. This folder is the self-contained project root. Work here; no sibling Tonnetz checkout is required. `PREPARATION.md` and `SOURCE_BASELINE.json` are historical references, not current task instructions. The user's current request takes precedence.

## Project ownership

Automatic accompaniment, model training and model improvements belong to this project. Since 2026-09-27 the runtime uses one joint R/H/B/M Transformer (accompaniment rhythm, harmony, bass, melody); the earlier Harmony v2 / Melody v5 / rule-planner runtime is archived in `archive/pre-joint-runtime-20260927/`. Read `training/README.md` before training work. Tonnetz and Volta are sibling projects; Tonnetz's existing runtime is intentionally retained, not a target for automatic backports. Use `.venv-training/bin/python` on this machine. Stage new model exports in `training/runs/`, then verify compatibility before deliberately replacing runtime weights.

The active browser code and assets physically live in `frontend/`; the local server and generation API live in `backend/`. Root `src/`, `vendor/`, `orchestra/`, `qa/`, `media/`, `index.html`, and `style.css` are compatibility symlinks, not copies. `training/` and `.venv-training/` deliberately remain at the root as backend-owned, path-sensitive assets. For UI work, edit the real files under `frontend/`; keep existing URL paths and browser/model contracts. The root `server.mjs` is a compatibility entry point for `backend/server.mjs`.

## Product principles

- Use **Cantelvio Compose** as the product name; Cantelvio is the shared brand.
- Keep a clear, compact performance interface with readable labels and usable touch targets. Default language is English with a Chinese option.
- This app is a music performance console without the Tonnetz keyboard. Preserve independent Chords, Bass and Melody controls.
- Preserve both Every bar and Free timing unless the user requests a change.
- The chord chart has two rows of four real measures. Widths represent actual beats. After the upper row finishes, promote the lower row and append four new measures.
- UI predictions must agree with what is played. Preserve earlier committed slots when editing a future chord, and regenerate only the affected suffix. Scheduled chords are locked.

## Timing and model contracts

- Use the audio clock for audible state and the playhead. The scheduling counter can lead playback; do not use it as the current visible measure.
- Rendering and audible-onset callbacks must not perform fresh model inference. Keep forecast preparation bounded and asynchronous.
- Stop/Panic must invalidate pending audio and onset callbacks. Restart from the last actually heard chord, with fresh chart history.
- The joint model generates per sixteenth step in the order R -> H -> B -> M; no stream is generated ahead of the others. Keep the window encoding identical to training (`training/scripts/joint_data.py`): reference key, window-start chord/onset tokens, bases, controls. Holds must continue the groove (only the harmony stream is held).
- Musical controls (Hold, Every bar, Free, temperatures, density, register limits, edits, notes tied over a scheduled barline) are masks on the model's distributions, not model changes. Temperatures only act on the choice among new events, never on whether an event happens.
- Weight tensors, vocabulary ordering, feature encoding and decoder contracts must remain compatible when changing model code; `tests/joint-model.test.js` compares the browser decoder with PyTorch logits. Re-export with `training/scripts/export_joint_js.py` (weights and parity fixture together). Preserve provenance and license notices; update manifests deliberately when those assets change.
- Distinguish model training from sampling constraints, musical rules, rendering, scheduling and UI changes. This is a small experimental model; do not claim listening quality from tests alone.

## Development and validation

- Plain ES modules, Node >=20, no external npm dependencies. `npm start`; default local URL is `http://127.0.0.1:4187/`. Use `PORT=4188 npm start` if occupied.
- `npm test` runs the automated suite. Run the independent chart scripts listed explicitly in `START_HERE.md` when changing the chord chart or planning.
- Run checks appropriate to the change. Audio/transport changes need a real browser check; visual changes need desktop, tablet and phone inspection. `/qa/` offers repeatable Web Audio renders.
- Preserve user-authored saved scene data (`normalizeScene` reads scenes saved by earlier versions). A browser mute only silences a bus; Melody Off stops scheduling melody notes while the joint model keeps generating the melody stream.
- Keep `README.md` and verification notes aligned with actual behavior; retain older evidence as historical results rather than rewriting it as new testing.
