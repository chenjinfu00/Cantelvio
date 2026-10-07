# Cantelvio 路线图（2026-10-07）

目标：把 Compose / Score / Harmony / Stage 做成一个整体，有可公开的网页演示，并最终在 GitHub 开源。
核心主线：**改进 Transformer 的和声与旋律生成**；编辑器和演示是让这件事可用、可评估、可发布的载体。

## 发布形态（已确定的假设，可改）
- **公开网页（GitHub Pages，纯静态）**：首页 `site/index.html` + Score 编辑器 + Harmony + Stage + Compose 的浏览器内联合模型页。`node site/build.mjs [--build]` 生成 `site-dist/`（约 100 MB），`.github/workflows/pages.yml` 在推送 main 后部署。
- **本机完整版**：Compose 的 Python 服务（v3.1 伴奏、连续演奏、录音转谱）需要 PyTorch 和权重，不进网页；README 写清安装步骤。网页上给出“需要本机服务”的说明，而不是假装可用。

## 阶段

### P0 · 发布底座（本轮已完成大部分）
- [x] 统一入口页（中英双语）与静态站构建脚本，所有路径相对，可放在子路径。
- [x] GitHub Pages 工作流。
- [ ] 根目录 `README.md` 改为面向公众的介绍（现在是内部交接说明，另存为 `docs/INTERNAL-HANDOFF.md`）。
- [ ] 选许可证；确认浏览器模型权重的训练数据许可（见 README 开源前清单第 2 条）。
- [ ] 把 `Score/.github` 移到根目录，CI 覆盖四个模块；个人路径/邮箱清理。
验收：在干净克隆上 `node site/build.mjs --build` 通过；Pages 部署后各入口可打开。

### P1 · 统一品牌与连通流程（约 1 周）
- 页面标题、导航、包名、存储键改为 Cantelvio / 四个模块名（保留迁移兼容，不全局替换）。
- 四个模块互相链接：Score 里“用 Compose 生成”、Compose 演示页“在 Score 中打开”、Harmony 的分析结果可带入 Score、Stage 可打开 Score 导出的 PDF/MusicXML。
- 网页端在没有本机服务时降级：隐藏或标注依赖服务的按钮，给出启动说明。
- Score 路线图里的现成项：SpessaSynth 回放音色、svg2pdf 矢量 PDF、@tonejs/midi 导出（见 `open-source` 清单）。

### P2 · 模型质量：和声与旋律（核心，约 2–3 周）
1. AMT 对照（约 1 天）：同样的冲突/强拍和弦音指标比较 v3.1 与 AMT，决定 v3.2 走“给定材料通道（A）”还是“预读式训练（B）”。
2. 统一和弦标签：AugmentedNet 重标非艺术歌曲训练乐谱，替代规则 ChordTracker。
3. 数据：PDMX 选子集（`no_license_conflict` + `all_valid`，按评分、去重）。
4. v3.2 训练与评估：伴奏冲突率、强拍和弦音比例、和声分析一致性（When in Rome / ABC 对照）、盲听 A/B。
5. 浏览器推理改用 ONNX Runtime Web，新模型进网页演示。
验收：评估表中冲突率与强拍和弦音比例优于 v3.1，且盲听不劣。

### P3 · 评估与演示内容（并行）
- 真实录音评估扒谱（ASAP / MusicNet / 《冬之旅》，需要在 Mac 上用 MuScriptor 转写）。
- 站上放一组预先生成的示例（旋律 → 伴奏 → 编辑后的谱），在没有服务的访客也能听、能看。
- 一页“模型怎么工作、怎么评估”的说明与已知局限。

### P4 · 开源发布
- 许可证、NOTICE、数据/权重来源表；大文件（>10 MB）改 LFS 或 Release 附件。
- 新建公开仓库并推送 main；处理旧 `chenjinfu00/volta`（存档并指向新仓库）。
- 发布说明、截图/GIF、Issue 与贡献模板。

## 现在需要用户决定的事
1. 许可证（MIT / Apache-2.0 / 其他）；MuScriptor 与部分数据集是非商用，整体是否标注“仅研究”。
2. 浏览器模型权重能否公开（训练用了本地曲谱库）。
3. GitHub 仓库名与是否使用 noreply 邮箱。
