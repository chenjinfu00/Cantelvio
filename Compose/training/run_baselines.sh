#!/bin/bash
# Train the two generic baselines one after the other. Safe to start again after the
# machine restarts: a finished model is skipped, an unfinished one resumes from its last
# saved state (train_joint.py --resume, saved every 200 steps); logs are appended.
cd "$(dirname "$0")/scripts"
RUN=../runs/joint-v1
finished() { python3 -c "import json,sys; sys.exit(0 if 'final' in json.load(open('$RUN/$1/training.json')) else 1)" 2>/dev/null; }
train() {
  name=$1; shift
  if finished "$name"; then echo "$name already finished"; return; fi
  python3 train_joint.py --model flat "$@" --output-dir "$RUN/$name" --resume >> "$RUN/$name.log" 2>&1
}
train flat-params --d 128 --heads 8 --layers 7 --ff 512
train flat-compute
