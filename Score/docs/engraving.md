# 排版引擎

代码：`packages/engraving`。决策：[ADR 0003](adr/0003-own-engraving-engine-smufl.md)。

排版是一个**纯函数**：`layoutScore(doc, options) → ScoreLayout`，再由 `renderPageSvg` 变成 SVG。
相同输入产生相同字节——这让快照测试和视觉对比有意义，也让未来放进 Web Worker 很简单。

## 流程

```text
ScoreDoc
  │ 1. 记谱（layout/notation.ts）每个谱表 × 小节：
  │      按拍号切分音符与休止符（rhythm.ts）、跨小节连线、隐式休止符、连音框架、
  │      符杠分组、符干方向、临时记号（每小节一次，连线后的音不重复）、移调记谱
  │ 2. 和弦几何（chord.ts）：二度错开、临时记号列、加线、附点、符尾、演奏法记号
  │ 3. 小节列（columns.ts）：所有谱表同一时刻对齐成“段”（segment），
  │      按时值的弹簧宽度 + 碰撞最小宽度
  │ 4. 分行（engrave.ts）：贪心装行；每行精确对齐到版心宽度（二分搜索拉伸系数）
  │ 5. 纵向间距：按每行谱表内容的实际上下范围（最高/最低点）决定谱表间距
  │ 6. 分页：按页高装行；标题块只在第一页
  │ 7. 绘制：draw.ts 画符头、符干、符杠（斜率限制、短符杠）、连线（含跨行）、连音记号、力度；
  │      engrave.ts 画小节线、括号、花括号、乐器名、速度、排练号、和弦记号（按谱表上方的
  │      轮廓线避让音符）；signatures.ts 画谱号、调号、拍号及其变化
  ▼
ScoreLayout { pages[], systems[], staffSpaceMm, options }
  └─ PageLayout { graphics[]（定位好的图形）, systems[]（命中测试几何） }
       └─ renderPageSvg → <svg>（字形在 <defs> 里，用 <use> 引用）
```

## 单位与坐标

- 排版内部单位是**谱表间距（staff space）**：五线谱高 4 个单位。y 轴向下。
- `settings.staffSpaceMm`（默认 1.75 mm，大总谱模板更小）把单位换成毫米；
  页面大小默认 A4，页边距 15 mm。
- `STYLE`（`options.ts`）集中了所有版式常数：线宽、符干长度 3.5、符杠粗 0.5、四分音符基础间距
  3.4、间距指数 0.62（时值加倍，间距乘以 2^0.62 ≈ 1.54）等。

## SMuFL / Bravura

- `scripts/gen-smufl.mjs` 从 Bravura 字体（SIL OFL 1.1）提取需要的字形轮廓、外框和锚点，
  生成 `src/smufl/bravura.generated.ts`（**不要手改**，运行 `npm run gen:smufl`）。
  脚本会对照官方 metadata 校验码位和外框。
- 运行时不需要音乐字体：SVG 里直接是路径。新增字形：在脚本的 `GLYPHS` 表里加名字和码位，重新生成。

## 横向间距

- 每个“段”（某一时刻所有谱表上的音/休止符）的宽度 = `spacingFor(到下一段的时值)`
  = `3.4 × (时值 / 四分音符)^0.62 × spacing`，再与碰撞需要的最小宽度取大。
- 小节开头留出谱号/调号/拍号变化的空间；行首重复谱号和调号。

## 分行与对齐

- 贪心：在不超过版心宽度的前提下往一行里放尽可能多的小节；`breakAfter: 'system'` 强制换行，
  `breakAfter: 'page'` 强制换页（该页不做纵向撑满）。
- 除最后一行（且不够满）外，每行通过二分搜索拉伸系数精确撑满版心宽度。
- 连续视图（`mode: 'continuous'`）：一行到底，不分页，适合编辑大总谱。

## 记谱规则（已实现）

- 按拍号的音符/休止符切分：简单拍子显示拍点，复合拍子按附点四分音符拍，4/4 显示小节中点，
  常见切分节奏保持不切开；休止符落在拍或半拍上。
- 符杠：4/4 中八分音符按半小节、十六分音符按拍分组；复合拍子按拍；短符杠（beamlet）。
- 临时记号：按调号与本小节内已出现的变音决定；连线后的音不重复记号；还原号。
- 移调乐器显示记谱音高（单簧管、圆号、小号……），可切换实际音高。
- 多声部：声部 1/3 符干向上，2/4 向下；空声部在有其他声部时显示休止符。
- AI 建议（`source.kind === 'ai'` 且未接受）带 `ghost` 类，编辑器里显示为蓝色；无法精确写出的时值
  带 `approx` 类（橙色）。

## 给编辑器的几何信息

`SystemGeometry` → `StaffGeometry`（每行谱表 y）→ `MeasureGeometry`（x、宽度、内容起点、长度）→
`SegmentGeometry`（每个时刻的 x 与 offset）。编辑器用它们做命中测试（点到哪个谱表的哪个小节、
哪个线位）、画输入光标、阴影音符和播放线。`offsetToX` / `xToOffset` 在小节内插值。
SVG 元素带 `data-ref`（`n:<音符 id>`、`e:<事件 id>`、`rest:…`、`ch:<和弦 id>`）用于选择和着色。

## 检查排版改动

```sh
npm run render -- --all --out out/            # 渲染全部示例为 SVG + PNG
npm run render -- --file my.ailegro.json --out out/ --concert   # 渲染自己的文件，实际音高
npm run render -- --sample orchestra --continuous --out out/
```

改排版规则时：在 `engraving.test.ts` 加规则测试，渲染受影响的示例看图，PR 里写明检查了什么，
最好附前后对比图。

## 已知缺口（路线图）

- 小节线前的谱号变化（目前画在变化位置）、提示性调号/拍号（行末预告）。
- 同一谱表上多声部的符头碰撞偏移。
- 连线（slur）、渐强渐弱、歌词、装饰音、八度记号、踏板。
- 跨谱表符杠、合并多小节休止（multi-rest）、声部谱提取。
- 临时记号的显示覆盖（`accidental: show/cautionary/hide`）尚未生效。
- 增量排版与 Web Worker（大总谱的输入延迟），见 [architecture.md](architecture.md#性能现状与方向)。
