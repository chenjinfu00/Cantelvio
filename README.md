# Cantelvio

**从一段旋律，写到完整曲谱。** · *From a melody to a finished score.*

Cantelvio 用 Transformer 改进自动作曲的**和声与旋律**生成，并配有曲谱编辑器、和声可视化和演奏跟随工具，让生成结果可以被听、被比较、被修改。
Cantelvio is a research project on Transformer-based music generation, focused on better harmony and melody, with a notation editor, harmony visualisation and a performance-following tool around it.

> 状态 / Status：研究原型。生成结果需要用耳朵判断。Research prototype — judge the output by ear.

## 模块 / Modules

| 目录 | 名称 | 作用 |
|---|---|---|
| [`Compose/`](Compose/) | Cantelvio Compose | 音乐生成：给定旋律配伴奏、旋律与和声分析、浏览器内联合模型、训练与评估代码 |
| [`Score/`](Score/) | Cantelvio Score | 网页曲谱编辑器：候选比较与接受、回放、MusicXML / MIDI / PDF 导入导出 |
| [`Harmony/`](Harmony/) | Cantelvio Harmony | Tonnetz 和声关系可视化 |
| [`Stage/`](Stage/) | Cantelvio Stage | PDF 读谱、演奏跟随与自动翻页 |

主线流程：给定旋律 → 生成伴奏 → 在 Score 中比较、编辑、接受 → 回放与导出 → 在 Stage 中演奏。

## 网页演示 / Web demo

```sh
node site/build.mjs            # 用已有的 Score 构建产物
node site/build.mjs --build    # 先重新构建 Score（需要 Score 里 npm ci）
python3 -m http.server -d site-dist 8080
```

生成的 `site-dist/` 是纯静态站（入口页 + Score + Harmony + Stage + Compose 的浏览器内模型页），推送到 `main` 后由 `.github/workflows/pages.yml` 部署到 GitHub Pages。
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
cd Score && npm run ailegro:serve
# Harmony（http://127.0.0.1:4174/tonnetz/）
cd Harmony && npm start
# Stage
cd Stage && npm run preview
```

测试：`npm test` 分别在 `Compose/`、`Score/`、`Harmony/`、`Stage/` 中运行。

## 路线图 / Roadmap

分阶段计划见 [ROADMAP.md](ROADMAP.md)。内部交接与迁移记录见 [docs/INTERNAL-HANDOFF.md](docs/INTERNAL-HANDOFF.md)。

## 许可与数据 / Licences and data

**许可证尚未确定**，首次公开发布前会补上。部分依赖和数据有各自的限制（例如 MuScriptor 权重和若干评估数据集仅限非商用），清单在 [`Compose/OPEN-SOURCE-INVENTORY.md`](Compose/OPEN-SOURCE-INVENTORY.md)。
**The licence is not yet decided** and will be added before the first public release. Some dependencies and datasets are non-commercial only; see `Compose/OPEN-SOURCE-INVENTORY.md`.
