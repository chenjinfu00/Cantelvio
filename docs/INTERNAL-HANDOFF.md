# Cantelvio：改名与整合规划（内部交接说明；面向公众的介绍见根目录 README.md）

更新：2026-10-08（当前展示品牌与服务入口已统一；下方迁移验证保留历史记录）

## 给 Claude 的交接说明

四个音乐模块共用 **Cantelvio** 品牌：Compose、Score、Harmony 和 Stage。当前界面、现行说明以及 Compose 与 Score 的包名使用 Cantelvio；本机服务推荐入口为 `cantelvio:serve`。原有作品格式、生成接口和浏览器保存键继续兼容，历史训练日志与来源证据保持原样。

**2026-10-06 迁移记录：** 四个文件夹已移入本目录，并按模块名改为 `Compose/`、`Score/`、`Harmony/`、`Stage/`；项目间相对路径（`../Compose`、`../Score` 等）、Score 的服务默认路径和适配器脚本路径、各项目说明文档里的本机路径已同步更新。日志、训练 manifest、validation 记录等历史文件保留原路径。

## 项目分工与目标目录

| 模块 | 文件夹 | 对外模块名称 | 职责 |
|---|---|---|---|
| Compose | `Compose/` | Cantelvio Compose | 音乐生成、旋律分析、给定旋律配伴奏 |
| Score | `Score/` | Cantelvio Score | 乐谱编辑、候选比较与接受、回放和导出 |
| Harmony | `Harmony/` | Cantelvio Harmony | 和声关系与音乐理论可视化 |
| Stage | `Stage/` | Cantelvio Stage | PDF 读谱、演奏跟随与自动翻页 |

搬迁前四个项目位于 `/Users/chenjinfu/software develop/`。现在的结构：

```text
Cantelvio/
├── README.md
├── Compose/
├── Score/
├── Harmony/
└── Stage/
```

## 接下来的简短计划

1. **迁移并验证。** ✅ 2026-10-06 完成，详见下方“迁移验证记录”。
2. **统一展示名称。** ✅ 当前页面标题、导航、介绍、包名和推荐服务入口已统一。代码标识、接口、存储键和历史路径按兼容需要处理。
3. **连通创作流程。** 以“给定旋律 → 生成伴奏 → 在 Score 中比较、编辑与接受 → 回放、导出及演奏”为主线；Harmony 辅助分析，Stage 承接读谱演奏。
4. **继续改善音乐质量。** 保留简单／中等／专业三档与乐器演奏限制，优先改进和声适配、自然织体和生成速度。默认保留模型原始织体与力度，避免把所有输出强制改成固定分解和弦。

## 开发时保留的上下文

- 本轮改名不涉及更换模型、覆盖权重或重新训练；迁移后先验证当前效果，再讨论模型调整。
- 自研模型与编辑器继续作为核心；结合已整理的开源工具。AMT 用于对照评估，下载完成不等于已经接入默认生成流程。
- 进入子项目时先读其 `AGENTS.md`，以及存在的 `CLAUDE.md`、`START_HERE.md`；保留各项目自己的开发规则。
- 现有共同规划与开源清单在 `Compose/JOINT-DEVELOPMENT-PLAN.md`、`Compose/OPEN-SOURCE-INVENTORY.md`。具体实现与验证以子项目代码和记录为准。

## 迁移验证记录（2026-10-06）

**修复**

- Stage：原 `.git` 借用旧 iCloud 仓库（`曲谱&编曲/volta`）的对象库，已从 GitHub（chenjinfu00/volta）补齐全部对象并去掉 alternates；`git fsck` 通过，HEAD、分支和未提交修改保持原样。origin 仍指向原 iCloud 仓库。
- Stage：本地曲谱库查找在项目旁边找不到时，回退到 iCloud 的 `曲谱&编曲/本地曲谱`（`scripts/library-root.mjs`，测试同步更新）。
- Compose：`.venv-training` 和 `MuScriptor-large-1.3B/.venv-py312` 的启动脚本、activate 改为新路径（路径含空格，脚本改用 pip 的 `/bin/sh` 启动写法）；`training/orchestra/work/python-path` 更新。
- Score：`ailegro:serve` 默认找 `../Compose`；编辑器适配器路径改为 `../Score/...`（源码和现有 `dist`）。

