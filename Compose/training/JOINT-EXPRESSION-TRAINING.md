# Joint-v1 precise rhythm and score-expression pilot (not full orchestration)

This is a **training-only experimental sidecar**. It preserves the backed-up
joint-v1 R/H/B/M Transformer and does not change the main performance page,
browser weights, or the five unrelated orchestral ablations. It is not yet a
browser-deployable replacement or proof of improved listening quality.
The user-selected full target also requires **learned six-group orchestration
with role-aware controls**. This pilot does **not** contain a group or role
head, and the MIDI orchestral data are not aligned to the frozen joint-v1
conditions. Do not present the command below as training that full target.

## What the data and model actually contain

`scripts/build_joint_expression.py` reads the pinned CC0 OpenScore Lieder MXL
archive directly. The existing chord-aligned, sixteenth-grid corpus supplies
the original coarse R/H/B/M context and the work-level train/validation/test
split. The new sidecar records, for each score note assigned to a coarse step:

- exact fractional onset *within* that step and exact notated quarter-note
  duration (MusicXML `duration/divisions`, without rounding to sixteenths);
- tuplet `actual-notes:normal-notes`, including 3:2, 5:4, 6:4 and 7:4 when present;
- MIDI pitch and approximate R/B/M role (vocal top line, lowest note of the
  bottom accompaniment part, remaining accompaniment);
- effective notated dynamics, accent/strong accent, and active hairpin direction.

Tied continuations are merged into the preceding note. Ordinary dotted values
are durations, not special tokens. No dotted-sixteenth category is required.
The model's existing meter input includes 3/4, 6/8 and 12/8. Dynamics here are
*score markings*, not measured performance velocities. For example, `mf`
remains effective until another sustained dynamic is marked; `sfz` is transient.
An unknown dynamic remains unknown rather than being guessed. The trainer now
masks that field's loss for these events (about 9% of training note events)
while their known pitch, onset, duration and other fields still train. A future
MIDI adapter can supply an explicit per-event, per-field `known` mask. Constant
MIDI velocity is not a score dynamic and must not be relabelled as one.

The sidecar sees **past** expressive events and the current coarse R/H/B/M
tokens, then predicts current-step note count and all the fields above. The
old backbone weights are loaded from the backup and frozen; only the sidecar
is optimized. This retains the old learned harmony/melody parameters, but a
future generator must still sample the sidecar in the correct order and render
its exact event times. No web runtime changes are made by training.

## Data build and checks

From the Cantelvio Compose project root, using its existing `.venv-training`:

```sh
.venv-training/bin/python training/tests/joint-expression.test.py
.venv-training/bin/python training/scripts/build_joint_expression.py \
  --output training/data/joint/lieder-expression-v1.npz
```

The full prepared dataset already exists at that output path. The builder
intentionally refuses to overwrite it; to rebuild, choose a *new* name and
point `--expression` below at that file. It needs only Python stdlib and the
project's NumPy; no music21 installation or extracted duplicate source tree.
The adjacent `.json` contains the train-only vocabularies, provenance and
alignment audit. Five eligible source scores had no aligned note events and
were skipped; the builder reports these rather than silently inventing labels.
Held-out test works are never used in the trainer.

This command uses the aligned OpenScore Lieder MusicXML corpus only. External
MIDI files found elsewhere on this computer are **not yet part of this
four-track sidecar corpus**: unlike the six-group orchestral corpus they lack
verified R/H/B/M and chord labels. They need a separate, work-split MIDI-to-
joint alignment and licensing audit before inclusion. The frontend integration
steps are in `../frontend/MODEL-INTEGRATION-ROADMAP.md`.

## Train expression-only pilot (user-run; optional, not full-target training)

The following command starts a new 2,400-step candidate in an iCloud-synced
output directory. It learns exact timing and known score expression **only**;
it will not learn which orchestral group plays, export browser weights or
replace the current model. Run it if a first-stage expression experiment is
useful while the full six-group data/model pipeline is being built:

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/scripts/train_joint_expression.py \
  --expression training/data/joint/lieder-expression-v1.npz \
  --base-checkpoint training/runs/backups/joint-v1-before-new-data-20260928/model.pt \
  --output-dir training/runs/joint-expression-known-v2 \
  --steps 2400 --batch 4 --threads 2 --eval-every 200
```

If interrupted *after* the first evaluation/checkpoint, repeat exactly the
same command with `--resume` appended. The script verifies input hashes and
schedule settings and the per-field loss-mask version. It never resumes from `joint-v1/structured/model.pt`, since
that completed checkpoint has no optimizer state. The candidate directory
contains `provenance.json`, `metrics.json`, `state.pt` (full restart state) and
`best.pt` (sidecar weights and vocabulary; requires the same frozen base).

Before running a longer experiment, check available memory/disk and leave
the Mac awake. The default CPU setting is conservative; this is a single-process
run, not parallel workers. Stop the run normally if the machine becomes
unresponsive; an evaluated checkpoint can be resumed. Do not use `--resume`
after changing the step count, batch, learning rate, evaluation interval or
seed; use a fresh output directory instead.

## Verification and limitations

The current source-data audit contains 1,077 aligned works and 1,061,747 note
events; 881 are training works, 107 validation, 89 untouched test. There are
9,516 training windows and 1,179 validation windows with no slot overflow.
The dataset contains 81,810 3:2, 289 5:4, 9,715 6:4 and 50 7:4 tagged note
events across all splits. These are note events, not independent examples or
guarantees that the rare tuplets will generate reliably. In the training split
specifically, there are 72,824 3:2, 284 5:4, 6,525 6:4 and only 29 7:4
notes. The ordinary validation split has 1,678 6:4 notes but **no 5:4 or 7:4**
notes, so its loss cannot select or certify the latter rare-tuplet behavior.
Eight held-out durations are outside
the train-only duration vocabulary and are masked in that field's validation
loss; the JSON records this explicitly.

Passing extraction, gradient and browser regression tests does **not** show
that the generated music is more realistic. Before deployment we still need a
causal browser-compatible decoder, exact-time renderer/transport integration,
parity tests, held-out rhythmic evaluation and fixed-prompt blind listening
against the untouched old model. Do not export `best.pt` into `vendor/lib/`.
