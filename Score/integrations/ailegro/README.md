# AIlegro adapter (reference implementation)

`score_compose.py` connects AIlegro Score to AIlegro's four-pillar v3.1 composer:

1. AIlegro Score writes an `ailegro.compose-request/1` (editor: AIlegro panel).
2. This script, run inside the AIlegro project with AIlegro's Python environment, feeds the
   context bars through `Composer.feed_bar()` and generates the requested bars with
   `Composer.next_bar()`.
3. It returns an `ailegro.compose-result/1`, which the editor imports as reviewable suggestions
   (blue notes; accept or reject per run).

It also answers harmonic-analysis requests (`ailegro.analysis-request/1` → `ailegro.analysis-result/1`,
editor: AIlegro panel → “自动标和弦”): chord symbols for existing music, from AIlegro's analysis model or its
chord tracker.

Both folders sit side by side (`software develop/Cantelvio/Compose` and `software develop/Cantelvio/Score`),
so the commands below use the relative path `../Score/...` from the AIlegro root.

## Local server (editor button “直接生成 / Generate”)

```sh
npm run ailegro:serve        # from AIlegro Score: finds ../Compose, .venv-training and the newest v3.1 weights
```

which runs, from the AIlegro root:

```sh
cd "<path>/AIlegro"
.venv-training/bin/python "../Score/integrations/ailegro/score_compose.py" \
  --serve --checkpoint training/runs/<run>/weights.pt
```

The model is loaded once; the server listens on `http://127.0.0.1:8765` (`--host`, `--port`) and
answers `GET /health`, `POST /compose` and `POST /analyze` (request JSON in, result JSON out). Browser calls are
accepted from loopback origins (`http://localhost:*`, `http://127.0.0.1:*`); add others with
`--allow-origin https://example.org`. One generation runs at a time.

The same server opens PDFs / scanned pages and recordings for the editor as background jobs
(`score_imports.py`, ADR 0013): `POST /import/pdf` (Audiveris, `--audiveris PATH`) and `POST /import/audio`
(MuScriptor's Python, `--muscriptor-python PATH`, then AIlegro's `audio_to_score.py`) take the file as the body
and return a job; `GET /jobs/<id>` reports stage, progress and finally the MusicXML (base64), `DELETE /jobs/<id>`
cancels. `GET /health` lists what can be opened (`imports`). Tests with stand-in tools:
`python3 integrations/ailegro/test_score_imports.py` (`npm run test:adapter`).

## Files (no server)

```sh
cd "<path>/AIlegro"
.venv-training/bin/python "../Score/integrations/ailegro/score_compose.py" \
  --request ~/Downloads/ailegro-request-<id>.json \
  --checkpoint training/runs/<run>/weights.pt \
  --output ~/Downloads/ailegro-result-<id>.json
```

Then import the result in the editor (AIlegro panel → “导入生成结果”). Analysis requests (AIlegro panel →
“导出分析请求”) run the same way; they need no `--checkpoint`.

## Checks without a model

```sh
# conversion check against AIlegro's time vocabulary and chord list (no torch needed; with numpy it also
# estimates context chords like the real run)
python3 "../Score/integrations/ailegro/score_compose.py" --request request.json --dry-run

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
- `--harmonic-rhythm auto|beat|half-bar|bar|two-bars` (default auto): how often the harmonizer's chords may change
  when a request does not say (requests carry the intent tag `harmonic-rhythm:<value>`; analysis requests the
  field `analyze.harmonicRhythm`).
- `--analyzer auto|none|PATH` (default auto): harmonic analysis uses AIlegro's analysis model (harmonizer v2,
  melody + every note, `training/runs/harmonizer-v2-20261003/weights.pt`) when present, otherwise the chord
  tracker; a request can ask for `engine: model` or `rules`.

## Status (2026-10-03)

- PDF and recording imports run end to end through the editor here (Linux): Audiveris 5.11.0 on an engraved
  chorale, and a recording through a stand-in for MuScriptor (its weights are on the Mac) plus the real
  `audio_to_score.py` with the analysis model; progress, cancel and the unsaved-changes prompt were checked in
  Chromium. MuScriptor itself has not run through the server yet.

- Harmonic analysis runs end to end with AIlegro's analysis model v2 (step 4,000): the two analysis examples of
  `npm run ailegro:examples` were analysed here and imported back as chord symbols (valid scores). On AIlegro's
  test songs it agrees with the AugmentedNet labels on 71.2% of the beats (chord tracker 67.0%).

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
