#!/usr/bin/env bash
# User-run candidate training. Never modifies frontend weights.
set -euo pipefail
cd "$(dirname "$0")/.."

PY=.venv-training/bin/python
EXPRESSION_RUN=training/runs/joint-expression-known-v2
ARRANGEMENT_RUN=training/runs/joint-arrangement-v1
LOCAL_ROOT="/Users/chenjinfu/Library/Mobile Documents/com~apple~CloudDocs"

"$PY" training/tests/joint-expression.test.py
"$PY" training/tests/joint-arrangement.test.py
"$PY" training/scripts/train_joint_arrangement.py \
  --local-root "$LOCAL_ROOT" --output-dir "$ARRANGEMENT_RUN" --preflight

resume_flag() {
  local directory="$1"
  if [[ -f "$directory/state.pt" ]]; then
    printf '%s' '--resume'
  elif [[ -d "$directory" ]] && [[ -n "$(ls -A "$directory")" ]]; then
    printf 'Training directory is nonempty but has no state.pt: %s\n' "$directory" >&2
    printf 'Keep it for diagnosis and choose a fresh run path before retrying.\n' >&2
    exit 2
  fi
}

EXPRESSION_RESUME="$(resume_flag "$EXPRESSION_RUN")"
ARRANGEMENT_RESUME="$(resume_flag "$ARRANGEMENT_RUN")"

"$PY" training/scripts/train_joint_expression.py \
  --expression training/data/joint/lieder-expression-v1.npz \
  --base-checkpoint training/runs/backups/joint-v1-before-new-data-20260928/model.pt \
  --output-dir "$EXPRESSION_RUN" \
  --max-seconds 14400 --batch 4 --threads 2 --eval-every 200 \
  ${EXPRESSION_RESUME:+"$EXPRESSION_RESUME"}

"$PY" training/scripts/train_joint_arrangement.py \
  --orchestra-data training/orchestra/work/data \
  --local-root "$LOCAL_ROOT" \
  --output-dir "$ARRANGEMENT_RUN" \
  --max-seconds 14400 --batch 24 --threads 2 --eval-every 200 \
  ${ARRANGEMENT_RESUME:+"$ARRANGEMENT_RESUME"}
