# Cantelvio Compose 模型训练与数据

**四大件 v2 当前状态：** 训练前修订 2 已补齐长小节覆盖、来源和声/表现监督、四类条件任务、因果持续音状态、离线自由生成及完整恢复。58 项相关测试与 8 组真实资料无更新前后向检查通过，45,357 份 MIDI 内容指纹已冻结。当前启动脚本已按用户选择扩到 **512 小节摘要历史**（总参数 6,965,881，可训练 5,384,572），训练与离线生成使用同一配置；精细事件窗口仍为 2048 tokens。新输出目录为 `runs/four-pillar-v2-history512-20260930/`，当前默认训练 **11 小时**、每 5 分钟保存。上述 58 项是窗口扩展前的历史结果；扩展后 61 项测试、8 组真实资料预检及额外完整 512 小节真实谱资源检查均通过，证据见下方当前说明。**正式训练由用户自行启动，本次未代为运行。**仅预检可运行 `bash training/run_four_pillar_v2.sh --preflight`；正式启动、恢复与兼容检查点续训见 [v2 当前说明](FOUR-PILLAR-V2-TRAINING.md)。

此目录是自动伴奏与模型的开发入口。2026-09-27 起网页使用联合四轨模型；当前主页采用 `runs/joint-continued-expression-v1/` 的续训主干与表现层，以及 `runs/joint-continued-arrangement-v1/` 的六组分类器。旧 `runs/joint-v1/structured/` 权重与导出文件保留作历史对照。训练新模型默认写入 `runs/`，不会覆盖网页正在使用的模型。下面“已包含”中的和声、旋律脚本与检查点属于换模型前的版本，保留用于复现与对照。

**2026-09-30 更新：** 用户已结束并删除四大件 v1 全语料短程试训的 `state.pt`，旧初始权重未动。下一轮跨调／力度／速度／动机的独立代码和无更新预检见 [FOUR-PILLAR-V2-TRAINING.md](FOUR-PILLAR-V2-TRAINING.md)；尚未开始 v2 训练，也未接入网页。以下 v1 全语料命令为历史方案，不可从已删除的状态继续。

**四大件 v1 网络结构现已单独实现。** 代码与已验证/未完成的边界见 [FOUR-PILLAR-V1-IMPLEMENTATION.md](FOUR-PILLAR-V1-IMPLEMENTATION.md)。它保留旧四轨主干，另有四小节曲式规划、精确时间多声部事件、动态声部、和弦/动机条件及六组生成前约束。当前的全资料训练入口见下一段；较早的 `train_four_pillar_v1_pilot.py` 与 `train_four_pillar_trial.py` 只是小规模技术试训。新模型仍缺可靠的自由完整乐谱解码、全部四种条件任务训练和独立验证；不能直接部署到主页。

### 四大件 v1：全部现有真实语料，训练专用（2026-09-29 准备）

`scripts/four_pillar_midi_data.py` 固定了 SymphonyNet 旧预处理通过的 43,036 份，以及用精确 MIDI 时间重新试读后恢复的 **2,204 份**（旧网格排除 1,947、旧拍号词表排除 251、旧长度门槛排除 6）；另纳入当前 `data/MIDI-Library/` 的 117 份。`scripts/four_pillar_score_index.py` 索引 OpenScore Lieder 原先保留的 1,131 首和古典总谱候选的 303 份。合计 **45,357 份 MIDI 文件 + 1,434 份乐谱记录**，这些是来源记录数，不保证跨库作品唯一。SymphonyNet 另有 1,118 份旧版重复文件、2 份不足两小节的文件不进入此次续写训练。此训练**不读取** `synthetic-joint.npz` 中 10,112 段程序生成乐句、历史 145 份本地 MIDI 副本、被剔除的 MIDI-Library 项或“我的编曲&打谱/博士二阶段”。两份 Lieder 的 MusicXML 有越过小节起点的回退时值，索引构建时只在内存中把回退截到该小节起点；原始压缩包不变，修复记录保存在索引元数据里。

用户决定把这批现有资料**全部用于训练**，暂不从中设验证集；等另找独立新资料再评估。因此运行只报告训练损失和定期可恢复检查点，不产生 `best.pt`，不能据此评价泛化或听感。各库按来源加权抽样、库内洗牌遍历后才重复，避免 SymphonyNet contemporary MIDI 淹没较小的古典库，也减少重复抽到同一文件；但限时九小时仍不保证每份资料都被看过。MIDI 从原始文件按需读取，保留细时间和声部；缺失的谱面/和声/曲式/角色标签不假造监督目标。该入口首先训练自由续写及已知的速度、力度、配器信号，不等于四种条件任务全部训练完成。旧主页四轨模型只作为**部分参数初值**并有冻结的旧分支；对不能严格对齐旧网格的资料，不伪造旧模型上下文。网页权重不会被替换。

先作不更新权重的预检；完成后，明早由你运行九小时命令：

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python -B training/scripts/train_four_pillar_v1_all_data.py \
  --output-dir training/runs/four-pillar-v1-all-data-20260930 --max-seconds 32400 --preflight

# 确认预检正常后，去掉 --preflight；保持终端唤醒
caffeinate -i .venv-training/bin/python -B training/scripts/train_four_pillar_v1_all_data.py \
  --output-dir training/runs/four-pillar-v1-all-data-20260930 --max-seconds 32400
```

意外中断后，同一命令末尾加 `--resume`；只有相同资料与配置、现有 `manifest.json` 和 `state.pt` 匹配才会继续累计九小时。不要重复运行不带 `--resume` 的命令，也不要把该状态文件直接复制进网页。索引与成员清单已准备在 `data/four-pillar-score-all-train-v1.sqlite`、`data/four-pillar-midi-all-train-v1.json`；重新生成索引见两个脚本的 `--help`。测试入口：`.venv-training/bin/python -B training/tests/four-pillar-all-data.test.py`。

`sample_four_pillar_v1_preview.py` 为独立 `/four-pillar/` 页面提供**受约束试听**：验证谱前两小节作提示，只从此前已听过的小节复制节奏/时值骨架，试训权重采样随后两小节的声部指针与音高。艺术歌曲可以开关第一段生成小节的旧四轨先验；两种模式都保留移植到新解码器的 H/M 权重。这不能代替真正的自由事件解码，也不能据此评价完整曲式、节奏生成或正式全语料泛化。没有覆盖当前网页权重。

### 四大件 v1 源对齐短程试训（非正式模型）

`four_pillar_v1_alignment.py` 对固定提交的 OpenScore Lieder 乐谱和旧 R/H/B/M 网格逐小节核对精确时间；不一致即拒绝，且旧先验只读目标小节以前的窗口。`four_pillar_v1_pilot_data.py` 默认取 8 首来源对齐的 Lieder 训练、2 首验证，另加原有临时筛选的 20 首古典谱训练、3 首验证。古典谱无可信旧四轨对齐，明确以 `NO_PRIOR` 训练精确事件与曲式目标；所有样本仍使用同一个四大件 v1 网络。源标注缺失的目标保持 mask；未来和弦只用作目标，不作为自由续写输入。这个小集不足以证明听感或泛化能力，也不替代跨库去重、许可复核及正式划分。

先做只读、无优化器更新的预检：

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/scripts/train_four_pillar_v1_pilot.py \
  --output-dir training/runs/four-pillar-v1-pilot-20260929 --max-seconds 300 --preflight
```

若明确启动五分钟试训，去掉 `--preflight`；仅写新的 `training/runs/four-pillar-v1-pilot-20260929/`，保存 manifest、完整状态与优化器、最佳内部验证权重和分项日志。意外停止只能以相同参数加 `--resume` 恢复累计计时；不能拿它直接替换网页权重或当作先前约定的十小时正式训练。测试包括 `four-pillar-v1-alignment.test.py` 及其余 `four-pillar-*.test.py`。

下一代作曲模型的**可实施 v1 设计规格**见 [FOUR-PILLAR-V1-SPEC.md](FOUR-PILLAR-V1-SPEC.md)，目标与已有工作的背景见 [FOUR-PILLAR-COMPOSITION-ARCHITECTURE.md](FOUR-PILLAR-COMPOSITION-ARCHITECTURE.md)：以和声、复调、曲式、配器为基本能力，并为将来的创作目标、给定旋律／动机／和弦输入预留统一条件接口。`runs/four-pillar-bootstrap-v0/init.pt` 已严格继承当前四轨主干，并部分继承兼容的表现与配器头；`scripts/score_events_v2.py` 可无时间量化地读取全部 303 首候选古典谱。**目前只有隔离的四大件技术试训入口，不是正式 v1 训练**：旧权重可部分移植为事件模型初值，但完整 R/H/B/M 先验尚未桥接；给定和弦与硬锁定解码、完整去重/许可审计、速度目标仍待实现。新能力未接入网页，主页权重不变。

### 四大件技术试训（不替代正式模型）

`scripts/four_pillar_codec.py` 保留有理数起音/时值、声部、六组/角色及可用谱面表现；`scripts/four_pillar_split.py` 从 `classical-score-v1` 作暂定的作品/作曲家隔离小样本；`scripts/four_pillar_trial_model.py` 包含因果小节规划器与多声部事件解码器；`scripts/train_four_pillar_trial.py` 提供限时保存/恢复。加 `--init-from-legacy` 后，`scripts/four_pillar_legacy_init.py` 从当前网页四轨主干的原始 PyTorch 检查点逐值移植 H/M 的 4 层注意力、前馈和层归一化块，并以训练过的调性向量初始化 12 音级的小节输入，共 699,392 个参数值；剩余事件词表、曲式规划器、交叉注意力等从新权重开始。**这不是完整旧模型继续训练**：R/B 分支、旧四轨生成过程和旧输出词表未接入，旧模型也不会在新事件模型推理时运行。不加该选项仍为纯随机试训。两种方式均无完整的受约束自由生成器。验证损失只用于技术检查，不代表音乐品质或四大件训练完成。仅纳入预选的 20 首训练、3 首内部验证候选谱；不引入已排除的本地 MIDI。S3 逐文件的发布权利与全库近重复尚未复核，不要把试训检查点发布或导出网页。

先做只读预检：

```bash
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/scripts/train_four_pillar_trial.py --output-dir training/runs/four-pillar-trial-legacy-5min-20260929 --technical-smoke --init-from-legacy --preflight
```

如果明确要跑**五分钟技术试训**，去掉 `--preflight` 并加 `--max-seconds 300`；程序输出到该独立目录，记录 `manifest.json`、`state.pt`、`best.pt` 和 `metrics.jsonl`。同一目录仅用 `--resume` 恢复（累积计时，不会另外再跑五分钟），不可把它当成正式模型或网页权重。若要重新试训，另建新的输出目录，不覆盖旧记录。测试：`training/tests/four-pillar-*.test.py`。

精确节奏与力度的早期冻结主干实验见 [JOINT-EXPRESSION-TRAINING.md](JOINT-EXPRESSION-TRAINING.md)：原始 MusicXML 中的准确起音、时值、三／五／六／七连音及谱面力度已提取为新训练数据。当前继续训练的完整入口是下一段的 `JOINT-CONTINUED-TRAINING.md`；所选表现层与六组配器分类器已接入主演奏页基础版。余下验证与改进见 [../frontend/MODEL-INTEGRATION-ROADMAP.md](../frontend/MODEL-INTEGRATION-ROADMAP.md)。

