# Independent-folder verification — 2026-09-27

The current local AIlegro demo was copied into this self-contained `AIlegro/` directory. The source demo was retained as a snapshot. Runtime source, weights, samples, notices, tests, screenshots and historical audio evidence were included; generated Python caches and OS metadata were omitted.

Handoff additions: `START_HERE.md`, `AGENTS.md`, `.gitignore`, this report, package name `ailegro`, a README entry point and portable relative paths for historical WAV result records. No runtime logic was changed during extraction.

## Results

- `npm test`: **29/29 pass** in this independent directory.
- Pure chord-chart checks: **7/7 pass**.
- Session oracle: **96 bars**, four mode/meter transitions and 20 four-bar promotions pass.
- Async forecast/edit checks pass, including stale-task cancellation and immutable played history.
- **75 runtime/test files** are byte-identical to the accepted source demo.
- **57/57** model/module/sample files match `VENDOR_MANIFEST.json`.
- **62 relative imports** resolve inside this directory; there are no symlinks to the old project.
- The local preview at `http://127.0.0.1:4187/` now runs from this `AIlegro/` folder. **62 served files** (entry page, stylesheet, app entry, handoff documents, models and samples) were checked over HTTP against this folder byte for byte. The served package name is `ailegro`.
- Existing browser scene storage remains associated with the same local address. No runtime behavior or visual design changed during extraction, so the previous browser/audio validation remains applicable; those historical results were not presented as newly rerun device tests.

For further work, open **this folder** as the project root and start with `START_HERE.md`. The former demo is preserved under `archive/generative-music-app-20260927/`; the active local preview serves this independent project. See `PROJECT-REORGANIZATION.md` for the subsequent sibling-folder and training-data migration.

## 2026-10-01 native six-group console and architecture experiment

- Main console has six group rows and no legacy three-lane controls, role selectors
  or learned/manual switches. Desktop inspection plus actual 768 px and 390 px
  iframe layouts showed all six controls without horizontal overflow in their
  panel. The in-app browser viewport override did not change its real viewport;
  embedded documents were used for the two narrow-width inspections instead.
- v2 MIDI now survives renderer and native router unchanged. Native groups do not
  copy legacy lanes, fold pitches, choose alternate groups or fabricate drums.
  Exact string playback removes the legacy detuned fundamentals. Legacy routing
  remains tested for archived callers. Saved native all-off choices survive reload.
- Actual offline Web Audio PCM: 68 distinct group/pitch pairs from 314 generated
  step-19193 notes, plus three pitched timbre controls; 71/71 passed. Dominant
  spectral peak is found independently before comparison with intended pitch;
  maximum absolute measured deviation 0.12 cents. Report:
  `training/reports/v2-native-pitch-audit-20261001.json`. This checks pitched
  playback, not compositional quality or unspecified unpitched drum identities.
- Real browser Play advanced through 11 scheduled/generated bars with the audio
  context running; Stop returned to an idle console. Fixed/Walk preference was
  restored after the test. Opening multiple model consoles triggers the existing
  single-session guard; responsive QA frames are for layout, not simultaneous music.
- Experimental streaming-event backbone passes three tests for causal attention,
  rolling-cache/full parity, plan-independent K/V and group-conditioned heads.
  It remains untrained, lacks the production planner/data adapter/trainer and
  does not replace or accept the v2 checkpoint. No speed or listening claim is
  made for the experiment. Current v2 training/resume sources remain unchanged.

## Claude handoff — 2026-10-01, v3 training prepared

User wants to start long training themselves and use Claude for the next step.
No third-party submission or long training was started. Read `START_HERE.md`,
`README.md`, the latest section of `training/README.md`, and project `AGENTS.md`.
The old documentation remains historical; the main page currently uses the fixed
v2 step-19193 snapshot and six direct group controls.

New code:
- `training/scripts/four_pillar_v3_model.py`: 5,348,187-parameter rotary streaming
  candidate; changing the planner cannot invalidate cached backbone states.
- `four_pillar_v3_data.py`: five-source packed-event supervision, exact fractions,
  original MIDI drum identity, masked unknown labels, bounded dense-bar chunks.
- `train_four_pillar_v3.py`: partial v2 initialization, separate run directory,
  atomic saves, source/code provenance and exact v3 resume. It can also initialize
  a fresh run from a compatible v3 checkpoint, resetting optimizer.
- `four_pillar_v3_sample.py`: offline bounded JSON diagnostics, not the full console.
- `training/tests/four-pillar-v3.test.py`: exact time, source-known masks, drum IDs,
  finite gradients, cache parity/eviction, plan independence and sampler bounds.

Prepared run is `training/runs/four-pillar-v3-ready-20261001/`, **step 0**, initialized
from v2 step 19193. It inherits 3,253,434 parameters; others need training. Pure
weights are 21,434,627 bytes. Initial state is 21,584,001 bytes; a trained AdamW
state is about 64.47 MB. Earlier smoke directories are diagnostic/historical and
some predate final code hashes; do not treat them as user training runs or try
silently bypassing their resume checks. The current v2 checkpoint is untouched.

