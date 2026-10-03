# 试用指南：AIlegro Score + AIlegro

在自己的电脑上把编辑器和 AIlegro 连起来，逐项试一遍：打开 MusicXML、PDF 识谱、录音扒谱、自动标和弦，
以及五项作曲任务（续写、依和弦写旋律、为旋律配伴奏、配器、动机发展）。所有 AI 结果都先作为“待审阅的建议”
出现，接受后才算数，一步就能撤销。

## 准备（只做一次）

1. **代码**：在 AIlegro Score 文件夹切到包含全部功能的分支。依赖和 `main` 一样，已经 `npm install` 过就不用再装：
   ```sh
   cd ~/software\ develop/AIlegro\ Score
   git switch claude/M3-AI-10-service-imports
   ```
2. **AIlegro**：放在旁边的 `../AIlegro`，带 `.venv-training` 环境和 v3.1 权重（`training/runs/four-pillar-v31-*`）。
   作曲、配和声、和声分析都只用这个环境。
3. **PDF 识谱（可选）**：安装 Audiveris（[pdf-import.md](pdf-import.md)，Mac 用 `Audiveris-5.11.0-macosx-arm64.dmg`），
   再在 Audiveris 里 Tools › Install languages… 装 OCR 语言，否则读不出标题、声部名和歌词。
4. **录音扒谱（可选）**：用 `AIlegro/MuScriptor-large-1.3B` 里已有的 `.venv-py312` 环境（需要 `muscriptor`、
   `beat_this`、`soundfile`）。MuScriptor 的权重是 CC BY-NC 4.0：只转写你有权转写的录音，不能商用。

## 启动（每次）

开两个终端，都在 AIlegro Score 文件夹：

```sh
npm run ailegro:serve     # 终端 1：本机 AIlegro 服务（找到 ../AIlegro、Python 环境、最新的 v3.1 权重）
npm run dev               # 终端 2：编辑器 → 浏览器打开 http://127.0.0.1:5178/
```

服务启动时会列出用的是哪份权重（含保存时间），以及“open PDF / images”“open recordings”能不能用、为什么不能用。
编辑器右侧 **AIlegro** 面板 → “本机 AIlegro 服务”→ **连接**：应显示“已连接：four-pillar-v3.1”和“识谱：可用 · 扒谱：可用”。

常用选项（写在 `npm run ailegro:serve --` 后面；第二个 `--` 之后的参数原样交给适配器）：

```sh
npm run ailegro:serve -- --checkpoint training/runs/four-pillar-v31-step101129/weights.pt   # 指定权重（续训前另存的一份）
npm run ailegro:serve -- --checkpoint training/runs/old-models-tmp/four-pillar-v31-step45225/weights.pt   # 旧模型
npm run ailegro:serve -- -- --audiveris /Applications/Audiveris.app/Contents/MacOS/Audiveris
npm run ailegro:serve -- -- --muscriptor-python ~/…/MuScriptor-large-1.3B/.venv-py312/bin/python
npm run ailegro:serve -- --mock           # 不用模型，占位音乐（只试界面）
```

## 逐项试

| 功能 | 怎么试 | 看什么 |
| --- | --- | --- |
| 打开 MusicXML | **打开**，或把 `.musicxml` / `.xml` / `.mxl` 拖进窗口 | 导入成新的未保存乐谱，没导入的内容在提示里 |
| PDF / 图片识谱 | **打开**（或拖入）PDF、PNG、JPG、TIFF；或面板“从 PDF 或录音开始”→“打开 PDF / 图片…” | 左下角显示进度（第几页、用时），完成后作为新乐谱打开 |
| 录音扒谱 | **打开**（或拖入）WAV、MP3、FLAC、M4A、AIFF；或面板 →“打开录音…” | 进度：载入 → 转写（第几段）→ 找拍子 → 整理成乐谱；完成提示保留了多少音、拍号、速度 |
| 自动标和弦 | 面板“和声分析”：先选中几个小节（不选为全曲），选“换和弦频率”，点“自动标和弦” | 和弦记号出现在谱上，“待审阅的 AI 建议”里可接受 / 拒绝 |
| 为旋律配伴奏 | 面板任务选“为旋律配伴奏”，“给定材料所在声部”勾旋律声部，设“从第几小节”“小节数”，点“直接生成” | 配和声模型先定和弦（作为和弦记号），v3.1 写伴奏 |
| 续写 / 依和弦写旋律与伴奏 / 配器 / 动机发展 | 选对应任务和小节范围，点“直接生成” | 新写的音是待审阅的建议，可以逐批接受 / 拒绝 |

识谱 / 扒谱的选项在面板的“识谱 / 扒谱选项”里，会记住：录音里有哪些乐器（不选由模型判断）、录音的拍号
（自动或指定 3/4、6/8 等）、合成一个钢琴谱；PDF 只读哪些页、PDF 是不是实际音高谱。同一时间只跑一个识谱 / 扒谱任务，
左下角可以取消。任务完成时如果当前乐谱有未保存的修改，会先问要不要保存；选“取消”后结果留着，点“打开结果”再打开。

导入的乐谱保存时另存为 `.ailegro.json`，不会写回 PDF、录音或 MusicXML。

## 常见问题

- **连不上服务**：终端 1 有没有在运行、端口是不是 8765（面板里的地址要一致）。在 claude.ai 上打开的编辑器连不到你电脑上的服务，
  要用本机的 `npm run dev`。
- **识谱不可用**：服务没找到 Audiveris。用 `-- --audiveris <路径>` 指定，或设环境变量 `AUDIVERIS`。
- **扒谱不可用**：服务没找到 MuScriptor 的 Python 或 AIlegro 的 `audio_to_score.py`。启动信息里写了缺什么。
- **v3.1 还在训练时**：服务用训练最近一次保存的权重（启动时显示保存时间）；训练结束后重启服务才会用最终权重。
  扒谱时 MuScriptor 也用 GPU，和训练同时跑两边都会变慢，最好等训练结束再试录音。
- **生成的音乐不满意**：在“待审阅的 AI 建议”里拒绝，改“随机种子”或“音高温度”（面板“采样参数”）再生成；配伴奏可以先改和弦记号，
  再把“和声”设为“用乐谱和弦”重新生成。
- **扒谱结果的音不对**：先在面板里写明录音里的乐器、指定拍号再试；真实录音的效果还没有系统评估过
  （模拟评估见 [audio-import.md](audio-import.md)）。

技术细节：服务的接口见 [ailegro-integration.md](ailegro-integration.md#d-打开-pdf图片和录音本机服务的导入任务)，
决定和取舍见 [ADR 0013](adr/0013-local-service-imports.md)。
