# Cantelvio Compose 开源软件与资源总清单

更新日期：2026-10-05。范围为本地 `Compose/`、相邻的 `Score/`，以及这轮已讨论的候选项目。

接入顺序和两个项目的分工见 [联合开发计划](JOINT-DEVELOPMENT-PLAN.md)。保留自有模型作基线，实测选择 AMT 等生成引擎；Score 保留自研排版与命令日志结构，开源工具补齐生成、分析、回放、导出、数据整理与评估。
下面区分软件代码、模型权重、乐谱数据、录音、字体和音色；“已下载”表示文件在本地，不表示已经接入或完成效果评估。
Cantelvio Compose 与 Score 自有代码也不因使用这些库而自动变成开源；Score 的包目前标记为 `UNLICENSED`。

## 状态说明

- **已使用**：现有代码或工具明确调用，本地依赖可查。
- **代码已接入**：新功能实现与依赖已写入项目，后续修改仍需相应复验。
- **已下载待验证**：保存了代码、权重或数据，但尚未完成目标任务的运行与评估。
- **候选**：讨论过用途，尚未接入；不是已安装软件。
- **暂不采用**：当前方案不需要替换已有架构，或项目状态不适合新增依赖。

## 生成模型与音频转写

| 项目 | 用途 | 许可 | 当前状态与本地位置 |
| --- | --- | --- | --- |
| [Anticipatory Music Transformer](https://github.com/jthickstun/anticipation) | 让模型提前看到给定旋律等事件，生成伴奏或补全音乐 | 官方代码 Apache-2.0；[公开模型卡](https://huggingface.co/stanford-crfm/music-medium-800k)标记 Apache-2.0 | 已下载待验证；`Anticipatory-Music-Transformer/`。代码、10 个官方公开模型快照、原始元信息与校验记录齐全，模型文件合计 13,055,478,862 字节，约 13.06 GB。尚未运行本项目的 AMT 对照，也未替换当前模型 |
| [Levanter](https://github.com/stanford-crfm/levanter) | AMT 官方训练后端 | Apache-2.0，以本地 LICENSE 为准 | 已下载待验证；`Anticipatory-Music-Transformer/training-backend/levanter/`，固定官方说明指定的 `split_lakh` 分支提交；未安装或启动训练 |
| [MuScriptor](https://github.com/muscriptor/muscriptor) | 多乐器录音转音符和 MIDI | 代码 MIT；[large 权重](https://huggingface.co/MuScriptor/muscriptor-large) CC BY-NC 4.0，并有输入录音权利条件 | 已接入转写流程；代码包 0.3.0，large 约 1.3B 参数，权重在 `MuScriptor-large-1.3B/model.safetensors`。环境 `.venv-py312/`。不能把代码 MIT 当作权重可商用依据；真实录音的本项目效果仍待评估 |
| [Beat This!](https://github.com/CPJKU/beat_this) | 从录音识别节拍与强拍，帮助转写结果量化 | 官方代码和公开权重 MIT；训练材料另有许可 | 已使用；包 1.1.0 位于 MuScriptor 环境，`training/scripts/audio_transcribe_muscriptor.py` 调用 `final0`，不使用 DBN 后处理 |
| [Basic Pitch](https://github.com/spotify/basic-pitch) | 单乐器录音的复音转写备用方案 | Apache-2.0 | 已下载待验证；`open-source/sources/basic-pitch/` 含上游自带模型。尚未安装到生产环境；它不提供完整管弦乐器分离能力 |
| [AugmentedNet](https://github.com/napulen/AugmentedNet) | 乐谱和声分析、统一和弦标签，减少标注约定混用 | 代码 MIT；仓库自带模型随源文件保留，第三方训练语料分别核验 | 已下载待验证；`open-source/sources/AugmentedNet/`，含 `AugmentedNet.hdf5`。未安装 TensorFlow 兼容环境，未重标现有训练语料；外部语料子模块没有递归下载 |

AMT 的 10 个快照是 small 系列 5 个、medium 系列 3 个、large 系列 2 个；具体名称、每个模型大小见
[AMT 下载说明](Anticipatory-Music-Transformer/README.md)。训练数据 Lakh MIDI 未随模型下载。
下载完成依据为 `DOWNLOAD_MANIFEST.json` 的 `complete: true`、逐文件 `verified` 和 SHA256，而非 Git LFS 指针文件。

## 乐谱处理与标准评估

| 项目 | 用途 | 许可 | 当前状态 |
| --- | --- | --- | --- |
| [Symusic](https://github.com/Yikai-Liao/symusic) | MIDI 读取、音符与声部处理，支持训练数据整理 | MIT；自带原生组件保留各自许可 | 已使用；训练环境安装 0.6.0，多个数据处理脚本明确导入它 |
| [Partitura](https://github.com/CPJKU/partitura) | 乐谱与演奏读取、音符数组、对齐与交叉检查 | Apache-2.0 | 已下载待验证；`open-source/sources/partitura/`。适合作为独立处理工具，不替换 Score 排版 |
| [mir_eval](https://github.com/mir-evaluation/mir_eval) | 标准音符起音、音高、结束时间等评估指标 | MIT | 已使用；独立评估环境安装 0.8.2，`open-source/tools/evaluate_notes.py` 输出 precision、recall、F1 与重叠率 |
| [Mido](https://github.com/mido/mido) | Python MIDI 文件和消息处理 | MIT | MuScriptor、评估环境均安装 1.3.3；评估脚本目前读 CSV，不能把 Mido 已安装理解为已经完成所有数据格式转换 |
| [music21](https://github.com/cuthbertLab/music21) | 乐谱分析、导入交叉验证、已有语料读取 | 软件 BSD；随带语料与单曲许可分别处理 | 项目脚本和历史云端验证使用；本机三个已盘点环境未安装。不是目前 Score 浏览器导入器的运行依赖 |
| [Audiveris](https://github.com/Audiveris/audiveris) | PDF 或扫描图识谱，输出 MusicXML | AGPL-3.0 | Score 的外部程序接口已接入，项目记录了 5.11.0 的历史测试；本机未发现默认 `/Applications/Audiveris.app`，其他自定义位置或云端安装未在这轮确认 |

标准评估工具比较的是**实际演奏秒数**，不是直接拿乐谱小节或拍点作时间；当前 CSV 需要
`onset_seconds,offset_seconds,midi`。已有工具不评价配器审美、不自动对齐任意录音，也尚未运行完整真实录音基准。

## Score 回放与文件导出

| 项目或资源 | 用途 | 版本与许可 | 当前状态 |
| --- | --- | --- | --- |
| [SpessaSynth 浏览器库](https://github.com/spessasus/spessasynth_lib) | AudioWorklet 乐器回放 | `spessasynth_lib` 4.3.14，Apache-2.0；核心 4.3.22，Apache-2.0 | 代码已接入；按需加载本地 SoundFont，停止会取消未来音符，保留原回放兜底 |
| [MuseScore General](https://ftp-osl.osuosl.org/pub/musescore/soundfont/MuseScore_General/) | GM 管弦乐与打击乐音色 | MIT，SF3 文件 39,900,972 字节 | 已下载并接入；Score `apps/web/public/audio/soundfonts/`，保留许可证和采样来源表 |
| [Tone.js MIDI](https://github.com/Tonejs/Midi) | MIDI 导出 | `@tonejs/midi` 2.0.28，MIT | 代码已接入；复用核心实际音高播放时间线，包含 GM 音色、力度与速度；当前单端口最多 15 个有音高声部 |
| [midi-file](https://github.com/carter-thaxton/midi-file) | 底层 MIDI 编码和解析 | 1.2.4，MIT | Tone.js MIDI 的间接依赖，不是另一套乐谱模型 |
| [svg2pdf.js](https://github.com/yWorks/svg2pdf.js) | 现有 SVG 乐谱转矢量 PDF | 2.8.1，MIT | 代码已接入；复用自研排版 |
| [jsPDF](https://github.com/parallax/jsPDF) | PDF 页面、尺寸、文字和字体嵌入 | 4.2.1，MIT | 代码已接入；菜单提供独立 PDF 导出 |
| [霞鹜文楷轻便版](https://github.com/lxgw/LxgwWenKai-Lite) | PDF 中文字体 | OFL-1.1，TTF 文件 13,872,424 字节 | 已下载并接入；Score `public/fonts/`，采用字体子集，当前各字重共用常规字体 |
| [Bravura](https://github.com/steinbergmedia/bravura) | SMuFL 音乐符号字形 | OFL-1.1；构建用 `@vexflow-fonts/bravura` 1.0.2 | 已使用；轮廓和锚点生成到自研排版。使用这个字体包不代表使用 VexFlow 排版引擎 |
| [Salamander Grand Piano](https://github.com/Tonejs/audio) | 既有钢琴采样及回放兜底 | 本地复制来源按 CC BY 3.0 保留署名，另保存作者公有领域声明 | Cantelvio Compose 与 Score 已使用，文件为选取的 MP3 子集；不把整个 Tone.js 库列为 Cantelvio Compose 运行依赖 |
| [tonejs-instruments 采样](https://github.com/nbrosowsky/tonejs-instruments) | Cantelvio Compose 电贝斯、电吉他音色 | 本地样本按 CC BY 3.0；保留 Brosowsky、Karoryfer 来源署名 | Cantelvio Compose 已使用；只复制样本，没有使用上游 JavaScript 加载器 |

10-04 曾完成新导出与回放的浏览器检查，包括中文矢量 A4 PDF、MIDI 下载和停止后静音。
随后补了打击乐点击试听映射；这份清单仅盘点文件与依赖，未重新执行该补丁的完整功能检查。
新增依赖的许可证文件、音色来源、字体许可和资源 SHA256 已保存在 Score 中，见
[Score 第三方资源说明](../Score/docs/third-party-notices.md)。

## 数据集和标注语料

| 数据或语料 | 适合用途 | 许可与条件 | 本地完成程度 |
| --- | --- | --- | --- |
| [OpenScore Lieder](https://github.com/OpenScore/Lieder) | 艺术歌曲、旋律与钢琴伴奏训练 | 固定来源记录为 CC0-1.0 | 已使用；`training/data/sources/` 有固定提交的完整源档案和 LICENSE，已有处理数据 `openscore-cc0.json` |
| [PDMX v9](https://zenodo.org/records/15571083) | 扩展 MusicXML 训练谱库 | 工具代码 MIT；乐谱按条目许可。不能把全部 254,077 条目视为已清除许可冲突 | 已下载 225.4 MB 元数据；过滤无许可冲突、文件有效、最佳唯一编配后，得到 **77,321 条候选索引**。MusicXML/MIDI 乐谱文件尚未下载或加入训练 |
| [MusicNet](https://zenodo.org/records/5120004) | 真实古典录音和音符标注评估，包括室内乐 | 官方记录说明录音涉及 Creative Commons 和公有领域来源，需逐录音核验 | 已下载元数据与 2.60 MB MIDI 包并解压；约 11 GB 音频未下载，完整录音评估未完成 |
| [Schubert Winterreise Dataset v2.0](https://zenodo.org/records/5139893) | 人声与钢琴录音、MusicXML、MIDI、演奏对齐及和声标注 | 发布页与 README 声明 CC BY 3.0，附 SC06 修改后不再分发条件；但包内 `license_SC06.txt` 写 CC BY-NC-ND 3.0。HU33 文件注明公有领域 | 已下载并校验 506.9 MB 完整 ZIP，已解压；尚未运行转写基准。优先 HU33，SC06 的矛盾尚未解决 |
| [ASAP](https://github.com/fosfrancesco/asap-dataset) | 钢琴真实演奏和乐谱对齐评估 | CC BY-NC-SA 4.0；音频需要另取 MAESTRO v2 并按其许可使用 | 候选，未下载；不能作为许可无条件的商用数据源 |
| [DCML 语料](https://github.com/DCMLab) | 专家和声标注、分析基准 | 各子仓库和版本分别核验；部分有非商用条件 | 未新增接入，不把整个组织当作一种统一许可 |
| music21 内置语料 | MusicXML 导入器的交叉检查 | 单曲来源与许可独立于 music21 软件许可 | 历史验证使用，不能据此宣称整个语料可商业训练 |
| 本地 MIDI-Library 和整理后的 MIDI | 当前模型已有训练材料 | 项目历史记录注明部分单曲授权不明确 | 已有本地数据，属于待核验来源；不列为已确认开放许可的数据集 |

PDMX 筛选是依据上游元数据的选择策略，不是对每首曲谱权属的独立法律认证。
数据的 MD5 已与 Zenodo 记录匹配，额外 SHA256、大小和固定记录编号见 `open-source/SOURCE_MANIFEST.json`。
代码许可、训练数据许可与训练后权重许可应分别记录。

## 现有基础依赖

以下为实际本地版本；Cantelvio Compose 网页和服务器仍使用原生 JavaScript、Node 内置模块，没有新增第三方 npm 运行依赖。
Score 的 npm 包及各 Python 环境独立管理，安装一个环境不表示另一个环境也有相同软件。

| 软件 | 当前本地版本 | 用途和许可记录 |
| --- | --- | --- |
| React / React DOM | 19.3.0 | Score 界面，MIT |
| Zustand | 5.0.15 | Score 界面状态，MIT |
| Immer | 11.1.18 | 核心命令更新与撤销支持，MIT |
| Vite | 8.3.2 | Score 开发与构建，MIT |
| TypeScript | 5.9.3 | 类型检查，Apache-2.0 |
| Vitest | 5.0.3 | 自动测试，MIT |
| ESLint | 10.11.0 | 代码检查，MIT；插件与类型包见完整清单 |
| Prettier | 3.9.9 | 代码格式，MIT |
| tsx | 4.23.15 | Node 中运行 TS 工具，MIT |
| opentype.js | 1.3.4 | 音乐字体轮廓提取，MIT |
| Sharp | 0.34.5 | 图像渲染工具，Apache-2.0；原生图像库另附许可 |
| PyTorch | 训练环境 2.14.0；MuScriptor 环境 2.13.0 | 模型训练与推理；主要 BSD 系许可，当前轮包元数据包含 Apache、LLVM 例外、BSD、BSL、MIT 等组合，详见清单 |
| TorchAudio | MuScriptor 环境 2.11.0 | 音频处理，BSD 系；此处记录安装状态，不据版本号推断与其他环境完全兼容 |
| NumPy | 训练与评估 2.4.6；MuScriptor 2.5.2 | 数组计算；BSD-3-Clause 与随包组件许可组合 |
| SciPy | 评估环境 1.17.1 | 标准评估数值计算，BSD 系与随包组件许可 |
| SoundFile | MuScriptor 环境 0.14.0 | 音频读写，Python 包 BSD 系；libsndfile 许可另行保留 |
| Hugging Face Hub / Safetensors | MuScriptor 环境 1.27.0 / 0.8.0 | 模型文件获取与安全张量读取；包许可元数据见完整清单，获取方式不改变模型许可 |

完整机器可读依赖表见 [DEPENDENCY_INVENTORY.json](open-source/DEPENDENCY_INVENTORY.json)。它覆盖
Score 锁文件中的 **298 条第三方 npm 包记录**，其中本机安装 **225 条**，其余包括其他平台的可选包；
同时记录三个本地 Python 环境的 **25、56、8 条安装记录**。这些数字不是去重后的项目数量，也不是所有包都被运行时调用。
开发工具、类型包、传递依赖和各平台变体都在该文件中列出；未报告许可的包明确记为 `unreported`，不补猜。

## 后续候选和暂不采用的项目

| 项目 | 当前判断 | 采用前仍需做什么 |
| --- | --- | --- |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) | 候选，MIT；可探索推理加速，尚未安装接入 | 导出当前模型，验证音符或 logits 一致、KV cache、实际机器延迟和内存，再决定使用；不会因为引入库就自动加速 |
| [Matchmaker](https://github.com/pymatchmaker/matchmaker) | 候选，Apache-2.0；适合实时跟谱或翻页 | 用真实演奏验证延迟和定位误差，先作为外部模块评估 |
| [Verovio](https://github.com/rism-digital/verovio) | 当前不替换自研排版；LGPL 路线 | 如果以后需要独立 MEI 查看或转换，单独评估模块、链接方式与许可证 |
| [VexFlow](https://github.com/vexflow/vexflow) | 当前不替换自研排版；这与已用 Bravura 字体包无冲突 | 只有明确发现现有排版无法补足的需求才评估迁移 |
| [Yjs](https://github.com/yjs/yjs) | 当前不改用它存乐谱数据，保留服务器排序的命令日志 | 文本协作等独立功能有需要时再评估，不把 CRDT 当成当前乐谱模型的直接替代 |
| [Replicache](https://github.com/rocicorp/replicache) | 暂不采用；仓库于 2026-06-10 归档 | 本清单不把该归档 SDK 当作可随意采用的开放许可代码 |
| [Magenta 主仓库](https://github.com/magenta/magenta) | 暂不新增依赖；主仓库于 2026-01-06 归档 | 归档状态不等于 Magenta 组织全部项目均归档；具体模型需另核验 |
| [MidiTok](https://github.com/Natooz/MidiTok) / [MusPy](https://github.com/salu133445/muspy) | 当前不迁移现有事件词表或数据模型 | 属于本项目适配收益判断，不表示这两个项目已失效或不能使用 |
| MIDI-GPT 等其他模型 | 未新增下载或接入，候选名不能代替精确模型版本 | 逐仓库确认代码、权重和语料许可后再进入正式选择 |

## 本地目录和可复核记录

主项目：`/Users/chenjinfu/software develop/Cantelvio/Compose`。
Score：`/Users/chenjinfu/software develop/Cantelvio/Score`。

| 文件 | 内容 |
| --- | --- |
| `OPEN-SOURCE-INVENTORY.md` | 本清单和用途建议 |
| `open-source/DEPENDENCY_INVENTORY.json` | npm 锁文件记录及三个 Python 环境安装元数据 |
| `open-source/SOURCE_MANIFEST.json` | AugmentedNet、PDMX、Basic Pitch、Partitura 固定提交；数据校验 |
| `Anticipatory-Music-Transformer/SOURCE_REVISIONS.json` | AMT 与 Levanter 固定代码提交 |
| `Anticipatory-Music-Transformer/DOWNLOAD_MANIFEST.json` | 10 个模型快照和逐文件大小、校验状态 |
| `open-source/evaluation-requirements.lock.txt` | 独立评估环境的版本快照 |
| `open-source/datasets/PDMX/selected.summary.json` | 254,077 行输入与 77,321 条选择结果 |
| `../Score/apps/web/public/licenses/manifest.json` | 新增回放和导出库的原始许可证位置与资产校验 |
| `frontend/media/*/NOTICE.txt` | 原有钢琴、贝斯、吉他样本来源与署名 |
| `training/data/sources/SOURCE.json` | OpenScore Lieder 固定提交、源档案 SHA256 和许可 |

建议下一步先做 AMT 与现有模型的同输入对照、AugmentedNet 标注约定统一，以及 HU33 等真实录音评估。
这些工作应有实际结果后再决定模型架构变化、数据扩充规模或推理引擎替换；本清单不把下载准备当成已经提高音乐质量的证据。