Next work is not yet completed: production active-note/tie handling and dynamic
voice registry; full v3 adapter for Hold/Every bar/Free, edits/prefix preservation,
controls and cancellation; drum-aware browser rendering; latency under a trained
long polyphonic session; held-out and listening evaluation. Complete these before
changing the default webpage model. Preserve native generated MIDI and group; no
range folding, duplication, invented drums or replacement pitches. Model quality
cannot be certified by a few optimizer steps or tests.

The user can run the exact prepared training command in the latest training README.
If Claude changes hashed training code before starting it, create a new versioned
run from the prepared `state.pt` via `--init-checkpoint`; do not edit manifests or
weaken strict resume to conceal the change. Existing v2 exact resume remains
available with its original manifest/config and original cumulative time budget.

Final preparation evidence: `training/reports/four-pillar-v3-preparation-20261001.json`.
Final-code tests: 6 v3 tests plus 3 architecture tests passed; one sampled training
example from each of the five sources passed forward/backward preflight with no
rejection in this check. A separate smoke run saved step 1 and resumed to step 2.
The prepared user run remains step 0; its manifest and every recorded source-code
hash were rechecked, as was the unchanged parent checkpoint hash. Eight diagnostic
bars generated valid exact events, but contained only four notes: these nearly
untrained weights do not demonstrate continuous or musically satisfactory output.
This is a preparation milestone, not completion of all model/music problems.

## Claude — 2026-10-01, group role status bars

Each main-console group row now shows the roles that group plays in the bar being heard
(Melody 1/2/3…, Harmony, Bass, Rhythm; several per group; Rest / — when silent / off).
Display only: `frontend/src/roles.js` analyses scheduled notes and `Session.roleView()`
follows the audio-clock bar. No model, note or scheduling change. The v2 bridge payload
gained an output-only `voice` field (same-seed notes identical). `npm test` 68/68.

No hashed training code changed; every code hash in the v3-ready manifest still matches.
Separately, the v2 continued run's manifest no longer matches three files changed at
08:18 UTC today (`train_four_pillar_v2.py`, `four_pillar_v1_model.py`,
`four_pillar_v2_runtime.py`), so its exact `--resume` would be refused unless those
versions are restored; a new run via `--init-checkpoint` is unaffected.

## Claude — 2026-10-01, v3.1 prepared before training (key-relative; v3 untouched)

The user asked whether v3 can do the four pillars (harmony, polyphony, form,
orchestration), whether it is compact and fast, and to optimize it before training;
then to encode pitch as "key + pitch relative to the key" (training must transfer
across keys, and the sounding note must be exactly the note chosen), taking the
earlier joint R/H/B/M model (good chords and melody) as reference.

New files only (plus this note and `training/README.md`):
`training/scripts/four_pillar_v31_{tonal,time,model,data,sample}.py`,
`train_four_pillar_v31.py`, `build_four_pillar_v31_time_vocab.py`,
`training/data/four-pillar-v31-time-vocab.json`, `training/tests/four-pillar-v31.test.py`,
`training/reports/four-pillar-v31-preparation-20261001.json` (hashes, evidence, limits).

- Pitch: every bar has a local key; index = pitch - tonic_ref(tonic) + 65 (tonic_ref
  in MIDI 54..65), exact inverse at generation. Chord roots relative to the key too.
- Keys: KeyTracker for all sources (78.6% bar agreement with AugmentedNet on held-out
  Lieder). Chords: AugmentedNet for aligned Lieder, ChordTracker elsewhere (75.9% root,
  67.0% root+quality per beat on held-out Lieder). Estimates, documented as such.
- Events: note, chord change (before the notes at its onset), bar end. Onsets are
  positions in the bar; notes within an onset go from the bass up.
- Decoder: kind -> onset -> chord root/quality | group -> voice pointer -> pitch (full +
  scale-degree + octave heads, chord/interval/scale priors) -> duration -> expression.
- Attention: rotary in event index, musical time and beat/bar phase. Planner over 511
  key-relative bar summaries; key, modulation, corpus style, groups and density as bar
  controls.
- 4,897,310 parameters; v2 step 19193 initializes 3,267,974 (fresh optimizer).
- Sampler: fused kernel tested equal to the training forward; key control and
  free/hold/bar/locked chord modes. Same host: 0.82 s vs v3 1.44 s per 128-note bar.

No run directory was created and no training was started. Commands are in the latest
section of `training/README.md` (preflight, `--initialize-only` into
`training/runs/four-pillar-v31-ready-20261001`, then `--resume`). Evidence came from a
cloud sandbox (torch 2.14.1; Mac venv has 2.14.0): 28/28 tests, a five-source real-data
subset (17,001 pitches decode exactly), identical training with 0 or 2 worker processes,
bitwise resume at `--threads 1`, and a single-parse MIDI loader equal to the v2 loader.
The full-data preflight and any MPS parity check must run on the Mac; the Linux view of
this folder has no torch. Remaining gates before replacing the webpage model: training,
held-out/listening evaluation, the console adapter (Hold/Every bar/Free, chord edits,
Stop) and long-session latency. The v3-ready run is still step 0 and all 16 code
hashes in its manifest still match.

