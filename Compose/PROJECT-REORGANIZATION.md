# 同级项目整理与验证 — 2026-09-27

三个独立项目位于同一个 `我的编曲&打谱/` 目录：

```text
我的编曲&打谱/
├── AIlegro/                  自动伴奏与生成音乐控制台
│   ├── src/                  UI、排程、八小节和弦谱、音频
│   ├── vendor/               本地和声与旋律模型、权重、音乐模块
│   ├── media/                本地音源
│   ├── training/             训练、原始/处理后数据、检查点、评估
│   ├── research/             旧 Tonnetz 伴奏研发记录
│   └── archive/              旧演示与 Tonnetz v91 完整快照
├── Tonnetz/                  键盘、网格及现有全部功能
│   └── demos/MusicalKaraoke/ 原有浏览器演示
└── Volta/                    读谱翻页应用与原有 Git 工作目录
    └── archive/working-files/ 原外层 output、tmp 工作材料
```

## 本次范围

- AIlegro 的 UI、模型推理、权重、音源、训练脚本、评估、原始乐谱、处理后语料和参数检查点均在本项目内。无需导入同级 Tonnetz 的源代码。
- 当前 Python 训练环境已迁移到 `.venv-training/`，并修正启动路径。此虚拟环境仍使用本机 Python，复制到另一台电脑时按 `training/README.md` 重建环境。
- 自动伴奏及模型的后续开发归 AIlegro；Tonnetz 原有伴奏入口、功能、运行时权重和测试完整保留。旧训练脚本已搬入 AIlegro 历史目录，当前可执行入口见 `training/scripts/`。
- Volta 从旧 `volta/ui-redesign/` 提升为独立根目录，保留原 `.git`、HEAD、未提交修改和未跟踪文件。改正本地曲谱路径查找及对应测试；曲谱库没有移动。原 `曲谱&编曲/volta` Git 源仓库未改动。
- 未重新训练、未替换模型、未改变 AIlegro/Tonnetz 的 UI 或演奏逻辑、未发布线上版本。

## 验证结果

| 项目 | 结果 |
| --- | --- |
| 搬迁时内容核对 | 2,067 个源文件逐文件 SHA-256 一致；排除 Git 内部文件、依赖、虚拟环境和缓存，目录原样搬迁 |
| AIlegro 自动测试 | 29/29 通过 |
| Tonnetz 自动测试 | 86/86 通过 |
| Volta 自动测试 | 155/155 通过，无跳过 |
| 原浏览器演示测试 | 75/75 通过 |
| 训练语料表示测试 | 3/3 通过 |
| Harmony / Melody | 独立加载，前向输出与导出探针对齐，各一次有限值反向传播；没有训练循环 |
| Harmony / Melody 参数 | 204,391 / 349,325 |
| 导出探针最大误差 | 约 9.54e-7 / 7.45e-9 |
| 固定原始乐谱版本 | 原始归档 SHA-256 通过；从固定版本源树重建的语料与随项目数据逐字节一致 |
| 模型/音源清单 | 57/57 文件与既有清单一致 |
| 最终运行时代码核对 | 213 个 AIlegro/Tonnetz 运行时及测试文件内容未变 |
| HTTP 实际服务文件 | AIlegro 71 个、Tonnetz 136 个，与新目录文件逐字节一致 |
| Volta 曲谱路径 | 正确解析到 `曲谱&编曲/本地曲谱` |

训练检查、完整测试输出和 HTTP 核对摘要在 `validation/reorganization-20260927/`；搬迁映射与 SHA-256 清单为 `PROJECT-MIGRATION.json`。当前旋律验证集评估和五种风格的生成测量见 `training/reports/`。这些不是新的主观试听结论。

运行时代码没有变化，因此本次未重复设备/音频视觉测试。既有 UI 与声音验证仍作为历史证据保留。

## 继续工作

- AIlegro：在本目录运行 `npm start`，打开 <http://127.0.0.1:4187/>。
- Tonnetz：在同级 Tonnetz 运行 `npm start`，打开 <http://127.0.0.1:4174/tonnetz/>。
- 两个本地预览已从新目录重新启动，地址不变，浏览器保存的个人场景未清除。
- 给其他 AI 打开此 `AIlegro/` 文件夹，先读 `START_HERE.md`、`AGENTS.md` 和 `training/README.md`。
