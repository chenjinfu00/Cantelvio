# 音频 → 乐谱

把一段录音变成可以编辑的乐谱。识别在 AIlegro 里完成（两个模型、两个 Python 环境），结果是 MusicXML，
在编辑器里用“打开”或拖进窗口即可（[musicxml-import.md](musicxml-import.md)）。

## 在编辑器里

先运行本机服务 `npm run ailegro:serve`（[try-it.md](try-it.md)），再“打开”或拖入录音（WAV、MP3、FLAC、OGG、M4A、
AIFF），或在 AIlegro 面板“从 PDF 或录音开始”→“打开录音…”。服务在后台依次运行下面两步，左下角显示阶段（载入、
转写第几段、找拍子、整理成乐谱）和用时，可以取消；完成后作为新乐谱打开，提示里写保留了多少音、拍号、速度和小节数。
面板“识谱 / 扒谱选项”对应命令行的选项：录音里的乐器（`--instruments`）、拍号（`--metre`）、合成一个钢琴谱（`--piano`）。
（[ADR 0013](adr/0013-local-service-imports.md)）

## 命令行流程

```sh
cd "<path>/AIlegro"
# 1. 音符和节拍：MuScriptor（转写）+ beat_this（节拍、强拍）
MuScriptor-large-1.3B/.venv-py312/bin/python training/scripts/audio_transcribe_muscriptor.py ~/Music/song.wav \
    --instruments acoustic_piano,voice            # 可选：告诉模型有哪些乐器 → song.notes.json
# 2. 乐谱：节拍对齐、节奏量化、声部与乐器、保留该保留的音符、记谱
.venv-training/bin/python training/scripts/audio_to_score.py ~/Music/song.notes.json   # → song.musicxml
# 3. 在 AIlegro Score 里打开 song.musicxml，保存为 .ailegro.json
```

- 第 1 步在 Apple 芯片上用 MPS 运行 MuScriptor large（约 13 亿参数）。乐器组名称见 `muscriptor list-instruments`
  （例如 `acoustic_piano`、`violin`、`cello`、`voice`、`flutes`）。
- 第 2 步常用选项：`--metre 3/4`（拍号读错时指定）、`--piano`（所有乐器缩成一份钢琴谱）、`--report r.json`
  （去掉、移动了哪些音及原因）、`--keep-all`（不清理，看原始转写）、`--analyzer none`（不用和声检查）。
- 细节和实测见 AIlegro 的 `training/README.md`（“音频 → 乐谱”一节）。

## “保留该保留的音符”做了什么

转写模型会多出音（泛音、极短的杂音、重复的音、标错乐器的音）、时值也不准。第 2 步：

1. 用跟踪到的每一拍做速度图（自由速度也跟得上），修补节拍跟踪的失误，量出并扣掉整体延迟；
2. 每一拍选一个细分（十六分、三连音……），对整段做 Viterbi，起音贴近网格、简单的细分优先、段落内保持一致；
3. 去掉重复的音、高八度 / 十二度的短“鬼音”、孤立的极短音；乐器演奏不了的音（远超音域，人声或管乐同时多于一个音）
   移到能演奏的声部；
4. 用 AIlegro 的和声分析模型（[ADR 0010](adr/0010-harmonic-analysis-contract.md) 的同一个模型）标出和弦，
   去掉既不是和弦音、也不在级进线条上的短音（最高声部总是保留）；
5. 钢琴分左右手，每谱表最多 4 个声部，按估出的调拼写升降号，移调乐器写记谱音高。

## 现状（2026-10-03）

- 没有在真实录音上量过：MuScriptor 的权重在 Mac 上（5.5 GB），云端跑不了。用模拟的转写（真实乐谱 + 模拟演奏 +
  模拟转写错误）量的结果：艺术歌曲（人声 + 钢琴）逐音 F1 84% → 清理后 86%，弦乐四重奏 86% → 88%；节奏和小节对齐
  之外的损失主要来自模拟的漏音和错音本身。和声检查在模拟里作用很小。
- 只写一个拍号（中途换拍号的作品会按主要拍号写）；不写力度（MuScriptor 不输出力度）、不写歌词。
- MuScriptor 是 CC BY-NC 4.0，附加条件：只能转写你有权使用的录音，不能商用。

## 下一步

在 Mac 上把测试集乐谱合成为音频、用 MuScriptor 真实转写，量出真实的错误分布；再用（转写, 原谱）训练 AIlegro 自己的
“保留 / 去掉”模型。