已完成 [JOINT-CONTINUED-TRAINING.md](JOINT-CONTINUED-TRAINING.md) 的两阶段训练：从旧四轨权重出发，继续训练四轨主干与表现层 4 小时，再用更新后的音高表示初始化六组配器候选层并训练 4 小时。三段选中权重已分别导出到浏览器运行时；主页只使用续训主干，旧权重仍作历史备份。六组层只分类已有音符，不是新的多声部生成器；听感和设备验证仍待完成。此前冻结主干的 [JOINT-ARRANGEMENT-TRAINING.md](JOINT-ARRANGEMENT-TRAINING.md) 保留作对照。

另有私用的历史 MIDI 副本 `data/local-midi-curated-v1/`（145 份），保留原始哈希清单，但**不再代表已批准的训练选集**。2026-09-29 复核后的可见目录 `data/MIDI-Library/` 保留 117 份；排除理由和 013 文件的用户改名见 `data/midi-library-curation.json`，其中 9 份可从 `data/MIDI-Library-Excluded-20260929/` 直接移回，另 19 份是用户手动移除且不予自动恢复。今后如果要训练配器层，明确把 `--local-root` 指向 `training/data/MIDI-Library/`，训练脚本会按其 `manifest.json` 校验文件与原始路径；不要再用历史 145 份目录或原始 iCloud 根目录，否则排除内容会重入。现有 `run_joint_continued.sh` 是历史训练入口，仍指向原始 iCloud 根目录；本次没有重训或变更网页权重。这些副本未核实再分发授权。

2026-09-29 另下载了三个固定提交版本的古典乐谱原始库：OpenScore Orchestra / Hauptstimme、OpenScore String Quartets 和 S3 Symbolic Symphony Set。压缩包及来源、SHA-256、许可区别记录在 [`data/sources/CLASSICAL-CORPORA.json`](data/sources/CLASSICAL-CORPORA.json)。已生成保留精确时值、拍号、连音、谱面力度、乐器组及可用角色标注的 [`data/classical-score-v1/`](data/classical-score-v1/README.md) 候选语料，并完成初步解析、去重、质量与旧 SymphonyNet 作品名重叠检查；**尚未接入旧训练脚本，也未分配新的训练／验证／测试划分**。后续仍需按任务映射到模型表示、处理异常小节与缺失标签，排除旧测试作品重叠后才可训练。原始包只保留一份，没有额外解压副本；网页权重未改动。

速度与力度的下一轮准备见 [`PERFORMANCE-TEMPO-V2.md`](PERFORMANCE-TEMPO-V2.md)：独立候选标注 `data/performance-labels-v1/` 保留原谱明确数值 QPM、MusicXML 数值力度以及原 MIDI 的显式速度事件；按来源区分，缺失值不填成监督目标。下一版拟从当前主页主干出发，学习速度条件与可选的模型驱动速度游走，同时扩展力度表达；**尚未训练或接入网页**。


## 管弦乐模型（2026-09-28 起开发）

下一版改用通用 Transformer，生成 6 个乐器组（木管、铜管、打击乐、竖琴/键盘、高音弦乐、低音弦乐）的管弦乐，每小节由模型或用户决定哪些组演奏。音高用旋转编码，模型对 12 平均律下的整体移调严格等变，训练时另做移调增强。代码、Mac 上的一条命令流程与设计都在 [orchestra/](orchestra/README.md)，设计见 [orchestra/DESIGN.md](orchestra/DESIGN.md)。

## 联合四轨模型（2026-09-27 起网页使用）

设计与决策记录见 [JOINT-MODEL-DESIGN.md](JOINT-MODEL-DESIGN.md)。这个原型把伴奏节奏 R、和声 H、低音 B、旋律 M 四条轨放进一个模型一起训练。每个十六分步按 R→H→B→M 的顺序生成，不让任何一轨提前。网页使用的是 `runs/joint-v1/structured/model.pt`，导出与对照测试见下方“导出到网页”。

- 处理后的四轨语料已放在 `data/joint/`：
  - `lieder-joint.npz/.json`：OpenScore Lieder 共 1,131 首，和声取自语料自带的 AugmentedNet 分析。
  - `synthetic-joint.npz/.json`：由现有语法和 App 的伴奏规划器生成的 10,112 个乐句。
- 构建合成数据时调用的规则伴奏规划器已随旧运行时移到 `../archive/pre-joint-runtime-20260927/src/planner.js`，`render_joint_accompaniment.mjs` 已改为从那里导入，重建结果与之前相同。构建数据还需要 `music21`（读乐谱）和 Node。导出 MIDI 需要 `mido`。请用项目环境安装：`.venv-training/bin/python -m pip install music21 mido`。

从 Cantelvio Compose 根目录运行：

```sh
# 可选：从原始乐谱重建四轨语料（原始包需先解压到 data/sources/extracted/）
.venv-training/bin/python training/scripts/build_joint_lieder.py \
  training/data/sources/extracted/OpenScore-Lieder training/data/joint/lieder-joint.npz
.venv-training/bin/python training/scripts/build_joint_synthetic.py training/data/joint/synthetic-joint.npz

# 因果性（信息泄漏）测试
.venv-training/bin/python training/tests/joint-causality.test.py

# 训练：结构化模型，以及两个通用基线（加 --resume 可从每 200 步保存的状态断点续跑）
.venv-training/bin/python training/scripts/train_joint.py --model structured --output-dir training/runs/joint-v1/structured
training/run_baselines.sh   # 两个通用基线依次训练；环境重启后再运行一次即可接着跑

# 评估、单独测速、训练曲线、报告表格、试听样例
.venv-training/bin/python training/scripts/evaluate_joint.py training/runs/joint-v1
.venv-training/bin/python training/scripts/benchmark_joint.py training/runs/joint-v1   # 机器空闲时运行
.venv-training/bin/python training/scripts/plot_joint_curves.py training/runs/joint-v1
.venv-training/bin/python training/scripts/summarize_joint.py training/runs/joint-v1
.venv-training/bin/python training/scripts/sample_joint.py training/runs/joint-v1/structured/model.pt training/runs/joint-v1/samples

# 盲听：两个检查点用同一开头、同样的采样规则各自续写（见 runs/joint-v1/blind/README.md）
.venv-training/bin/python training/scripts/blind_joint.py training/runs/joint-v1/structured/model.pt \
  training/runs/joint-v1/flat-params/model.pt training/runs/joint-v1/blind/blind-data.json
```

最终结果见 [runs/joint-v1/REPORT.md](runs/joint-v1/REPORT.md)：参数量相同的通用 Transformer 训满后与结构化模型一样好（验证 1.783 对 1.784），盲听 3 : 3 : 2；结构化模型每步快一倍多、推理计算量约为三分之一。下一版改用通用架构。Lieder 的测试集（sha256(歌曲目录) % 10 == 1）只用于最终报告，不参与训练或选择检查点。

### 导出到网页

```sh
.venv-training/bin/python training/scripts/export_joint_js.py training/runs/joint-v1/structured/model.pt \
  vendor/lib/joint-weights.js tests/fixtures/joint-parity.json
npm test
```

脚本同时写出 float32 权重（含检查点 SHA-256 与训练信息）和 PyTorch 对照 logits；`tests/joint-model.test.js` 用后者检查浏览器推理。更换权重时，请同时更新 `../VENDOR_MANIFEST.json` 与 `../vendor/JOINT-MODEL-NOTICE.txt`，并在浏览器里试听。

## 已包含

- `scripts/train_harmony.py`：4 层、8 头和声 Transformer，204,391 参数；完整原创合成乐句生成器、训练、验证和 JavaScript 导出。
- `scripts/train_melody.py`：4 层、8 头旋律 Transformer，349,325 参数；合成乐句、真实乐谱表示、训练、验证和导出。
- `data/chord-qualities.json`：训练使用的和弦类别顺序。更改它时，必须同步考虑运行时词表和权重的兼容性。
- `data/openscore-cc0.json`：135 份处理后乐谱记录。按模型表示筛选后，训练使用 116 部作品的 899 个片段，验证使用 15 部作品的 150 个片段。
- `data/sources/OpenScore-Lieder-38c5db5.tar.gz`：固定提交版本的完整原始源码树，包含原始乐谱、元数据和许可证，不包含 Git 内部数据库。`SOURCE.json` 记录源仓库、完整提交号及压缩包 SHA-256。
- `checkpoints/melody-v5.pt`：原有旋律模型的 PyTorch 参数检查点。
- `checkpoints/harmony-from-browser-v2.pt`：从当前网页部署权重重建的和声 PyTorch 参数检查点，保留导出精度；它不是原始优化器状态。
- `reports/`：历史训练/验证记录、当前独立校验与评估结果。
- `legacy/` 与 `../archive/tonnetz-v91/`：旧演示模型、原始脚本和 Tonnetz 集成的历史快照。后续开发使用本目录中的新入口，不继续修改这些快照。

模型参数检查点不含 AdamW 优化器状态。训练脚本默认从头训练；如需从现有权重微调，应显式添加或采用 `load_state_dict`，并记录新的训练方案与验证结果。

## Python 环境

这台电脑已有的 PyTorch 环境已归入项目根目录 `.venv-training/`。从 **Cantelvio Compose 根目录**执行：

```sh
.venv-training/bin/python training/scripts/check_training.py
.venv-training/bin/python training/tests/training-corpus.test.py
```

该环境使用本机已安装的 Python 3.11。虚拟环境不是跨机器分发格式；复制到其他电脑后，请创建项目专用 Python 3.11 环境，再通过该环境的 Python 安装 `training/requirements-lock.txt`。不要安装到系统或 Anaconda base。锁定版本记录了当前已工作的 PyTorch 2.14.0 和 NumPy 2.4.6 环境；平台支持情况由目标机器确认。

## 重新训练

```sh
.venv-training/bin/python training/scripts/train_harmony.py \
  --steps 1600 --output-dir training/runs/harmony-experiment

.venv-training/bin/python training/scripts/train_melody.py \
  --steps 1500 --corpus training/data/openscore-cc0.json \
  --output-dir training/runs/melody-experiment
```

输出包括 JavaScript 权重、PyTorch 参数和训练元数据。不要用低步数试跑的结果直接替换网页权重。先核对模型/词表兼容性、导出探针、回归测试和实际声音，再有意更新 `vendor/lib/` 与对应清单。

## 从原始乐谱重新生成数据

在 Cantelvio Compose 根目录：

```sh
mkdir -p training/data/sources/extracted
tar -xzf training/data/sources/OpenScore-Lieder-38c5db5.tar.gz \
  -C training/data/sources/extracted
.venv-training/bin/python training/scripts/prepare_openscore.py \
  training/data/sources/extracted/OpenScore-Lieder \
  training/runs/rebuilt-openscore.json \
  --source-commit 38c5db510224d9facdc4b08d741fc788cfb58ea8
```

