# 开发环境

## 需要什么

| 工具 | 版本 | 说明 |
| --- | --- | --- |
| macOS | — | 主要开发环境（Windows / Linux 也能用） |
| Node.js | ≥ 22.12（`.nvmrc` 写的是 22） | `brew install node@22` 或 `nvm install 22` |
| npm | 随 Node | 本项目用 npm workspaces，不用 pnpm/yarn |
| git | 任意新版本 | 远程仓库建议 GitHub（见 [git-workflow.md](git-workflow.md)） |
| Python 3 | 可选 | 只有运行 AIlegro 适配器时需要；真正生成要用 AIlegro 自己的 `.venv-training` |
| 浏览器 | Chrome / Edge 最新版 | 开发时主要在 Chromium 上测试；Safari、Firefox 尚待验证 |

## 第一次运行

```sh
cd ~/"software develop/Cantelvio/Score"

npm install           # 在 Mac 本机运行（不要在 Linux 虚拟机里装，见下文）

npm run dev          # 编辑器：http://127.0.0.1:5178/
npm run check        # lint + 类型检查 + 单元测试（提交前必跑）
npm run build        # 生产构建到 apps/web/dist
npm run preview      # 预览生产构建：http://127.0.0.1:5179/
npm run render -- --all --out out/   # 无界面渲染示例乐谱（SVG + PNG）
```

VS Code 推荐插件：ESLint、Prettier、Vitest（`.vscode/extensions.json`），保存时自动格式化。

## 常用脚本

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | Vite 开发服务器（热更新） |
| `npm run check` | `lint` + `typecheck` + `test` |
| `npm run test:watch` | 测试监听模式 |
| `npm run format` | Prettier 格式化全部文件 |
| `npm run render -- …` | `tools/render-score.ts`：`--sample <id>`、`--all`、`--file x.ailegro.json`、`--out dir`、`--concert`、`--continuous`、`--svg-only`、`--zh`、`--scale` |
| `npm run gen:smufl` | 重新生成 Bravura 字形数据（只在改字形表时） |

## 项目位置与同步（重要）

1. **工作副本在本地**：`~/software develop/Cantelvio/Score`，和 `~/software develop/Cantelvio/Compose` 并排——
   适配器命令里的 `../Compose`、`../Score` 相对路径依赖这个位置关系。
   （2026-10-02 从 iCloud Drive 移出：同步盘会同步约 220 MB 的 `node_modules`，`.nosync` 符号链接对
   npm 无效，两台电脑同时打开还可能损坏 `.git`。）
2. **GitHub 是唯一的事实来源**：备份、换电脑都用 `git push` / `git pull`，不要把仓库放回 iCloud、
   Dropbox 之类的同步盘，也不要在两份副本之间直接拷贝文件。
3. **依赖在 Mac 本机安装**：不要在 Linux 虚拟机 / 沙盒里对这个文件夹运行 `npm install`（包括 Claude
   Cowork 的电脑端虚拟机）。esbuild、rollup、sharp 等带有平台相关的二进制文件，Linux 装的在 macOS 上
   不能用。`node_modules`、`apps/web/dist`、`out/` 都被 git 忽略，可以随时删除重建。
4. **文件名不要含空格**。`name 2.ext` 这样的文件是同步冲突副本（`.gitignore` 忽略它们），要人工处理：
   `find . -path ./node_modules -prune -o -name "* [2-9]*" -print`。

## AIlegro 适配器的环境

```sh
# 检查转换（不需要 torch）
python3 integrations/ailegro/score_compose.py --request request.json --dry-run --ailegro-root ../Compose
# 不需要模型的完整往返测试（编辑器里“连接”→“直接生成”）
python3 integrations/ailegro/score_compose.py --serve --mock
# 真正生成：在 AIlegro 文件夹里用它自己的环境
cd ../Compose && .venv-training/bin/python "../Score/integrations/ailegro/score_compose.py" \
  --serve --checkpoint training/runs/<run>/weights.pt
```

详见 [ailegro-integration.md](ailegro-integration.md)。

## 常见问题

- **端口被占用**：`npm run dev -- --port 5180`。
- **没有声音**：浏览器要求先有一次点击/按键才能启动音频；第一次播放钢琴采样需要下载约 1.3 MB。
- **“未连接” AIlegro 服务**：确认服务器在运行、地址是 `http://127.0.0.1:8765`；
  如果编辑器不是从 localhost 打开的，服务器要加 `--allow-origin <编辑器的地址>`。
- **中文字体**：乐谱里的中文用系统字体（PingFang SC / Songti SC / Noto CJK），导出的 SVG 在没有这些
  字体的电脑上会换用其他字体。
- **类型错误找不到包**：确认是在仓库根目录运行 `npm install`（workspaces 需要从根目录安装）。
