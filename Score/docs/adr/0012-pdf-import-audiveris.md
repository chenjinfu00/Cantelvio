# 0012. PDF / 图片识谱：调用外部的 Audiveris，再走 MusicXML 导入

- 状态：已接受（编辑器经本机服务打开 PDF 的部分由 [ADR 0013](0013-local-service-imports.md) 补充）
- 日期：2026-10-03

## 背景

用户要把 PDF 乐谱转成 AIlegro Score 的格式。识谱（OMR）是一个独立的大问题：五线谱、符头、符干、符尾、
连音、调号、文字都要从图像里找出来再组合成音乐。我们已经有 MusicXML 导入（[ADR 0011](0011-musicxml-import.md)），
而成熟的 OMR 软件都能导出 MusicXML。

## 决定

- 用 **Audiveris**（开源、Java、带 Tesseract 文字识别，2026-07 为 5.11.0）做识别，`tools/pdf-to-score.ts`
  （`npm run import:pdf`）以批处理方式调用它（`-batch -export`），把导出的 `.mxl` 交给 MusicXML 导入。
- Audiveris 由用户自己安装（macOS / Windows / Linux 安装包自带 Java），我们不打包、不修改它：它是 AGPL-3.0，
  作为单独的程序调用，不影响本仓库的许可证。
- 识谱的输出按印刷的样子读：MusicXML 导入加了三个选项（默认关闭，`import:pdf` 打开）——移调乐器按记谱音高读
  （`writtenPitch`）、按顺序指定乐器（`instruments`，没有 OCR 时声部名称读不出来）、中间的短小节按拍号补足
  （`trustTimeSignatures`）。“有声部填满拍号、别的声部更长时按拍号截断”对所有导入都生效（music21 语料库里
  没有文件受影响）。
- 编辑器不直接打开 PDF：浏览器里运行不了 Audiveris。识别结果（`.ailegro.json` 或 `.mxl`）照常打开。

## 后果

- 在本编辑器排出的 300 dpi 乐谱上：四声部众赞歌 100% 的音符一致，人声 + 钢琴的《菩提树》约 90%，
  单簧管 + 钢琴约 80%（指定乐器后 95%）。识别错误主要是漏音、时值和小节长度；可以在 Audiveris 里校对 `.omr`
  后再导出。
- 依赖用户机器上的 Audiveris 和它的 OCR 语言；没有它时命令给出安装说明。
- 以后若接到本机服务（例如与音频转谱共用），编辑器可以加“打开 PDF”。

## 考虑过的其他方案

- **深度学习 OMR（例如 oemer，或端到端的 transformer 识谱模型）**：对手机拍照更宽容，但要下载大模型权重，
  多声部总谱和文字的支持有限，许可证和维护状况不一；Audiveris 覆盖多声部总谱、移调、文字，且可以人工校对。
- **在浏览器里识谱（WebAssembly）**：没有成熟的可用实现，图像处理和 OCR 都要重写。
- **商业软件（PhotoScore、SmartScore、Soundslice）**：不能自动化调用，也不能随仓库说明安装方式。
