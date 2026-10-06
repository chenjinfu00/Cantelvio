# AIlegro：独立实时音乐工作台准备稿

**状态：仅产品与实施准备。** 本轮没有修改 Tonnetz、网站或现有模型，也没有实现或发布新 App。产品名称由用户确定为 **AIlegro**：第一个字母 A、第二个字母 I 均大写，后面的 legro 小写。

## 定位与受众

AIlegro 是一台用于实时生成和演出控制的音乐工作台：用户选定调性与织体，让和声模型提交接下来的和弦，让旋律模型在当前和弦与下一和弦条件下生成可选的单音旋律，再用场景、声部混音和段落控制塑造演出。自动旋律默认关闭。新 App 不内嵌 Tonnetz 键盘；用户仍可并排打开 Tonnetz 或弹实体钢琴，V1 不承诺跨 App 自动同步键盘状态。

主要面向想快速获得和声伴奏、即兴素材或氛围底层的键盘演奏者、编曲探索者与音乐学习者。两个模型是小型本地实验模型：和声模型从原创合成句法训练，旋律模型另有有限的 CC0 OpenScore 古典歌曲训练片段及合成语料；它们不应被宣传成专业大型模型、完整作曲家或听感保证。

**DJ 式控制台**指实时调节织体、段落和多个可保存场景。Harmony 与 Melody 是生成控制和声部来源，不是两台能直接互相交叉推子的音频唱盘。V1 用四个场景 pads 共用播放时钟和已提交的和声队列；按小节边界量化切换。真正的双引擎并行和无缝音频 crossfade 留到后续，避免用“切换模型”制造队列、旋律上下文和音频时钟分裂。

新 App **不内嵌 Tonnetz 键盘**。主界面由场景 pads、三声部 mixer、和弦参数块与四和弦走带组成；Tonnetz 只作为可选外部链接／并排即兴工具，不承诺跨 App 键盘或 transport 同步。DJ 控制台的交互参考如下：

