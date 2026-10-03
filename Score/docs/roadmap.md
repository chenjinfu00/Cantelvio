# 路线图

任务 id 格式 `M<里程碑>-<领域>-<编号>`，领域：`CORE`、`ENG`（排版）、`AI`（AIlegro）、`WEB`、
`HIST`（版本历史）、`COLLAB`（协作）、`DOCS`、`OPS`。开始做某个任务时在“负责人”填上名字或助手
（如 `codex`、`claude`），分支名带上任务 id（见 [git-workflow.md](git-workflow.md)）。

状态：✅ 完成 · 🚧 进行中 · ⏳ 待做 · ⛔ 受阻（写明原因）

## 当前状态（2026-10-02）

能用的：

- 乐谱模型、精确时值、移调乐器、多声部、连音、拍号/调号/速度/谱号变化、和弦记号、来源标记。
- 记号与线条（格式 v2）：演奏法、装饰记号、震音、琶音、换气、小音符、倚音；连线、渐强渐弱、
  八度记号、踏板、颤音线——都能输入、排版、回放，并导出给 AIlegro（倚音、渐强渐弱）。
- 41 种编辑命令（含批处理），撤销/重做，`.ailegro.json` 规范格式（逐事件一行，适合 git）。
- 自研排版：SMuFL Bravura 字形、按时值间距、分行对齐、分页、总谱括号、移调记谱、AI 建议样式、
  按轮廓线避让的线条与记号。
- 编辑器：MuseScore 式键盘输入 + 鼠标输入、Sibelius 式浮动小键盘（6 个标签页）、输入时画线条、
  选择与范围操作、乐器管理、文字记谱输入（v1）、属性面板、新建对话框（钢琴到双管编制交响乐的模板）、
  回放（钢琴采样 + 合成音色）、保存（写回原文件）/ 另存为 / 打开 / 最近文件 / 拖放打开 / 自动保存、
  SVG 导出、打印。
- AIlegro：乐谱记录、作曲请求、结果导入为可审阅建议；本机适配服务器（`--serve`）与文件交换；
  `--mock` 往返测试。五项任务都能用训练好的 v3.1 运行（续写、依和弦写旋律、为旋律配伴奏、动机发展、配器），
  `npm run ailegro:examples` 写出示例请求并检查导入结果；为旋律配伴奏时和弦由 AIlegro 的配和声模型给出。
- 中英文界面，116 个单元测试，CI（lint、类型检查、测试、构建、示例渲染）。

最需要先做的：在 Mac 上用真实权重跑一遍 `M3-AI-01` 的检查清单并试听、`M2-ENG-01`（增量排版）、
`M2-ENG-02`（多声部碰撞）。

## M1 · 基础（v0.1）✅

| id | 任务 | 状态 |
| --- | --- | --- |
| M1-OPS-01 | monorepo、TypeScript、ESLint、Prettier、Vitest、CI、Git 规范、AGENTS.md | ✅ |
| M1-CORE-01 | 乐谱模型、有理数时值、音高拼写、乐器目录（51 种）与模板（10 种） | ✅ |
| M1-CORE-02 | 命令系统、撤销/重做（immer patches）、结构校验 | ✅ |
| M1-CORE-03 | `.ailegro.json` 文件格式 v1、文字记谱 v0、回放时间线、示例乐谱 | ✅ |
| M1-ENG-01 | SMuFL 排版引擎、SVG 输出、命中测试几何、无界面渲染工具 | ✅ |
| M1-AI-01 | 三个契约（score-record / compose-request / compose-result）与导入 | ✅ |
| M1-AI-02 | 参考适配器 `score_compose.py`（文件、`--serve`、`--mock`、`--dry-run`） | ✅（真实权重未验证 → `M3-AI-01`） |
| M1-WEB-01 | 编辑器 MVP（输入、面板、回放、文件、AIlegro 面板） | ✅ |
| M1-DOCS-01 | 设计文档、ADR、路线图 | ✅ |

## M2 · 记谱完整性与性能（v0.2）

