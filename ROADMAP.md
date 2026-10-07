# Cantelvio 长期计划

更新：2026-10-07 · 英文摘要：*A phased plan from today's research prototype to a public, honest, reproducible release (v0.1 preview → v0.2 better harmony → v0.3 complete loop). Core goal: better harmony and melody from Transformers; everything else exists to make that testable, usable and publishable.*

配套文档：[docs/AUDIT-2026-10-07.md](docs/AUDIT-2026-10-07.md)（现状审计与改进空间）· [结果页](site/results/)（所有实验数字）· [docs/INTERNAL-HANDOFF.md](docs/INTERNAL-HANDOFF.md)（迁移与开源前清单）。
日期与工期都是估计；标“用户”的步骤需要在 Mac 上运行（训练、MuScriptor 转写），标“Claude”的可以在云端完成。

## 1. 目标与原则

1. **核心目标**：用 Transformer 把自动作曲的**和声与旋律**做得更好。编辑器、演奏、网页都是为了让结果能被听、被比较、被修改、被发布。
2. **先评估，再改模型**：没有独立留出集之前，不宣称“更好”。每个模型改动都要在同一套指标上和上一版、AMT、真实乐谱对照。
3. **演示要诚实**：公开网页只展示真能在浏览器里跑的东西；需要本机服务的功能明确标注；局限写在结果页里。
4. **可复现**：一条命令跑测试、一条命令跑评估、一条命令建站；训练环境可锁定。
5. **合规先行**：每个公开的权重都有数据来源与许可说明；不确定的不公开。

## 2. 版本里程碑

| 版本 | 目标日期（估计） | 主题 | 验收 |
|---|---|---|---|
| **v0.1 公开预览** | 2026-11-15 | 能放心给别人看：网页上线、许可证、CI、可公开的权重、无个人信息 | Pages 上线且无死链；CI 全绿；LICENSE + 模型卡；仓库不含个人路径/邮箱 |
| **v0.2 更好的和声** | 2027-01-31 | v3.2 与独立评估：在留出集上比 v3.1 更好，浏览器里跑上新模型 | 评估门槛（见 §5）达成；盲听 ≥10 人；浏览器推理与 PyTorch 对齐 |
| **v0.3 完整闭环** | 2027-04-30 | 旋律 → 伴奏 → 编辑 → 回放/导出 → 演奏 一条龙；真实录音扒谱评估 | Score 的 MusicXML 导出、SoundFont 回放、矢量 PDF；真实录音 F1 报告；Stage 能打开导出的谱 |

## 3. 工作流

### A · 模型与评估（核心）

| # | 事项 | 谁 | 时间 | 说明 / 验收 |
|---|---|---|---|---|
| A1 | **独立留出集 + 统一评估命令** | Claude | H1 | 训练里没用过的曲目（PDMX 子集、手选公有领域作品）；一个 `eval` 入口输出固定 JSON：半音冲突、强拍和弦音、声部进行（平行五八度、大跳）、音级分布 KL、重复结构、和弦换速；对照真实乐谱与 AMT |
| A2 | 和弦标签统一 | Claude（AugmentedNet 在云端）| H1 | AugmentedNet 重标非艺术歌曲训练乐谱，取代规则跟踪器；用 When in Rome / ABC 检查 |
| A3 | 9 小时收尾训练（学习率衰减 + EMA） | **用户** | H0 | `bash training/train_four_pillar_v31_anneal.sh`；完成后三份权重各评一次 |
| A4 | PDMX 数据扩充 | Claude | H1 | `no_license_conflict` + `all_valid`，按评分与去重筛选，写数据来源表 |
| A5 | **v3.2：“给定材料”通道** | Claude 写代码，**用户**训练 | H2 | 零初始化新通道，从 v3.1 微调；不依赖“选 N 份”也能少冲突；预读式（B 路线）保留为备选 |
| A6 | 配和声 v2 | Claude | H2 | 和声节奏偏密的问题（简单旋律几乎每拍换和弦）；读拍位/速度；对留出集评估 |
| A7 | 配器与人声 | Claude | H2 | 用满所要求的乐器；人声成为可预测的组；复调的声部进行先量化 |
| A8 | **真实录音扒谱评估** | **用户**转写，Claude 评估 | H2 | ASAP / MusicNet / 《冬之旅》+ mir_eval；写“模拟 vs 真实”的差距；再决定补音模型要不要重训 |
| A9 | **盲听实验** | Claude 做页面，用户找听众 | H2 | 静态页 A/B（随机顺序、导出 JSON）；≥10 人 × ≥20 段；消除顺序偏好（已观察到） |
| A10 | 长曲结构 | Claude | H3 | 64+ 小节的主题发展与回归；参考小节指针的评估 |

