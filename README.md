# Cantelvio

**从一段旋律，写到完整曲谱。** · *From a melody to a finished score.*

Cantelvio 用 Transformer 改进自动作曲的**和声与旋律**生成，并配有曲谱编辑器、和声可视化和演奏跟随工具，让生成结果可以被听、被比较、被修改。
Cantelvio is a research project on Transformer-based music generation, focused on better harmony and melody, with a notation editor, harmony visualisation and a performance-following tool around it.

> 状态 / Status：研究原型。生成结果需要用耳朵判断。Research prototype — judge the output by ear.

## 模块 / Modules

| 目录 | 名称 | 作用 |
|---|---|---|
| [`Compose/`](Compose/) | Cantelvio Compose | 音乐生成：给定旋律配伴奏、旋律与和声分析、浏览器内联合模型、训练与评估代码 |
| [`Score/`](Score/) | Cantelvio Score | 网页曲谱编辑器：候选比较与接受、回放、MusicXML 导入、MIDI / PDF / SVG 导出 |
| [`Harmony/`](Harmony/) | Cantelvio Harmony | Tonnetz 和声关系可视化 |
| [`Stage/`](Stage/) | Cantelvio Stage | PDF 读谱、演奏跟随与自动翻页 |

主线流程：给定旋律 → 生成伴奏 → 在 Score 中比较、编辑、接受 → 回放与导出 → 在 Stage 中演奏。

## 网页演示 / Web demo

[打开 Cantelvio 网页](https://chenjinfu00.github.io/Cantelvio/) · [编辑示例曲谱](https://chenjinfu00.github.io/Cantelvio/score/?demo=continue) · [试听模型结果](https://chenjinfu00.github.io/Cantelvio/results/#s-listen)

公开网页可直接使用编辑器的示例、编辑、回放和导出，Harmony，以及 Stage 的 PDF 读谱与批注；Compose 提供浏览器联合模型和预生成试听。公开编辑器不会连接访客的本机生成服务。AI 作曲、和声分析、PDF 识谱和录音转谱需使用本机完整版。MusicXML 目前支持导入，导出尚未实现。
The public editor supports examples, editing, playback, MusicXML import, and MIDI/PDF/SVG export. AI composition, harmony analysis, PDF recognition and audio transcription require the local version. MusicXML export is not implemented yet.

所有公开页面共用「⚙ 外观设置」：可选择跟随系统、浅色、深色，调整主色和自定义背景色；切换页面或刷新后继续沿用，同源的已打开页面也会同步更新。偏好保存在当前浏览器，按项目隔离；恢复默认只重置外观，不影响作品或模块设置。谱纸、批注、声部和乐器标记保留各自的功能颜色。
Every public page shares the Appearance settings: system/light/dark mode, accent and custom background. Preferences persist in this browser and sync between open pages of this project. Reset affects appearance only; music paper and functional music/annotation colors retain their meaning.

```sh
npm ci --prefix Score
npm run site:build             # 构建公开试用模式的编辑器与完整静态站
npm run site:check             # 检查页面、相对链接、锚点及发布边界
npm run site:serve
```

生成的 `site-dist/` 是纯静态站（入口页 + Score + Harmony + Stage + Compose 的浏览器内模型页），推送到 `main` 后由 `.github/workflows/pages.yml` 部署到 GitHub Pages。
GitHub 仓库的 Settings → Pages → Source 应选择 **GitHub Actions**。部署先运行三个浏览器模块的测试与 Score 完整检查，再构建、检查链接，全部通过后发布。`version.json` 记录已发布提交；`site-dist/` 不包含 Python 检查点或大型第三方权重。
`site/results/` 是实验与评估结果页（数据在 `site/results/data.js`，更新数字只改这一个文件）。
完整的伴奏生成、连续演奏和录音转谱需要本机 Python 服务，不在静态站里。
The static site contains everything that runs in the browser. Full accompaniment generation, continuous performance and audio-to-score need the local Python service and are not part of it.

## 在本机运行 / Run locally

需要 Node ≥ 22.12（Score）/ ≥ 20（其余）。各模块的细节见它们自己的 README。

```sh
# Compose：本机服务（http://127.0.0.1:4187/）。完整生成需要 PyTorch 环境和模型权重，见 Compose/README.md
cd Compose && npm start
# Score：编辑器（http://127.0.0.1:5178/）
cd Score && npm ci && npm run dev
# Score ↔ Compose：让编辑器调用本机生成服务
cd Score && npm run cantelvio:serve
# Harmony（http://127.0.0.1:4174/tonnetz/）
cd Harmony && npm start
# Stage
cd Stage && npm run preview
```

测试：在根目录 `npm test` 运行 Compose / Harmony / Stage 及共用外观的测试，`npm run check:score` 运行 Score 的检查；`npm run site:build && npm run site:check` 建站并检查链接。

## 路线图 / Roadmap

长期计划见 [ROADMAP.md](ROADMAP.md)，现状审计见 [docs/AUDIT-2026-10-07.md](docs/AUDIT-2026-10-07.md)，所有实验结果见 [结果页](site/results/)。内部交接与迁移记录见 [docs/INTERNAL-HANDOFF.md](docs/INTERNAL-HANDOFF.md)。

## 许可与数据 / Licences and data

**许可证尚未确定**，首次公开发布前会补上。部分依赖和数据有各自的限制（例如 MuScriptor 权重和若干评估数据集仅限非商用），清单在 [`Compose/OPEN-SOURCE-INVENTORY.md`](Compose/OPEN-SOURCE-INVENTORY.md)。
**The licence is not yet decided** and will be added before the first public release. Some dependencies and datasets are non-commercial only; see `Compose/OPEN-SOURCE-INVENTORY.md`.
