# Volta Git 协作约定

本项目使用 Git 追踪所有应提交的源代码、配置、文档和测试修改。

## 给每个 AI 分配独立工作区

推荐为每个 AI 使用一个独立的 worktree，并让它在自己的分支上工作：

```bash
git worktree add ../volta-ai-1 -b codex/ai-1 main
git worktree add ../volta-ai-2 -b codex/ai-2 main
```

这样不同 AI 不会互相覆盖未完成的文件。每个 AI 完成一项逻辑完整的修改后，应在自己的 worktree 中提交：

```bash
git add -A
git status
git commit -m "描述这次修改"
```

## 合并修改

确认修改和测试结果后，在主 worktree 中合并对应分支：

```bash
git switch main
git pull --ff-only
git merge --no-ff codex/ai-1
```

如果多个 AI 修改了同一文件，合并时出现冲突属于正常情况；解决冲突后运行测试，再完成合并。

## 基本规则

- 不直接让多个 AI 同时写同一个 worktree。
- 每个独立任务使用独立分支，分支名建议以 `codex/` 开头。
- 提交前检查 `git status` 和 `git diff --staged`。
- 不提交 `node_modules/`、构建产物、私有本地库、环境变量或密钥。
- `main` 只保留已经检查过、可以作为稳定基线的提交。
- 未提交的修改也会被 Git 识别，但只有提交后才会成为可安全合并、回退和追踪的版本记录。

## 查看协作状态

```bash
git status
git log --oneline --decorate --all --graph
git worktree list
```