源乐谱为 CC0。真实和弦与调性标签来自推断；重复段未展开，不支持的拍号、复杂节奏、多声部旋律等会被排除。训练/验证按作品划分，并去除转调后的精确旋律重复。保留 `data/sources/` 和 `../vendor/MELODY-DATA-NOTICE.txt` 中的来源与限制说明。

和声语料，以及旋律的合成语料，由脚本中的固定随机种子和乐句生成器重建，不另依赖外部数据文件。

## 评估

```sh
.venv-training/bin/python training/scripts/evaluate_melody.py
node training/scripts/evaluate_rollouts.mjs
npm test
```

`evaluate_melody.py` 在真实验证作品的相同前 64 个事件上评估检查点。`evaluate_rollouts.mjs` 测量当前浏览器旋律演奏器的自由生成行为，也可传入另一个完整演奏器模块的绝对路径作比较。旧 v4 逐版本比较脚本保存在历史快照中。

验证集曾参与模型选择，不是未使用过的最终测试集。预测损失和生成结构指标不等于好听程度，仍需要试听与演奏评价。此次目录整理仅恢复和验证训练能力，没有重新训练或替换正在使用的模型。

### ALICE 迁移准备（2026-10-01）

从完整 v2 检查点开始新训练时，`--init-checkpoint` 现在按相邻 `manifest.json` 的结构与旧模型配置构建网络，再严格加载完整权重；该路径不再读取历史 `best-base.pt`。冻结 R/H/B/M 模块仍保留，优化器、抽样和计时重置。从头初始化的旧路径不变。代码变更后，不要把旧运行直接按精确 `--resume` 恢复；新运行后续恢复保留相同参数与父检查点。

必要材料包与逐文件清单在 `alice-preparation/`。验证：当前试听快照 507 个张量逐项一致、无历史检查点读取、冻结先验与架构拒绝检查通过；10 项 v2 训练回归通过。ALICE 端环境和计算节点验证尚未完成。现有入口使用 CPU，额外 MIDI 依赖为 `symusic==0.6.0`；不包含本机虚拟环境。

## Streaming event architecture experiment — 2026-10-01

The current v2 preview remains step 19193. Its planner memory enters every decoder
layer; changing that memory requires refeeding historical causal states. Its score
grammar also needs roughly a dozen serial token choices for one note. Runtime KV
and event-input caching reduce that cost but cannot remove either structural cause.

`experiments/streaming_event_model.py` is an **untrained, isolated prototype**:

- A causal event backbone uses rotary positions with a monotonically increasing
  session position and a bounded sliding K/V window. Window eviction does not
  renumber past positions. A complete musical event advances the backbone once.
- A slow planner should update at bar/phrase boundaries from the existing 512-event
  summaries. The prototype accepts its vector as an input; the planner and its
  training objective are not implemented yet. Plan conditioning occurs in event
  heads, outside the cached backbone, so a future plan edit cannot invalidate past
  K/V. Past plan/control context belongs in each committed event's input features.
- Group selection precedes group-conditioned pitch, exact-time code, duration,
  velocity and event-kind heads. Attribute heads need either small conditional
  adapters or joint loss/masks for dependencies such as onset/duration. Six groups
  are native identities, never role-based remapping. Drum identity is explicit;
  current v2 console drops unpitched notes without drum identity rather than
  inventing bass-drum/snare/hi-hat events.
- Production conversion must retain rational time dictionaries (including tuplets),
  voice identity/ties, same-onset polyphony, zero-onset continuation, and a separate
  end-of-onset event. Do not advance the clock until the onset is complete. The
  prototype's 65 time classes and 32 event features are placeholders, not a corpus
  schema. Hold, Every bar, Free and group controls remain sampling masks; planning,
  generation and audio scheduling stay separate.

Three tests in `tests/streaming-event-model.test.py` establish full/incremental
parity across cache eviction, causal independence from future events, and unchanged
backbone caches under changing plans. They do not establish speed, music quality or
training compatibility. This is a different parameter layout: strict-loading v2
weights is unsupported. A new dataset adapter, objectives, trainer, provenance and
held-out evaluation are required before training/deployment. Keep any new runs
separate; the current v2 resume command and its training-source hashes are intact.
Acceptance should include long-session bar latency below the playback budget at
92 BPM (2.61 s per 4/4 bar), musical listening comparison, all six group contracts,
exact-time/pitch audits and edit/Stop cancellation under load.

## V3 migration and training entry (2026-10-01, supersedes prototype-only status)

The separate candidate is `scripts/four_pillar_v3_model.py`: width 192, six heads,
four rotary event decoder layers, three past-bar planner layers, 512 past summaries
and a sliding cache of 256 complete events. It has **5,348,187 trainable parameters**.
Pure FP32 tensor payload is 21,392,748 bytes; the saved `weights.pt` is 21,434,627
bytes (21.43 MB / 20.44 MiB). AdamW training checkpoints are approximately 64.47 MB
after optimizer state exists. The initialized step-zero checkpoint is smaller
because no optimizer moments have been created.

The existing v2 step-19193 weights initialize 3,253,434 parameters (60.83% of v3).
Transferred tensors include the planner, self-attention, feed-forward layers,
normalization, native group rows, sounding MIDI pitch rows and harmony heads.
Cross-attention to changing memory, old absolute decoder positions and the frozen
legacy teacher are omitted. Equal tensor dimensions do not prove equal behavior:
RoPE, packed event inputs and new timing/expression heads need further training.
This is **partial weight initialization with a fresh optimizer**, never an exact
v2 resume. No long training or webpage replacement has been launched.

`four_pillar_v3_data.py` uses the five existing approved training sources. Numerators
and denominators retain exact unsigned byte representations (up to the existing
10-byte wire limit), rather than a restricted rhythmic grid. Whole notes advance
the backbone once; small attribute heads predict bytes, group, voice, pitch,
duration, onset delta, MIDI velocity, source dynamic/accent/wedge, event kind and
source-supported harmony. Unknown groups use a separate conditioning row and no
group supervision; unknown labels stay masked. Explicit drum MIDI identities are
recovered from original drum tracks, with source-index parity checks. No drum
identities are guessed from score staff placement. Dense target bars sample
beginning/middle/end chunks rather than always training their last events.
Grace notation lacking a performed-timing label is excluded from this event task.

Prepared step-zero migration: `runs/four-pillar-v3-ready-20261001/`. Start it yourself:

```sh
.venv-training/bin/python -u training/scripts/train_four_pillar_v3.py \
  --output-dir training/runs/four-pillar-v3-ready-20261001 \
  --resume --max-seconds 39600 --threads 4
```

Use the same command after interruption. `--max-seconds` is cumulative saved
training time, not extra time per invocation. V3 permits increasing that budget
without changing model/data config. Its exact resume restores optimizer, RNG and
source-cycler state; changes to hashed training code or sources deliberately fail
resume. A new run can initialize from either v2 or compatible v3 `state.pt` using
`--init-checkpoint` and a fresh output directory, resetting optimizer/sampling.

To create a new migration directory rather than use the prepared one:

```sh
.venv-training/bin/python -u training/scripts/train_four_pillar_v3.py \
  --output-dir training/runs/four-pillar-v3-new-run \
  --init-checkpoint training/runs/four-pillar-v2-preview-20261001-step19193/state.pt \
  --max-seconds 39600 --threads 4
```

Diagnostics after training use `four_pillar_v3_sample.py --checkpoint <weights.pt>
--bars 8 --output <file.json>`. This bounded sampler checks event/cache contracts;
it does **not** yet implement the complete console adapter, active-note/tie state,
Hold/Every bar/Free/edit suffix policy or user-material tasks. It is not connected
to the webpage. These are explicit remaining integration gates for Claude, along
with independently held-out evaluation and musical listening. Do not deploy the
short smoke-test weights as a finished model or promise uninterrupted realtime
music from structural tests. Current v2 training code/checkpoints remain unchanged.

## 四大件 v3.1：调内相对音高的新版本（2026-10-01，不改动 v3）

> 2026-10-02：已训练完成（`training/runs/four-pillar-v31-ready-20261001`，第 45,225 步，7 小时 30 分，CPU）。下文“尚未训练”等描述是训练前的记录。拆分与作曲任务见本文末节。

v3.1 针对作曲“四大件”（和声、复调、曲式、配器）重写了 v3 的编码、属性解码和输出层，参考了此前和弦、旋律效果都不错的联合 R/H/B/M 小模型（调内相对编码、先和声后低音与旋律、动机参考）。**5,014,967 个参数**（v3 为 5,348,187），`weights.pt` 约 20.1 MB，带 AdamW 状态的 `state.pt` 约 60.5 MB。**从随机初始化开始训练**（用户 2026-10-01 决定；同一批窗口的短跑对照中，v2 部分初始化的总损失不如从零开始，音高略好但起音和时值更差；v2 迁移路径已删除），默认学习率 1e-3。尚未训练，没有建立运行目录，也没有接入网页；v2/v3 的代码、清单和运行目录都未改动。

**音高编码（主调 + 相对主调的相对音）**：每小节都有局部调（主音、大小调）。音高进出模型时都是相对主音的编号：`编号 = 音高 − tonic_ref(主音) + 65`，`tonic_ref` 把主音放在 MIDI 54–65；还原是精确逆运算 `音高 = 编号 − 65 + tonic_ref`，所以播放的就是模型选的音，不折叠、不替换。同一旋律在 C 和 D 调的编码相同；绝对音区另由“发声八度”输入和输出项保留（乐器音域）。和弦根音同样相对主音。

**调与和弦标签**（估计值，不是真值，规则随代码哈希进入清单）：
- 调：所有来源用 `four_pillar_v31_tonal.KeyTracker`（每小节音级时值直方图、每个起音的最低音×1.5、由 Lieder 与 AugmentedNet 局部调统计出的调式轮廓、乐谱调号小幅加分、按五度圈距离计代价的 Viterbi 平滑）。在 187 首留出 Lieder 上与 AugmentedNet 逐小节一致 78.6%（调号相同 82.9%）。
- 和弦：已对齐的 Lieder（937/1,131 首）用 AugmentedNet 标注；其余来源用 `ChordTracker`（按拍分段、9 种和弦性质、低音与调内先验、Viterbi）。在留出 Lieder 上逐拍根音一致 75.9%，根音+性质一致 67.0%。