## Claude — 2026-10-01, v3.1 second pass (reference bars, cached planner, train from scratch)

Supersedes the numbers and commands of the previous note. The user asked whether the v3.1
architecture was at its limit and to keep optimizing; later in the session they agreed to
train from scratch. Still no run directory and no training; v2/v3 code, manifests and runs
untouched (the v3-ready run is step 0 with all 16 code hashes matching).

Changed files: `training/scripts/four_pillar_v31_{tonal,model,data,sample}.py`,
`train_four_pillar_v31.py`, `training/tests/four-pillar-v31.test.py`,
`training/reports/four-pillar-v31-preparation-20261001.json` (schema 3), the v3.1 section of
`training/README.md`, and this note.

- Reference bars (form memory, like the joint melody model's motif input): about 40% of score
  bars restate an earlier bar key-relatively (Jaccard >= 0.5; 22% near-exact), often 100+
  bars back, beyond the 512-event window. Training uses the most similar earlier bar (or
  none); a pointer over the planner's bar states learns the choice (`bar_ref`, weight .25);
  the decoder reads the aligned reference note (next onset, and group/pitch/duration at the
  same onset and rank) as inputs and learned copy biases. 20% reference dropout. The sampler
  takes `reference='auto' | bar index | None` (`--references auto|none`).
- Planner: causal pre-norm blocks with rotary positions over bar distance, streamed with a
  cache (one step per bar instead of recomputing 511 bars). Planner input adds a 16-bin onset
  rhythm, top/bass scale-degree histograms and phrase phases (summary_dim 78).
- Decoder: onset logits are masked in training as in generation; chord heads run on chord
  rows only and note heads on note rows only; new inputs: a note's interval above the chord
  root and the interval by which its voice reached its previous note; top-p for pitch only.
- Bug fixed: 13 symphony-score parts change instrument group mid-piece; their target voice
  was excluded by the voice mask (loss 4e35 on one step of a short run). A voice identity now
  includes its group (a regrouped part opens a new voice, as in generation); 0 masked
  targets in the full score sweep.
- Training: no v2 transfer any more (it trailed scratch in total loss in short runs on the same
  windows: better pitch early, worse onsets and durations); `--lr`
  default 1e-3; lead-in capped at 384 events; `--workers` default = CPU cores - 2, at most 6.
- 5,014,967 parameters. Same host as the previous pass: training forward+backward 1.62 s vs
  1.90 s (8 windows, 2 threads); 128-note bar 0.99 s vs 0.86 s, 0.94 s vs 1.01 s with 511
  bars of history. 240-step scratch runs, last 50 steps: onset 0.699 vs 0.873, pitch 2.433 vs
  2.602, duration 1.131 vs 1.181 (early evidence only).

Evidence (cloud sandbox, torch 2.14.1): 33/33 tests (training/generation parity including
reference inputs, copy biases and pointer; kernel parity; streaming planner equals the full
pass and slides correctly), 1,434 scores x 2 windows with 0 errors, 0 out-of-range pitches
and 0 masked voice targets, bitwise resume at `--threads 1`, identical reruns, preflight and
the sampling CLI. Commands are in the v3.1 section of `training/README.md` (preflight,
`--initialize-only` into `training/runs/four-pillar-v31-ready-20261001`, then `--resume`;
no `--init-checkpoint`). The full-data preflight and MPS parity must run on the Mac.
Remaining gates: training, listening/held-out evaluation, the console adapter and
long-session latency on the target machine.

## Claude — 2026-10-01, v3.1 training launcher (7.5 training hours, ready to start)

The user asked for one script to run training directly, then set the training time to 7.5 hours. New:
`training/train_four_pillar_v31.sh` (start | status | log | stop | sample) and
`training/scripts/four_pillar_v31_midi.py` (sampler JSON -> standard MIDI; not imported by
the trainer, so editing it never blocks resume). Changed before any run exists:
`train_four_pillar_v31.py` (batches move to MPS as float32 because MPS has no float64 — the
first MPS step would otherwise fail; `--preflight` now builds one full batch, times several
forward+backward passes and, with `--device mps`, also times the CPU and reports loss and
gradient-norm parity) and `tests/four-pillar-v31.test.py` (35 tests).

The launcher runs tests -> preflight/device choice (MPS only if parity holds and it is at
least 20% faster) -> `--initialize-only` into `training/runs/four-pillar-v31-ready-20261001`
-> training with `--max-seconds 27000` (7.5 h; checks and samples add about 10 min),
checkpoints every 600 s -> three 16-bar MIDI samples. It runs detached (new session,
`caffeinate -ims`), so closing Terminal or Ctrl-C does not stop it; a failed trainer is
resumed from the last checkpoint (MPS failures switch to CPU), at most 3 retries. Logs,
device choice, preflight JSON and samples: `training/logs/four-pillar-v31-ready-20261001/`
(added to `.gitignore`). Sandbox tests of every path passed; bash 3.2 itself could not be
downloaded here, so 3.2-only pitfalls were avoided by review. MPS behaviour is untested
until it runs on the Mac. No run directory was created and no training was started.
