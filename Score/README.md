# Cantelvio Score

新一代的网页打谱软件：可以写钢琴、室内乐和交响乐总谱，自带排版引擎，并作为 **Cantelvio**
（AI 作曲 / 续写 / 配器系统）的乐谱前端——在这里写下的旋律、和声、配器设定，可以直接整理成
Cantelvio 能读的输入；Cantelvio 写出的音乐也能回到乐谱里审阅、修改。

*A web-based notation editor for piano, chamber and orchestral music, with its own SMuFL engraving
engine and a first-class bridge to Cantelvio, an AI composition system.*

产品名称统一为 **Cantelvio Score**。新保存的曲谱使用 `.cantelvio.json`，旧曲谱仍可直接打开；
已有自动保存、最近文件和设置沿用原存储，更新名称不会清除它们。
推荐命令是 `npm run cantelvio:serve` 和 `npm run cantelvio:examples`，旧命令别名继续可用。

> 状态：早期开发（v0.1）。当前可以用的功能和下一步计划见 [docs/roadmap.md](docs/roadmap.md)。

顶栏的曲谱视图可选择 **无缝模式**：按可用宽度换行，整份曲谱连续向下滚动，没有分页空隙或页码。
页面视图和横向连续视图也可随时切换；打印及 PDF / SVG 导出仍使用纸张分页。
回放进度线按音频时钟连续前进，包括每小节的最后一拍、长音和休止。

本机联合演示：[全部功能入口](http://127.0.0.1:4187/demo/)，实际可用项、检查证据与重启方法见 [演示验证](docs/demo-verification.md)。

## 快速开始

需要 Node.js 22.12 或更新版本。

```sh
npm install
npm run dev        # 打开 http://127.0.0.1:5178/
npm run check      # 代码检查 + 类型检查 + 单元测试
npm run render -- --sample orchestra --out out/   # 无界面渲染示例乐谱为 SVG/PNG
npm run import:musicxml -- score.mxl --out out/score.cantelvio.json   # MusicXML → .cantelvio.json
npm run import:pdf -- score.pdf   # PDF / 图片识谱（需要 Audiveris，见 docs/pdf-import.md）
npm run cantelvio:serve             # 本机 Cantelvio 服务：作曲、和声分析、在编辑器里打开 PDF 和录音
```

## 和 Cantelvio 一起用

```sh
npm run cantelvio:serve   # 终端 1：找到 ../Compose、它的 Python 环境和最新的 v3.1 权重，启动本机服务
npm run dev             # 终端 2：编辑器
```

然后在编辑器右侧 **Cantelvio** 面板点“连接”→“直接生成”：生成的音乐以蓝色建议音符出现，
按批次接受或拒绝；“自动标和弦”给已有的音乐标和弦记号；“打开”PDF、图片或录音时由服务在后台识谱或扒谱。
不开服务器也可以导出请求文件、运行脚本、再导入结果；没有模型时用 `--mock` 测试整个流程。
一步步试用见 [docs/try-it.md](docs/try-it.md)，接口见 [docs/ailegro-integration.md](docs/ailegro-integration.md)。

## 项目结构

| 目录 | 内容 |
| --- | --- |
| `packages/core` | 乐谱数据模型、精确有理数时值、音高拼写、乐器与模板、编辑命令与撤销/重做、文件格式、文字输入、MusicXML 导入、回放时间线 |
| `packages/engraving` | 自研排版引擎：数据模型 → 分行分页 → SVG（SMuFL / Bravura 字形） |
| `packages/ailegro-bridge` | 与 Cantelvio 的数据交换：导出乐谱记录、生成作曲请求、导入生成结果 |
| `apps/web` | 网页编辑器（React + Vite） |
| `tools` | 命令行工具（无界面渲染等） |
| `docs` | 设计文档、架构决策记录（ADR）、路线图 |

## 文档

- [Cantelvio + Score 联合开发与开源接入](docs/open-source-integration-plan.md)
- [产品愿景与特色功能](docs/vision.md)
- [整体架构](docs/architecture.md)
- [乐谱数据模型](docs/score-model.md)
- [排版引擎](docs/engraving.md)
- [试用指南：Cantelvio Score + Cantelvio](docs/try-it.md)
- [与 Cantelvio 的接口](docs/ailegro-integration.md)
- [编辑器与输入方式](docs/editor.md)
- [版本历史、对比与实时协作](docs/collaboration-and-history.md)
- [文字记谱输入](docs/text-notation.md)
- [Git 工作流（与 Codex / Claude 协作）](docs/git-workflow.md)
- [开发环境](docs/dev-setup.md)
- [路线图](docs/roadmap.md)

AI 编程助手（Codex、Claude）请先读 [AGENTS.md](AGENTS.md)。

## 许可

尚未选择开源许可证（`UNLICENSED`，保留所有权利）。第三方资源：

- Bravura 字体字形（SIL Open Font License 1.1，© Steinberg Media Technologies GmbH）。
- Salamander Grand Piano 采样（Alexander Holm；CC-BY 3.0，作者后来声明进入公有领域），
  见 `apps/web/public/audio/salamander/NOTICE.txt`。