**结构**：
- **事件**：音符、和弦变化、小节结束各占主干一步。和弦变化排在同一起音的音符之前；同一起音内先无音高打击乐，再从最低音往上（低音先于旋律）。
- **属性顺序**：事件类型 → 小节内起音位置（REMI 式，训练时也只在合法范围内计分）→ 和弦：根音 → 性质；音符：乐器组 → 声部 → 音高 → 时值 → 力度/表情。和弦头只在和弦行、音符头只在音符行上计算。
- **和声**：当前和弦进入每个音符的输入与解码状态，每个音符还输入它相对和弦根音的音程；音高先验包括和弦相对项、和弦音项、正在发声的音级与低音级、大小调音阶项；调与转调步进是小节条件，下一小节的调是规划器目标。
- **复调**：64 个声部槽指针选择；音高以该声部上一个音、它上一次的走向（音程）和按乐器组区分的音程先验为条件。同一声部在曲中换了乐器组时开新声部（与生成一致；修复了 13 个交响乐声部的目标被声部掩码排除的问题）。
- **曲式**：
  - 因果规划器读取最多 511 个已完成小节的调内摘要：音级、乐器组、密度、平均音高、大小调、主音步进，以及每小节的节奏型（16 格）、最高声部与低音的音级分布、乐句位置。规划器按“相隔几个小节”做旋转编码；生成时每小节只算一步，用缓存，不再重算 511 个小节。
  - **参考小节（曲式记忆）**：乐谱中约 40% 的小节与前面某小节调内相似（Jaccard ≥ 0.5），22% 几乎完全重复，很多在 100 小节以前，超出 512 事件的注意力窗口。训练时每小节的参考是之前最相似的小节（或无）；指针从规划器的小节状态中学会选它；解码器读取对齐的参考音（参考的下一个起音、同一起音同一顺序那个音的乐器组、音高、时值，以及参考在此起音的音级），既作输入，也作可学习的复制偏置。训练时 20% 的参考被随机去掉；生成时由指针选择（`reference='auto'`），也可以指定某个之前的小节或不用。
  - 注意力按事件序号、音乐时间（四分音符）、拍内与小节内相位做旋转编码；数据中没有段落标签。
- **配器与风格**：六个原生乐器组；“请求的乐器组”和“密度”是学到的小节条件（训练时各 50% 随机去掉），生成时同时作为硬掩码；另有语料风格条件（训练时 30% 去掉）。
- **时值**：冻结的 384 个精确分数（`data/four-pillar-v31-time-vocab.json`），乐谱三连音、五连音等原样保留。
- **训练**：每步 8 个 512 事件窗口；窗口前最多 16 小节、最多 384 个事件的预热（密集管弦乐不再处理上千个被丢弃的事件）；按步预热后按已保存训练时间余弦下降；默认样本进程数 = CPU 核数 − 2（最多 6），结果与进程数无关；严格续训。
- **生成**：融合推理核加 Gumbel-max 精确采样；音高可用 top-p（`--top-p`，只作用于音高）。采样器支持指定调、保持调或由模型选调，free / hold / bar / 锁定和弦，风格条件，以及参考小节（`--references auto|none`）。

**同一台云端机器上的对比**（与上一版 v3.1 相比；这台机器速度波动约 ±20%）：

| | 上一版 v3.1 | 本版 |
|---|---:|---:|
| 参数 | 4,897,310 | 5,014,967 |
| 训练前向+反向，8 个窗口（2 线程） | 1.90 秒 | 1.62 秒 |
| 生成 128 个音符的小节（1 线程） | 0.86 秒 | 0.99 秒 |
| 同上，已有 511 小节历史 | 1.01 秒 | 0.94 秒 |
| 240 步短跑（从零、学习率 1e-3、同一批窗口）最后 50 步：起音 / 音高 / 时值交叉熵 | 0.873 / 2.602 / 1.181 | 0.699 / 2.433 / 1.131 |

92 BPM 4/4 每小节可用 2.61 秒。240 步只是早期迹象，不能证明长训练后的效果或音乐质量；乐器组、声部、和弦根音与性质的损失也都略低，总损失相同是因为本版多了参考指针这一项目标。

**开始训练（推荐）**：在“终端”里进入 Cantelvio Compose 文件夹，运行一个脚本；默认训练 7 个半小时（整个过程约 7 小时 40 分）。

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
bash training/train_four_pillar_v31.sh          # 开始；中断后再运行同一命令，会从最近的保存点接着训练
bash training/train_four_pillar_v31.sh status   # 进度、损失、剩余时间
bash training/train_four_pillar_v31.sh log      # 接着看日志（Ctrl-C 只是不再显示）
bash training/train_four_pillar_v31.sh stop     # 当前一步结束后保存并停止
bash training/train_four_pillar_v31.sh sample   # 用当前权重生成 3 段试听 MIDI
```

脚本依次做：35 项单元测试 → 预检（每个数据来源都取窗口做前向+反向；有 Apple GPU 时比较它与 CPU 的速度和结果，损失与梯度范数一致且快 20% 以上才用 GPU）→ 建立第 0 步（`training/runs/four-pillar-v31-ready-20261001`，随机初始化）→ 训练 7 小时 30 分（`--max-seconds 27000`，每 10 分钟保存一次）→ 生成 3 段 16 小节的试听 MIDI（管弦乐 C 大调、钢琴 a 小调、现代管弦乐 D 大调并由模型转调）。训练在后台的独立进程组里进行，`caffeinate` 防止 Mac 睡眠：关掉终端或按 Ctrl-C 都不会中断训练（请接上电源，不要合盖）。训练进程出错时自动从最近的保存点续训（GPU 出错改用 CPU），最多重试 3 次。日志、设备选择、预检结果和试听 MIDI 在 `training/logs/four-pillar-v31-ready-20261001/`。`AILEGRO_V31_HOURS` 改训练的小时数（默认 7.5；开头的检查和最后生成试听另需约 10 分钟）；训练开始后改大再运行，会以最低学习率接着训练。`AILEGRO_V31_DEVICE=cpu|mps` 跳过自动选择。

手动运行的等价命令（第 1、2 步不写运行目录）：

```sh
# 1. 单元测试（35 项）
.venv-training/bin/python training/tests/four-pillar-v31.test.py

# 2. 预检：一个训练批次（每个来源至少一个窗口），前向+反向，不更新权重；加 --device mps 时同时计时 CPU 并比较结果
.venv-training/bin/python -u training/scripts/train_four_pillar_v31.py \
  --output-dir training/runs/four-pillar-v31-ready-20261001 --preflight --device mps

# 3. 建立第 0 步运行（随机初始化）
.venv-training/bin/python -u training/scripts/train_four_pillar_v31.py \
  --output-dir training/runs/four-pillar-v31-ready-20261001 \
  --initialize-only --max-seconds 27000

# 4. 训练；中断后用同一命令继续（--device mps 只在第 2 步显示结果一致且更快时使用）
.venv-training/bin/python -u training/scripts/train_four_pillar_v31.py \
  --output-dir training/runs/four-pillar-v31-ready-20261001 \
  --resume --max-seconds 27000 --threads 8
