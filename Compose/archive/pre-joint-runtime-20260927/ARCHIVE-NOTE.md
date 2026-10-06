# Runtime before the joint model (archived 2026-09-27)

This folder keeps the AIlegro runtime exactly as it was before the app switched to the joint R/H/B/M Transformer:

- Harmony v2 (frozen Tonnetz v91 harmony Transformer, 204,391 parameters) with the probability-conditioned duration policy (`src/queue.js`, `src/duration-policy.js`);
- Melody v5 (349,325 parameters) and its timeline performer (`src/melody-timeline.js`);
- the frozen v91 rule accompaniment and bass planner (`src/planner.js`, `vendor/accompaniment.js`, `vendor/walking-bass.js`, `vendor/improvisation.js`);
- the matching `src/app.js`, `src/session.js`, `src/scenes.js`, `src/chord-chart.js`, tests, QA page, chart validation scripts and documents.

Moved or copied unchanged (SHA-256 identical to the files that ran before); `VENDOR_MANIFEST.json` in the project root lists the retired vendor files at their new paths. `vendor/lib/chord-vocabulary.js` and `vendor/lib/tonality.js` are copies, because the current runtime still uses them.

The old tests still pass from here: `node --test tests/*.test.js` (29 tests). To play this version, run a static server from this folder with the project's `media/` folder available at `./media/` (for example copy or link it), then open `index.html`.

`training/scripts/render_joint_accompaniment.mjs` imports `src/planner.js` from this folder to rebuild the synthetic joint-model corpus exactly as it was built.
