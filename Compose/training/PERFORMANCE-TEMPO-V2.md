# 下一轮：当前四轨模型的力度与速度扩展（尚未训练）

2026-09-29。目标是从**目前主页的 continued R/H/B/M 主干**初始化新版本，保留已部署权重与浏览器契约；不是改用五组管弦乐消融模型。候选标注位于 `data/performance-labels-v1/`，现有网页和检查点均未改变。

## 标签实际是什么

- `score-events.jsonl.gz` 记录 OpenScore Lieder 与三个新增古典乐谱库中**明确写出的**数值速度（四分音符每分钟，QPM）和 MusicXML `sound dynamics` 数值。坐标是原谱的零基小节与精确四分音符偏移；`split` 沿用 Lieder 原有划分，新增古典乐谱仍为 `null`。无数字的 Allegro、rit. 等文字不能自动变成 BPM，缺失标记也不是 120 BPM。
- Lieder 的印刷 `p/mf/f`、重音和渐强／渐弱方向已有 `data/joint/lieder-expression-v1.npz`；新增古典乐谱同类标签在 `data/classical-score-v1/`。MusicXML `sound dynamics` 是播放百分比类数值，**不是**原始 MIDI velocity，也未验证它在各软件间的标度一致性。
- SymphonyNet 预处理语料已经有每小节 32 档速度和每音 8 档 velocity，但 `prepare.py` 对没有 tempo meta-event 的原 MIDI 补 120 BPM。`midi-tempo-evidence.jsonl.gz` 只标明原 MIDI 真正含有的 `FF 51` 事件，下一轮应据此建立监督 mask，而不是把默认值学成真实速度。已审的 `MIDI-Library` 也有同类证据。

## 已完成的数据质量核对

- **目前主页训练来源 Lieder**：1,131 首里 1,035 首有显式数值速度，276 首有多个不同速度值；新生成的 `lieder-joint-tempo.npz` 与原四轨语料的 809,992 个十六分步及原有作品级 split 一一对齐，其中 733,803 步有已知 QPM，缺失的 76,189 步保持 `NaN` 并以 `known=false` 屏蔽。18 个同位置冲突未进入对齐目标。
- **新增古典候选谱**：303 首里 298 首有数值速度，230 首有多个速度值；但无批准的训练/验证/测试划分，不能直接混进现有模型。字词方向标记只计数，未被猜成数值速度。
- **原 MIDI**：逐文件检查 `FF 51` 后，SymphonyNet 已纳入的 43,036 个 MIDI 全部含至少一个显式速度事件，23,438 个有多个不同数值；经审核 MIDI-Library 的 117 份也全部含显式事件，其中 62 份有多个不同数值。可见预处理代码的 120 BPM 缺失回退不是这批已纳入文件的主要来源，但 MIDI 导出器仍可能主动写入默认 120，不能据此认定每个值都来自演奏者。SymphonyNet 中 10,325 份以显式 120 开始，5,884 份从头到尾只记 120；需要按来源和作品人工抽查。原谱在首个标记前的时间仍为未知（SymphonyNet 4 份、MIDI-Library 21 份）。
- **力度**：Lieder 中 1,084 首有 MusicXML 数值 `sound dynamics`；SymphonyNet 43,036 首中 40,029 首的已量化 MIDI velocity 有不止一档。这证明数值变化存在，不证明跨乐器响度标定可靠。乐谱与 MIDI 数值必须保留不同单位、监督 mask 和来源质量标记。

## 模型与训练的最小安全扩展

1. **条件与输出分开。** 给四轨主干的每个窗口加当前的连续 `log(QPM)` 条件（窗口边界、拍号和四轨顺序保持不变），让节奏／和声／低音／旋律在所选速度下生成。另加一个速度变化头，在乐句或有标注的速度事件位置预测“保持/改变”和连续的 `Δlog(QPM)` 分布；不要把每首作品的观测 BPM 当成唯一正确类别。相同写法在多个速度下可以有非零概率。先冻结或低学习率更新旧主干，再比较遗忘与自由生成。
2. **速度游走**是可选择的演奏模式：固定使用用户设定 BPM；游走从该 BPM 出发，模型在乐句边界建议下一速度，控制层约束用户范围与最大单次变化，音频时钟按预先确定的 tempo map 排程。不是均匀随机换 BPM，也不能在已排程小节内改音。当前网页尚无这个模型头，因此此处只是后续实现约定，不应假称已上线。
3. **力度多任务监督。** 谱面 `p/f`、重音、wedge、MusicXML 数值 dynamics 与 MIDI velocity 是不同目标，各自携带 `known` mask 和来源/乐器信息；没有力度的 MIDI 仍可训练音高、节奏、组别。不要把 p→64、f→100 之类的伪造映射作为真实标签。数值力度建议学习相对乐器与乐句的强弱，并通过校准后的声音层表现，而非把不同乐器 velocity 直接当等响度。
4. **缺失与分布。** 数值速度用连续对数域概率密度或条件分布，评估多个可接受速度的覆盖率与生成音乐质量，不做单一 BPM 分类准确率。可以比较有限幅度的 tempo 条件扰动，但扰动样本不可冒充乐谱原标注。训练中分别报告速度、velocity、谱面力度各来源的覆盖率与验证损失，并分拍号、乐器、来源报告。
5. **划分与泄漏。** Lieder 用已有作品级 train/validation/test；新增古典乐谱还需作品级跨库去重，尤其先排除与旧 SymphonyNet test 重叠的作品。MIDI 默认 120、无 MIDI 力度、文本速度词都需 mask。不同配速的同一作品必须在同一 split，不可分到训练和测试两边。

## 网页接入门槛

- 新主干的输入维度、表现头和词表变化会形成**版本 2** 权重；从旧主干迁移需显式映射旧张量和新层，重新导出 PyTorch↔浏览器逐 logit 夹具。旧网页权重始终保留，验证通过后再由用户决定切换。
- `render.js` / `transport.js` 应在排程前把 tempo map 的拍位置积分为音频秒数；跨小节延音要按实际速度曲线算结束时间。保留八小节和弦谱的拍位置、音频时钟可听状态、未来编辑只重生未锁定后缀、Stop/Panic 取消旧回调。
- UI 可提供「速度：固定／游走」、起始 BPM、允许范围和变化幅度。走动节奏默认以乐句为单位，允许用户在播放中关闭游走或改起始值。需先有模型生成能力与 A/B 试听，再开放游走开关。
- 验证包含明确速度标注覆盖、速度变化校准、动态层次、跨拍号时值、播放不抖动／削波、长时间连续演奏，以及“固定”模式不受新头干扰的回归测试。预测损失不等于听感。

重建候选标注：

```sh
.venv-training/bin/python training/scripts/prepare_performance_labels.py --output training/data/performance-labels-v2
.venv-training/bin/python training/scripts/audit_midi_performance.py --output training/data/performance-labels-v2/midi-tempo-evidence.jsonl.gz
.venv-training/bin/python training/scripts/build_joint_tempo_features.py --sidecar training/data/performance-labels-v2/score-events.jsonl.gz --output training/data/performance-labels-v2/lieder-joint-tempo.npz
```

这三个程序只读源语料、写新的候选标注目录；**不会启动训练或替换网页模型**。运行第二、三个命令前，第一个命令必须已建立相同的新目录。
