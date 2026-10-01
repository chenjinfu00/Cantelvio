# Contributing

This repository is developed by its owner together with AI coding agents (Codex, Claude).
Agents: start with [AGENTS.md](AGENTS.md). Humans: start with [README.md](README.md) and
[docs/git-workflow.md](docs/git-workflow.md) (Chinese).

Quick rules:

1. Branch from `main` (`feat/…`, `fix/…`, `codex/<task-id>-…`, `claude/<task-id>-…`).
2. Conventional Commits (`feat(core): …`). Small, focused commits.
3. `npm run check` before every commit; CI runs the same plus a build and sample renders.
4. Open a PR, fill in the template, squash-merge when green.
5. Contracts (`.ailegro.json`, AIlegro interchange schemas) change only with a version bump.