### B · 网页演示与产品

| # | 事项 | 谁 | 时间 | 说明 / 验收 |
|---|---|---|---|---|
| B1 | **修公开站的死角** | Claude / Codex | H0 | ✅ 公开编辑器返回总入口；Harmony / Stage 子路径缓存隔离；链接检查覆盖锚点、本机地址和发布边界 |
| B2 | **Score 无服务演示模式** | Claude / Codex | H1 | 🚧 公开试用模式已可编辑示例、回放、导入 MusicXML、导出 MIDI/PDF/SVG；不访问访客本机服务。五项任务的预生成伴奏候选仍待接入 |
| B3 | 试听库 | Claude | H1 | 把 v3.1 五项任务的 MIDI（共 30 段）渲染成音频并放进结果页；或用 SpessaSynth 在浏览器里直接播 |
| B4 | **新模型进浏览器** | Claude | H2 | 先量 v3.1（≈5.0M 参数）与配和声（0.87M）在 fp16/int8 下的大小与速度；ONNX Runtime Web；与 PyTorch 逐 logit 对照；首次加载 ≤ 10 MB 并显示进度 |
| B5 | 体积与首屏预算 | Claude | H1 | 站点 103 MB：音色 39 MB（首次播放才下载）、中文字体 15 MB（改子集）；首页 + 结果页 ≤ 3 MB |
| B6 | 无障碍与移动端 | Claude | H1 | 键盘可用、对比度、手机宽度；Lighthouse 进 CI |
| B7 | 英文化 | Claude | H1 | 各模块 README 与关键界面英文；中文保留 |

### C · 编辑器、演奏、和声（Score / Stage / Harmony）

| # | 事项 | 时间 | 说明 |
|---|---|---|---|
| C1 | SpessaSynth + MuseScore_General 回放 | H2 | 替代自写采样器；顺带离线渲染 WAV |
| C2 | svg2pdf.js + jsPDF 矢量 PDF；@tonejs/midi 导出 | H2 | 路线图 M2 现成项 |
| C3 | **MusicXML 导出**（M2-CORE-05） | H2 | 没有现成库，必须自己写；它一做好，Verovio 分谱与 MuseScore 互通都能接上 |
| C4 | Score ↔ Compose 流程 | H2 | “用 Compose 生成”、Compose 页“在 Score 中打开”；`--clash-penalty` 加进适配器（目前缺） |
| C5 | Stage 与 Score 对接 | H3 | Stage 能打开 Score 导出的 MusicXML/PDF；全景/无缝视图的批注与自动跟随 |
| C6 | Harmony → Score | H3 | 和声分析结果带入 Score 作和弦记号 |
| C7 | 历史、协作（M3-HIST / M4） | 后续 | ShareDB 服务器排序操作；按 ADR 不用 CRDT |

### D · 工程与发布

| # | 事项 | 谁 | 时间 | 说明 |
|---|---|---|---|---|
| D1 | 根脚本与 CI | Claude / Codex | ✅ H0 | 根 CI 与 Pages 发布均测试浏览器模块、检查 Score 并构建检查站点；预览 API 测试已不再依赖被忽略的训练清单 |
| D2 | 仓库瘦身 | Claude + **用户**决定 | H0–H1 | `Compose/archive`（67 MB，4 份相同的 4 MB 权重）移出主线（打 tag 保留）；评估 `Compose/validation`（38 MB）、`Harmony/demos`（33 MB） |
| D3 | 个人信息与历史 | **用户**决定 | H1 | 18 个文件含 `/Users/chenjinfu` 路径；162 个提交的作者邮箱是个人邮箱。公开宣传前决定：改写历史（git filter-repo + mailmap，之后强制推送）或保留 |
| D4 | 改名收尾 | Claude | H1 | 包名（`ailegro`→`@cantelvio/compose` 等）、页面标题、localStorage 键迁移；保留 `ailegro:serve` 等旧命令别名 |
| D5 | 可复现训练 | Claude | H2 | 锁定 Python 环境（已有 `requirements-lock.txt`）；一条命令评估；训练手册 |
| D6 | git-lfs | **用户** | H0 | 仓库装了 LFS 钩子但没有 `.gitattributes`；决定要不要用（大文件见 D2），不用就 `git lfs uninstall` |
| D7 | 文档 | Claude | H1 | 一张架构图、ADR 索引提到根目录、CONTRIBUTING、CHANGELOG、`CITATION.cff` |

