#!/bin/bash
# New research run: eleven hours, longer polyphonic event windows, no web export.
# --preflight checks all five sources without updating weights or creating a run.
# --resume restores the same run and its remaining cumulative time budget.
# Additional arguments are passed to the trainer (including --help).
set -euo pipefail

PROJECT_ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$PROJECT_ROOT"
PYTHON="$PROJECT_ROOT/.venv-training/bin/python"
if [[ ! -x "$PYTHON" ]]; then
  echo "Missing project Python: $PYTHON" >&2
  exit 1
fi

runner=()
if command -v caffeinate >/dev/null 2>&1; then
  runner=(caffeinate -i)
fi
exec "${runner[@]}" "$PYTHON" -B -u training/scripts/train_four_pillar_v2.py \
  --output-dir training/runs/four-pillar-v2-history512-20260930 \
  --max-seconds 39600 \
  --context 2048 \
  --history-bars 512 \
  --checkpoint-seconds 300 \
  "$@"
