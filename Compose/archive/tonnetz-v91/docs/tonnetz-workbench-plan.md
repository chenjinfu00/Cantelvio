# Tonnetz：可即兴演奏的和声工作台

日期：2026-09-26。基于已发布的 Tonnetz 与 MusicalKaraoke v79。

## 目标与范围

把演示中除 Choir 外的音乐功能融入 `/tonnetz/`，让用户一边弹旋律，一边控制可持续、可变化的伴奏。原演示页面保持不变。默认英语，跟随底部设置中的中英文切换。使用清晰的无衬线字体、可触控按钮与少量说明。

## 产品结构

1. 键盘仍为主演奏区。新增与乐器设置完全独立的底部上拉工作台；收起时常驻伴奏开始／停止、当前和弦与清楚标注的“伴奏”拉手，另一处保留清楚标注的“乐器设置”拉手。工作台展开后仅面板内部滚动，并从下方为键盘预留空间，不能覆盖仍可演奏的上方键盘。速度、温度、伴奏模式、模型与具体参数均在打开工作台后调控；展开两个底部面板中的一个时可收起另一个以免重叠。
2. **Accompaniment**：40–200 BPM；独立伴奏音量；Pop、Jazz、Classical 织体预设；节奏型（四分、八分、切分、摇摆、三拍）和音型（上行、下行、往返、Alberti、柱式和弦、低音＋和弦）可分别覆盖预设；伴奏乐器至少钢琴、电钢琴、风琴、竖琴/拨弦与柔和铺底。必须产生实际不同的音序、重音与时值，不能仅换标签。清楚标注三拍与四拍。默认 92 BPM、适度音量，不自动启动音频。
3. **Harmony**：复用 33 和弦、四套和声调色板、Markov 1/2 与小型 Transformer；保留下一和弦概率、点击候选手动选和弦、温度、历史、参数与真实 attention；保留“不能重复当前和弦”和 M1/M2 可见差异约束，说明它是教学模型。迁入全部八组进行，可逐个弹或按小节循环；加入带良好声部连接的 Authentic cadence。用户可以选固定和弦、预设进行循环或模型自动生成；手动选下一和弦也可持续即兴。
4. **Learn**：把晶格构建做成自由探索材料：半音圆圈→同一圆圈的五度路径→12 音最小周期单元→铺满平面的周期扩展。解释五度、纯五度 3:2 与十二平均律。和弦形状采用同一个全标音网格，说明边的五度／大三度／小三度含义，支持逐和弦试听；显示可移动三角形。原有 Classic/Harmonic 键盘继续可用。

## 音频与接口约定

- 两类声音所有权必须隔离：旋律、伴奏/预览。停止伴奏、换和弦、换速度或音型不得切断按住或延音中的旋律；全局 Stop all 才同时停止。切换键盘布局/旋律音色仅重置键盘自己的声音。
- 音频引擎暴露 `window.TonnetzAudio`：`ensureReady(): Promise<boolean>`、`playNote(midi,{instrument,velocity,duration,group}): voiceId|null`（duration 秒；默认 group=accompaniment）、`stopGroup(group)`、`setGroupVolume(group,0..1)`、`getContext()`、`panic()`、`highlightChord(pcs)`。伴奏不能占用旋律的 16 声部限额。音频被中断或页面离开必须取消调度，之后由用户手势恢复，不追赶堆积的音符。
- `accompaniment.js` 导出 `RHYTHMS/PATTERNS/STYLES/INSTRUMENTS`（id 与英中名称）、`buildBarEvents(midis,options)`、`createAccompaniment({audio,onBar,onBeat,onState})`。控制器：`start(midis)` 返回 Promise、`stop()`、`setChord(midis)`、`update(options)`、`getState()`；状态包含 playing/bpm/rhythm/pattern/style/instrument/volume/beatsPerBar。onBar 在每个小节开头调用，可返回下一和弦 MIDI 列表；首次 start 不自动跳过初始和弦。onBeat 为位置提示，停止后不遗留定时器。
- 主要钢琴样本使用已在站内的可靠本地采样，可选音色优先现有可立即发声的引擎。外部采样不可用时不得静音等待；对降级音色如实标注。
- `learn.js` 导出 `createLearnPanel({container,audio,getLanguage})`，返回 `{render,destroy}`；预览使用 `group:learn`，停止预览不影响伴奏/旋律。自带命名空间 CSS。
- `workbench.js` 在已有 app.js 后加载为 ES module，负责响应式面板、i18n、伴奏控制器、和声 UI、Learn 嵌入；模型直接使用 `lib/harmony-models.js`。不要重写已有模型数学，不依赖演示页面或幻灯片导航。

## 分工与文件边界

- GPT‑5.6 Sol 音频：app.js（引擎桥接/所有权隔离）、accompaniment.js、音频/节奏测试。
- GPT‑5.6 Sol 工作台：index.html、workbench.js/css、workbench-data.js、sw.js、UI/数据测试；不改 app.js、Learn 文件。
- GPT‑5.6 Sol 科普：learn.js/css、科普测试；不改 index.html 或公共 CSS。
- 主代理：审查集成、排版与音频实际调用验证、修复交叉问题、发布。

## 验收

- 全部八个进行与终止式可真实播放；生成器每种模型输出归一化概率、无当前和弦自循环、温度可调；参数和 attention 来自实际模型。
- 节奏/音型/速度测试检查事件序列及小节时值；停止/重启/异步音频解锁测试检查没有叠加循环；伴奏停止不能伤及旋律。
- 浏览器检查桌面、iPad 横向、窄屏：键盘与控制可到达，无水平溢出、文字重叠、被挡按钮；操作面板不中断持续伴奏。中英文切换覆盖新内容。
- 复查英文音名、Roman 数字、C 大调范围内功能和弦、和弦形状和纯律数学。不要声称手工教学模型是训练于真实音乐的大模型。
- 更新 Service Worker 资源版本，运行原演示回归测试与新功能测试，完成本地交互审查后按现有 Sites 流程发布 `/tonnetz/`。