### E · 许可与合规

| # | 事项 | 谁 | 时间 | 说明 |
|---|---|---|---|---|
| E1 | **许可证** | **用户**决定 | H0 | 建议代码用 Apache-2.0（含专利授权）；权重按数据来源**单独**授权，不跟代码一个许可 |
| E2 | **数据来源表** | Claude | H0–H1 | 每个模型 → 训练数据 → 许可 → 能否公开。Lieder（CC0）与合成数据训练的联合模型 v1 最有望公开；v3.1、配和声、补音模型用到的语料（SymphonyNet 版权不明、本地曲谱库）需逐项确认 |
| E3 | 模型卡 | Claude | H1 | 每个公开权重：用途、数据、指标（链到结果页）、局限、许可 |
| E4 | NOTICE 汇总 | Claude | H1 | 音色（MuseScore General，MIT）、字体（霞鹜文楷，OFL）、pdf.js、KaTeX、Bravura（OFL）等 |
| E5 | 非商用依赖标注 | Claude | H1 | MuScriptor 权重、部分评估数据集仅限非商用；README 写明 |
| E6 | 社区文件 | Claude | H1 | CODE_OF_CONDUCT、SECURITY、Issue/PR 模板（已移到根目录）|

## 4. 时间线

- **H0（本周，到 10-14）**：用户启动 A3；决定 E1 许可证、D6；Claude：审计文档（本次）、修死角、根 CI、数据来源表草稿。
- **H1（到 11-15，v0.1）**：A1 评估底座、A2/A4 数据、B2 无服务演示、B3 试听库、B5–B7、D2–D4、E2–E6。
- **H2（到 2027-01-31，v0.2）**：A5 v3.2 训练与评估、A6–A9、B4 浏览器新模型、C1–C4、D5。
- **H3（到 2027-04-30，v0.3）**：A10、C5–C6、真实录音结果、Stage 对接；视情况启动协作（C7）。

## 5. 质量门槛（提议值，需要用户确认）

| 指标 | 现在 | v0.2 门槛 |
|---|---|---|
| 配伴奏半音冲突，**不选候选**（留出集） | v3.1 在训练集窗口：21.9%（3 首旋律）/ 26.3%（24 首艺术歌曲） | ≤ 12%（艺术歌曲，留出集），不靠“选 N 份” |
| 强拍和弦拟合（艺术歌曲，对 AugmentedNet 标签） | 51.3%（v3.1 选 8 + 惩罚 4）；真实钢琴 93.1% | ≥ 65% |
| 和声分析逐拍完全一致（80 首测试） | 71.2% | ≥ 75% |
| 盲听 A/B（对 v3.1 基线） | 无 | ≥ 60% 偏好新版，≥10 人 × ≥20 段 |
| 音频→乐谱逐音 F1 | 模拟 89.1%；**真实录音未测** | 先出真实基线，再定目标 |
| 浏览器新模型 | 无 | 与 PyTorch 最大 logit 差 < 1e-3；首次加载 ≤ 10 MB |

## 6. 风险

- **没有留出集**：目前所有“更好”都是在训练集窗口上比做法；A1 是一切的前提。
- **许可**：训练数据版权不明会让大模型无法公开；不确定就不发权重，只发代码、评估和小模型。
- **算力**：训练只能在用户的 Mac 上跑（4 核虚拟机/M2 Pro），v3.2 与重训要排期；云端只做评估、小模型和数据处理。
- **只靠一个人维护**：范围先收窄到 v0.1，再扩。
- **指标 ≠ 听感**：和弦拟合依赖有噪声的标签，必须配盲听。

## 7. 维护约定

- 每个实验写一份 JSON 报告到 `Compose/training/reports/`，同时更新 `site/results/data.js`；结果页是唯一的“对外说法”。
- 完成一项就在这里打勾并写日期；决定变了就改这里，不另起文档。
- 提交信息说明改了什么、为什么；公开前跑 `npm test`、`npm run site:build`、`npm run site:check`。