```

`--max-seconds` 是累计的已保存训练时间。余弦学习率按第一次给定的预算展开；以后加大预算会以最低学习率继续，不会重新升温。线程数、进程数和设备不进入清单，可在续训时改变。MPS 不支持 float64，训练批次里的旋转相位（相对窗口起点）在 GPU 上以 float32 传入，CPU 上保持不变。`metrics.jsonl` 的 `dataWaitSeconds` 若接近 `stepSeconds`，说明样本准备跟不上，可加大 `--workers`（脚本里用 `AILEGRO_V31_WORKERS`）。`--threads 1` 时续训与不中断的训练逐位一致。

训练后的诊断生成（脚本的 `sample` 命令会自动做，并转成 MIDI）：`.venv-training/bin/python training/scripts/four_pillar_v31_sample.py --checkpoint training/runs/four-pillar-v31-ready-20261001/weights.pt --bars 16 --key Am --chord-mode free --output /tmp/v31-bars.json`（`--model-keys` 让模型自己转调，`--references none` 关掉参考小节）。`Composer.feed_bar()` 用与生成完全相同的路径写入提示或锁定的前缀；`next_bar(reference=小节号)` 让新小节参考指定的小节，供日后的网页适配器使用。`training/scripts/four_pillar_v31_midi.py --input 样例.json --output 样例.mid` 把采样结果转成标准 MIDI：按乐器组和音高中位数选 General MIDI 音色（长笛/双簧管/单簧管/大管、小号/圆号/长号/大号、钢琴、小提琴/中提琴、大提琴/低音提琴、定音鼓），无音高打击乐用鼓通道和原鼓键，调与和弦写成标记；音高原样写出。它不被训练进程导入，以后修改不影响续训。

证据：`reports/four-pillar-v31-preparation-20261001.json`（含全部文件哈希）。云端沙箱（Python 3.11.15、torch 2.14.1，本机为 torch 2.14.0）中 35 项测试通过，包括训练前向与生成路径逐个属性的 logits 一致（含参考小节输入、复制偏置和指针）、融合推理核与训练模块一致、规划器逐步计算与整段计算一致、音高编码精确还原、续训逐位一致；全部 1,434 首乐谱各 2 个窗口构建零错误、零越界、零被掩码排除的声部目标。启动脚本在云端用短预算测过：完整流程（测试 → 预检 → 第 0 步 → 训练 → 试听 MIDI）、Ctrl-C 只停止显示、训练进程被杀后自动续训、`stop` 保存后再开始从下一步连续训练、训练进程启动阶段与检查阶段的 `stop`、不完整的第 0 步目录、强制 GPU 但不可用时退回 CPU；macOS 自带的 bash 3.2 不支持的写法都已避开（云端无法下载 bash 3.2 实测）。MPS 路径只能在 Mac 上验证，预检会比较 CPU 与 MPS 的损失和梯度范数。全量数据预检需在本机运行（云端只有子集，本机文件夹的 Linux 环境没有 torch）。没有独立验证集；测试和损失都不能证明音乐质量。接入网页前仍需：Hold/Every bar/Free、和弦编辑与 Stop 的控制台适配器，长时间多声部延迟测试，以及试听评价。

### 续训到第 101,129 步（2026-10-03）

7.5 小时（第 45,225 步）之后用 `AILEGRO_V31_HOURS=17.5` 又训练了 10 小时，到第 101,129 步（学习率一直是最低值 1e-4）。
第 45,225 步的权重移到 `training/runs/old-models-tmp/four-pillar-v31-step45225/`，确认新权重好用后再删。同样的评估
（训练集窗口，只能比较两版，不是绝对水平）：

| | 第 45,225 步 | 第 101,129 步 |
|---|---:|---:|
| 音符交叉熵（六项之和，完整模型） | 1.834 | **1.792** |
| 和弦根音 / 性质交叉熵（训练用的和弦标签） | 0.686 / 0.402 | **0.515 / 0.287** |
| 配伴奏（18 段）只锁旋律：半音冲突 / 强拍和弦音 | 24.6% / 52.8% | **22.5% / 55.9%** |
| 同上，每小节选 8 份 | **13.7%** / 73.1% | 16.0% / 72.8% |
| 同上，选 32 份 | **8.1%** / 83.5% | 9.9% / **86.3%** |
| 锁旋律 + 人写的和弦，选 8 份：半音冲突 | 10.2% | **8.7%** |
| 依和弦写旋律：强拍和弦音（锁定的和弦 / 模型自己的和弦） | 93.0% / 92.8% | **95.2% / 97.1%** |
| 配器：给定音分到原曲用过的组（要求乐器组 / 再加轻度叠置） | **70.8%** / 67.7% | 66.4% / **68.0%** |
| 动机：完整织体合成模进的 Jaccard | 0.512 | **0.528** |
| 三首旋律配伴奏（选 8 份）半音冲突：v3.1 自己定和弦 / 配和声模型的和弦 | **11.8% / 6.1%** | 17.2% / 8.0% |

- 音符和和弦都预测得更准（艺术歌曲：根音 0.316 → 0.196；四重奏 / 管弦乐：0.970 → 0.760）。第一次评估显示和弦变差
  （1.244 / 0.966 → 1.356 / 1.087）是评估脚本的问题：艺术歌曲窗口配的是 ChordTracker 的和弦，而训练时对齐的艺术歌曲
  用 AugmentedNet 的和弦，模型越学越按 AugmentedNet 的风格配。2026-10-04 起 `eval_four_pillar_v31_tasks.py` 的 parts
  一节按训练时的标签算，并分来源给出（`bySource`）；两版的重算在 `reports/four-pillar-v31-parts-labelled-20261004.json`。
- 真实变差的是配伴奏“每小节选 8 份”时的半音冲突（不选时反而更少：25.7% → 21.9%）：挑候选只看旋律在伴奏下的概率，
  不惩罚冲突。可以在生成时加冲突惩罚，不用重训。
- 报告：`reports/four-pillar-v31-tasks-step101129-20261003.json`（21 段试听 MIDI 在同名文件夹）、
  `reports/harmonizer-v1-tunes-step101129-20261003.json`（`--sections tunes,auditions`，9 段）。试听页的配伴奏和五项任务
  已换成新权重，页面顶部可以切换回第 45,225 步对照。
- （已不推荐，改用下面“收尾训练”一节的 `train_four_pillar_v31_anneal.sh`）再训练 9 小时：
  `bash training/train_four_pillar_v31_more_9h.sh`（`status`、`log`、`stop`、`sample` 同原脚本）。它是
  `AILEGRO_V31_HOURS=26.5`（17.5 + 9）的包装，开始前先把当前权重另存到 `training/runs/four-pillar-v31-step<步数>/`，
  因为训练会不断覆盖运行目录里的 `weights.pt`。

## 四大件 v3.1：拆成两部分，以及 Cantelvio Score 的作曲任务（2026-10-02）

只增加解码与分析代码，**不改动** v3.1 计入哈希的文件和权重（以后精确续训不受影响）。

**拆分**（`scripts/four_pillar_v31_parts.py`）：
- **规划器部分**（1,386,440 参数）：已完成小节的摘要 → 计划向量，以及下一小节的调、音级、乐器组、密度、音区和参考指针；
- **作曲部分**（3,628,527 参数）：事件输入、4 层主干、小节控制、参考小节读入、属性解码器；
- 两者之间只有计划向量和小节摘要；`modulation_in` 两边都用，各存一份。`assemble` 组装后与原模型逐位相同（张量与生成结果都核对过）；`planner_free` 只用作曲部分（每小节用训练里的空计划，调要给定）；`save_parts`/`load_parts` 存成两个文件；`planner_frozen` 用于只训作曲部分。
- 实测（96 个训练集窗口，不重训，只把输入换成“没有”）：去掉规划器，音符六项交叉熵之和 +3.9%、和弦根音 +24%；去掉参考小节 +14%（音高 +21%）；去掉乐器组/密度/风格控制 +1%。规划器单独用来预测下一小节的调（95.0%）并不比“不转调”（95.4%）好。训练时冻结规划器每步省 18%，预先算好它的输出省 29%，只训属性解码器省 55%。

**作曲任务**（`scripts/four_pillar_v31_tasks.py`，`TaskComposer` 扩展 v3.1 的 `Composer`）：
- **小节内锁定音**（`Lock`）：固定起音，并可固定乐器组、声部身份、音高、时值、力度；没固定的由模型决定。模型提出的事件若在流顺序上排在下一个锁定音之前就保留，否则视为“现在写锁定音”。在锁定音的起音上，模型选了锁定音所在的乐器组（即使自由音不能用这个组），或在别的组提出锁定音的音高，也都视为写锁定音。自由音在同一声部、同一起音不重复同一音高。锁定音逐音保持；没有锁定音时与 `next_bar` 逐位相同。
- `unison`：默认 `'after'`，给定音写下之前，别的组不和它同音；`'before'` 让每个组先同音重复一次给定音（训练数据里同一起音、同一音高时组号小的在前），再提出一次才算锁定音。
- **配器**：没给乐器组的锁定音，按 p(组)·p(声部|组)·p(音高|组,声部)·p(时值|…) 选最可能的组和声部；允许叠置音时，模型自己在该起音提出这个音高，就用它提出的组和声部（同一后验的一次抽样）。可用 `free_filter` 只允许叠置音。
- **候选**：`best_of(K, …)` 把同一小节写 K 份，保留锁定材料对数概率最高的一份（配伴奏时就是“旋律在这份伴奏下最自然”）。
- **合成参考小节**：`reference_from_notes` + `transform_motif`（重复、调内模进、倒影、逆行、增值、减值、截取）。
- Cantelvio Score 的适配器（`../../Score/integrations/ailegro/score_compose.py`）用它实现为旋律配伴奏、配器和动机发展。

**修正（2026-10-02）**：第一版在给定音的起音上，把模型“该写旋律了”的提议改派到伴奏的组，钢琴于是把旋律原样抄一遍，还会在同一声部重复同一个音（人声旋律选 8 份时 81% 的旋律音被钢琴同音重复，每小节 0.2–0.3 个重复音）；当时冲突和和弦音的改善有一部分来自这种抄写。上面“乐器组”“音高”两条规则修正了它，下表是修正后的结果。

**测试**：`.venv-training/bin/python training/tests/four-pillar-v31-tasks.test.py`（25 项：拆分与组装逐位一致、单用规划器/作曲部分、存取、冻结规划器；锁定音的保持与流顺序、自由音不先抄给定音、在给定音的起音可选给定声部的组、`unison='before'` 每组最多一次、配器只用允许的组、只生成表情或音高、过滤、锁定和弦与锁定音并存、候选可复现、复制互不影响、合成参考；动机变形；有权重时再测真实模型，包括人声旋律配钢琴）。

**评估**：

```sh
.venv-training/bin/python training/scripts/eval_four_pillar_v31_tasks.py \
  --output training/reports/four-pillar-v31-tasks-<日期>.json     # 约 12 分钟（云端 2 线程）
