# AIlegro Score

新一代的网页打谱软件：可以写钢琴、室内乐和交响乐总谱，自带排版引擎，并作为 **AIlegro**
（AI 作曲 / 续写 / 配器系统）的乐谱前端——在这里写下的旋律、和声、配器设定，可以直接整理成
AIlegro 能读的输入；AIlegro 写出的音乐也能回到乐谱里审阅、修改。

*A web-based notation editor for piano, chamber and orchestral music, with its own SMuFL engraving
engine and a first-class bridge to AIlegro, an AI composition system.*

> 状态：早期开发（v0.1）。当前可以用的功能和下一步计划见 [docs/roadmap.md](docs/roadmap.md)。

## 快速开始

需要 Node.js 22.12 或更新版本。

```sh
npm install
npm run dev        # 打开 http://127.0.0.1:5178/
npm run check      # 代码检查 + 类型检查 + 单元测试
npm run render -- --sample orchestra --out out/   # 无界面渲染示例乐谱为 SVG/PNG
```

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `packages/core` | 乐谱数据模型、精确有理数时值、音高拼写、乐器与模板、编辑命令与撤销/重做、文件格式、文字输入、回放时间线 |
| `packages/engraving` | 自研排版引擎：数据模型 → 分行分页 → SVG（SMuFL / Bravura 字形） |
| `packages/ailegro-bridge` | 与 AIlegro 的数据交换：导出乐谱记录、生成作曲请求、导入生成结果 |
| `apps/web` | 网页编辑器（React + Vite） |
| `tools` | 命令行工具（无界面渲染等） |
| `docs` | 设计文档、架构决策记录（ADR）、路线图 |

## 文档

- [产品愿景与特色功能](docs/vision.md)
- [整体架构](docs/architecture.md)
- [乐谱数据模型](docs/score-model.md)
- [排版引擎](docs/engraving.md)
- [与 AIlegro 的接口](docs/ailegro-integration.md)
- [编辑器与输入方式](docs/editor.md)
- [版本历史、对比与实时协作](docs/collaboration-and-history.md)
- [文字记谱输入](docs/text-notation.md)
- [Git 工作流（与 Codex / Claude 协作）](docs/git-workflow.md)
- [开发环境与 iCloud 注意事项](docs/dev-setup.md)
- [路线图](docs/roadmap.md)

AI 编程助手（Codex、Claude）请先读 [AGENTS.md](AGENTS.md)。

## 许可

尚未选择开源许可证（`UNLICENSED`，保留所有权利）。第三方资源：Bravura 字体（SIL Open Font
License 1.1，© Steinberg Media Technologies GmbH）。
