# Rhythm extension: experiment plan (draft, 2026-09-28)

## Material Passport

- Origin Skill: academic-research-suite / experiment-agent
- Origin Mode: plan
- Origin Date: 2026-09-28
- Verification Status: DATA_AND_CODE_CHECKED (no new model trained or listening evaluation)
- Version Label: rhythm_extension_plan_v2

Implementation update (2026-09-28): `scripts/build_joint_expression.py` and
`scripts/train_joint_expression.py` implement a *training-only* expressive
sidecar with exact fractional note events and frozen joint-v1 weights. Full
data, commands and remaining browser/listening gates are in
`JOINT-EXPRESSION-TRAINING.md`. The current web model remains unchanged.

## Scope agreed with the user

- Preserve the current main-page joint R/H/B/M Transformer and its backed-up weights as the baseline. Do not use the five separate orchestral ablation models or replace runtime weights during experiments.
- Keep exact sixteenth-note onsets, ordinary dotted values (such as dotted eighth/quarter), triplets, and extensibility for other tuplet ratios including 5 and 7. Dotted sixteenths are not required.
- Preserve tuplet ratio, exact onset and duration in both model history inputs and generation targets. Merely attaching a tuplet label as a control would not teach the model to emit one.
- Distinguish metrical accent (strong and weak beat positions) from performed loudness. Preserve score dynamics, accents and hairpins as separate annotations, with missing/ambiguous marks represented explicitly rather than guessed as note velocity.
- Add 6/8 and 12/8 performance support alongside existing 3/4 and 4/4. Define the tempo unit explicitly for compound metre before changing playback.
- Save every candidate and listening sample under a new iCloud-synced `training/runs/` directory. Never train into or overwrite `joint-v1/structured/`.

## Evidence and constraints

- `training/scripts/joint_data.py` fixes one R/H/B/M step per sixteenth and a maximum context of 128 steps. It already has metre IDs and bar-length capacity for 3/4, 6/8 and 12/8.
- `src/composer.js` and `src/instruments.js` currently expose only 3/4 and 4/4. `src/render.js` maps steps onto a quarter-note BPM clock.
- `training/scripts/build_joint_lieder.py` rounds note onsets and ends to the nearest sixteenth. In the 1,131 kept Lieder works, metadata records 5,613 off-grid melody events and 56,778 off-grid accompaniment events. These are *not* verified tuplet counts.
- The model-ready corpus has `rhythm` (rest, hold, one onset, two-or-more onsets) and `level` (metrical position strength), plus metre, position, beat phase and melody/bass onset/hold. It has no score-dynamics, accent, velocity, or tuplet-ratio arrays. Browser `src/render.js` supplies velocity from fixed per-role/per-metrical-level values and small humanization rather than a trained dynamics stream.
- A direct scan of the pinned MusicXML for the 885 training-eligible Lieder works found 74,317 noteheads marked 3:2 in 344 works and 290 noteheads marked 5:4 in 16 works; these are source-score counts, not retained model-window examples. The same source set had 18,036 `<dynamics>` elements in 849 works, 12,169 accent/strong-accent elements in 576 works, and 33,589 wedge elements in 811 works. `<sound dynamics>` often duplicates `<dynamics>` and must not be counted as an additional marking. These counts do not prove that all marks align to a usable model event.
- The pinned OpenScore Lieder source archive is present, but its extracted tree is not. [MusicXML's `time-modification`](https://www.w3.org/2021/06/musicxml40/musicxml-reference/elements/time-modification/) can represent sounding tuplet ratios using `actual-notes` and `normal-notes`; source annotations must be audited rather than inferred from rounded data.
- The completed `model.pt` has model weights and configuration, not optimizer state. A new optimizer and a new checkpoint series are required for warm-start fine-tuning; this is not an exact resume.

## Proposed stages and gates

1. **Data audit (read-only):** the first source-score inventory is recorded above; next align exact tuplets, dynamics, accents and wedges to playable events/windows by metre, part and work. Record unsupported notation, duplicates, missing annotations and clean train/validation/test splits. Gate: do not claim 5/7 support from a corpus that lacks enough examples, and do not equate notated dynamics with measured audio velocity.
2. **Representation prototype:** retain the old harmonic/melodic backbone where compatible; represent new onset positions and note lengths as exact bar-relative rational events rather than multiplying every bar into a very fine fixed grid. Reconstruct source notation and playback timing before training. Gate: round-trip tests for straight sixteenths, dotted eighths/quarters, 3:2, 5:4, 7:4 and 3/4, 6/8, 12/8; no dotted-sixteenth requirement.
3. **Warm-start pilot:** initialize compatible parameters from the backed-up structured checkpoint, initialize any new timing components separately, and keep some old-corpus replay. Save optimizer state and fixed-seed listening samples at each evaluation checkpoint. The exact entry command, step count, sampling mix and timeout are **TBD**; this plan is not yet an executable training command.
4. **Comparison:** unchanged baseline versus candidate on held-out works, rhythmic accuracy, validation loss, old-style retention, browser/PyTorch decoder parity, transport tests, and blind listening. A lower loss by itself does not establish better music. Export to the main page only after an explicit decision.

## Monitoring and outputs to agree before execution

- New output directory only; checkpoint plus optimizer state, metric log, source/provenance record, fixed-prompt MIDI/WAV previews.
- Monitor process liveness and wall-time limit. Do not silently restart a crashed experiment.
- Training is not running as of this plan; current browser weights are unchanged.
