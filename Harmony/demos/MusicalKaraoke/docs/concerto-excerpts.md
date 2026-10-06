# 本地协奏曲演示片段

2026-09-23。两段均为按乐谱制作的合成排练音轨，不是真人录音。声音由本机 FluidSynth 与 MuseScore 的 MS Basic 音色库渲染，网页播放本地 Ogg 文件，无需在线音色服务。

| 入口 | 片段 | 正文时长 | 演奏方式 |
|---|---|---|---|
| You play the soloist | 柴可夫斯基第一乐章第 23–41 小节，至第 41 小节长音结束、装饰音与再现弱起前 | 54.363 秒；含尾音 55.563 秒 | 播放乐队，用户演奏独奏线；Listen 包含独奏与乐队 |
| You play the chords | 门德尔松第一乐章第 1–24 小节，加第 25 小节前两拍的落点 | 58.8 秒；含尾音 60 秒 | 播放小提琴，用户演奏简化和弦；Listen 加入参考和弦 |

门德尔松采用四分音符 = 100 的慢速排练速度，使开头主题呈示约一分钟；不是原曲 Allegro 的音乐会速度。可在演奏界面调速。柴可夫斯基保留源 MIDI 的速度变化。四拍预备不计入上述时长。

## 来源与处理

### 柴可夫斯基

来源：[Mutopia 项目第 466 项](https://www.mutopiaproject.org/cgibin/piece-info.cgi?id=466)，Will Oram 录入，依据 Eulenburg 1920 版，Public Domain，版本 Mutopia-2017/11/06-466。

下载的第一乐章为 `tchai_op35.mid`。独奏轨 `solo:`（通道 10）用于生成 174 个按键提示；乐队版排除该通道。末端精确到源 MIDI 的 62548 tick，避开下一弱起前的两个装饰音，落在 D 大调和弦的释放点。参考版保留独奏与乐队。

源数据缓存于 `tmp/concerto-sources/tchaikovsky-midi/` 与 `tchaikovsky-lilypond/`，下载链接在 Mutopia 项目页。生成后的 MIDI、音频和 JSON 位于 `public/media/concertos/`。

### 门德尔松

来源为用户已有公版 Hans Sitt / Ernst Eulenburg 钢琴伴奏版的印刷页 2–3（PDF 第 4–5 页）：

`本地曲谱/其他/小提琴协奏曲 Op.64/钢琴伴奏·Sitt 版 · cae5f849.pdf`

小提琴旋律按谱录入。和弦是便于现场互动的和声简化，并非完整钢琴或管弦乐配器：每小节一个和弦，不复制伴奏的琶音、低音转位与所有经过音。第 15、19 小节保留 G♯ 对应的 E7；第 16、20 小节使用 Am。

主题最后停在第 25 小节前两拍的 B 长音及 Em 落点，避免截入后面的快速音群。共有 25 个和弦提示。

## 同步与复现

JSON 中的 `guide.time` 与 `duration` 以原始音轨秒数计。播放以音频当前位置为准；改变播放速度时同步提示随音轨变化。导入个人音轨时停用内置时间线，避免错误提示。

生成脚本为 `scripts/build-concerto-excerpts.py`，使用现有 `chopin-op21-accompanist` Python 环境内的 mido、numpy、soundfile 和 FluidSynth。脚本记录源切点、旋律、简化和弦、速度及音量处理；四个成品音轨归一化峰值为 0.72，尾部保留衰减。