```

结果 `reports/four-pillar-v31-tasks-20261002.json`，试听 MIDI 在同名文件夹（每种做法每首曲子一段）。窗口来自训练集（没有独立验证集），只比较做法；音乐质量要靠试听：

| 为旋律配伴奏（3 首公有领域旋律，8 小节，人声 + 钢琴） | 半音冲突 | 强拍和弦音 | 同音/八度重叠 | 其中同音 | 每段秒数 |
|---|---:|---:|---:|---:|---:|
| 只锁旋律 | 24.6% | 52.8% | 40.8% | 5.8% | 0.5 |
| 锁旋律，选 8 份 | 13.7% | 73.1% | 65.1% | 6.7% | 4.3 |
| 锁旋律，选 32 份 | 8.1% | 83.5% | 68.3% | 5.9% | 15.8 |
| 锁旋律 + 人写的和弦 | 10.6% | 87.5% | 64.6% | 12.3% | 0.6 |
| 锁旋律 + 人写的和弦，选 8 份 | 10.2% | 87.5% | 72.1% | 11.8% | 5.2 |
| 锁旋律，`unison='before'` | 18.5% | 54.3% | 53.3% | 45.7% | 0.5 |
| 锁旋律，`unison='before'`，选 8 份 | 11.1% | 73.0% | 82.2% | 73.7% | 4.6 |
| 真实 Lieder（人声对钢琴，9,449 个音） | 7.9% | 90.3% | 67.2% | 43.0% | — |

- 依和弦写旋律：强拍音是锁定和弦音的比例 93.0%（模型自己写和弦时 92.8%）。
- 配器（40 个真实管弦乐小节，先送入 8 个真实上下文小节）：给定音分到原曲演奏过它的组 70.8%（告诉模型要用哪些组；不告诉 69.9%；像 Cantelvio Score 那样再加轻度叠置 67.7%，每小节加 11.8 个叠置音），按上下文音区分配 66.0%，随机 35.1%。
- 动机重述（39 个窗口，与目标小节调内 (起音, 音高) 的 Jaccard）：原小节参考 0.567，不参考 0.080；完整织体的合成模进 0.512（不参考 0.057）；只给最高声部的模进 0.236、倒影 0.238，倒影加上其下方伴奏 0.292；完整织体的截取 0.405、减值 0.305。

结论：修正后，选 32 份时半音冲突（8.1%）和同音/八度重叠（68.3%）已接近真实 Lieder（7.9%、67.2%），强拍和弦音还差（83.5% 对 90.3%）；锁定人写的和弦仍然最有效，下一步宜另训“旋律 → 和弦”的配和声小模型。默认钢琴在旋律之前不与人声同音，所以同音只有约 6%（Lieder 43.0%）；`unison='before'` 只写一份时同音 45.7%，选 8 份升到 73.7%——挑选标准是旋律在伴奏下的概率，抄旋律的伴奏最占便宜。

## 配和声模型 v1：旋律 → 和弦（2026-10-03）

v3.1 在同一拍里先写和弦、再写旋律音，所以给定旋律配伴奏时只能猜和声（上一节的短板）。这里另训一个小模型：双向读完整段给定旋律，给出和弦；`TaskComposer` 再把和弦和旋律一起锁定，让 v3.1 写伴奏。**v3.1 不变。**

- **模型**（`scripts/harmonizer_v1.py`，865,248 参数）：4 层双向 transformer 编码器（宽 128、4 头）。输入是十六分音符网格上的旋律（音级、八度、起音/延续/休止），以及拍内位置、拍位层级、拍号和调号（换成大调主音的音级）。这套网格与 Lieder 联合语料完全一致：从数据库的总谱重建，99.9% 的格子相同。每一步输出 12 根音 × 40 性质（v3.1 的和弦表）。训练时随机移调，不给局部调，转调和离调从旋律推断。
- **解码**：Viterbi。换和弦的概率按拍位层级从训练标注统计：强拍 77%、其余拍 25%、八分 3.8%、十六分 0.1%。“换到哪个和弦”的额外惩罚在验证集上选为 0.0（拍点准确率：每步取最大 38.6% → Viterbi 39.5%）。输出每小节的和弦变化（小节内位置、根音、性质）。
- **数据**：`data/joint/lieder-joint.npz`。来源是 OpenScore Lieder（CC0），人声声部作旋律，和弦标注是 AugmentedNet v1.9.1。按作品分为训练 924 首、验证 111 首、测试 96 首。调号从 `data/four-pillar-score-all-train-v1.sqlite` 的总谱读出，缓存在 `data/joint/lieder-keysig-v1.npz`（缺失时自动重建，约 16 秒）。
- **训练**：`.venv-training/bin/python training/scripts/harmonizer_v1.py --run-dir training/runs/harmonizer-v1-20261003 --steps 4000`，然后加 `--tune-decoding` 选解码惩罚。云端 2 线程约 31 分钟。`runs/harmonizer-v1-20261003/weights.pt` 是验证集拍点准确率最高的一次（第 3500 步）；`checkpoint.pt` 可用 `--resume` 接着训练。
- **调号的作用**：不给调号的对照（`runs/harmonizer-v1-nokey-20261003/train.log`，中途停止）第 1500 步验证集拍点准确率 33.7%，给调号是 35.4%。

**测试集**（96 首没参加训练的作品，15,379 个拍点；和弦与 AugmentedNet 标注比较）：

| 方法 | 完全一致 | 根音一致 | 根音和三和弦类型一致 |
|---|---:|---:|---:|
| 配和声模型 | 36.9% | 44.3% | 41.9% |
| 规则配和声（把调号当大调） | 27.7% | 35.3% | 33.0% |
| 主和弦（把调号当大调） | 23.2% | 26.8% | 25.3% |
| 规则配和声（用 AugmentedNet 自己的局部调，仅作参考） | 39.3% | 48.2% | 45.9% |
| 主和弦（同上，仅作参考） | 36.8% | 40.7% | 39.0% |

只依据调号时，模型比规则配和声高 9.2 个百分点；比给了真实局部调的规则配和声（这个信息实际用时拿不到）只低 2.4 个百分点。

**用于配伴奏**（v3.1 写钢琴伴奏，旋律锁定；同上一节的指标）：

| 三首公有领域旋律（3 首 × 4 个种子） | 半音冲突 | 强拍和弦音 | 同音/八度重叠 | 每小节伴奏音数 |
|---|---:|---:|---:|---:|
| 和弦由 v3.1 自己定 | 25.7% | 52.0% | 40.7% | 20.2 |
| 同上，选 8 份 | 11.8% | 72.5% | 64.1% | 19.5 |
| 配和声模型的和弦 | 13.5% | 98.3% | 72.3% | 35.1 |
| 同上，选 8 份 | 6.1% | 99.4% | 68.5% | 28.9 |
| 人写的和弦 | 10.6% | 87.5% | 66.7% | 22.7 |
| 同上，选 8 份 | 9.2% | 87.5% | 72.8% | 26.6 |

| 真实艺术歌曲（测试集 60 首各一处：先送入 8 个真实小节，再写 4 小节，每小节选 4 份） | 半音冲突 | 强拍和弦音 | 与 AugmentedNet 逐拍一致 | 根音一致 |
|---|---:|---:|---:|---:|
| 和弦由 v3.1 自己定 | 19.5% | 68.7% | 30.0% | 37.5% |
| 配和声模型的和弦 | 14.3% | 84.0% | 31.9% | 40.5% |
| AugmentedNet 的和弦（参考） | 18.1% | 79.9% | 93.1% | 93.5% |

- 三首旋律上，配和声模型的和弦与人写和弦逐拍一致 74.0%（ode-to-joy 65.6%, twinkle 68.8%, lightly-row 87.5%）。
- 试听：`reports/harmonizer-v1-20261003/`，每首旋律三种和弦来源各一段（选 8 份，种子 1）。

结论：
- 换上配和声模型的和弦后，伴奏和旋律的冲突明显减少：三首旋律选 8 份时 11.8% → 6.1%，比人写和弦（9.2%）还低；真实艺术歌曲 19.5% → 14.3%。
- 强拍和弦音接近 100%：模型本来就挑能容纳旋律音的和弦。
- 代价是和声节奏偏密（《欢乐颂》几乎每拍换一次和弦），伴奏的音也更多。如果想要更舒缓的和声节奏，可以提高解码惩罚，或者在乐谱里改和弦后用给定和弦重新生成。
- 和 AugmentedNet 的逐拍一致率只是略高于 v3.1 自己定的和弦（31.9% 对 30.0%）：只看旋律时，可行的配法本来就很多。

**测试**：`.venv-training/bin/python training/tests/harmonizer-v1.test.py`（13 项：网格与语料一致的约定、弱起、调号、移调、Viterbi、换和弦频率的位置与分段解码、每小节的和弦变化、模型与存取、长旋律分段读取；有权重时检查《小星星》从 C 大三和弦开始、在 C 上结束，`bar` 设置下每小节最多一个和弦，以及分析模型从全部音符读出 C–F–G7–C）。

**评估**：`.venv-training/bin/python training/scripts/eval_harmonizer_v1.py --harmonizer training/runs/harmonizer-v1-20261003/weights.pt --output training/reports/harmonizer-v1-<日期>.json`（约 8 分钟；`--sections auditions` 另写试听 MIDI）。

**Cantelvio Score**：适配器 `--harmonizer auto`（默认）在为旋律配伴奏、且没有给定和弦时，用这个模型给出和弦并锁定；和弦随结果导入为和弦记号，可以修改后用给定和弦重新生成。

### 换和弦频率（2026-10-03）

`harmonize(..., rhythm=...)` 可以大致指定换和弦的频率：`auto`（按模型学到的频率，默认）、`beat`（最多每拍）、`half-bar`（最多每半小节：小节第一拍和中间那一拍）、`bar`（最多每小节）、`two-bars`（最多每两小节，从第一个完整小节数起）。

- 不是 `auto` 时，和弦只能在允许的位置换。解码按段：每段对每个和弦打分 = 该段各步后验概率平均值的对数 + `fit` ×（该段旋律时值落在和弦音上的比例），相邻两段保持或换和弦的概率取自训练标注（`RHYTHM_CHANGE`：在允许位置真的换和弦的比例，每拍 42.9%、半小节 58.7%、每小节 70.2%、两小节 74.1%）。`fit` 在验证集上选（`RHYTHM_FIT`：每拍 3，其余 2）。
- 三首公有领域旋律（种子 1、2，每小节选 8 份，v3.1 写伴奏）：

| 设置 | 每小节和弦数 | 与人写和弦逐拍一致 | 半音冲突 | 强拍和弦音 | 每小节伴奏音数 |
|---|---:|---:|---:|---:|---:|
| `auto` | 1.83 | 74.0% | 7.1% | 98.9% | 27.6 |
| `beat` | 1.83 | 72.9% | 6.0% | 98.9% | 25.6 |
| `half-bar` | 1.17 | 77.1% | 7.8% | 96.8% | 21.2 |
| `bar` | 0.71 | 72.9% | 10.7% | 74.9% | 18.7 |
| `two-bars` | 0.21 | 54.2% | 14.1% | 79.8% | 17.6 |

和弦越稀，伴奏越简单，但旋律落在和弦外的机会越多，冲突随之上升；`half-bar` 与人写和弦最接近。

**Cantelvio Score**：作曲请求里的意图标签 `harmonic-rhythm:<beat|half-bar|bar|two-bars>`（面板“换和弦频率”）；适配器 `--harmonic-rhythm` 设默认值。

## 和声分析模型 v2：旋律 + 全部音符 → 和弦（2026-10-03）

给已有的整份乐谱标和弦（Cantelvio Score 的“自动标和弦”）。和配和声模型 v1 是同一个网络和同一份语料，只多读一个**织体通道**：同一网格上每一步所有声部的音（每个音级正在发声的音数，最多记 3；这一步起音的音级；最低音的音级）。

- **模型**：`scripts/harmonizer_v1.py --texture`，870,368 参数。织体从数据库总谱重建，只用时间轴与语料逐步对上的作品（`verified_bar_steps`；训练 780 首、验证 77 首、测试 80 首），缓存在 `data/joint/lieder-texture-v1.npz`（缺失时自动重建）。其余作品和随机 30% 的训练窗口不给织体（`--texture-dropout 0.3`），所以只有旋律时也能用。
- **训练**：`.venv-training/bin/python training/scripts/harmonizer_v1.py --run-dir training/runs/harmonizer-v2-20261003 --steps 4000 --texture`，再加 `--tune-decoding`（惩罚选为 0.25）。云端 2 线程约 42 分钟。验证集拍点准确率：每步取最大 64.9%，Viterbi 67.2%；只给旋律 37.2%。
- **测试集**（80 首测试作品中能对上总谱的，13,213 个拍点；与 AugmentedNet 标注比较）：

| 方法 | 完全一致 | 根音一致 | 根音和三和弦类型一致 |
|---|---:|---:|---:|
| 分析模型 v2，读全部音符 | **71.2%** | **77.6%** | **75.9%** |
| Cantelvio Compose 和弦跟踪器（规则），读全部音符 | 67.0% | 75.3% | 73.1% |
| 分析模型 v2，只读旋律 | 35.0% | 42.7% | 40.0% |
| 配和声模型 v1，只读旋律 | 36.1% | 43.9% | 41.3% |

结论：读全部音符时，分析模型比规则和弦跟踪器高 4.2 个百分点（完全一致）。只有旋律时 v1 略好，所以为旋律配伴奏仍用 v1，和声分析用 v2。

**评估**：`.venv-training/bin/python training/scripts/eval_harmonizer_v1.py --harmonizer training/runs/harmonizer-v1-20261003/weights.pt --analyzer training/runs/harmonizer-v2-20261003/weights.pt --sections analysis --output training/reports/harmonizer-v2-<日期>.json`（约 10 秒）。

**Cantelvio Score**：契约 `ailegro.analysis-request/1` → `ailegro.analysis-result/1`，服务器 `POST /analyze`。适配器 `--analyzer auto`（默认）有 v2 权重时用它，否则用规则和弦跟踪器；请求里的 `engine` 可以指定 `model` 或 `rules`，`harmonicRhythm` 同上。

## 音频 → 乐谱：MuScriptor 转写，节拍对齐，保留该保留的音符（2026-10-03）

把一段录音变成 Cantelvio Score 能打开的乐谱（MusicXML）。分两步，因为两个模型在两个 Python 环境里：

```sh
# 1. 音符和节拍（MuScriptor 的环境；只能用于你有权转写的录音，MuScriptor 是 CC BY-NC 4.0）
MuScriptor-large-1.3B/.venv-py312/bin/python training/scripts/audio_transcribe_muscriptor.py song.wav \
    [--instruments acoustic_piano,voice]          # → song.notes.json
# 2. 乐谱（Cantelvio Compose 的环境）
.venv-training/bin/python training/scripts/audio_to_score.py song.notes.json [--metre 3/4] [--piano] [--report r.json]
                                                  # → song.musicxml，在 Cantelvio Score 里打开或拖进窗口
