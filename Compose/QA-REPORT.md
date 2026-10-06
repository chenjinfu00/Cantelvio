# AIlegro — verification

## 前端／后端目录分离 — 2026-09-28

浏览器页面、`src/`、`orchestra/` 的客户端文件、`qa/`、`vendor/` 和 `media/` 已原地移动到 `frontend/`；本地服务与管弦乐生成接口在 `backend/`。根目录同名软链接保持现有 4187 进程及旧路径可用；`training/`（5.9 GB）和 `.venv-training/`（776 MB）没有移动或复制，检查点与浏览器权重也没有替换。

- 根目录 `npm test`：**41/41 通过**。三个独立和弦谱脚本通过，包括 96 小节和 20 次两排谱面上移。
- 新后端在临时 4188 端口通过路由检查：主演奏页、`/orchestra/`、`/orchestra/joint.html`、`/qa/`、模型资源、两份说明、`/api/orchestra/models` 与已有生成 MIDI 正常返回；`/backend/server.mjs` 和训练内部数据返回 404。
- 隐藏浏览器实际载入主页面并显示八小节谱面；管弦乐页加载五组模型，既有 8 小节样本渲染完成且 MIDI/WAV 链接出现；旧联合模型管弦乐页也显示完整控件。未以浏览器试听或验证长时间连续演奏。临时 4188 服务已停止，原 4187 服务和用户标签页未中断；原进程重启后才会采用新的静态文件隔离规则。

## Unified instrument board — 2026-09-28

The original performance console now routes its unchanged joint R/H/B/M model through one board containing the original three instruments and six optional orchestral groups. Its main arrangement button switches **Fixed / Walk**; each group independently has **On / Off**, **Fixed / Walk** eligibility, a source role (Harmony/Bass/Melody/Rhythm) and level. Walk rotates only enabled, participating groups with the same role at the chosen bar interval. New orchestral groups and Melody are Off in the default setup. This is deterministic, untrained routing; none of the five SymphonyNet ablation checkpoints or runtime joint weights were replaced.

- `npm test`: **41/41 pass** after the final Fixed/Walk refactor, including default sound, role routing, group isolation and phrase rotation. All three independent chord-chart checks passed; the 96-bar advertised-versus-played oracle still passed with 20 four-bar promotions.
- The training-encoding check `training/tests/joint-transposition.test.py` passed: **16 windows × 12 semitone shifts** left all old-model token/control fields identical when notes, chords and key are transposed together. This establishes representation equivariance, not a newly trained orchestral arranger.
- Hidden local-browser QA loaded the unified nine-row panel, switched individual On/Off and Fixed/Walk controls, assigned roles, and observed the next-bar active count change. A prior live browser run under per-role rotation reached bar 2 with no console errors. The final simplified control layout was reloaded and checked through its accessibility tree. The user's visible performance tab was not reloaded or interrupted.
- Updated `/qa/` Warm Piano, seed 41977, four bars, original mix plus all six orchestral groups: **35/35 samples decoded**, 0 failures; peak **−5.67 dBFS**, RMS **−23.96 dBFS**, 0 clipped/nonfinite samples, last 250 ms silent. Events included all six new groups plus the original three. These are signal-integrity checks, not evidence of musical quality.
- Desktop layout was visually inspected. A narrow mobile simulation was attempted, but the in-app viewport override did not give a reliable final CSS-width screenshot; physical phone/tablet and Safari checks remain open. No subjective listening comparison with the user's preferred previous sound has been made.

## Joint-model runtime — 2026-09-27

The runtime now uses the joint R/H/B/M Transformer (1,581,309 parameters) for accompaniment rhythm, chords, bass and melody; the Harmony v2 / Melody v5 / rule-planner runtime is archived unchanged in `archive/pre-joint-runtime-20260927/`. All checks below were run in the Claude cloud workspace (Linux container, Node 22.22, headless Chromium 1194 through Playwright), not on the user's devices. Nobody has listened to the audio as part of these checks.

