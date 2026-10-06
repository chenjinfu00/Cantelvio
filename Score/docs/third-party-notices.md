# 回放与导出的第三方资源

日期：2026-10-04。新增依赖只用于 web 应用；核心乐谱、排版和协作命令模型保持原有结构。

| 资源 | 版本或固定文件 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [SpessaSynth 浏览器库](https://github.com/spessasus/spessasynth_lib) | 4.3.14 | Apache-2.0 | AudioWorklet 回放 |
| [MuseScore General](https://ftp-osl.osuosl.org/pub/musescore/soundfont/MuseScore_General/) | MuseScore_General.sf3 | MIT | GM 管弦乐及打击乐音色 |
| [Tone.js MIDI](https://github.com/Tonejs/Midi) | 2.0.28 | MIT | MIDI 文件编码 |
| [jsPDF](https://github.com/parallax/jsPDF) | 4.2.1 | MIT | PDF 文档 |
| [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | 2.8.1 | MIT | 将现有排版 SVG 写入矢量 PDF |
| [霞鹜文楷轻便版](https://github.com/lxgw/LxgwWenKai-Lite) | LXGWWenKaiLite-Regular.ttf | OFL-1.1 | PDF 中文字体嵌入 |

完整依赖版本和原始许可证位于 `apps/web/public/licenses/`；新增库的传递依赖也保留了随包许可证。
音色版权及采样来源保留在 `public/audio/soundfonts/`，字体许可证保留在 `public/fonts/`。
资源的 SHA256 和大小记录在 `public/licenses/manifest.json`，构建后这些目录会一并发布。

首次回放按需加载约 40 MB 音色；首次 PDF 导出按需加载约 13 MB 字体。浏览器缓存减少重复下载，
失败时回放使用已有钢琴采样和合成音色。PDF 使用字体子集，文字采用同一常规字体，粗体和斜体暂不嵌独立字重。
请在分发时保留上述许可证和采样来源。SoundFont 与 MIDI 播放器的设备差异可能造成音色差异；文件内的音高来自核心实际音高时间线。