| 官方参考 | 借鉴 | 不照搬 |
|---|---|---|
| [Novation Launchpad Pro MK3](https://userguides.novationmusic.com/hc/en-gb/articles/25494530115346-Launchpad-Pro-MK3-interface) | 列表示 tracks、行表示 scenes，queued / playing 状态可见。 | 不做完整 clip 网格、MIDI 控制器映射或硬件工作流；AIlegro 的 2×2 场景 pads 不沿用其行列模型。 |
| [Traktor Pro workflow](https://docs.native-instruments.com/ni-tech-manuals/traktor-pro-manual/en/the-traktor-workflow) | 各声部／通道各有音量控制。 | 不把和声与旋律当成两个音频盘，也不以跨推子替代独立声部推子。 |
| [Ableton Move](https://www.ableton.com/en/move/manual/) | 紧凑的 track 与 pad 组合。Move Session 模式行=track、列=scene，与 Launchpad/Live 的方向不同；AIlegro 不照搬任一方向。 | 不引入完整 DAW 的轨道编辑器或编曲视图。 |
| [Ableton Live 12 Session View](https://www.ableton.com/en/live-manual/12/session-view/) | 按小节量化触发场景、切换保持连续音乐时间的概念。 | 不复制 Session View 布局或它的完整录音／编曲流程。 |

## 产品名称

**AIlegro**。所有界面、文档和应用元数据均使用这一拼写；第二个字符是大写字母 **I**，不是小写 l。旧工作名和候选名不再使用。

## 60 秒首次使用

1. 打开后默认看到 English 界面；语言菜单可切到中文。选择一个主调，默认保持固定；选择一个场景，例如 **Warm Piano**。
2. 点 **Play**。默认和弦为 **Hold**；用户可以在并排打开的 Tonnetz 或实体钢琴上手弹，V1 不承诺跨 App 自动同步键盘状态。点 **Auto** 后，队列中的和弦从下一小节开始接管。
3. 打开 **Melody On**，开始自动生成；明确的 **Melody Off** 会关掉旋律模型。调节 **Chords / Bass / Melody** 三个独立声部滑杆。
4. 用 Harmony T、Melody T、Density、Feel 宏控制对应单项参数；点四个场景 pads 之一，在下一小节套用另一配器快照。
5. 看见当前和弦加三个未来和弦；点一个未来和弦打开简短编辑器，选候选或编辑根音、类型、转位，再确认重算后续。
6. 任何时候按 **Stop** 停止走带，按显眼的 **Panic** 立即停止 AIlegro 里的全部声部与排队事件。并排 Tonnetz 是独立音频上下文，不受 AIlegro 的 Panic 控制。

## V1 范围

### 主界面与必做控制

桌面主界面以演出中最常用的块状控制为主：播放／停止与 Hold／Auto、主调和调性游走状态、当前和弦加未来三个和弦、Chords／Bass／Melody 三个声部推子、2–4 个宏旋钮，以及 Warm Piano、Velvet Jazz、Indie Drive、Open Air 四个显眼的场景 pads。主布局不含钢琴键盘；Tonnetz 只作为可选外部链接，不放在主界面，用户可以自行并排打开它即兴。旋钮旁显示短标题、当前位置和单位；可点按也可拖动，触屏目标留足尺寸，不在演出主面板塞入模型层数、注意力图或小字号参数。

宏控件建议首版收敛为四个：

| 宏控制 | 作用 | 建议范围和生效时机 |
|---|---|---|
| **Harmony T** | 和声 Transformer 的单一采样温度参数；低值更集中，高值分布更分散。 | 0.25–2.00，初值约 0.82。松手后重算尚未播放的三个队列槽；正在响的和弦不改。 |
| **Melody T** | 旋律 Transformer 的单一温度参数，不替代 Melody 音量或 Melody On/Off。 | 0.25–1.50（现有采样器边界）；下一个尚未排程的小节使用新值，不重写已排程音符。 |
| **Density** | 映射到旋律规划器的单一 density 参数，控制旋律事件密度。 | 0–1；下一小节生效。旋律 Off 时保留数值，但不推理或排程旋律。 |
| **Feel** | 映射到伴奏规划器的单一 feel 参数，控制既有的时值摆动／表现变化强度。 | 0–1；下一小节生效。自动场景随机率由单独控件设置，不与 Feel 绑定。 |

Tempo 独立显示为 **40–200 BPM**，用较大的减／加按钮与数字读数，可拖动或点按输入；建议在下一小节边界应用。主调可从 24 个大小调选一个。调性游走是单独的开关：开启后每 4／8／16／32 次和弦变化获得一次转调机会，也可能留在原调；Hold、打开界面和查看和弦不推进该计数。

织体预设以现有可用类型为基础：quarter / eighth / syncopated / swing / waltz 节奏，comping / ascending / descending / updown / Alberti / block / bass-chord 音型，以及对应的原声钢琴、电钢琴、吉他、弦乐、pad、贝斯等音色。V1 用易懂场景组合呈现，不需要把整个选项表搬到主面板。音色、节奏、音型和模型互动强度放在 V1 常规参数抽屉。低音可独立关闭；自动旋律标签固定使用 **Melody On / Melody Off**，避免与混音台“Solo（独听）”混淆，默认 Off。音量拉到 0 或静音只改变 bus gain，不等于关闭模型：Melody Off 才清除未来旋律排程、decoder 上下文与反馈；它不能影响手弹音符、和弦或低音声部。当前 Tonnetz 尚未提供完全独立的三路推子：伴奏和低音音量有乘积耦合（低音组增益 = 伴奏音量 × bassVolume），新 App 需要新增 Chords、Bass、Melody 独立 bus gain。

**自动变化率**：V1 提供 Random Scene 开关和每 1–32 小节的平均切换间隔（可用 4／8／16／32 预设）；默认 Off。切换在小节边界抽样，不改变主调、总音量、Melody On/Off 或已承诺和弦队列。默认窄范围同类场景；“Wild”可以留到后续。场景／小节量化仅参考 [Ableton Live 12 Session View](https://www.ableton.com/en/live-manual/12/session-view/) 中场景与 clip 的启动概念，不复制 DAW 布局或完整工作流。

**和弦走带与编辑**：当前和弦加未来三格（总计四格）一直可见。Hold 保持当前和弦；Auto 消耗未来队列。编辑未来槽保留更早已承诺的槽，只把该槽替换并按新和弦上下文重算更后面的槽。显示完整和弦名、低音／转位与调性；小屏细节可点击展开，避免长斜线和弦符号挤压格子。

**场景库**：V1 提供 Warm Piano、Velvet Jazz、Indie Drive、Open Air 四个场景 pads。场景保存声部音色、节奏／音型、Harmony T、Melody T、Density、Feel 和三路相对混音值。它默认不改变全局 BPM、主调／调性游走、Melody On/Off、总音量或已承诺的和弦队列；切换在下一小节共用 transport 上应用配器快照。切入的新 Harmony T 只影响后续新生成并追加的队列槽，不重算三个已承诺的未来槽。BPM 或其他全局设置未来可由用户显式勾选“随场景切换”，V1 不引入该行为。场景 pads 显示名称及选中状态，并允许保存当前快照。

四个场景的第一轮参数起点如下，属于待试听校准的设计值，不是新的模型风格或训练成果：

| 场景 | 和声条件 / 伴奏风格 / 旋律风格 | 节奏、织体与音色 | 温度与表现参数 |
|---|---|---|---|
| Warm Piano | `pop / pop / pop` | `syncopated + comping`；和弦 piano，低音 piano / root-fifth，旋律 piano | Harmony T .78；Melody T .78；Density .55；Feel .65 |
| Velvet Jazz | `jazz / jazz / jazz` | `swing + comping`；和弦 epiano，低音 electric-bass / walking，旋律 reed-lead | .82 / .80 / .50 / .72 |
| Indie Drive | `pop / rock / blues` | `eighth + rock-strum`；和弦 electric-guitar，低音 electric-bass / driving，旋律 electric-guitar | .78 / .82 / .60 / .55 |
| Open Air | `pop / pop / ambient` | 显式覆盖 `quarter + block`；和弦 pad，低音 synth-bass / pedal，旋律 bell | .72 / .64 / .30 / .50 |

三个风格字段必须独立映射：和声模型没有 `rock` 或 `ambient` 条件，不能把界面场景名直接传给模型。自动场景变化使用场景状态转移；和弦仍由 Transformer 预测。以上所有场景都保留 Melody On/Off 的全局选择。

播放中点场景先显示 **Queued**，在下一小节切为 **Active**；再次点其他场景替换待执行项，点已排队场景取消它。停止时选场景立即准备参数但不启动声音。已提交和弦队列保持稳定，新增场景和声条件仅影响下一次追加预测。队列中的旧条件预览不能被界面刷新悄悄重抽。

### 明确后续

- 两套真正并行、可分别运行的生成器，独立历史／KV cache，自动对齐乐句后混合，以及跨音频引擎的无缝 crossfade。
- Attention 可视化、模型内部概率面板和模型结构调试页；后续作为学习／高级功能，不占演出主界面。
- 后续模型调试页可展示真实结构与范围，包括 Harmony 4 层、8 头、宽度 64、上下文 24 个和弦、204,391 个可训练参数；Melody 4 层、8 头、宽度 96、前馈宽度 224、96 事件 KV cache、349,325 个可训练参数。这里展示的是已有模型事实，不把“参数多”包装成音乐质量。
- 完整随机编配编辑器、任意参数映射、自动音量均衡／母带、录音与导出、MIDI／外部设备、账号云同步、用户模型训练、跨小节旋律连音、微分音及超出有限词表的多调性和弦。
- 场景间渐变或按拍交叉淡化；第一版先验证场景的量化切换可靠。

## 文字线框

桌面：

```text
┌ AIlegro  Key: C major ↝ off     92 BPM         English ┐
│ [▶ Play] [Hold | Auto]       [Harmony T .82] [Melody T .78]│
│ [Warm Piano] [Velvet Jazz] [Indie Drive] [Open Air]        │
│ Current C       +1 Am       +2 F       +3 G                 │
│ [Chords ━━━━━━━] [Bass ━━━━━] [Melody OFF / ━━━]           │
│ [Settings ▾] [Density .55] [Feel .65]             [PANIC] │
└─────────────────────────────────────────────────────────────┘
```

手机：

```text
┌ AIlegro    C major ↝      92 BPM ┐
│ [▶ Play]       [Hold / Auto]  [PANIC] │
│ [Warm Piano] [Velvet Jazz]               │
│ [Indie Drive] [Open Air]                 │
│ C  →  Am  →  F  →  G                 │
│ Chords ━━━━━━━━    Bass ━━━━━          │
│ Melody [OFF] ━━━━━  [More controls ▾]  │
│ [Harmony T] [Melody T] [Density] [Feel] │
└───────────────────────────────────────┘
```

手机布局中，四和弦走带保持单行、格子可点且不缩成小字；上方播放键、Hold/Auto 与 Panic 在首屏。三个推子可两行排列；宏控制用两列参数块，常规参数抽屉覆盖呈现音色、节奏、音型、模型互动强度及 Random Scene 间隔。平板可用左侧场景／主控、右侧三声部与宏控的双栏；竖屏平板沿用手机顺序但放大点击区域。抽屉覆盖当前页面，打开时不推移场景块和控制台。主要控件文字以 16px 起步，触摸目标至少 44px；320px 时通过重排避免缩小字体。

## 可复用模块与抽取风险

以下路径均相对于 `tonnetz-workbench/`：

| 源文件 | 当前职责／可复用能力 | 耦合与独立 App 抽取风险 |
|---|---|---|
| `public/tonnetz/lib/harmony-models.js` | `prepareModels`、`predictNext`、`sampleDistribution`、`voiceChord`；和声 Transformer 推断、解码分布与和弦配音。 | 低到中：本身模块化，但强依赖 chord-vocabulary、tonality、内嵌权重与词表顺序；模型是同步 JS 计算，需测首屏加载／低端手机响应。 |
| `public/tonnetz/lib/harmony-transformer.js` | 导出固定 Harmony Transformer 权重与训练元数据。 | 低运行时耦合，高体积：约 204,391 参数；权重内嵌 JS，需避免被 UI bundle 重复载入。与词表 token 顺序必须版本一致。 |
| `public/tonnetz/lib/chord-vocabulary.js` | 40 种和弦质量、12 根音、480 基本符号与 2,172 个和弦／转位版本；名称、音高、解析。 | 低到中：独立规则库，但编码 ID、转位次序是权重和训练契约。 |
| `public/tonnetz/lib/tonality.js` | 24 个大小调、调性解析／显示、key-walk 状态推进。 | 低：纯逻辑为主；场景状态需决定保存当前 key，且队列中每槽已绑定 key。 |
| `public/tonnetz/lib/melody-model.js` | `createMelodyDecoder`、`melodyForward`、`sampleMelodyLogits`；有限 KV cache 和真实 attention 输出。 | 低：纯推断模块；依赖 Melody 权重／特征 token 契约。权重 3.9 MB 非压缩，加载策略要单独设计。 |
| `public/tonnetz/lib/melody-transformer-weights.js` | Melody 权重、特征和训练元数据。 | 低运行时耦合，高体积；与特征顺序、训练脚本输出、采样器必须锁定同版本。 |
| `public/tonnetz/improvisation.js` | `createMelodyPerformer`、`buildMelodyBar`；旋律事件、短动机、乐句、和声 affinity feedback。 | 中：纯模型逻辑为主，直接引入 tonality 和 chord vocabulary；事件输出尚适配 Tonnetz 的音符角色和采样器。 |
| `public/tonnetz/accompaniment.js` | `createAccompaniment`；每小节调度，Harmony/Bass/Melody 事件分组，播放状态与音频取消。 | 高：需要 `TonnetzAudio` 兼容对象、计时器时钟、回调注入和组音量 API；使用 `window` 监听 `tonnetz:panic` / `tonnetz:audio-state`。应先切出无 DOM 的 transport／audio adapter。 |
| `public/tonnetz/chord-lookahead.js` | `createChordLookahead`；当前加未来三格、稳定 UID、advance、`contextFor`、`replaceFuture`。 | 低：接 predict/sample 回调；适合作为共享队列核心。用户界面与和弦展示不要复制进此层。 |
| `public/tonnetz/walking-bass.js` | 依和弦低音、落点和过渡音规划低音。 | 中：作为纯规划模块可复用，但音色 ID 和音频调度仍要通过 adapter 映射。 |
| `public/tonnetz/performance-controls.js` | 当前轻量主调、key-walk、温度、Random、Solo 控件。 | 高 UI 耦合：直接访问 `document`、容器和 data 属性；可参考尺寸与交互，建议新 UI 重写而不是复制整页。 |
| `public/tonnetz/chord-timeline.js` | 当前四格和弦走带、Transport 进度及键盘／触屏点击。 | 中到高：可借鉴 UID 点选、长符号适配、aria 与响应式 fit；带有 Tonnetz 类名、CSS 和时间线协议。 |
| `public/tonnetz/workbench.js` | 连接 UI state、DOM、模型、队列与 audio 全局；场景应用与和弦编辑器。 | 极高：`document.querySelector`、全局 `window.TonnetzAudio`、现有键盘／面板 ID、工作台 CSS 深度绑定。**不可直接复制整页**；提取其业务状态和 action 到新 session/controller 边界。 |
| `public/tonnetz/app.js` | 页面级 Web Audio 引擎，导出 `window.TonnetzAudio`，提供 `ensureReady`、`playNote`、`stopGroup`、`setGroupVolume`、`getContext`、`panic`、`highlightChord`。 | 极高：音色样本、键盘高亮、window 与页面生命周期同在；先把音频引擎拆成可注入模块，去掉高亮／DOM side effect，再给 AIlegro adapter。`window.blur`、`document.hidden`、`pagehide` 目前都触发全局 Panic，独立引擎必须重新定义这些生命周期行为。 |

源码对应线上 Tonnetz v91、commit `b6bc3e7aefa4f415408566957b7b1918d32a31af`；14 个核心模块的校验哈希和 3 份音源 NOTICE 记录在 [SOURCE_BASELINE.json](SOURCE_BASELINE.json)。本准备稿以该清单作为后续抽取前的源码基线，不改动该清单。音源 NOTICE 路径为 `public/tonnetz/media/piano/NOTICE.txt`、`public/tonnetz/media/bass/NOTICE.txt`、`public/tonnetz/media/guitar/NOTICE.txt`；三组样本按保守 CC BY 3.0 处理并保留署名。OpenScore 训练数据是另一许可链，见 `public/tonnetz/MELODY-DATA-NOTICE.txt`，许可为 CC0。源码存在 `app.js` 全局 audio API，但核心调度模块已用依赖注入接收兼容音频对象，给后续拆分留有切入口。

## 独立化边界

建议新 App 分四层，依赖只从上往下：

1. **Session / scene state**：保存 key、key walk、当前和弦、mode、场景快照、三声部 mix、宏参数和随机状态；不直接碰浏览器 API。
2. **Harmony adapter 与 queue**：封装 `predictNext`、`sampleDistribution`、`voiceChord` 和 `createChordLookahead`。对外只提供状态快照、未来槽编辑、队列提交／推进；将 Harmony 参数变更变成显式“未来队列重算”命令。
3. **Melody adapter 与 accompaniment planner**：把 chord/key/next chord/tempo 及 melody controls 映射为 `createMelodyPerformer.plan()` 的事件；保留旋律独立 Off 和 decoder reset 规则。使用 Harmony affinity 时只在旋律开启并且有有效反馈时，按 interaction strength 调整**还没提交**的新和弦预测。
4. **独立 Transport / Audio adapter / UI**：Transport 管 bar/beat、启动、停机、量化场景提交与 generation token；Audio adapter 提供 `ensureReady`、`playNote`、`stopGroup`、`setGroupVolume`、时钟／取消接口和独立 bus gain。adapter 不读取 DOM、不依赖 `window.TonnetzAudio`，UI 通过事件／订阅渲染。当前 `app.js` 将 `window.blur`、`document.hidden` 和 `pagehide` 全部连到 Panic；独立引擎必须去掉普通窗口失焦即全停的耦合，保证与 Tonnetz 并排可见演奏时切换焦点不会断伴奏。AudioContext suspend、pagehide 或设备音频中断应停止调度并清理未来事件；恢复需用户手势唤醒音频，跳过错过的时间，不追赶积压节拍。后台隐藏标签的持续演奏性能不作保证。

首个技术里程碑是把现在的 `createAccompaniment` 调度约定改成显式注入的纯接口（transport clock、音频 output、queue callback、voice planner）；随后从 `app.js` 的页面对象中抽出音色播放与 group cancel。新产品可以先复用模型逻辑与模型权重文件，但应以包／模块边界引用，而非复制 `workbench.js` 与页面 HTML/CSS。采样 URL 从新 App 的资源根路径解析；缓存名、Service Worker scope 和本地偏好存储使用独立命名空间，避免与 Tonnetz 相互覆盖。音频启动只发生在用户手势之后。

## 最少数据契约与并发规则

队列槽的最低字段：

```ts
type ChordSlot = {
  uid: number; chordId: string; key: { tonic: number; mode: 'major' | 'minor' };
  keyAge: number; step: number | null; edited?: boolean;
};
type HarmonyQueueView = { revision: number; slots: [ChordSlot, ChordSlot, ChordSlot, ChordSlot] };
type VoiceMix = { harmony: number; bass: number; melody: number };
type ModelEvent = {
  role: 'harmony' | 'bass' | 'melody'; midi: number; atBeat: number;
  durationSec: number; velocity: number; instrumentId: string; generation: number;
};
```

四格含当前和弦加三个未来槽。`uid` 在槽生成时固定，播放只能消费对应队首 UID；队列 `revision` 在 reset、改 key、重算、编辑未来、切换生成策略时递增。场景可保存值，但不保存／恢复正在响的队列历史。正在播放时的场景切换在下一小节套用声部与宏参数；当前已发声事件保持原样，共享同一 transport，队列只由本 session 提交或用户明确编辑。

编辑未来和弦时，打开编辑器必须捕获 `{uid, revision}`。提交前重新查找该 UID：若已播放、队列已被参数变更重建，或 UID 不存在，则丢弃提交并显示“队列已前进，请重新选择”；不能把旧选项写到当前同索引的新和弦。编辑成功后，目标槽之前的 advertised 槽保持不变，目标被替换，后续槽按新 harmony/key/model state 顺序重算。关闭编辑器、切换场景或 Stop 均取消当前编辑 intent；播放推进若尚未越过目标 UID可以保留编辑器，但提交必须再校验 UID。

`Stop` 让 transport 停止，增加 generation token，取消所有未触发 timer 与自动声部音频组，清空旋律 decoder/context；重新 Play 使用新 token。**Panic 停止 AIlegro 整个 App 的所有声部**，并停止 transport；它不控制或中断并排运行的独立 Tonnetz（两个 App 不共享音频上下文）。普通窗口失焦不能触发 Panic；AudioContext suspend、pagehide 和设备音频中断则停止调度、清理未来事件，恢复由手势触发且从当前位置重新开始，不追赶积压事件。场景量化只允许在 transport 的安全边界提交；乱序回调、旧 token 与取消后事件必须无效。

## 训练状态与模型冻结

**Harmony**：4 层、8 头、宽度 64、FF 192、24 chord context、204,391 参数；训练于 4,800 个人工构造的原创合成和声句，验证集 512 句。最佳 checkpoint 是 step 200；验证 chord cross-entropy 3.100、perplexity 22.20、top-1 26.33%，条件转位 top-1 67.63%。没有真实音乐语料或真实作品听感验证；合成语法上的验证改善不能当成专业和声质量证明。

**Melody**：4 层、8 头、width 96、FF 224、96 event cache、349,325 参数。训练含 4,500 条合成八小节乐句，以及从 CC0 OpenScore/Lieder 保守提取的 899 个训练片段（116 作品）与 150 个验证片段（15 作品）；验证作品参与 checkpoint 选择，所以不是独立测试集。真实片段仅代表古典声乐，其他风格仍以合成为主。真实验证前缀上 v4→v5 pitch CE 3.341→2.043、duration CE 2.526→1.088；预测指标不证明听众偏好。未做听众偏好研究；浏览器性能数字不等于移动性能保证。

**首个独立 App 版本冻结现有模型权重与 token contract**：准确复用已核验的权重、词表、特征顺序和导出元数据；V1 只优化 UI、adapter、队列与音频结构。任何重新训练、换语料、改 token／层数、生成新 checkpoint 都作为单独模型版本和评估项目，不能与 App 抽取混在一起。界面高级抽屉若披露训练状态，应明确它们是有限实验模型及上述验证边界。

## 分阶段任务与验收

| 阶段 | 工作 | 验收条件 |
|---|---|---|
| 0. 冻结基线 | 标记 Harmony/Melody 权重、词表、训练元数据和当前模型 commit；记录现有 queue、transport、audio 行为。 | App 能准确报告模型版本／限制；新工作不改现有 Tonnetz 的站点和运行行为。 |
| 1. 纯逻辑适配 | 对外包装模型预测、音符事件与 `createChordLookahead`；抽出 session contract、UID/revision 与参数应用时机。 | 注入相同随机序列、相同历史和参数后，新旧规划器的 chord id、key、inversion 与 melody events 一致；失效 UID 提交安全取消；关闭 Melody 不生成旋律事件。 |
| 2. Audio / transport 拆分 | 提取独立 audio adapter 和可测时钟；共享 BPM、拍点、小节边界，统一独立 bus gain/cancel/panic 与 audio context lifecycle。 | Play/Stop/Panic 无残留排程；快速重启时旧事件不响；Panic 停止 AIlegro 内全部声部，外部 Tonnetz 不受影响；A/B 切换仅在边界改场景，transport 不重启；与 Tonnetz 并排可见窗口互切焦点不中断；context suspend/device interruption 停止调度，手势恢复后不追赶积压；后台隐藏标签的支持边界明确。 |
| 3. 单页演出界面 | 新独立路由／App 壳，英默认、中可切；不内嵌键盘；主控制、四和弦走带、三推子、四场景 pads、四宏、常规参数抽屉（音色、节奏、音型、互动强度、随机切换率）。模型结构和 attention 调试面板后置。 | 桌面、320px 手机和平板布局没有文字重叠或过小点击区；四格和弦始终可读可点；Melody 默认 Off 且能单独关闭；mute 与模型 Off 表意不同。 |
| 4. 可演出预览 | 在独立 App 内接入真实浏览器音频，按实际设备试听与操作。 | 共享时钟下手弹可与自动伴奏共存；future edit race、参数 debounce、随机场景切换和 panic 可复现并稳定；不同屏幕控制无跳动。 |
| 5. 后续产品准备 | 名称可用性核查、隐私／离线说明、性能与音频权限文案、完整发行评估。 | 产品名称确认、首次使用流程可完成、模型限制表述准确、支持目标设备的加载和响应经实测。 |

## 本轮完成与未做

本轮完成了现有 v5/v2 文档、improvisation 计划、运行时源码与源码基线清单的交叉核对，并整理定位、用户确定的名称 AIlegro、V1 交互、真实复用边界、数据契约、队列竞态规则、训练限制和拆分顺序。主代理核对了 Launchpad、Ableton 和 Traktor 官方交互参考，并按用户确定的名称统一为 AIlegro。

GPT-6 Luna 完成准备稿和会话内布局草图，主代理审核并修正。草图已检查 1024px 桌面与 320px 手机宽度，确认场景立即选择、播放中排队、再次点击取消、模拟小节提交、场景参数更新和推子读数。草图只演示界面状态，不连接真实声音、Transformer 推理或和弦编辑器；这些功能按照上述阶段实现。

2026-09-26 补充设备尺寸预览：1366×900 桌面、1180×820 iPad 横屏、820×1180 iPad 竖屏。较宽布局将每个声部的名称、推子、读数和静音排列在同一行，减少空白；测得控制台高度依次约 760、760、806px，均无横向溢出。按钮和表单控件高度不低于 44px，场景排队／取消交互复核通过。截图保存在 `previews/`。这些是浏览器尺寸模拟，不代表 iPad Safari 真机、触控、多点触控或音频测试。

本轮没有创建 App、改动 Tonnetz 源码／权重／训练数据／网站，也没有做正式商标／域名确认、性能测试、听感测试或发布。