**Automated**

- `npm test`: **33/33 pass** (joint-model parity and provenance, sampler, generation constraints, window restarts, edits, frozen bars and tied notes, key changes, pitch encoding after a key move, async prefetch, long-session step release, long Hold and Stop after many bars, speed-sized edit margin, transport safety, mixing and Melody Off, scenes, chart = playback, Stop/restart, saved-scene migration).
- Browser decoder vs PyTorch: largest logit difference **2.4×10⁻⁵** over 10,458 logits (two Lieder validation windows and one synthetic 3/4 jazz window).
- `validation/check-chord-chart.mjs`: 4/4 checks pass (spans tile every measure for 3 styles × 2 meters × 2 timings × 16 bars; continuations; page promotion; widths).
- `validation/check-chart-session.mjs`: **96 bars** advertised = played across Every bar/Free × 3/4, 4/4; six next-bar changes (Hold→Auto, Free→Every bar, Every bar→Free, meter, scene, key) forecast = played; 20 page promotions; Stop resets.
- `validation/check-chart-edits.mjs`: 8-bar forecast prepared asynchronously (about 0.5 s in Node); 100 chart renders ran the model 0 times; an edit kept every earlier step; a superseded prefetch resolved as cancelled after a key change.

**Browser (headless Chromium, desktop 1280×1000)**