| id | 任务 | 状态 | 负责人 |
| --- | --- | --- | --- |
| M2-ENG-01 | **增量排版**：以 `StaffMeasure` 对象为键缓存每小节的记谱与间距列，只重做分行/对齐；目标：300 小节双管编制每次按键 < 50 ms | ⏳ | |
| M2-ENG-02 | 同一谱表多声部的符头碰撞偏移、休止符避让 | ⏳ | |
| M2-ENG-03 | 连线（slur）：模型字段 + 命令 + 排版（贝塞尔、避让）+ 编辑器 | ✅ | claude |
| M2-ENG-04 | 渐强渐弱（hairpin）；导出为 AIlegro 的 `wedge` | ✅ | claude |
| M2-ENG-05 | 行末提示调号/拍号；小节线前的谱号变化 | ⏳ | |
| M2-ENG-06 | 临时记号显示覆盖（show / cautionary / hide）生效 | ⏳ | |
| M2-ENG-07 | 合并多小节休止；分谱（单个乐器的声部谱）版面 | ⏳ | |
| M2-ENG-08 | 歌词 | ⏳ | |
| M2-ENG-09 | 装饰音、装饰记号、八度记号、踏板 | ✅（另有震音、琶音、颤音线、小音符） | claude |
| M2-ENG-10 | 连线的手动调整（上下、形状）；跨谱表、跨声部、连到倚音的连线 | ⏳ | |
| M2-ENG-11 | 滑音（glissando）、踏板换踏、震音（两音之间）、和弦里单个音的记号 | ⏳ | |
| M2-CORE-01 | 反复记号与房子（volta）、D.C./D.S.，回放展开 | ⏳ | |
| M2-CORE-02 | 复制 / 粘贴（范围剪贴板 → 命令） | ⏳ | |
| M2-CORE-03 | 文字记谱按记谱音高输入（移调乐器的记谱调号） | ⏳ | |
| M2-CORE-04 | MusicXML 导入（导入的内容带 `source: import`） | ⏳ | |
| M2-CORE-05 | MusicXML、MIDI 导出 | ⏳ | |
| M2-CORE-06 | 文件格式 v2（事件记号、倚音、`spanners`，v1 迁移）、文字记谱 v1 | ✅ | claude |
| M2-WEB-01 | 复制粘贴界面；范围移调、范围改时值 | ⏳ | |
| M2-WEB-02 | 快速插入面板：力度、谱号、调号、拍号、演奏法 | 🚧 小键盘已有力度、演奏法、装饰、线条；谱号、调号、拍号还在属性面板 | |
| M2-WEB-03 | 更好的回放音色（弦乐、木管、铜管采样或 SoundFont） | ⏳ | |
| M2-WEB-04 | 排版放进 Web Worker（配合 M2-ENG-01） | ⏳ | |
| M2-WEB-05 | Safari、Firefox 兼容性检查 | ⏳ | |
| M2-WEB-06 | Playwright 端到端测试进 CI（流程见 [editor.md](editor.md#手动检查清单改编辑器后过一遍)） | ⏳ | |
| M2-WEB-07 | 矢量 PDF 导出（页面尺寸准确） | ⏳ | |
| M2-WEB-08 | 浮动小键盘（Sibelius Keypad + MuseScore 面板）、输入时画线条 | ✅ | claude |
| M2-WEB-09 | 文件：写回原文件、另存为、最近文件、拖放打开、未保存提醒 | ✅ | claude |

## M3 · AIlegro 深度集成与版本历史（v0.3）

| id | 任务 | 状态 | 负责人 |
| --- | --- | --- | --- |
| M3-AI-01 | **在 AIlegro 环境用训练好的权重运行适配器**，核对 `load` / `feed_bar` / `next_bar` 参数与返回值，修正适配器 | 🚧 云端用第 45,225 步权重端到端跑通（2026-10-02）；Mac 上待跑一次并试听 | claude |
| M3-AI-02 | 生成区间内的锁定材料：`accompany-melody`、`orchestrate`、`develop-motif` | ✅ 用 AIlegro 解码约束实现（[ADR 0008](adr/0008-locked-material-by-decoding.md)） | claude |
| M3-AI-03 | 声部角色（旋律 / 低音 / 和声）界面 → 记录里的 `role` | ⏳ | |
| M3-AI-04 | 文字意图与风格标签（需要 AIlegro 定义词表） | ⛔ 等 AIlegro 侧 | |
| M3-AI-05 | 一次请求多个候选（不同种子），并排比较后选择 | ⏳ | |
| M3-AI-06 | 部分接受：按小节 / 按乐器接受 AI 建议 | ⏳ | |
| M3-AI-07 | 配和声：AIlegro 侧“旋律 → 和弦”小模型，先出和弦记号给用户改，再锁定和弦写伴奏 | ✅ 配和声模型 v1 + 适配器 `--harmonizer`（[ADR 0009](adr/0009-harmonizer-model.md)）；和弦随结果导入为和弦记号 | claude |
| M3-AI-08 | 动机发展的变形方式（重复、模进、倒影、增值、截取）在面板里逐小节选择 → `compose-request/2` | ⏳ | |
| M3-HIST-01 | 命名版本：IndexedDB、自动版本、时间线面板 | ⏳ | |
| M3-HIST-02 | `diffScores` 语义对比（core）+ 测试 | ⏳ | |
| M3-HIST-03 | 对比界面（叠加 / 并排） | ⏳ | |
| M3-HIST-04 | `tools/score-diff.ts`，git 外部 diff | ⏳ | |
| M3-HIST-05 | 三方合并 + 冲突界面 | ⏳ | |

设计见 [collaboration-and-history.md](collaboration-and-history.md)、[ailegro-integration.md](ailegro-integration.md)。

## M4 · 多人实时协作（v0.4）

| id | 任务 | 状态 | 负责人 |
| --- | --- | --- | --- |
| M4-COLLAB-01 | 协议定稿与版本化 schema | ⏳ | |
| M4-COLLAB-02 | 协作服务器（Node + WebSocket，日志 + 快照） | ⏳ | |
| M4-COLLAB-03 | 客户端同步与本地命令重放 | ⏳ | |
| M4-COLLAB-04 | 在线状态（远端选择与光标） | ⏳ | |
| M4-COLLAB-05 | 按用户撤销 | ⏳ | |

## M5 · 产品化（v1.0）

| id | 任务 | 状态 |
| --- | --- | --- |
| M5-OPS-01 | 选择许可证（目前 UNLICENSED） | ⏳ |
| M5-OPS-02 | 部署（静态站点 + 协作服务器）、账号与分享 | ⏳ |
| M5-WEB-01 | 桌面打包（Tauri）以便本机文件读写 | ⏳ |
| M5-WEB-02 | 无障碍（键盘导航、屏幕阅读器标签） | ⏳ |
| M5-WEB-03 | 性能目标：双管编制 300 小节流畅编辑与回放 | ⏳ |
