# Classical score candidate corpus v1

This is a **prepared source corpus**, not a new checkpoint or a dataset that the current
R/H/B/M or six-group training scripts can consume directly. The three pinned archives
remain under `../sources/`; no second extracted copy of their source trees is stored.

## Contents and checks

- `scores.jsonl.gz`: one JSON object per accepted score, with part metadata, measures,
  and notes. Note onset/duration and measure onset/duration are exact rational numbers
  in quarter-note units, encoded as strings. `pitch` is sounding MIDI pitch after
  MusicXML transposition; `writtenPitch` is retained. `tuplet`, `dynamic`, `wedge`,
  `accent`, `voice`, `staff`, `group`, and S3 `role` are preserved where present;
  unknown values are null, not guessed.
- `catalog.json`: per-score source, work identity, content hash, meter/tuplet counts,
  instrument-group coverage, missing-label counts, and score-quality flags.
- `prepare.json`: aggregate counts and the explicit rejection list.
- `overlap-audit.json`: conservative work-name match against the existing 43,036
  SymphonyNet-prepared MIDI pieces and their old splits. This is a warning list,
  **not proof that unmatched scores are novel**.

The three archives contain 96 + 196 + 16 full scores. Four OpenScore Beethoven Ninth
movements were not included because S3 supplies the same movements with orchestral
role annotations. One one-measure Brandenburg Concerto movement was too short for
training slices. The result contains **303 score candidates**, **204 composition
groups**, and **3,010,494 notated note events**; 241 scores meet the conservative
six-group screen (at least 80 mapped pitched notes, at least 8 measures, no vocal
parts, no irregularly long measures). This does not validate their listening quality.

The parser preserves rather than rounds 90 unusually long measures across 24 scores
and flags them in the records. Such measures and all unpitched/grace notes need a
task-specific decision before training. There are score-level rhythm, meter, dynamics,
and six-group instrument labels, but no trustworthy R/H/B/M alignment for the current
joint backbone. S3 provides some per-instrument `mel`/`harm`/`rhythm` annotations;
unlabeled notes remain unlabeled. The source manifest separates CC0 score licensing
from non-CC0 annotations; check downstream obligations before release.

The filename audit found ten possible work overlaps with SymphonyNet, including a
**test-set match for Beethoven's Symphony No. 6**. No train/validation/test split is
assigned to this corpus. At minimum, that work must be excluded from new training
against the existing SymphonyNet test set; a full cross-corpus near-duplicate audit
is still required before any held-out evaluation. The existing old training entry
points at older data and does not silently include this directory.

## Rebuild and verify

From the project root, use a fresh output directory for a new version:

```sh
.venv-training/bin/python training/tests/classical-score-preparation.test.py
.venv-training/bin/python training/scripts/prepare_classical_scores.py \
  --output training/data/classical-score-v2
.venv-training/bin/python training/scripts/audit_classical_overlap.py \
  --catalog training/data/classical-score-v2/catalog.json \
  --output training/data/classical-score-v2/overlap-audit.json
.venv-training/bin/python training/scripts/verify_classical_scores.py \
  training/data/classical-score-v2
```

Do not run the old `run_joint_continued.sh` expecting it to use these score files.
Adding them to an actual training objective requires a separate loader, a work-level
split aligned with existing data, and explicit handling of irregular bars and
missing targets. Keep source-archive and derived-corpus provenance with the model.
