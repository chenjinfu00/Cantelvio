# 0005. 与 AIlegro 只通过版本化 JSON 契约交互

- 状态：已接受
- 日期：2026-10-01

## 背景

AIlegro 是独立演进的 Python 项目（训练、采样、四支柱 v3.1 编码器、自己的 `AGENTS.md`）。
AIlegro Score 要为它提供输入、接收它的输出，但两个项目节奏不同，不能互相改代码。

## 决定

- 三个带版本号的 JSON 契约（`packages/ailegro-bridge/src/schemas.ts`）：
  `ailegro.score-record/1`（乐谱记录）、`ailegro.compose-request/1`（作曲请求）、
  `ailegro.compose-result/1`（生成结果）。
- 约定与 AIlegro 训练代码一致：四分音符分数字符串、发声 MIDI、六个乐器组、声部身份、
  合并连线、缺失信息为 null、AIlegro 的和弦性质顺序。
- 请求里的每个条件带 `timeSpan`、`known`、`hardLock`、`source`（AIlegro 的统一请求契约）。
- AIlegro 的结果以**可审阅的建议**进入乐谱（`source.kind = 'ai'`，未接受时蓝色显示，
  默认不再作为材料导出），按生成批次接受或拒绝。
- 参考适配器 `integrations/ailegro/score_compose.py` 放在**本仓库**：它实现的是本项目的契约，
  只 import AIlegro 的模块，永不修改 AIlegro。

## 后果

- 两边可以独立开发；契约变化通过版本号显式管理。
- AIlegro 的模型接口变化时，只需改适配器。
- 生成区间内的“锁定材料”任务（伴奏、配器、动机发展）在契约里已经能表达，但要等 AIlegro 解码器支持。

## 考虑过的其他方案

- 在浏览器里直接运行模型（ONNX/WebGPU）：模型和采样逻辑在 Python 里持续变化，过早固化。
- 直接读写 AIlegro 的内部数据格式：耦合太紧，AIlegro 改一个字段这边就坏。
- MusicXML 作为交换格式：缺少乐器组、声部身份、条件（锁定 / 已知）等 AIlegro 需要的信息。
