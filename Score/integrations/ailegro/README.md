# AIlegro adapter (reference implementation)

`score_compose.py` connects AIlegro Score to AIlegro's four-pillar v3.1 composer:

1. AIlegro Score writes an `ailegro.compose-request/1` (editor: AIlegro panel → “导出请求”).
2. This script, run inside the AIlegro project with AIlegro's Python environment, feeds the
   context bars through `Composer.feed_bar()` and generates the requested bars with
   `Composer.next_bar()`.
3. It writes an `ailegro.compose-result/1`, which the editor imports as reviewable suggestions.

```sh
cd "<path>/AIlegro"
# conversion check only (no torch needed)
python3 "<path>/AIlegro Score/integrations/ailegro/score_compose.py" --request request.json --dry-run
# generation
.venv-training/bin/python "<path>/AIlegro Score/integrations/ailegro/score_compose.py" \
  --request request.json --checkpoint training/runs/<run>/weights.pt --output result.json
```

Status (2026-10-01): the dry run was verified against AIlegro's real time vocabulary, chord-quality
list and score reader (`score_events_v2.ScoreEvents.from_candidate` loads every exported sample).
Generation has not been run from this repository against trained weights. Supported tasks:
`continue`, `melody-from-chords` (locked chords). Tasks with hard-locked notes inside generated
bars wait for AIlegro's decoder support. The contract is specified in
[docs/ailegro-integration.md](../../docs/ailegro-integration.md).

This file lives in AIlegro Score because it implements AIlegro Score's contract; it only imports
AIlegro modules and never modifies the AIlegro project.
