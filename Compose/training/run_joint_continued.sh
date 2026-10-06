#!/usr/bin/env bash
# User-run, time-bounded continuation of the homepage R/H/B/M checkpoint.
# Candidate outputs only: never changes the live browser model.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv-training/bin/python
BASE=training/runs/backups/joint-v1-before-new-data-20260928/model.pt
EXPECTED_BASE_SHA=8b269c4a6e4e4abd8ef3e2825743451da9c965155403b53a94115486fcce5059
EXPRESSION_RUN=training/runs/joint-continued-expression-v1
ARRANGEMENT_RUN=training/runs/joint-continued-arrangement-v1
LOCAL_ROOT="/Users/chenjinfu/Library/Mobile Documents/com~apple~CloudDocs"

BASE_SHA="$(shasum -a 256 "$BASE")"
if [[ "${BASE_SHA%% *}" != "$EXPECTED_BASE_SHA" ]]; then
  printf 'Old homepage checkpoint hash differs; refusing to start.\n' >&2
  exit 2
fi

resume_flag() {
  local directory="$1"
  if [[ -f "$directory/state.pt" ]]; then
    printf '%s' '--resume'
  elif [[ -d "$directory" ]] && [[ -n "$(ls -A "$directory")" ]]; then
    printf 'Incomplete directory without state.pt: %s\n' "$directory" >&2
    printf 'Keep it for diagnosis and choose a new run path.\n' >&2
    exit 2
  fi
}

"$PY" training/tests/joint-expression.test.py
"$PY" training/tests/joint-arrangement.test.py
"$PY" training/scripts/train_joint_arrangement.py \
  --local-root "$LOCAL_ROOT" --output-dir "$ARRANGEMENT_RUN" --preflight

EXPRESSION_RESUME="$(resume_flag "$EXPRESSION_RUN")"
"$PY" training/scripts/train_joint_expression.py \
  --expression training/data/joint/lieder-expression-v1.npz \
  --base-checkpoint "$BASE" --output-dir "$EXPRESSION_RUN" \
  --fine-tune-base --base-lr 0.00002 --joint-weight 1.0 \
  --max-seconds 14400 --batch 4 --threads 2 --eval-every 200 \
  ${EXPRESSION_RESUME:+"$EXPRESSION_RESUME"}

if [[ ! -f "$EXPRESSION_RUN/best-base.pt" ]]; then
  printf 'No validated fine-tuned base checkpoint; refusing arrangement stage.\n' >&2
  exit 2
fi

ARRANGEMENT_RESUME="$(resume_flag "$ARRANGEMENT_RUN")"
"$PY" training/scripts/train_joint_arrangement.py \
  --orchestra-data training/orchestra/work/data --local-root "$LOCAL_ROOT" \
  --joint-initialization "$EXPRESSION_RUN/best-base.pt" \
  --output-dir "$ARRANGEMENT_RUN" \
  --max-seconds 14400 --batch 24 --threads 2 --eval-every 200 \
  ${ARRANGEMENT_RESUME:+"$ARRANGEMENT_RESUME"}
