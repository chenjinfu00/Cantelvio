# AIlegro — 从这里开始

这是可以单独运行、单独修改的 AIlegro 项目。名称是 **AIlegro**：A 和第二个字母 I 大写，后面是小写 legro。

本目录于 2026-09-27 从已验证的本地演示版本独立整理，并补齐训练与原始数据。把整个 `AIlegro` 文件夹作为其他 AI 编辑器的工作区即可，也可以完整复制到其他位置。运行时不需要原来的 `generative-music-app`、`tonnetz-workbench`、在线服务或账号。

## 启动

需要 Node.js 20 或更新版本。在本文件所在目录打开终端：

```sh
npm start
```

浏览器打开 <http://127.0.0.1:4187/>。项目使用原生 JavaScript 和 Node 内置静态服务器，没有第三方 npm 依赖，无需 `npm install` 或构建。

若端口被另一份演示占用，在 macOS/Linux 使用：

```sh
PORT=4188 npm start
```

然后访问 <http://127.0.0.1:4188/>。Windows PowerShell 可先设置 `$env:PORT=4188`，再运行 `npm start`。默认只监听本机。

播放器需要先点击 Play 才会启动声音。新载入页面默认为 Hold、Every bar、Melody Off；选择 **Auto + Free** 可体验小节内换弦和跨小节延续，点击 **Melody On** 可开启自动旋律。

## 当前已经能做什么

- 四个可保存场景：Warm Piano、Velvet Jazz、Indie Drive、Open Air。
- 和弦、低音、旋律三个声部独立音量与静音；自动旋律可单独关闭。
- 和声与旋律两个本地 Transformer，温度、风格、音色、节奏、织体、速度等控制。
- 固定主调或调性游走；Hold 保持当前和弦，Auto 自动推进。
- Every bar 每小节换弦；Free 可在小节内换弦或持续多个小节。
- 两行共八小节和弦谱，指针向右移动。上排播完，下排上移，补出后四小节；和弦宽度对应实际拍数。
- 点击未排程的未来和弦，可修改根音、类型、转位，并重新生成其后的进行。
- 英文默认界面，中英文切换；桌面、平板布局与手机横向谱面跟随。
- 本地声音检查页 `/qa/` 可生成可复现的测试 WAV。

这是独立音乐控制台，主界面没有 Tonnetz 键盘。

自动伴奏及和声、旋律模型的后续工作统一在本项目进行。`Tonnetz` 和 `Volta` 是旁边两个同级项目：前者保留键盘/和声可视化和现有功能，后者负责读谱翻页。

## 代码入口

| 文件或目录 | 负责什么 |
| --- | --- |
| `index.html`、`style.css` | 页面入口和响应式布局 |
| `src/app.js` | 界面、控件事件、和弦谱渲染与指针 |
| `src/session.js` | 演奏状态、场景、和弦/旋律协作、小节计划、谱面记录 |
| `src/queue.js` | 和弦队列、稳定 UID、未来和弦编辑与重算 |
| `src/chord-chart.js` | 队列投影为真实小节、拍点与延续段 |
| `src/duration-policy.js` | 根据和声预测概率与音乐规则选择持续时间 |
| `src/transport.js` | 共用音频时钟、预排程、实际发声回调、停止和中断 |
| `src/planner.js` | 伴奏与低音事件；一个小节内的和弦变化 |
| `src/melody-timeline.js` | 根据实际和声时间线生成旋律 |
| `src/audio.js` | Web Audio、采样、合成音色、混音与输出保护 |
| `src/scenes.js` | 默认参数与四个场景 |
| `vendor/` | 随项目携带的模型权重、和弦词表与音乐模块 |
| `media/` | 本地采样、来源说明与授权信息 |
| `training/` | 完整训练、原始/处理后数据、检查点、评估与复现说明 |
| `tests/` | 自动回归测试 |
| `qa/`、`validation/` | 音频检查页面、独立验证脚本与历史结果 |
| `previews/` | 最近的桌面、平板与手机截图 |

## 修改前后如何验证

主要回归测试：

```sh
npm test
```

独立和弦谱检查：

```sh
node validation/check-chord-chart.mjs
node validation/check-chart-session.mjs
node validation/check-chart-edits.mjs
```

独立整理时已有 29 项自动测试，另有 96 小节预告/播放一致性对照。详细历史见 `QA-REPORT.md`，本次独立整理的结果见 `HANDOFF-VERIFICATION.md`，同级目录与训练材料迁移见 `PROJECT-REORGANIZATION.md`。过去通过不代表未来修改自动通过；改动涉及的检查应重新运行。

修改播放逻辑后，还应在浏览器检查：Play/Stop、Auto/Free、两次四小节换行、未来和弦编辑、Melody On、声音中断后恢复。修改布局后检查桌面、平板横竖屏与窄手机，特别注意长转位名称、小节内多个和弦和弹窗。现有平板结果来自浏览器尺寸模拟，未替代真实 iPad/Safari 测试。

## 交接时需要知道

1. `README.md` 和实际实现描述当前状态。`PREPARATION.md`、`SOURCE_BASELINE.json` 是早期设计与来源快照，其中的“四和弦走带”等内容已经被两行八小节版本取代，不应当作新的待办要求。
2. 模型权重和音源已全部随目录提供。`VENDOR_MANIFEST.json` 中的 source 字段记录来源，destination 指向本项目实际使用的文件；来源路径不构成外部运行依赖。样本和训练数据的 NOTICE 文件应保留。
3. Free 时长由和声 Transformer 的概率分布加音乐规则决定，并不是重新训练过的时长预测头。两个模型是小型实验模型，不应把排程修复或界面改进描述成训练成果。
4. 预告中的和弦就是之后要播放的和弦；已经排程或发声的记录不能被页面刷新重新抽样。编辑未来进行应保留之前的和弦和时长。
5. 浏览器自己保存的场景不在项目文件里。相同域名与端口继续使用原来的 localStorage；换端口、设备或浏览器时，不会自动携带这些个人场景。
6. 完整训练入口、原始乐谱压缩包、处理后的语料、参数检查点与评估脚本已集中在 `training/`。先读 [training/README.md](training/README.md)。网页运行不依赖训练环境。

可以把下面这句话交给其他 AI：

> 这是 AIlegro 的独立项目。先阅读 START_HERE.md、AGENTS.md 和 README.md，查看 QA-REPORT.md 的最近更新。以实际代码和当前功能为基准，按我的下一条要求修改；完成后运行相关测试并检查浏览器中的声音、两行和弦谱及响应式布局。