```

- **第 1 步**（`scripts/audio_transcribe_muscriptor.py`）：MuScriptor large 逐个音符给出起止时间（秒）、音高、乐器组
  （Apple 芯片上用 MPS、float16）；节拍和强拍来自 beat_this（MuScriptor 自己也用它），不假设固定速度。
  `--instruments` 告诉模型有哪些乐器（`muscriptor list-instruments`），乐器标签会稳定很多。输出
  `ailegro.transcription/1` JSON。
- **第 2 步**（`scripts/audio_to_score.py`，只需要 numpy；有 torch 和两个模型的权重时多和声检查、补音两步）：
  - **节拍 → 小节**：用跟踪到的每一拍做速度图（跟得上自由速度）；修补节拍跟踪的失误（多出来的拍、有音符起音处漏掉的拍、
    与强拍对不上的小节）；量出音符整体比节拍晚多少并扣掉；强拍给出拍号和第一小节（弱起小节自动识别）。
  - **节奏**：每一拍选一个细分（1、2、4、8 或三连音 3、6、12），对所有拍做 Viterbi：起音贴近网格、简单的细分优先、
    同一段落保持同一种细分；三连音占多数时写成复拍子（6/8、9/8、12/8；`--metre` 可以指定）。有几件乐器时每件乐器
    各选各的细分（伴奏的三连音和旋律的十六分音符可以同时成立）；短于 70 ms 的音（多是装饰音或杂音）在选细分时
    只算 0.3 个音，一个起音拉偏网格的代价有上限。
  - **跑动**（音阶、琶音、快速经过句）：量化之前先找出来：同一件乐器里相隔 35–300 ms、每步不超过 7 个半音的音连成链，
    间距规则（是典型间距的 0.6–1.6 倍或相差 45 ms 以内；约两倍、三倍的间距算漏了一两个音）且至少 5 个音的算一段跑动；
    被一两个漏音切开的跑动（间隔超过 300 ms，链会断）重新接上。
    每段跑动单独定网格：相邻两音的间距用 Viterbi 选细分（一格；漏了音就是几格，每漏一个加代价；段内换细分也加代价，
    比如先六连音后十六分音符），再把音放到离自己最近、严格递增的格点上（保序回归），一处挤在一起不会把后面的音
    都推错；跑动经过的拍也用它的细分。跑动里的音写成连奏（延到下一个音，但不延过漏了音的格点）。和声检查之后再做
    两种很保守的修补：网格上空了一两格（前两步、后一步都是一格，空格前的音没有延长，这里没有和弦，走向一致，
    每格只有一个音合适）时，补上漏掉的音阶音或琶音的和弦音；音阶跑动里偏了半音、又不是和弦音的音
    移回音阶上（按估出的调，有和声分析时加上它的和弦音）。人声、管乐这类单声部乐器，新音开始时结束前一个音，
    不再把连奏的重叠当成多出来的音去掉。
  - **声部与乐器**：MuScriptor 的乐器组换成目录乐器（弦乐、铜管合奏按音区拆成高低两个声部，人声按音域定女高到男低），
    一个人声标签常常同时有几个音（合唱、重唱；MuScriptor 都标成 `voice`）时按起音拆成几条线，各成一个声部；
    音符很少的乐器组并进音区最近的声部；打击乐不要。钢琴、管风琴、竖琴两行谱，左右手按跟随的分界线分。
  - **保留该保留的音符**：去掉重复的音；去掉与一个更长的音同时开始、高八度 / 十二度 / 两个八度、在自己音区没有邻音的短音
    （泛音“鬼音”）；去掉孤立的极短音；乐器演奏不了的音（远超音域，或人声、管乐同时多于一个音）移到能演奏的声部
    （优先键盘），没有就去掉；用 **Cantelvio Compose 的和声分析模型**（配和声模型 v2）标出每个十六分音符的和弦，去掉既不是和弦音、
    也不在级进线条上、这个声部前后两拍内也不再出现这个音级的短音（最高声部总是保留）。每谱表最多 4 个声部；
    比下一个音略早结束的音延到下一个音。
  - **补音**：**Cantelvio Compose 的补音模型**（`note_filler_v1.py`，见下面“补漏掉的音”）读整理好的乐谱，把转写最可能漏掉的音补上，
    放进这一刻离它最近的声部。`--filler none` 关掉，`--filler-threshold 0.7` 补得少一些、更准。
  - **记谱**：按音级分布估调（Krumhansl），按调拼写升降号；移调乐器写记谱音高并加 `<transpose>`；跨拍、跨小节用连音线；
    三连音括号按声部加（伴奏的三连音和旋律的十六分音符各写各的）。`--piano` 把所有乐器缩成一份钢琴谱；
    `--report` 写出去掉、移动、补上了什么及原因，以及找到的跑动。
- **评估**（`scripts/eval_audio_to_score.py`）：没有音频，用模拟：把数据库里的真实乐谱“演奏”出来（逐拍漂移的速度、最后渐慢、
  起音抖动、提前放开），再加上转写错误（漏 6%、八度 / 十二度鬼音 4%、错成相邻半音 2%、长音被切开 2%、乐器标签错 4%、
  极短杂音 3%、和声样的多余音 2%），节拍是真实拍点加 12 ms 抖动；“节拍跟踪有错”一组再漏掉 3% 的拍、多出 1% 的拍；
  `--fast-errors` 再加一组“跑动转写更差”：与同乐器另一个起音相距不到 150 ms 的音漏 12%、错成相邻半音 4%、起音再多抖 12 ms。
  转回乐谱后和原谱按“从第一个强拍起的拍数位置 + 音高”逐音比较（和 mir_eval 一样不分乐器）；原谱里的跑动音
  （同一声部连续 6 个以上、每个不长于三连音八分音符、每步不超过四度）另外统计：找到、位置错（节奏错）、音高错、没有。

最初一版（没有跑动处理）是 `training/reports/audio-to-score-20261003.json`，每首取前 24 小节，云端约 10 秒：

| 测试集 | 不清理 F1 | 规则清理 F1（精确率 / 召回率） | + Cantelvio Compose 和声检查 F1 | 时值正确 | 拍号正确 |
|---|---:|---:|---:|---:|---:|
| 艺术歌曲（测试集 30 首，人声 + 钢琴） | 84.2% | 86.3%（88.1% / 84.5%） | 86.3% | 82% | 90% |
| 同上，节拍跟踪有错 | 79.8% | 81.8% | 81.8% | 82% | 87% |
| 弦乐四重奏（10 个乐章） | 86.2% | 88.2%（90.7% / 85.8%） | 88.2% | 85% | 70% |
| 同上，节拍跟踪有错 | 76.8% | 78.5% | 78.6% | 85% | 70% |

- 模拟的错误（漏音 6% + 错音 2%）本身就把召回率的上限压在约 92%；节奏和小节对齐只再损失约 7%。清理让精确率提高 4 个百分点、
  召回率几乎不变。和声检查只多去掉约 0.4% 的音、精确率 +0.2 个百分点：模拟里它要找的错误（不在和弦上、也不在线条上的短音）
  本来就少。拍号错误主要来自中途换拍号的作品（只能写一个拍号）、3/2 写成 6/4、带三连音的 4/4 写成 12/8。

### 跑动段落（2026-10-03）

最初一版的跑动音有约 10% 写错了位置：三连音和二分的细分混淆、全曲只有一套细分（四重奏里一件乐器的六连音和另一件的
十六分音符互相拉扯）、快速音阶的几个音挤到同一个格点上。现在每件乐器各选细分、跑动单独定网格并保持音的先后
（见上面“节奏”“跑动”两条）。`training/reports/audio-to-score-v2-20261003.json`（`--fast-errors`，
云端约 18 秒），“规则 + Cantelvio Compose 和声检查”，箭头前是最初一版在同样模拟上的结果（各行的模拟随机数不同，只在行内比较）：

| 测试集 | F1 | 时值正确 | 拍号正确 | 跑动音找到 | 跑动音位置错 |
|---|---:|---:|---:|---:|---:|
| 艺术歌曲（测试集 30 首，人声 + 钢琴；跑动音 682 个） | 86.3% → **88.3%** | 82% → 83% | 90% | 80.7% → **85.3%** | 10.3% → **5.1%** |
| 同上，节拍跟踪有错 | 81.8% → **83.4%** | 82% → 83% | 87% | 82.7% → **83.6%** | 4.0% → **3.1%** |
| 同上，跑动转写更差 | 85.5% → **87.3%** | 81% → 82% | 87% → 90% | 79.5% → **81.7%** | 7.0% → **5.0%** |
| 弦乐四重奏（10 个乐章；跑动音 546 个） | 88.2% → **89.9%** | 85% | 70% | 80.8% → **85.2%** | 10.3% → **5.9%** |
| 同上，节拍跟踪有错 | 78.6% → **80.6%** | 85% → 86% | 70% | 80.6% → **81.7%** | 10.3% → **9.2%** |
| 同上，跑动转写更差 | 89.1% → **89.8%** | 87% → 86% | 70% | 85.2% → 83.5% | 5.3% → 6.8% |

- 主要是节奏变好了：跑动音写错位置的比例减半，整体 F1 提高 1–2 个百分点（每件乐器各选细分，跑动以外的音也受益）。
  位置错的音既算多出来的、又算漏掉的，所以精确率和召回率一起提高（艺术歌曲 90.2% / 86.4%，四重奏 92.6% / 87.4%）。
- 唯一变差的一格是“跑动转写更差”的四重奏（跑动音找到 85.2% → 83.5%）：起音抖得更厉害时，有的跑动被切成几段，
  或者整段选错了细分。参数是在另一组作品上调的（艺术歌曲验证集的 40 首、评估之外的 16 个四重奏乐章），没有按测试集再调。
- 补音、改音两条修补规则很保守，模拟里只动了极少几个音，数字几乎不受影响；跑动里漏掉的音（7–10%）大多还补不回来。
  真实录音里 MuScriptor 在跑动上的错误可能和模拟不同（比如整段连音、滑音），要用真实转写再看。
- 示例的四段（试听页的扒谱示例也是其中三段）：Brahms《Der Strom》（钢琴跑动多）F1 62.0% → 75.5%（跑动音找到
  28 → 48 / 66），Mayer 四重奏 94.1% → 94.4%，Bartók 四重奏 88.7% → 88.9%，Lang 不变（85.3%）。
- 这些都是模拟的结果，不代表 MuScriptor 在真实录音上的错误分布。下一步：在 Mac 上把测试集乐谱合成成音频，用 MuScriptor
  真实转写，再用 `(MuScriptor 的输出, 原谱)` 训练 Cantelvio Compose 自己的“保留 / 去掉”模型，跑动的节奏也可以从中学。
- 示例：`reports/audio-to-score-v2-20261003/`（两首艺术歌曲、两个四重奏乐章的模拟输入 `*.notes.json` 和结果 `*.musicxml`）；
  最初一版的示例在 `reports/audio-to-score-20261003/`。

**测试**：`.venv-training/bin/python training/tests/audio-to-score.test.py`（19 项：节拍图、节拍修补、延迟与拍号、细分选择、
声部与乐器、左右手、各条清理规则、和声检查、声部与时值、拼写与移调、记谱时值拆分、端到端写 MusicXML 并检查每小节时值；
跑动：抖动的快速音阶写成三十二分音符、跑动中途由六连音换成十六分音符、保序的格点、单声部乐器的重叠、补音与改半音
（回音不改）、按声部的三连音；有分析模型权重时检查和声检查能运行）。



### 补漏掉的音：规则 + 补音模型（2026-10-04）

先在调参集上看清理之后还缺哪些音（模拟里每个原谱音都带着“被模拟漏掉 / 偏了 / 保留”的标签）：除了模拟本身漏掉的音，
流程自己也丢音：合唱、重唱被当成一个人声（同时多于一个音的被移走或去掉），和声检查去掉了伴奏里反复出现的经过音，
被一个漏音切开的跑动补不上。改了四条规则，再训练一个补音模型。

**规则**（`audio_to_score.py`）
- **合唱拆声部**：一个人声标签有 35% 以上（且至少 12 个）的起音同时有两个以上音高时，按起音拆成 k 条线（k 取同时音数的
  80% 分位数，2–4）：音数够时高的给上面的线、最低的给最下面一条；不够时给音高最近、没有还在响的线。每条线一个声部，
  按音区定女高、女低、男高、男低（同一类两个声部只在明显时出现）。
- **和声检查少删**：不是和弦音、不在级进线条上的短音，只有这个声部前后两拍内都不再出现这个音级时才删。
- **跑动接续**：跑动被一两个漏音切开时（下一段的头正好在典型间距的 2 倍或 3 倍处，音高相近、间距相同）接成一段；
  规则间距也接受 3 倍。跑动里的连奏不跨过漏了音的格点（否则前一个音的时值是错的）。
- **跑动补音**：空一格或两格都补，但条件更严（见上面“跑动”一条）。

调参集（规则 + 和声检查，不用补音模型）：艺术歌曲 F1 86.6% → 88.6%（召回率 82.7% → 86.3%），跑动转写更差时
83.7% → 85.5%；其中 4 首合唱 / 重唱 71.9% → 90.3%（召回率 60.1% → 90.1%），其余 36 首 87.8% → 88.5%。
四重奏不变（88.0% → 88.2%；跑动转写更差 87.3% → 87.3%）。

**补音模型**（`scripts/note_filler_v1.py`，权重 `runs/note-filler-v1-20261004/weights.pt`，582,841 参数）

```sh
.venv-training/bin/python training/scripts/note_filler_v1.py data --out training/data/note-filler-v1.npz   # 约 4 分钟
.venv-training/bin/python training/scripts/note_filler_v1.py train --data training/data/note-filler-v1.npz \
    --run-dir training/runs/note-filler-v1-20261004                                                     # 约 1 小时
