# 0001. npm workspaces monorepo，全 TypeScript，核心包保持纯净

- 状态：已接受
- 日期：2026-10-01

## 背景

项目要同时有：浏览器编辑器、无界面渲染工具（CI 里生成示例图）、将来的协作服务器和可能的
Web Worker 排版。还会和 Codex、Claude 一起开发，需要类型系统帮助 AI 和人发现错误。

## 决定

- 一个仓库，npm workspaces：`packages/core`、`packages/engraving`、`packages/ailegro-bridge`、
  `apps/web`、`tools/`。工作区包直接以 TypeScript 源码被引用（无需预编译）。
- TypeScript 严格模式（`strict`、`noUncheckedIndexedAccess`、`noUnusedLocals`、`verbatimModuleSyntax` 等）。
- `packages/*` **纯净**：不依赖 DOM、Node API、React、浏览器存储；用单独的 tsconfig（无 DOM lib）
  和 ESLint 规则强制。
- 工具链：Vite（编辑器）、Vitest（测试）、ESLint flat config、Prettier、tsx（命令行工具）。

## 后果

- 核心逻辑可在任何 JS 环境运行和测试；CI 能无浏览器渲染乐谱。
- 浏览器专属功能（音频、文件、存储）只能写在 `apps/web`。
- 依赖少：核心只有 `immer`。

## 考虑过的其他方案

- pnpm / Turborepo：更快，但多一层工具；当前规模 npm workspaces 足够。
- 每个包单独仓库：版本协调成本高，AI 助手跨包修改困难。
