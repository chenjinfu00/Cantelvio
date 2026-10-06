# AIlegro

本机联合演示：[全部功能入口](http://127.0.0.1:4187/demo/)，可用项和限制见 [Score 演示验证](../Score/docs/demo-verification.md)。

## 2026-10-05 联合开发方向

[AIlegro 与 AIlegro Score 联合开发计划](JOINT-DEVELOPMENT-PLAN.md)：先完成给定旋律到可编辑伴奏的工作流程，再实测接入 AMT 等引擎，扩展连续生成与完整作品。曲谱编辑、审阅、回放和导出任务见 [Score 实施计划](../Score/docs/open-source-integration-plan.md)。这部分为待实施方案，下文保留此前模型与页面的历史记录。

2026-10-01 试听更新：主页和 `/four-pillar/` 已切到续训第 19,193 步（父模型第 20,134 步）的固定快照 `training/runs/four-pillar-v2-preview-20261001-step19193/`。源续训目录保留用于 `--resume`；网页读取独立快照，恢复训练不会改变正在试听的权重。以下 2026-09-30 模型信息为此前记录。

## 2026-10-01：乐器组角色状态栏

主页六个乐器组每行下方显示该组在**正在演奏的小节**里承担的角色：旋律 1（最突出的旋律）、旋律 2、旋律 3……、和声、低音、节奏。一组可同时显示多个角色（如“旋律 1 · 和声”）；开启但本小节没有音符显示“休止”，关闭显示“—”。未播放时预览下一小节。状态随音频时钟所在的小节更新，中途关闭的组立即从判断中去掉。

判断依据是该小节各组实际演奏的音符：谁占据最高音或最低音、旋律线的起伏与级进、同时发声的音数、稳定重复的节奏型；同度或八度重复同一旋律的组共用同一编号；打击乐记为节奏。v2 音符还带有采样时所属的声部类型（旋律／和声／低音），在几组接近时用来决定谁是旋律 1。这是对已生成音符的显示分析：不运行模型，不改音符和排程，也不是训练出的角色输出。当前 v2 控制台不播放无固定音高的打击乐，所以打击乐通常显示“休止”。

为区分同组内的多条声部，`training/scripts/four_pillar_v2_performance.py` 返回的音符增加了 `voice` 字段（只增加输出；同种子生成的音符逐项相同）。代码在 `frontend/src/roles.js`、`Session.roleView()`、`src/app.js` 和 `style.css`；测试 `tests/group-roles.test.js`。

## 2026-09-30 当前主页：Four-pillar v2 连续演奏

主页现通过本机 Python 常驻推理进程运行 `training/runs/four-pillar-v2-history512-20260930/state.pt`（20,134 步、6,965,881 参数），不再加载 Continued 四轨主干、表现层或旧六组分类器。必须保留项目的 `.venv-training/` 和该检查点；主页已经不是纯静态运行。`src/v2-composer.js` 经 `/api/four-pillar/perform` 提前准备八小节并持续续写；推理不发生在音频起音回调里。模型上下文保留最近 512 小节，含跨边界的持续音。

沿用原主页的独立 Chords、Bass、Melody、Hold / Auto、Every bar / Free、调性、七种拍号、温度、密度、音域、乐器角色、Fixed / Walk、音量、语言、未来和弦编辑与 Stop / Panic。六组开关现使用新模型的原生乐器组；关闭后仍可按手动角色配器。已排程小节锁定，未来编辑保留此前音符和和弦，只重写后缀。Stop 清除待播放事件，重启从最后听到的和弦建立新历史。

本次接入增加了和声、低音、旋律三类启动声部及连续演奏采样掩码，避免自由解码提前结束小节；音高和时值仍来自新模型采样。修复小节末起音导致零时长音符的循环。上述属于推理约束与页面接入，没有训练或更换权重。若续写尚未就绪，页面显示等待并在就绪后继续，当前机器不保证任何速度和配置下都无缝。

下文提及旧四轨主页的说明为历史版本记录；`/four-pillar/` 保留独立短段试听和连续试听入口。自动检查只能证明接口、时序和声部结构，音乐质量仍需试听。


**Independent project root:** this `AIlegro/` folder contains everything needed to run and modify the app. Start with [START_HERE.md](START_HERE.md) for the Chinese handoff guide and [AGENTS.md](AGENTS.md) for coding-agent context. You can copy the entire folder elsewhere; no sibling Tonnetz checkout is required.

A standalone, locally served performance workbench. Since 2026-09-27 one local **joint Transformer** writes the music: accompaniment rhythm, chords, bass and melody, generated together one sixteenth note at a time. It replaced the earlier pair of frozen Tonnetz v91 models (Harmony v2 and Melody v5) and the rule-based accompaniment/bass planner; those files are kept, unchanged, in `archive/pre-joint-runtime-20260927/`. No account, network service or deployment is involved. The model weights and sampled instruments are bundled.

## Frontend / backend layout

- [`frontend/`](frontend/README.md) is the browser/UI workspace: pages, styles, client-side music code, model runtime assets and audio samples. Open this folder alone to work on the interface. Its own `npm start` uses the local server.
- [`backend/`](backend/README.md) contains the local HTTP server and orchestral generation endpoints. It serves the frontend at the original URLs and keeps backend files private.
- `training/` and `.venv-training/` remain at the project root as backend-owned model/data assets. Moving these large, path-sensitive assets was unnecessary; no second copy was created. Tests, validation and historical documentation also remain at the root.

Old root paths such as `src/`, `vendor/` and `orchestra/` are compatibility symlinks into `frontend/`, not duplicated files. The rest of this document uses some of those familiar root paths; the physical files now live under `frontend/`.

Run with Node 20 or newer:

```sh
npm start
```

Open **http://127.0.0.1:4187/**. The server binds to loopback only. `PORT=4188 npm start` changes its port; the `HOST` override is deliberately opt-in. `npm test` runs the regression tests. No package installation is required.

The main console now uses only the selected **Continued** R/H/B/M backbone from the 2026-09-28/29 training, paired with its exact-note expression sidecar and the separately trained six-group note classifier. The old backbone remains on disk for historical parity tests but is not loaded by the homepage. The obsolete scene pads and synthetic-style selector are removed; new styles can be developed as separate fine-tunes. This is a playable first integration, not a listening-quality verdict. See [the frontend handoff](frontend/MODEL-INTEGRATION-ROADMAP.md) for known limitations and next tests.

The console has one **Instruments & roles** panel for Chords, Bass, Melody and six orchestral groups. **Fixed** plays every enabled group; **Walk** rotates enabled groups marked Walk by role every 1/2/4/8/16/32 bars, while Fixed groups stay on. Each group has On/Off, Fixed/Walk, role and level controls. The six orchestral groups are Off initially; configuration is saved in the browser under `ailegro.instrument-board.v1`. A visible **Six-group model** switch bypasses learned note classification when Off; enabled groups then use manual roles. With all six groups Off, this switch cannot change the Chords/Bass/Melody sound. The classifier does **not** compose new orchestral voices, and is separate from the five ablation checkpoints in the orchestral listening room.

The separate **[orchestral listening room](http://127.0.0.1:4187/orchestra/)** lets you select any of five local SymphonyNet-trained ablation checkpoints, generate 4/8/16-bar passages under shared settings, listen to a browser-synthesized sketch or piano reduction, inspect a note timeline, and download MIDI or rendered WAV. Generation runs through the project-local Python training environment on the local server; it never swaps the performance console's joint R/H/B/M model. New deterministic samples are cached under `training/orchestra/work/samples/` in the iCloud-synchronized project. The page needs the five checkpoints and `.venv-training`; unlike the performance console, it is not a stand-alone static-only page. Its simple synthesized sound is not a measure of final orchestral playback quality. The source MIDI corpus has unresolved per-file licensing, so generated previews are for research/personal evaluation rather than commercial release.

The listening room also has **continuous play**: four-bar segments keep the selected Transformer context and random-generator state between requests, are prepared ahead of playback, and play in sequence. The two-by-four-bar chart shows *estimated* harmony inferred from the notes; these orchestral models do not emit explicit chords. Six group switches (Auto/On/Off) and quick combinations, tempo, pitch temperature, and top-p can be changed for later segments. Switching model or seed starts a new piece. `On` means a group is available to the model, not guaranteed to sound in every bar; `Off` excludes it. Continuous session state is kept in `training/orchestra/work/sessions/`, and generated MIDI/events in `training/orchestra/work/samples/`, all in the synchronized project. The browser prepares at most about one segment ahead and stops on page exit.

## Training and project ownership

The four-pillar v2 training preparation now includes complete long-bar sampling, source-aligned harmony/expression targets, four supported tasks, ordered motif and sounding-note state, offline constrained free decoding, and exact checkpoint recovery. All 58 relevant tests and eight real-source/task no-update checks passed. MIDI contents are fingerprinted; independent musical evaluation and browser deployment remain separate gates. The launcher now uses 512 completed-bar summaries (6,965,881 total parameters; 5,384,572 trainable) and a separate `training/runs/four-pillar-v2-history512-20260930/` directory. Training and offline decoding share the configured history length; exact event context remains 2048 tokens. The user will launch training locally; `bash training/run_four_pillar_v2.sh --preflight` checks only. The expanded window passed 61 tests, eight real-source/task no-update checks, and an additional full-512-bar real-score forward/backward resource check. The earlier 58-test evidence remains historical. See [the revised v2 training record](training/FOUR-PILLAR-V2-TRAINING.md) for training, recovery and compatible checkpoint continuation.

All automatic-accompaniment and model development belongs to AIlegro. The sibling Tonnetz project retains its existing runtime; Volta remains the score reader. Training scripts, data preparation, the pinned OpenScore source archive, processed corpora, checkpoints and evaluation tools are in [training/README.md](training/README.md); the joint model's design and results are in [training/JOINT-MODEL-DESIGN.md](training/JOINT-MODEL-DESIGN.md). New training outputs go to `training/runs/` and never replace runtime weights automatically.

The next-generation four-pillar composition network (harmony, counterpoint, form, orchestration) has an integrated implementation and a five-minute **private pilot** checkpoint, not a full-corpus trained model. [The separate pilot listening page](http://127.0.0.1:4187/four-pillar/) uses two completed validation-score bars as a prompt and a rhythm/duration scaffold from the already-heard bar; the pilot checkpoint samples voice pointers and pitches for two further bars. The old four-track prior can be toggled for aligned Lieder prompts, but transplanted H/M weights remain in both modes. This is not unconstrained score generation, and it does not change homepage weights. The remaining training/inference gates are documented in [training/FOUR-PILLAR-V1-IMPLEMENTATION.md](training/FOUR-PILLAR-V1-IMPLEMENTATION.md).

## The joint model in the app

Four token streams per sixteenth-note step, always generated in the order **R → H → B → M**:

These are the authoritative musical pitches and chord attacks in the current page. The expression head supplies fractional onset, duration, tuplet labels and dynamics to those structural notes. Its independently predicted absolute pitches proved unreliable in free generation and are not currently played or fed back to the backbone. The following "heard as" descriptions therefore apply again, with expressive timing layered on top.

| Stream | Tokens | Heard as |
|---|---|---|
| R, accompaniment rhythm | rest / hold / one onset / several onsets | when the chord instrument plays: block chords for several onsets, a broken-chord note for one |
| H, harmony | hold, or a chord (40 qualities × 12 roots, relative to the context key) | the chord chart and the chord voicing |
| B, bass | rest / hold / onset of one of 48 pitches | the bass line (the model's own pitches) |
| M, melody | rest / hold / onset of one of 36 pitches | the melody (the model's own pitches) |

`vendor/lib/joint-model.js` runs the continued backbone in the browser (1,581,309 parameters, float32, `vendor/lib/joint-continued-weights.js`). The expression head (`joint-expression.js`) predicts exact fractional onset, duration, tuplet label and dynamics after each four-token step. For the current listening-safe hybrid, its pitch guesses and extra-step feedback are disabled in live playback; the R/H/B/M output remains authoritative. The arrangement head (`joint-arranger.js`) classifies a completed bar's performed notes before scheduling when enabled. The four-track context window remains 128 sixteenth steps with barline restarts. `npm test` checks PyTorch/browser logits for all three heads; this is not a listening-quality guarantee.

`src/composer.js` keeps the generated timeline in absolute terms (MIDI notes, pitch classes, local keys) and applies the musical controls as masks on the model's distributions:

- **Every bar**: a new chord on each downbeat, no other changes. **Free**: the model decides when chords change, on beats only, and a chord lasts at most two bars. **Hold**: the chord stays (the harmony stream is held); rhythm, bass and melody keep moving.
- **Harmony T / Melody T** use two-stage sampling: whether something new happens (a chord change, a new note) is drawn from the model at temperature 1, and the temperature only sharpens or flattens *which* chord or note. With plain temperature scaling the frequent hold/rest tokens took over and the art-song condition stalled; this was measured, not assumed (`training/JOINT-MODEL-DESIGN.md`). Top-p 0.95 applies to the choice.
- **Density** adds a small bias for or against new accompaniment and melody notes (0.5 is neutral).
- Bass stays within E1–D4 and melody within A3–A5. These ranges are chosen so that every context window can encode them (the model has 48 bass and 36 melody pitch tokens above a base that can sit up to 11 semitones below the lowest note). An edited chord can also fix its bass note (the inversion).
- **Model style** selects the model's condition: *Art song (Lieder)* is the real-music domain; *Pop, Jazz, Blues/rock, Classical (rule phrases), Ambient* are the synthetic conditions learned in pretraining from the earlier rule system. The synthetic *exploratory* condition is not offered: its training phrases had no melody.

`src/render.js` only voices and times what the model wrote: a close chord voicing between E3 and F5 with voice leading, broken-chord order for single onsets (sustained like a pedal on decaying instruments), swing if chosen, velocity by metrical position and a deterministic touch of humanisation. It never calls the model.

## Playing

- **Play** creates/unlocks this app's audio context within the user gesture, loads 35 local samples, then starts. Stop remains available during loading. The sound drawer reports decoded sample counts, failures and synthesis fallback, plus generation diagnostics. **Retry missing samples** retries only failed sample files, with a 12-second request timeout.
- The chord chart shows eight real measures in two rows of four; they are the bars the model has already written and that will be played. Widths are real beats; "continue" marks a chord carried across a barline. After the upper row finishes, the lower row moves up and four newly generated measures appear. A striped measure is still being generated.
- **Hold / Auto** and **Every bar / Free** apply from the next available bar. Melody is **Off** in a new browser setup, unless the user has saved a different instrument-board choice. Melody Off stops scheduling that instrument's notes; the joint model still writes the melody stream, because the four streams are generated together, so turning it on continues the same music. A mixer mute only silences a bus.
- The unified instrument panel controls all nine lanes. The original three use user-selected sounds; the six new groups use local synthesized colours. Fixed/Walk affects only which enabled groups play, not key walk, generated notes or the chord chart. Turning a group Off stops its sounding voices immediately.
- The scene pads and model-style/groove selectors are no longer exposed. The current Lieder sound has instrument, meter, temperature, density, feel and mix controls. Legacy saved scene records remain readable internally, without changing the active model.
- Bars are frozen when they are scheduled, about 100 ms before they sound. A bar whose scheduling is too close for its rewrite to finish is also no longer editable: at least 0.6 s, more on slower devices (the margin is sized from the measured generation speed, so a bar boundary never has to wait for the model). Changes that rewrite the future (style, meter, temperatures, density, mode, timing, key walk, random scenes, key) start at the first bar that is still editable. Sound choices (instruments, groove, register, feel, Bass On/Off) affect the next scheduled bar. Mix and mute respond immediately.
- **Tempo**, 40–200 BPM, changes on the next available bar. Select any of 24 major/minor keys; a new key starts on its tonic chord at the next available bar, and the model continues in the new key. **Key Walk** moves to a neighbouring key every 4/8/16/32 bars (favouring common tones with the current chord); the model receives the new local key as its key input. Hold does not walk.
- Click an editable future chord for the model's own alternatives at that point (its most likely chords, with probabilities) or choose root, quality and bass/inversion. The edit keeps every earlier step, writes the chosen chord (and bass note) into the timeline and rewrites everything after it. An editor opened before the bars changed, or on a chord that has since been scheduled, cannot submit.
- Legacy random-scene logic remains for saved-data compatibility and regression tests but has no control on the current page.
- **Stop** and **Panic** cancel all scheduled voices and timer generations. Restart begins a fresh timeline and chart from the last actually heard chord (or a pending new key). Ordinary window focus loss does not stop playback. Audio suspension/interruption/page exit stops safely; a Play gesture resumes without catching up missed bars. Keep the tab visible for reliable timing.
- A bass or melody note that continues across a barline is scheduled with its full length; later rewrites keep it held until that release.

English is the default; the language selector switches to Chinese. There is no embedded Tonnetz keyboard, MIDI, recording/export in the performance page, or cloud synchronization. WAV export in the separate diagnostics page is solely for evaluating rendered fixtures.

## Historical factory scenes (not exposed in the current UI)

| Scene | Model style | Sound |
|---|---|---|
| Warm Piano | Art song (Lieder) | Sampled piano for chords, bass and melody |
| Velvet Jazz | Jazz, swing groove | Electric piano, sampled electric bass, reed lead |
| Indie Drive | Blues/rock | Sampled electric guitar, sampled electric bass, guitar lead |
| Open Air | Ambient | Pad, synth bass, bell melody |

Scenes saved with the earlier console (`ailegro.scenes.v1`) are still read: instruments, temperatures, feel and mix carry over; the old harmony style, waltz rhythm and swing rhythm map to the new style, 3/4 meter and swing groove; retired fields (textures, bass patterns, melody patterns, interaction) are ignored.

## Implementation and testing

- `src/composer.js`: timeline, context windows, incremental decoding, constraints, asynchronous generation in slices of about 6 ms, synchronous completion only as a bounded fallback at a bar boundary.
- `src/session.js`: scenes, parameters, bar plans (style, key, key walk, random scenes), freezing and scheduling bars, chart view, editing, Stop/restart.
- `src/render.js`, `src/voicing.js`: tokens → audio events; chord labels (slash chords from the bass the model wrote).
- `src/instrument-board.js`, `src/orchestration.js`: the main console's nine-lane role/Walk routing and the separate preview's six-group routing. Both are deterministic, untrained adapters around the original joint-model output.
- `src/transport.js`: one audio clock, generation checks, the 100 ms planning window and audible start callbacks (unchanged).
- `src/audio.js`: sample/synthesis adapter with nine independent lane buses, ramps, per-group cancellation, headroom, compressor and soft saturation.
- `src/chord-chart.js`, `src/scenes.js`, `src/instruments.js`, `src/app.js`: chart helpers, scenes and saved-scene migration, sound choices and model conditions, interface.

`npm test` covers PyTorch parity for the continued backbone, expression head (including nonempty extra-step context), six-group classifier, seven exposed meters, exact onset timing and user group/role masks. Historical scene and original-model tests remain as regression checks. The independent chart checks are listed in `START_HERE.md`.

The original four-track training windows were **12-tone equal-temperament transposition-equivariant**. The selected continued model inherited that backbone and adds absolute-pitch expression and learned MIDI group classification; those new heads require separate transposition and register evaluation. Duplicating old windows under twelve key names is not a substitute for new instrument-register data.

**http://127.0.0.1:4187/qa/** contains the earlier reproducible audio checks. Its fixture set has not been refreshed to cover the new expression/arrangement path; adding that is a priority in the [frontend handoff](frontend/MODEL-INTEGRATION-ROADMAP.md). Offline metrics do not prove listening quality or live-device timing.

## Model limitations and provenance

The deployed checkpoint set is `training/runs/joint-continued-expression-v1/best-base.pt` plus its matching `best.pt` expression sidecar, and `training/runs/joint-continued-arrangement-v1/best.pt`. The previous `training/runs/joint-v1/structured/model.pt` remains a historical comparison, not the homepage model. Original pretraining used project-authored synthetic phrases; continued four-track/expression training used OpenScore Lieder (CC0) and its automatic AugmentedNet harmony analyses. The MIDI-trained six-group head is a note classifier. Prediction losses, parity tests and earlier comparisons with Melody v5/Harmony v2 do not establish listening quality for this combined version. See [vendor/JOINT-MODEL-NOTICE.txt](vendor/JOINT-MODEL-NOTICE.txt).

`VENDOR_MANIFEST.json` records SHA-256 for the chord vocabulary, tonality helper, sound assets and the joint-model files; the retired Tonnetz v91 modules are listed with their archive location. `SOURCE_BASELINE.json` and `PREPARATION.md` remain historical preparation snapshots.

The performance console performs inference and audio locally in the browser. The separate orchestral preview sends only the chosen generation settings to the loopback server, which runs the selected local Python checkpoint; its audio is synthesized in the browser. Saved scene settings stay in the browser. There is no analytics, service worker, account or remote upload.

## Credits and licenses

Sample families are carried forward with their source attribution and conservative CC BY 3.0 treatment; retain their notices and manifests when redistributing:

- [Piano notice](media/piano/NOTICE.txt)
- [Electric bass notice](media/bass/NOTICE.txt)
- [Electric guitar notice](media/guitar/NOTICE.txt)
- [Joint model notice](vendor/JOINT-MODEL-NOTICE.txt) (OpenScore Lieder, CC0; separate from the sampled instrument license chain)

Electric piano, pad, strings, lead, reed, organ, bell and plucked colours are synthesized. Piano, electric bass and electric guitar use sampled buffers when available; missing buffers fall back explicitly to synthesis.

## History

- The first live browser pass of the earlier console caught a timer receiver issue that fake-clock tests could not expose; default timers call `globalThis.setTimeout`/`globalThis.clearTimeout` through explicit wrappers. The transport is unchanged since.
- The first four-scene audio fixtures kept more than 13 dB of peak headroom but played quietly. Calibration adds 5 dB before the compressor and soft safety guard, and trims sustained pad and synth-bass voices by 3 dB. This fixed output calibration is unchanged.
- Until 2026-09-27 the app used Harmony v2 (204,391 parameters) with a probability-conditioned duration policy, Melody v5 (349,325 parameters) and the frozen v91 accompaniment planner. Their documentation, tests and verification records remain in `archive/pre-joint-runtime-20260927/`, `QA-REPORT.md` and `validation/`.

## 2026-09-30：训练后 v2 网页试听

`/four-pillar/` 现调用已完成的 `training/runs/four-pillar-v2-history512-20260930/state.pt`（20,134 步，累计约 11 小时），严格核对 manifest 并加载 v2 结构。两小节原谱提示后自由生成两小节，起音、时值、声部与音高不再复制旧试训的节奏骨架。乐器组为生成掩码，速度参与生成条件。Python 本机推理后由浏览器合成音频并提供 WAV；主页仍为续训四轨模型。

五个提示沿用早期试训的谱例列表，但已属于本轮训练语料，不能称为 v2 验证集。简化音色、每生成小节 128 音符资源上限和无固定音高音符的音频省略均在页面说明；结果摘要报告资源收束次数。旧 v1 试训接口代码保留为历史，本节取代上文关于该页面仍使用 v1 的描述。

### Six-group console and pitch verification (2026-10-01)

The v2 performance console exposes six native instrument groups with On/Off,
Fixed/Walk and levels. The former Chords/Bass/Melody lanes, role selectors and
arrangement toggle are removed from this console. Legacy scene fields remain
readable. Native notes retain their generated group and MIDI pitch: rendering no
longer adds the melody-register octave, routes to alternative groups, duplicates
basic lanes or folds into instrument ranges. Exact native string notes use tuned
harmonics rather than the legacy ±0.2% chorus detuning. Disabling a group silences
its notes; it does not transfer them to another instrument. Walk still rotates
participating groups within the existing families and can intentionally rest them.

`/qa/pitch.html` renders actual step-19193 notes through the same router and Web
Audio engine, finds the dominant PCM spectral peak independently of the requested
pitch, and compares MIDI/frequency. Additional pitched controls cover the other
three timbres. Unpitched percussion identity is not currently available in the v2
console export; no substitute drum notes are fabricated. Musical quality and
harmonic correctness still require listening; pitch equality alone does not prove
that the model composed a good note. The independent streaming architecture
prototype and remaining training requirements are documented in `training/README.md`.

## 开源软件和资源清单

已接入、已下载待验证及候选项目的用途、许可证和本地位置见 [OPEN-SOURCE-INVENTORY.md](OPEN-SOURCE-INVENTORY.md)。

## 旋律配伴奏模型发展方向

下一阶段的主目标、架构候选、基准与验收标准见 [旋律配伴奏路线图](training/MELODY-ACCOMPANIMENT-ROADMAP.md)。这是待实施方案；训练与模型切换尚未执行。
