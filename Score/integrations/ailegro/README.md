# AIlegro adapter (reference implementation)

`score_compose.py` connects AIlegro Score to AIlegro's four-pillar v3.1 composer:

1. AIlegro Score writes an `ailegro.compose-request/1` (editor: AIlegro panel).
2. This script, run inside the AIlegro project with AIlegro's Python environment, feeds the
   context bars through `Composer.feed_bar()` and generates the requested bars with
   `Composer.next_bar()`.
3. It returns an `ailegro.compose-result/1`, which the editor imports as reviewable suggestions
   (blue notes; accept or reject per run).

Both folders sit side by side (`software develop/AIlegro` and `software develop/AIlegro Score`),
so the commands below use the relative path `../AIlegro Score/...` from the AIlegro root.

## Local server (editor button “直接生成 / Generate”)

```sh
cd "<path>/AIlegro"
.venv-training/bin/python "../AIlegro Score/integrations/ailegro/score_compose.py" \
  --serve --checkpoint training/runs/<run>/weights.pt
```

The model is loaded once; the server listens on `http://127.0.0.1:8765` (`--host`, `--port`) and
answers `GET /health` and `POST /compose` (request JSON in, result JSON out). Browser calls are
accepted from loopback origins (`http://localhost:*`, `http://127.0.0.1:*`); add others with
`--allow-origin https://example.org`. One generation runs at a time.

## Files (no server)

```sh
cd "<path>/AIlegro"
.venv-training/bin/python "../AIlegro Score/integrations/ailegro/score_compose.py" \
  --request ~/Downloads/ailegro-request-<id>.json \
  --checkpoint training/runs/<run>/weights.pt \
  --output ~/Downloads/ailegro-result-<id>.json
```

Then import the result in the editor (AIlegro panel → “导入生成结果”).

## Checks without a model

```sh
# conversion check against AIlegro's time vocabulary and chord list (no torch needed)
python3 "../AIlegro Score/integrations/ailegro/score_compose.py" --request request.json --dry-run

# placeholder music (scales over a tonic bass) to test the editor round trip anywhere,
# even without the AIlegro folder; clearly marked as mock in the result
python3 integrations/ailegro/score_compose.py --serve --mock
```

## Status (2026-10-02)

- The dry run was verified against AIlegro's real time vocabulary, chord-quality list and score
  reader (`score_events_v2.ScoreEvents.from_candidate` loads every exported sample).
- The editor ↔ server round trip (request → result → suggestions → accept/reject) is tested with
  `--mock`.
- **Generation with trained weights has not been run from this repository** — run the server
  once in the AIlegro environment and report any mismatch in `Composer` arguments.
- Supported tasks: `continue`, `melody-from-chords` (locked chords). `accompany-melody`,
  `develop-motif` and `orchestrate` need hard-locked notes inside generated bars and wait for
  AIlegro's decoder support; the server rejects them with a clear message.

The contract is specified in [docs/ailegro-integration.md](../../docs/ailegro-integration.md).
This file lives in AIlegro Score because it implements AIlegro Score's contract; it only imports
AIlegro modules and never modifies the AIlegro project.