.venv-training/bin/python training/scripts/note_filler_v1.py tune --run-dir training/runs/note-filler-v1-20261004
```

- **读什么**：清理和跑动修补之后的乐谱。每个起音和每个网格点是一个位置，读这里开始的音和正在响的音（88 个音高，
  移到 C 大调 / a 小调）、Cantelvio Compose 和声分析的和弦、小节里第几拍、拍内位置、前后间距；4 层 Transformer（宽 128，
  每段最多 384 个位置，长曲重叠分段）读上下文，再用一个小网络读每个音高自己的证据（一拍、两拍、一小节前后同一音高
  有没有出现，八度、和弦音、调内音、同时的邻近音）。输出每个位置、每个音高“原谱在这里有一个音开始”的概率。
- **怎么补**：乐谱里没有、概率不低于阈值的音补上，放进这一刻离它最近的声部（同时开始的音优先，否则正在响的、
  前后相邻位置的音），时值和那个音相同（或到这个声部的下一个起音）；人声、管乐这类单声部乐器同一时刻不加第二个音。
  报告里记为 `added: filler`，并有 `noteFiller: true`。默认使用（有 torch 和权重时）。
- **数据**：乐谱库里不参加评估和调参的作品（艺术歌曲训练集 924 首、其余 170 个四重奏乐章、107 部管弦乐总谱），
  用评估脚本同样的模拟演奏和转写（普通、跑动转写更差、节拍跟踪有错），由 `audio_to_score.py`（规则 + 和声分析）
  整理，每段 24 小节，目标是原谱：1,201 部作品、4,250 段（`data/note-filler-v1.npz`，12 MB）。
- **训练**：4,000 步，每批 8 段，学习率 1e-3 余弦，整理后的乐谱缺的音损失权重 2；云端 CPU 约 1 小时（中途断开一次，
  从第 3,000 步的检查点续训）。留出的 5%（204 段）上平均精确率 0.209。
- **阈值**在调参集上选（普通 + 跑动转写更差，0.4–0.8 中两组 F1 之和最大）：**0.6**，补的音 70% 是对的（778 对、335 错）；
  调参集 F1 艺术歌曲 87.1% → 88.0%、四重奏 87.7% → 87.8%（`runs/note-filler-v1-20261004/tuning.json`）。

**测试集**（`reports/audio-to-score-v3-20261004.json`，`--fast-errors`，云端 31 秒；和上一版用同样的模拟，可以逐行比较）：

| 测试集 | F1 上一版（10-03） | 新规则 | + 补音模型 | 召回率 | 跑动音找到 | 时值正确 |
|---|---:|---:|---:|---:|---:|---:|
| 艺术歌曲（30 首） | 88.3% | 88.8% | **89.1%** | 86.4% → **88.8%** | 85.3% → **88.1%** | 82.7% → 83.1% |
| 同上，节拍跟踪有错 | 83.4% | 83.6% | **83.8%** | 81.5% → **83.3%** | 83.6% → **85.3%** | 82.9% → 83.1% |
| 同上，跑动转写更差 | 87.3% | 87.8% | **88.2%** | 85.2% → **87.7%** | 81.7% → **82.4%** | 81.8% → 82.5% |
| 弦乐四重奏（10 个乐章） | **89.9%** | 89.6% | 89.7% | 87.4% → 87.7% | 85.2% → 83.5% | 85.4% → 85.6% |
| 同上，节拍跟踪有错 | 80.6% | 80.8% | **80.9%** | 78.4% → 79.3% | 81.7% → **83.9%** | 85.7% → 86.3% |
| 同上，跑动转写更差 | **89.8%** | 89.6% | 89.6% | 87.3% → 87.7% | 83.5% → 83.0% | 86.5% → 86.3% |

（召回率、跑动音、时值三列：上一版 → 新规则 + 补音模型。）

- **找回了一些漏掉的音**：艺术歌曲召回率 +1.8–2.5 个百分点（规则 +0.4–0.7，补音模型 +1.4–1.7），精确率 −1.0–1.2
  （补的音约三成是错的），F1 +0.4–0.9；跑动音找到 +0.7–2.8。补音模型在艺术歌曲里每首补约 11 个音（30 首共 329–344 个），
  在四重奏里每个乐章只补 3–5 个：四重奏声部多、模型很少有把握，F1 只 +0.1。
- **四重奏（普通、跑动转写更差两组）比上一版略低**（F1 −0.2，跑动音找到 −1.7 / −0.5）：跑动接续有时把两把小提琴
  （同一个乐器标签）的线接在一起，
  音放错格。关掉它，四重奏回到上一版，但艺术歌曲 F1 −0.3–0.5；调参集上也是艺术歌曲受益、四重奏不变，所以保留
  （`RUN_BRIDGE`）。这是看了测试集之后的取舍。
- 合唱拆声部和和声检查在测试集上几乎不起作用（30 首里 3 首触发拆声部，F1 不变），作用在调参集上（见上）。
- 跑动接续起初让时值正确率降了约 1 个百分点（前一个音被连奏到漏音之后）；连奏不跨过漏了音的格点之后回到上一版以上。
- **示例**（`reports/audio-to-score-v3-20261004/`，和上一版同样的四段；依次是上一版、新规则、+ 补音模型）：
  Brahms《Der Strom》75.5% → 82.8% → 82.7%（跑动音找到 48 → 54 / 66，补了 26 个音），Lang 85.3% → 84.9% → 85.0%，
  Bartók 88.9% → 88.9% → 89.0%，Mayer 94.4% → 94.1% → 94.1%。
- **限制**：模拟里漏音是随机的（每个音 6%，快速段落 12%）；MuScriptor 在真实录音上漏的音可能集中在别处（内声部、
  轻的音、和弦里的重复音）。补音模型学的是“乐谱在这里通常有什么”，在真实录音上可能补出没有演奏的音，所以补上的音在
  报告里单独计数，可以用 `--filler none` 对照。下一步仍是用真实转写（测试集乐谱合成音频 → MuScriptor）来量和训练。

**测试**：`audio-to-score.test.py` 现在 24 项（新增：合唱拆成四个声部、独唱不拆；和声检查保留反复出现的音级；
被漏音切开的跑动接上；跑动音不延过漏掉的音；空格前的音延长时不补；补音接口：秒数换算、报告、`--keep-all` 时不补）；
`.venv-training/bin/python training/tests/note-filler-v1.test.py` 3 项（位置、调与拍位；补的音放到哪个声部、单声部乐器不加
第二个音、已有的音不重复；有 torch 时：模型形状、权重存取、分段预测）。

## v3.1 收尾训练：学习率衰减 + 权重滑动平均（2026-10-04）

- **问题**：前 17.5 小时的后半段一直停在固定学习率 1e-4（余弦早已走完），保存的是最后一步的原始权重，每批损失在 4.5–5.8 之间摆动；
  评估里和弦损失变差（1.244 → 1.356）而训练损失里和弦根音一直在降（0.83 → 0.71），说明最后一步的权重带着噪声。
  语料全部用于训练（`noValidation`），所以没有干净的验证集可以选“最好的一步”；这里用不需要验证集的两个常规办法。
- **更正（2026-10-04）**：“评估里和弦损失变差”是评估脚本的问题（艺术歌曲窗口用了 ChordTracker 的和弦，训练用的是
  AugmentedNet），不是权重噪声；按训练时的标签重算，第 101,129 步的和弦比第 45,225 步更好（根音 0.686 → 0.515，
  性质 0.402 → 0.287）。衰减学习率和 EMA 仍是合适的收尾做法。
- **做法**：`scripts/train_four_pillar_v31_anneal.py`（复用 `train_four_pillar_v31.py` 的数据管线、损失、随机移调，原脚本和它的严格续训清单不动）：
  从第 101,129 步的 `weights.pt` 开新运行（优化器重置，预热 200 步），学习率从 1.5e-4 余弦衰减到 4.5e-6，9 小时刚好走完；
  同时保存权重的指数滑动平均（衰减 0.9995，半衰期约 1,400 步）。`weights.pt` 是 EMA 权重（schema 不变，所有 v3.1 工具直接可用，多一个 `ema: true`），
  `weights-raw.pt` 是最后一步的原始权重；`--resume` 可续训。
- **运行**：`bash training/train_four_pillar_v31_anneal.sh`（`status` / `stop`）。输出在 `training/runs/four-pillar-v31-anneal-20261004/`，
  不会改动 `four-pillar-v31-ready-20261001`。
- **云端冒烟测试**（torch 2.14.1，Lieder + classical-scores，batch 2，12 步 + 续训 6 步）：能跑、能保存、能续训；EMA 与原始权重不同；
  `weights.pt` 能被 `FourPillarV31.load_state_dict(strict=True)` 读入。还没有在 Mac 上用完整数据（含 SymphonyNet MIDI）跑过。
- **训练完后怎么比**：用 `eval_four_pillar_v31_tasks.py` 对三份权重（第 101,129 步、`weights-raw.pt`、EMA `weights.pt`）各评估一次，
  和之前一样比音符交叉熵、和弦损失、配伴奏冲突率（用 2026-10-04 修好的评估：第 101,129 步是音符 1.792、和弦根音 0.515、
  性质 0.287，比它低才算更好）。