- Page load to a filled eight-bar chart: about 1 s. 35/35 samples decoded. No console errors except the pre-existing `/favicon.ico` 404.
- 48 consecutive bars at 160 BPM with Auto + Free and Melody On, including a chart edit, a queued scene change (Indie Drive), a switch to 3/4 and a key change to D major: **0** differences between the chart shown before each bar and the bar scheduled, **0** synchronous generation fallbacks, no scheduling-deadline stops. Events in those bars: 495 chord, 86 bass, 179 melody notes (the page samples with the browser's own random numbers, so each run differs). Repeated after the review repairs below.
- Earlier run at 92 BPM: edit dialog listed the model's alternatives with probabilities (G7 60%, G 10%, F 4% …); applying F maj7 rewrote the later bars; queued Velvet Jazz became active at its bar; A minor started on its tonic; Stop restarted the chart from the last heard chord.
- With Chromium's 4× CPU throttling: playback continued (10 bars at 92 BPM), 0 synchronous fallbacks. Longest generation slice: 56 ms throttled; unthrottled steady-state slices 3–11 ms (the first slices after load are longer while the JavaScript engine warms up).
- Generation cost in Node: about 75 ms of work per 4/4 bar (50 ms per 3/4 bar) including context re-encoding; a single step unit has median 2.7 ms and p99 4.9 ms after warm-up.
- Layout screenshots: desktop, tablet 1024×768 and phone 390×844 (chart scrolls horizontally as before); settings drawer in English and Chinese. No overlap found. Saved as `previews/ailegro-joint-*.png` (desktop while playing, settings, chord editor, tablet in Chinese, phone).
- Chord names in the chart are spelled in the local key (C♯ø7/E in D major, G♯dim7 in A minor); the editor's own root list keeps the vocabulary names.

**Offline renders (`/qa/`, seed 41977, Free, full mix, 4 bars + 2 s tail)**

| Scene | Events (chords / bass / melody) | Peak dBFS | RMS dBFS | Clipped | Non-finite |
|---|---:|---:|---:|---:|---:|
| Warm Piano | 38 / 16 / 5 | −6.66 | −25.40 | 0 | 0 |
| Velvet Jazz | 49 / 16 / 18 | −7.53 | −22.14 | 0 | 0 |
| Indie Drive | 93 / 31 / 16 | −6.31 | −24.27 | 0 | 0 |
| Open Air | 60 / 4 / 16 | −10.32 | −23.54 | 0 | 0 |

All tails decay to 0. Every timeline starts with a seeded melody note (a chord tone near G4): from a silent start the art-song condition often opens like a piano introduction (in 12 trials the melody first entered after a median of about 4 bars, and not within 8 bars in 3 of them); with the seeded note it entered within the first bar in 9 of 12 trials.

**Independent review (subagent, read-only) and repairs.** A separate review agent ran randomized stress tests (8 seeds × 500 interleaved generate/truncate/edit/regenerate/lock operations with style and meter changes: decoder cache always equal to a fresh re-feed, scheduled steps never changed, every scheduled bass/melody release matched the final timeline) and found three bugs, all repaired and covered by new tests:

1. Releasing old steps in long sessions made the chart read a released step: Stop after 14 or more bars threw and left the app unusable, and plain Hold failed at bar 14. Chord spans now carry their onset bass and key, and bars whose steps were released are never read.
2. After the window moved to a new key, a melody note near the top of the old range could be encoded past the 36 melody tokens, which fed NaN into the model for several bars. The melody range is now A3–A5 (every window can encode it), and pitch tokens and embedding lookups are guarded.
3. A change made just outside the fixed 0.6 s margin could force about 170 ms of synchronous generation at the boundary (the transport allows about 150 ms). The margin is now sized from the measured generation speed.

Known minor limitations it also noted: a note tied over a barline keeps the old tempo if the tempo changes at that barline; the audio engine caps single notes at 12 s; parameter changes made while a scene is queued are replaced by that scene (as before); an edit to the same chord as the previous one merges with it and ignores its bass choice.

**Not verified**: listening quality, Safari/iOS and physical phones or tablets, real audio output devices, sessions longer than about two minutes, and the parameter-matched flat baseline (training paused).

## Earlier console (Harmony v2 / Melody v5) — historical

**Status: local demo accepted, 2026-09-26.** No production deployment was performed. GPT-6 Sol implemented the app; GPT-6 Astra performed independent read-only code review; the parent agent checked the running browser, responsive layouts and exported audio.

## Functional evidence

- All **12 regression tests pass**. They exercise real frozen model inference, accompaniment parity, queue identities and revisions, scene/global-state preservation, independent mixing, cancellation and timing races.
- The parent observed **34 consecutive Auto + Melody bars** advancing through the advertised chords. A separate Hold/random-scene run reached 25 scheduled bars while keeping the current D-minor chord.
- All **35/35 local samples** decoded in the browser. The actual audio context ran, and Stop/Panic cancelled playback. No browser console warnings/errors were recorded in the final UI pass.
- Future-chord editing changed the selected second future slot to D♭/F, preserved the current and earlier future chord, and regenerated later predictions.
- Saving a modified Warm Piano pad, reloading and recalling it restored triple meter, Alberti accompaniment and high melody register. Live playback reached bar 2 in 3/4. The test snapshot was then removed with Restore preset.
- Random scene switching at mean interval 1 changed active scenes while preserving key, tempo and Melody On. English/Chinese switching and the small-screen chord editor were exercised.
- Astra compared all four scenes across four bar phases against the original expressive accompaniment planner (16 comparisons). Eight Hold bars preserved keys, ages and future identities with key walk enabled. Auto consumed the advertised UID.
- Final independent hash check: **57/57 copied files** match the vendor manifest; **14/14 original Tonnetz modules** match the frozen baseline. Original Tonnetz and model weights are unchanged.

## Issues found and repaired

1. Replaced the initial simplified accompaniment adapter with the unchanged expressive planner, retaining voice-leading, chord-tone and articulation behavior.
2. Separated lookahead planning from the audible/UI boundary. Queued scene gain changes and the visible current chord now commit at the scheduled start. The 100 ms planning cutoff is documented.
3. Isolated manual mixer changes so they do not cancel another voice's pending automation.
4. Added late-clock/inference-overrun protection to avoid collapsed catch-up attacks.
5. Live browser QA caught a native timer receiver bug that fake-clock tests missed. Explicit native timer wrappers fixed advancement; a regression test and sustained browser playback confirmed it.
6. Increased output calibration by 5 dB before the compressor/guard, trimmed sustained pad and synth-bass by 3 dB, and repeated audio measurements.
7. Compressed desktop/landscape spacing. Changed phone dialogs to full-width stacked controls after finding truncated option labels.

## Audio evidence

Ten deterministic four-bar WAVs were rendered through the **same models, planners and Web Audio adapter** used by the app, then downloaded and independently measured using `validation/check_wav.py`. Seed 41977, 92 BPM, C major, Melody On, two-second release tail; stereo 44.1 kHz, 12.435 seconds each.

| Final render | Peak dBFS | RMS dBFS |
|---|---:|---:|
| Warm Piano | -9.05 | -27.89 |
| Velvet Jazz | -8.92 | -25.04 |
| Indie Drive | -9.01 | -27.23 |
| Open Air | -12.15 | -24.04 |
| Velvet bass only | -12.68 | -28.18 |
| Warm melody only | -16.66 | -32.15 |
| Indie chords only | -13.37 | -34.47 |
| Indie, all gains 100% | -4.94 | -21.89 |
| Open Air, all gains 100% | -6.03 | -16.89 |
| Warm, Panic at 2 seconds | -12.31 | -35.45 |

All ten passed signal-integrity checks: finite, non-silent output, zero clipped samples, negligible DC offset, and a silent final half-second. Panic's final active 100 ms window ended at 2.1 seconds. Float-buffer metrics before WAV encoding also reported zero nonfinite/clipped samples. The generated performances are dynamic; these fixtures do not exhaust every possible setting.

Evidence: `validation/audio-results.json`, `validation/browser-audio-metrics.txt`, and `validation/audio/*.wav`.

## Responsive evidence

- **1366×900 desktop** and **1180×820 iPad landscape**: all main performance controls fit in one viewport; settings button ends at y=705 in landscape.
- **820×1180 iPad portrait**: main controls fit without horizontal overflow; settings ends at y=1001.
- **390×844 and 320×740 phones**: natural vertical scrolling, no horizontal overflow/outside controls. Settings and chord editing use full-width stacked inputs, retain 44 px touch targets, and remain operable.
- Drawer overlays the page. Saved screenshots are in `previews/ailegro-demo-*.png`. Viewport overrides were reset after testing; playback is stopped in the delivered page.

## Limits

These are browser viewport simulations, **not physical iPad/Safari, multitouch or Bluetooth-latency tests**. Audio signal checks and code review verify output and engineering behavior, not a subjective listening preference or professional composition quality. The two small frozen experimental models were reused, not retrained. Background-tab timing is not guaranteed; interrupted playback stops safely and requires Play to resume.

## Update: Free harmonic timing — 2026-09-27

Accepted locally after GPT-6 Sol implementation, GPT-6 Astra independent review and parent browser/audio verification. The main transport now offers **Changes → Every bar / Free** alongside Hold/Auto. Every bar remains the default. Free commits 1/2 beats or 1/2 bars from a transparent duration policy conditioned on the frozen Harmony Transformer's inversion-aggregated distribution. This is not a newly trained duration head.

Evidence and fixes:

- **26/26 final tests pass.** Added coverage for model-dependent duration probabilities, committed short/long timing, real bar versus chord progress, mode changes, every scheduled edit lock, Stop/restart at internal onsets, meter remapping, tonal replacement and prefetch safety after live edits.
- **64/64 frozen melody fixtures** retain exact event hashes and decoder context counts with one harmony per bar. Astra additionally verified 16 complete Every-bar session outputs against the previous implementation, including RNG order.
- Parent independently ran **256 Free bars** over four styles and 3/4 + 4/4: every configuration produced internal chord changes and multi-bar holds, with finite positive events inside the correct bar. Maximum observed plan time was 37 ms on this computer; this is not an iPad performance claim.
- Browser trace: Am held through bars 17–18; bar 19 changed from Dm on beats 1–2 to Gsus4/C on beats 3–4; C held through bars 20–21. The bar counter retained the musical meter throughout. Switching back to Every bar produced Cadd9, Em, Am and Dm on successive bars 39–42. Hold displayed “Held · ∞” and retained C before resuming Auto.
- Latest three-beat + swing-melody browser run reached bar 12 with no console warning/error. Free/Auto are selected in the delivered preview, playback stopped; a fresh page still defaults to Hold/Every bar.
- Fixed a pedal-bass gap after an internal change; fixed bar-unit progress across 3/4↔4/4 meter changes. Review found and repaired two short-remainder melody duration-mask crashes. Independent review then passed 12,000 integer-timeline cases and 1,872 fractional-timing bars.
- Four actual Free-mode browser WAV renders passed independent signal checks: Warm peak/RMS −8.84/−27.24 dBFS; Velvet −9.31/−24.97; Indie −8.60/−26.74; Air −11.86/−23.98. All had zero clipping, finite signal, negligible DC and silent release tails. Each render decoded 35/35 samples.
- iPad landscape simulation 1180×820 fits the new control and durations; settings ends at y=722. Phone 390×844 shows a full-width Changes selector with no horizontal overflow. Viewport overrides were reset. Original saved pads were preserved.
- Final hash verification: all 57 vendor files and 14 original Tonnetz modules still match the frozen manifests. No deployment.

Additional evidence: `validation/FREE-RHYTHM-ACCEPTANCE.md`, `validation/melody-free-parity.json`, `validation/free-rhythm-simulation.json`, `validation/free-browser-beat-trace.json`, `validation/every-bar-browser-trace.json`, `validation/free-audio-results.json`, `validation/free-browser-audio-metrics.txt`, `validation/audio/*-free-full-41977.wav`, and `previews/ailegro-free-*.png`.


## Update: Two-row eight-measure chord chart — 2026-09-27

Implemented by the explicitly requested **GPT-6 Luna**, then independently reviewed and repaired by the parent. Accepted locally at `http://127.0.0.1:4187/`. Both Every bar and Free timing remain available.

- The former four-card lane is now a real measure chart: two rows × four bars, beat-proportional chord spans, continuation labels, visible beat dividers, current-segment highlight and a moving playhead. At each four-bar boundary the lower row moves to the upper row and the next four bars are prepared.
- **29/29 tests pass**, plus all seven independent pure chart checks. The parent's independent session oracle compared **96 actual bars** with previously advertised UID/chord/start/duration spans across Every bar/Free and 3/4/4/4, including **20 four-bar promotions**, then verified four mode/meter transitions.
- Independent asynchronous/edit checks pass: bounded visible-horizon preparation, no model inference in rendering or synchronous audible-onset callbacks, edited chord preserves the earlier prefix, stale prefetch cancels on key replacement, played history survives regeneration, and interruptions clear old chart history. A sample initial horizon prepared eight slots in approximately 40 ms on this computer; this is not a mobile-device performance guarantee.
- Actual browser trace: **32 beat observations**, **241 stable forecast-span comparisons**, and page transitions from bars 5–12 to 9–16 to 13–20. Prepared partial bars can gain additional spans, while their existing spans remain unchanged. The pointer stays on the upper row and resets to its left edge on promotion. No browser warning/error was recorded.
- In a second live run, bars 17 and 19 visibly contained internal changes: Dm for one beat → G/B for three beats, then G/B continuation for one beat → C for two beats → F for one beat. Continuations across neighboring measures were shown separately from new attacks.
- Future editing through the real UI successfully selected **D♭maj9♯11/G** and rebuilt the later forecast. A three-voice playback run reached 29 scheduled bars, decoded **35/35** samples and reported seven active voices with no interruption or console error. The sound engine and frozen model assets were not changed by this chart work.
- Parent review fixed forecast-vs-actual precedence, exhausted-tail fabrication, Every-bar initial cursor, missing-UID fallback, Hold-to-Auto projection, old history after interrupted playback, pointer row selection and exact measure positioning. Final UI repairs make beat lines visible over chord blocks, keep keyboard focus during refresh and restrict highlighting to the current measure.
- Responsive viewport checks: **1366×900 desktop**, **1180×820 iPad landscape**, **820×1180 iPad portrait**, **390×844 and 320×740 phones**. No document horizontal overflow or clipped chord labels in tested states. Landscape settings ends at y=817; portrait settings ends at y=1141. Narrow phones retain a 920 px two-row chart inside an independently scrollable container.
- Phone follow trace spans eight consecutive bar starts, including two row promotions. The chart's horizontal scroll followed the current measure while page `scrollY` stayed exactly **865** throughout, with one highlighted sounding segment and two rows throughout.
- All **57 vendor files** still match the frozen manifest. User-authored saved scene pads were preserved. Temporary viewport overrides were reset and playback was stopped in the delivered page.

These are browser viewport simulations, not physical iPad/Safari or touch-latency tests. No model retraining or deployment occurred in this update.

Evidence: `validation/CHORD-CHART-ACCEPTANCE.md`, `validation/check-chord-chart.mjs`, `validation/check-chart-session.mjs`, `validation/chart-session-result.json`, `validation/check-chart-edits.mjs`, `validation/chart-edit-result.json`, `validation/chart-browser-trace.json`, `validation/chart-browser-result.json`, `validation/chart-phone-follow.json`, and `previews/ailegro-chart-*.png`.


## 2026-09-30 trained four-pillar v2 web audition

The `/four-pillar/` backend now loads the completed history512 v2 checkpoint (step 20134), with strict state/manifest and tensor compatibility checks, and runs the free event decoder. Homepage weights remain unchanged. Original 53 Node tests passed; two additional v2 input/prompt tests passed separately. Actual browser generation with prompt 0, seed 41977, temperature 0.95, tempo 96, all groups produced 53 continuation notes and zero resource closures. Audio rendered, native player entered playback, and WAV link became available. Desktop, 820px tablet and 390px phone layouts inspected in the in-app browser; not physical device testing. Synthesized audio is not a listening-quality verdict. All five prompts are training-source material for this v2 run.

## 2026-09-30 — Four-pillar v2 主页面连续接入与声部修复

主页改用本机 v2 检查点（step 20,134），沿用原演奏控件、两排和弦图表和音源。启动谱例明确区分和声、低音、旋律；采样约束避免缺少声部时提前结束小节。小节末起音不再产生零时长音符。没有重新训练或改变权重。

验证：Node 全套 58/58 通过；独立 chord-chart、chart-session、chart-edits 检查通过。Python performance 5/5、decode 5/5；新增次小节边界起音回归。真实检查点 Auto/Free 连续八小节，每小节都有三类声部、起音处于本小节内、时值大于零、资源收束为零；回滚第五小节并在第二拍后改和弦，此前 15 个音符完整保留。模型缓存的数值一致性检查见 inference-cache / performance 测试。

真实浏览器：主页播放推进至第 19 小节，Audio running、11 个活动音符，无停止错误；Auto / Free 可切换，Stop 可停止。手机 390×844、平板 820×1180 与桌面检查，无页面横向溢出。此处没有进行音乐质量盲听评价。实测自由模式每小节约 4.8–12.9 秒；浏览器最长单小节生成约 11.6 秒，因此持续续写已经生效，但当前 CPU 速度不保证无限无缝播放，耗尽缓冲时显示等待并继续。以上是新测试记录，不替代此前历史结果。

## 2026-09-30 — 网页推理交叉注意力缓存加速

仅修改 `four_pillar_v2_inference_cache.py`，缓存每层固定记忆的交叉注意力 K/V 投影。历史/和弦记忆或掩码改变时重新建立；不修改训练源、检查点、声部限制或采样温度。输出存在浮点舍入差异，随机采样边界附近可能产生不同曲段，不能宣称采样结果逐音相同。

CPU 两线程、192 维四层解码器、516 个记忆位置、1024-token 预填充后逐步增加 100 tokens，三轮受控基准：旧实现合计 0.855 秒，新实现 0.556 秒，解码器部分约 1.54 倍速度（耗时下降约 35%）。这是单组件基准，不是端到端生成加速比例。真实检查点 Hold 连续三小节生成约 2.77 / 1.96 / 6.55 秒，三类声部均存在、无资源收束；音符数量不同，不能用前次生成直接比较速度。performance 5/5、decode 5/5、缓存回归通过（包含记忆、填充掩码、时钟和前缀变化）。当前用户开始续训；训练与试听共享处理器，速度需在单独推理时再次评价。浏览器原标签已关闭，本次未重新启动浏览器播放；下次新建生成会话加载新缓存。

## 2026-10-01 — 中断续训模型快照试听

源 `four-pillar-v2-history512-continued-20260930/state.pt` 的 schema / manifest 哈希通过，结构严格加载兼容，权重均有限。源检查点为续训第 19,193 步、累计 37,594.385 秒，父检查点第 20,134 步。复制 state 与 manifest 到 `four-pillar-v2-preview-20261001-step19193/`，另存 PREVIEW.json 来源与哈希；主页和独立试听脚本均指向该静态快照，不修改源续训状态或优化器。主页模型说明更新续训步数。

真实快照 Hold 三小节检查：17 / 38 / 35 音符，每小节和声、低音、旋律均存在，时值为正、起音在本小节内、资源收束零，输出 checkpointStep 均为 19193。生成时间 2.06 / 2.30 / 3.13 秒（含首段启动），不同随机结果不能用于推断质量提升。Node 全套 58/58 通过。浏览器以 Auto / Every bar 准备八小节，保留用户乐器配置；旧权重仍在原目录。

浏览器播放确认：已推进第 11 小节，Audio running、24 个活动音符、已排程/生成均 11 小节，无停止错误；最长单小节生成约 8.43 秒。截图 `/tmp/ailegro-continued-preview-20261001.png`。吞吐仍可能耗尽缓冲并等待，未宣称连续无缝或主观质量提高。

## 2026-10-01 — 确定选择跳过推理与因果输入缓冲

主页 PerformanceCursor 先执行原有采样掩码；只剩一个合法答案时跳过模型调用，仍使用单项 multinomial 消耗相同随机状态。token、声部反馈和时间特征改为追加到预分配输入缓冲，窗口截断时重填，未新增 token 的末行时钟更新单独覆盖。没有改变训练脚本、权重、历史窗口长度、密度或声部采样约束。

真实 step19193 快照、seed41977、Hold 四小节，两轮优化前后逐条 payload 完全相同（音符、和弦、资源收束、检查点）。四小节总耗时均值由 15.380 秒降至 13.925 秒（减少 9.46%）；不计首段加载，后续三小节由 13.032 秒降至 11.504 秒（减少 11.73%）。样本小、共享 CPU 上的短测，不能推断所有种子/自由模式或长时间播放都有相同提速。报告：`training/reports/four-pillar-v2-fast-choice-benchmark-20261001.json`。

performance 6/6、decode 5/5、cache 1/1 通过。新增回归检查强制选择不调用模型并保持 RNG；输入缓存检查覆盖新声部、窗口截断，以及不加 token 的时钟变化。

加速版本浏览器已播放到第八小节，生成九小节，Audio running、34 个活动音符、无停止错误；保持 Auto/Every bar，截图 `/tmp/ailegro-speed-optimized-20261001.png`。当前演奏未宣称无缝。

## 2026-10-01 — 当前事件专用推理与规划解码省略

在推理缓存模块中增加 EventInferenceCache。原模型 forward 在条件变化时生成完整规划及记忆，随后只投影新增的因果反馈行、只计算当前事件的声部指针和表现输出，省去历史位置的声部输出及平方事件掩码的重复创建。额外原模型掩码或不支持的输入退回完整 forward。和弦规划保留完整 score/history/motif，只缩短不参与规划头计算的事件解码前缀；规划头独立性测试通过。只在主页 Python worker 开启；未改变训练文件、检查点、词表或上下文长度。

最终两轮真实 step19193 快照、seed41977、Hold 四小节：优化前平均 13.083 秒，最终实现平均 7.662 秒（耗时减少 41.44%）；不计首次加载，后三小节 11.044 秒到 5.693 秒（减少 48.45%）。两轮前后 payload 均完全相同，包括音符、和弦、时值与资源收束。中间版本测到约 44% / 54% 提速，仅作为过程测量；本节采用最后实现结果。短测有负载波动，不能推断所有模式或长时间无缝播放。报告 `training/reports/four-pillar-v2-event-cache-benchmark-20261001.json`。

performance 8/8、decode 5/5、cache 1/1 通过；新事件专用路径与原未缓存模型比对包含新增声部、时钟、256-token 窗口截断、速度条件和显式掩码退回。自由模式八小节及第二拍后的未来和弦编辑在中间事件缓存实现通过，三类声部均有生成且资源收束为零，编辑之前 12 音符完整保留。浮点计算布局不同，其他种子不承诺逐音相同，未据此宣称音乐质量提升。

最终实现再次跑完 Auto/Free 八小节和后缀编辑：起音均处于本小节内、时值为正、checkpointStep19193、无资源收束，三个声部均生成，编辑前 12 音符保留。实测各小节 2.63 / 2.75 / 3.79 / 3.74 / 5.57 / 6.24 / 6.42 / 9.58 秒，说明长历史的自由模式仍可能明显慢于音频时钟，不能把 Hold 四小节提速比例推广为所有模式的实时保证。

浏览器最终事件缓存版本已排程播放十小节，随后处于用户停止状态（last stop: Stopped by user），未自动恢复。当前仍在准备停止后的图表，最长生成段约 5.32 秒；截图 `/tmp/ailegro-event-cache-20261001.png`。

## 2026-10-01 — 乐器组角色状态栏

- `npm test`：**68/68 通过**。新增 `tests/group-roles.test.js` 8 项：典型织体、旋律 2/3、八度重复共用编号、一组多角色、同组两条旋律声部、v2 声部类型与纯织体判断的对比、延音与无效音符，以及 Session 的预览、跟随小节和中途开关。三个独立和弦谱脚本通过。
- `four_pillar_v2_performance.py` 只在返回音符中增加 `voice`。在隔离环境用同一 step19193 快照、种子 12345、Auto/Every bar 生成 5 小节：修改前后 175 个音符除新字段外完全相同。`training/tests/four-pillar-v2-performance.test.py` 8/8 通过。
- 隔离环境（Linux，torch 2.14.1 CPU，无头 Chromium）运行完整前后端和真实 v2 推理。点击 Play 后，状态栏标题随 `transport.frame` 从第 1 小节走到第 10 小节，角色每小节更新；Stop 后回到“正在准备下一小节”。1280、768、390 px（中英文）均无横向溢出；五个角色标签在 768 px 换行，行高不变。
- 用 5 段真实生成（每段 24 小节，Auto/Every bar 与 Auto/Free）离线统计：木管多为旋律 1（同组有第二条声部时为“旋律 1 · 旋律 2”），键盘多为和声，低音弦乐多为低音。不使用 v2 声部类型时，键盘高音区的和弦音常被判为旋律 1，所以对当前模型保留了这项提示。
- 没有在用户 Mac 的浏览器里重新试听。角色标签只描述音符，不代表音乐质量。
