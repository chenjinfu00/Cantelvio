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
# conversion check against AIlegro's time vocabulary and chord list (no torch needed; with numpy it also
# estimates context chords like the real run)
python3 "../AIlegro Score/integrations/ailegro/score_compose.py" --request request.json --dry-run

# placeholder music (scales over a tonic bass) to test the editor round trip anywhere,
# even without the AIlegro folder; clearly marked as mock in the result
python3 integrations/ailegro/score_compose.py --serve --mock
```

## Options

- `--candidates N` (default 16): accompany-melody writes each bar N times and keeps the version under which the
  given melody is most probable. More candidates fit the harmony better and cost proportionally more time.
- `--doublings none|light|full` (default light): octave/unison doublings orchestrate may add (light: at most half as
  many as the given notes per bar).
- `--harmonizer auto|none|PATH` (default auto): accompany-melody without given chords first reads chords from the
  given melody with AIlegro's harmonizer (melody -> chords, `training/scripts/harmonizer_v1.py`) and locks them;
  the chords come back with the result and import as chord symbols. `auto` uses
  `training/runs/harmonizer-v1-20261003/weights.pt` when present; `none` lets v3.1 choose the chords.

## Status (2026-10-02)

- All five tasks run. `accompany-melody`, `develop-motif` and `orchestrate` use AIlegro's
  `training/scripts/four_pillar_v31_tasks.py` (decoding only; the v3.1 training code and weights are unchanged).
  An AIlegro folder without that file runs `continue` and `melody-from-chords` only and rejects the others.
- Context bars without any chord symbol get chord changes from AIlegro's own chord tracker (the labeler of the
  training data); a chord symbol that repeats the chord in effect is not fed as a change; with `chordMode: given`
  a bar without a symbol holds the previous chord.
- **Run end to end with the trained weights** (four-pillar v3.1, step 45,225, torch 2.14.1, Linux): the requests
  written by `npm run ailegro:examples -- --out out/ailegro` were generated here and imported back with
  `npm run ailegro:examples -- --check out/ailegro` (valid scores, given material unchanged). Not yet run on the
  owner's Mac `.venv-training`.
- The dry run was verified against AIlegro's real time vocabulary, chord-quality list and score reader; the
  editor ↔ server round trip is tested with `--mock`, which now also handles the three new tasks.

The contract is specified in [docs/ailegro-integration.md](../../docs/ailegro-integration.md).
This file lives in AIlegro Score because it implements AIlegro Score's contract; it only imports
AIlegro modules and never modifies the AIlegro project.
