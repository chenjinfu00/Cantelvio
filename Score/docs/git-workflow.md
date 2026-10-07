# Git 工作流（与 Codex / Claude 协作）

这个仓库由人和 AI 编程助手（Codex、Claude）一起开发。规则的目的：**任何时候 `main` 都能运行**，
每个改动都小、可审阅、可回退，AI 助手之间不互相踩踏。

## 一次性设置：GitHub 远程仓库（强烈推荐）

工作副本在本机（`~/software develop/Cantelvio/Score`）。**以 GitHub 私有仓库作为唯一的事实来源**：
备份、换电脑、和 Codex 云端协作都经过它。

```sh
cd ~/"software develop/Cantelvio/Score"
git config user.name "你的名字"
git config user.email "你的邮箱"

# 方式一：GitHub CLI（brew install gh；gh auth login）
gh repo create ailegro-score --private --source . --remote origin --push

# 方式二：先在 github.com 新建空的私有仓库 ailegro-score，然后
git remote add origin git@github.com:<你的用户名>/ailegro-score.git
git push -u origin main
```

然后在 GitHub 仓库设置里：

- Branches → 给 `main` 加保护规则：必须通过 PR 合并、必须通过 CI（`Lint, typecheck, test, build`）。
- 如需 Codex 云端：在 Codex 里连接这个 GitHub 仓库。

## 分支

| 前缀 | 用途 | 例子 |
| --- | --- | --- |
| `main` | 默认分支，始终可运行，只通过 PR 合并 | |
| `feat/<scope>-<slug>` | 新功能 | `feat/engraving-slurs` |
| `fix/<scope>-<slug>` | 修 bug | `fix/core-rebar-ties` |
| `docs/<slug>`、`chore/<slug>`、`refactor/<slug>` | 文档、杂项、重构 | `docs/ailegro-contract` |
| `codex/<task-id>-<slug>` | Codex 做的任务 | `codex/M2-ENG-03-slurs` |
| `claude/<task-id>-<slug>` | Claude 做的任务 | `claude/M3-HIST-02-diff` |

任务 id 来自 [roadmap.md](roadmap.md)。**一个分支只做一个任务。**

## 提交信息：Conventional Commits

```text
<type>(<scope>): <概要，英文，祈使语气，不加句号>

<正文：为什么改、怎么改、注意事项（可多行，英文或中文均可）>
```

- type：`feat`、`fix`、`docs`、`test`、`refactor`、`perf`、`chore`、`ci`。
- scope：`core`、`engraving`、`bridge`、`web`、`tools`、`docs`、`ci`。
- 例：`feat(engraving): beam 16ths across beat pairs`、`fix(core): keep ties when re-barring`。
- 破坏性变更（文件格式、Cantelvio 契约）：在正文写 `BREAKING CHANGE: …`，并按
  [score-model.md](score-model.md#文件格式-ailegrojson) / [ailegro-integration.md](ailegro-integration.md#修改契约的规则) 的规则升版本。

## 一个任务的完整流程

```sh
git switch main && git pull --rebase
git switch -c feat/core-hairpins
# …改代码、写测试…
npm run check                     # lint + typecheck + test，必须全绿
npm run render -- --all --out out/   # 改了排版就看图
git add -p && git commit          # 小而完整的提交
git fetch && git rebase origin/main
git push -u origin feat/core-hairpins
gh pr create --fill               # 按 PR 模板填写：做了什么、怎么验证、截图
```

- 合并方式：**Squash merge**（一个 PR 在 `main` 上是一个提交，标题用 Conventional Commits）。
- 合并后删除分支；`roadmap.md` 里把任务标为完成（可以在同一个 PR 里改）。

## 与 AI 助手协作

### 共同规则

- 所有助手先读 [AGENTS.md](../AGENTS.md)（Claude 通过 `CLAUDE.md` 引用它）。
- 给任务时写清楚：任务 id、目标、验收标准、相关文档。例：
  > 做 roadmap 里的 `M2-ENG-03`（连线 slur）：模型字段 + 命令 + 排版 + 测试，按 AGENTS.md 的规则，
  > 分支 `codex/M2-ENG-03-slurs`，完成后开 PR。
- **同一时间不要让两个助手改同一个包的同一块代码**；在 roadmap 的“负责人”列登记。
- 助手不得：直接推送到 `main`、手改 `*.generated.ts`、悄悄修改契约（文件格式、Cantelvio schema）、
  修改 `../Compose` 项目、提交 `node_modules` / `dist` / `out` / 本地乐谱。
- 审阅 AI 的 PR 时重点看：测试是否真的覆盖了改动、是否违反架构不变量、排版截图。

### Codex

- **云端**（chatgpt.com/codex）：连接 GitHub 仓库后按任务开分支、跑 `npm run check`、开 PR。
  适合独立、边界清楚的任务（一个命令、一个排版规则、一个面板）。
- **CLI**（在本机仓库目录运行 `codex`）：适合需要你在旁边看的任务。

### Claude（Claude Code / Cowork）

- 同样读 `AGENTS.md`；提交信息末尾带 `Co-Authored-By` 署名行，便于区分作者。

## 版本与发布

- 语义化版本，`0.x` 期间允许破坏性变更但必须写明。
- 发布：更新 `package.json` 版本 → `git tag -a v0.2.0 -m "v0.2.0"` → `git push --tags` →
  GitHub Release（从提交历史生成变更说明）。
- 文件格式版本（`.cantelvio.json` 的 `version`）和 Cantelvio schema 版本独立于应用版本。

## 同步冲突副本

iCloud、Dropbox 等同步盘冲突时会生成 `name 2.ext` 这样的副本。仓库现在不在同步盘里，但 `.gitignore`
仍然忽略这类名字（项目文件名不含空格），以防万一——遇到时**要处理**：比较内容，保留正确的版本，删除副本。

```sh
find . -path ./node_modules -prune -o -name "* [2-9]*" -print     # 找出冲突副本
git status --ignored --short | grep " [2-9]"                         # 同上（git 视角）
```

2026-10-02 已清理同级 Cantelvio 文件夹从 iCloud 带来的 25 个副本（如 `frontend/media/piano/Fs2 2.mp3`，都与原文件相同）。