**检查结果**

| 模块 | 检查 | 结果 |
|---|---|---|
| Compose | `npm test` | 68/68 通过 |
| Compose | 本地服务 4187、`/demo/`、`/api/demo/status` | 正常 |
| Score | typecheck、vitest、build、adapter 测试 | 全部通过（192 测试、8 adapter 测试） |
| Score → Compose | `ailegro:serve` 路径解析；8 个示例请求用 v3.1 真实权重生成/分析并导回编辑器检查 | 全部成功，0 problems |
| Harmony | `npm test`、本地服务 `/tonnetz/` | 86/86 通过，页面正常 |
| Stage | `npm test`、预览 `/volta/` 页面 | 159 通过、3 跳过（测试环境看不到私人曲谱库，属预期），页面正常 |

Score 测试在隔离副本中用 Linux 依赖运行，没有改动 Score 的 `node_modules`。模型生成在 CPU 上用 PyTorch 2.5.1 复现；Mac 上的 `.venv-training` 解释器本身未在本机执行过。

## Git 仓库（2026-10-06 建立）

Cantelvio 根目录是唯一的 Git 仓库（monorepo），四个模块都在其中：

- `main` 包含 Score 和 Stage 的完整历史（已改写到 `Score/`、`Stage/` 子目录下），之后一次提交保存两边当时未提交的工作，再一次提交首次加入 Compose 和 Harmony。
- 旧分支以前缀保留：`score/*`（原 AIlegro Score 的全部分支）、`stage/*`（原 Volta 的 main 和 origin 分支）。
- 原来的两个 `.git` 原样备份在 `_git-backup-2026-10-06/`（已忽略，不进 Git）；确认新仓库无误后可删除。
- 根 `.gitignore` 排除大模型与第三方源码（AMT、MuScriptor、open-source 的 sources 与 datasets）、训练 runs/logs/数据、本机环境；它们的清单、下载脚本和 SHA 保留在仓库里。
- 当前远程仓库为 [chenjinfu00/Cantelvio](https://github.com/chenjinfu00/Cantelvio)，网页端通过 GitHub Pages 发布。

## 开源前清单（未完成）

1. **选许可证**：根目录还没有 LICENSE；Score 的包标记为 `UNLICENSED`。
2. **模型权重和训练数据**：仓库里的浏览器模型（如 `Compose/frontend/vendor/lib/joint-*weights.js`、Harmony 的 melody/harmony transformer）训练时用过本地曲谱库，要确认数据许可允许公开权重。PDMX、Winterreise、ASAP 等数据许可见 `Compose/OPEN-SOURCE-INVENTORY.md`。
3. **第三方资源**：音色（MuseScore General，MIT）、字体（霞鹜文楷，OFL）、pdf.js、KaTeX、采样等已附许可/NOTICE；公开前再对照清单核一遍。
4. **个人信息**：文档和记录中有本机路径（`/Users/chenjinfu/...`），提交作者邮箱为 273286233@qq.com；公开前决定是否清理或改用 GitHub noreply 邮箱。
5. **GitHub 配置**：`Score/.github`（工作流、模板）在 monorepo 中不会生效，需移到根目录并调整路径。
6. **大文件**：最大的已跟踪文件是 39 MB 的音色和若干 4–8 MB 的权重 JS；如果仓库继续增大，可考虑 Git LFS。
7. **旧公开仓库**：决定 chenjinfu00/volta 是存档并指向 Cantelvio，还是用 `git subtree split` 继续同步。

已检查：Score 和 Stage 的全部历史以及待提交文件中，未发现 API 密钥、令牌或私钥。
