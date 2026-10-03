# 架构决策记录（ADR）

记录**有取舍的**决定：当时的背景、选择、后果、放弃的方案。已接受的 ADR 不改写；
要推翻时写一个新的 ADR，并把旧的标为“被 000N 取代”。

| 编号 | 决定 | 状态 |
| --- | --- | --- |
| [0001](0001-monorepo-typescript.md) | npm workspaces monorepo，全 TypeScript，核心包保持纯净 | 已接受 |
| [0002](0002-score-model.md) | 语义化乐谱模型：稳定 id、精确有理数时间、实际音高、一音一事件 | 已接受 |
| [0003](0003-own-engraving-engine-smufl.md) | 自研排版引擎 + SMuFL（Bravura），不用 VexFlow / Verovio | 已接受 |
| [0004](0004-commands-and-history.md) | 所有修改都是确定性的可序列化命令（immer patches 支撑撤销） | 已接受 |
| [0005](0005-ailegro-contract.md) | 与 AIlegro 只通过版本化 JSON 契约交互，AI 结果作为可审阅的建议 | 已接受 |
| [0006](0006-file-format.md) | `.ailegro.json`：规范化、逐事件一行、适合 git 的 JSON | 已接受 |
| [0007](0007-marks-graces-spanners.md) | 记号挂在事件上，倚音属于主音，线条放在全局 `spanners` 列表（格式 v2） | 已接受 |
| [0008](0008-locked-material-by-decoding.md) | 生成区间内的给定材料（配伴奏、配器、动机发展）用 AIlegro 的解码约束实现，不重训 | 已接受 |
| [0009](0009-harmonizer-model.md) | 配伴奏的和弦由单独训练的配和声模型（旋律 → 和弦）给出，v3.1 只写伴奏 | 已接受 |
| [0010](0010-harmonic-analysis-contract.md) | 和声分析用单独的契约（analysis-request/1 → analysis-result/1），结果作为可审阅的和弦记号 | 已接受 |

## 模板

```markdown
# 000N. 标题

- 状态：提议 / 已接受 / 被 000M 取代
- 日期：YYYY-MM-DD

## 背景
## 决定
## 后果
## 考虑过的其他方案
```
