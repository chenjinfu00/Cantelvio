# 0013. 编辑器经本机 AIlegro 服务打开 PDF、图片和录音（后台导入任务）

- 状态：已接受（补充 [ADR 0012](0012-pdf-import-audiveris.md) 的“编辑器不直接打开 PDF”）
- 日期：2026-10-03

## 背景

识谱（Audiveris，[ADR 0012](0012-pdf-import-audiveris.md)）和扒谱（MuScriptor + AIlegro 的 `audio_to_score.py`，
[audio-import.md](../audio-import.md)）都要在本机运行外部程序，浏览器做不到，所以之前只有命令行：
`npm run import:pdf`，以及 AIlegro 文件夹里的两步脚本。用户希望在编辑器里直接打开 PDF 和录音。

编辑器已经和一个本机服务打交道：参考适配器 `score_compose.py --serve`（生成、和声分析），它运行在 AIlegro 的
Python 环境里，知道 AIlegro 文件夹在哪里，只接受回环地址的请求。

## 决定

- **同一个本机服务负责导入。** 适配器新增 `POST /import/pdf`、`POST /import/audio`（请求体就是文件本身，
  选项在查询参数里）、`GET /jobs/<id>`、`DELETE /jobs/<id>`；`GET /health` 的 `imports` 说明哪种文件能打开、
  不能时为什么。代码在 `integrations/ailegro/score_imports.py`，只用标准库：工具作为子进程运行，不需要 torch，
  `--mock` 模式也能识谱。
- **后台任务 + 轮询。** 识谱每页 10–20 秒，扒谱一首歌可能要几分钟，一次 HTTP 请求等不了也看不到进度。
  上传立即返回任务（`202`，`ailegro-score.import-job/1`），编辑器每 0.7 秒查一次：阶段（识谱中 / 载入 / 转写 /
  找拍子 / 整理成乐谱）、进度（Audiveris 的页数、MuScriptor 的段数，从它们的输出里读出）、用时、最后几行日志。
  一次只跑一个工具（很耗资源），其余排队；任务可以取消（结束子进程）；结果保留一小时，上传的文件在工具跑完后删除。
- **结果是 MusicXML，导入在编辑器里做。** 服务原样返回 Audiveris 的 `.mxl` 或 `audio_to_score.py` 的 MusicXML
  （base64），编辑器用已有的 MusicXML 导入（[ADR 0011](0011-musicxml-import.md)）；PDF 用识谱的选项
  （`writtenPitch`、`trustTimeSignatures`）。这样导入规则只有一份，命令行和编辑器的结果一致。
- **不打断正在编辑的乐谱。** 任务在后台跑，用户可以继续编辑；完成时当前乐谱有未保存的修改就先询问，
  用户拒绝时结果留着（“打开结果”）。导入的乐谱是新的未保存文档，保存为 `.ailegro.json`。
- **一条命令启动。** `npm run ailegro:serve`（`tools/ailegro-service.ts`）找到 `../Compose`、它的
  `.venv-training`、最新的 v3.1 权重，再启动适配器；Audiveris 和 MuScriptor 的 Python 由适配器按默认位置寻找，
  也可以用参数指定。
- 这不是 AIlegro 的契约（不在 `packages/ailegro-bridge` 里）：任务格式只在编辑器和本仓库的适配器之间，
  变化时一起改；`schema` 字段留着以后升版本用。

## 后果

- 编辑器的“打开”和拖放接受 PDF、PNG、JPG、TIFF 和 WAV、MP3、FLAC、OGG、M4A、AIFF；AIlegro 面板有
  “从 PDF 或录音开始”一节和选项（录音里的乐器、拍号、合成钢琴谱；PDF 页码、实际音高谱）；左下角显示任务状态。
- 在 claude.ai 的 Artifact 里打开编辑器时连不到本机服务，这些入口给出说明，其余功能不受影响。
- 适配器多了一个职责（导入），但仍是可选的：命令行 `npm run import:pdf` 和 AIlegro 的两步脚本照旧可用。
- 测试：`npm run test:adapter`（用替身 Audiveris / MuScriptor / AIlegro 脚本测任务、进度、取消、拒绝和 HTTP 接口），
  编辑器侧的纯函数在 `service-import.test.ts`。

## 考虑过的其他方案

- **单独的导入服务**：多一个进程和端口要启动、要配置；适配器已经有 AIlegro 的路径和 Python 环境。
- **同步请求（上传后一直等结果）**：几分钟没有进度，浏览器或代理可能超时，也不能取消。
- **WebSocket / Server-Sent Events 推送进度**：更即时，但标准库的 HTTP 服务器不好做，轮询的延迟（0.7 秒）对
  几十秒到几分钟的任务足够。
- **服务端直接返回 ScoreDoc**：要在 Python 里重写 MusicXML 导入，两份实现会分叉。
