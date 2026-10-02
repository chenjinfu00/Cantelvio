# 乐谱数据模型（最重要的契约）

代码：`packages/core/src/model/types.ts`（类型）、`io/json.ts`（文件格式）、
`model/validate.ts`（结构校验）。决策记录：[ADR 0002](adr/0002-score-model.md)、
[ADR 0006](adr/0006-file-format.md)。

## 七条设计规则

1. **语义而非图形**：存音乐本身（音高、时值、结构）。版面由排版引擎推导；版面提示是显式的
   可选字段（例如 `breakAfter`）。
2. **稳定 id**：每个可寻址元素都有永不改变的字符串 id。选择、AI 补丁、版本对比、协作都引用 id。
3. **精确时间**：位置和时值都是有理数，单位是**全音符**（四分音符 = `1/4`）。
4. **一个发声的音 = 一个事件**：事件时值可以跨过小节线；小节线处的连线由排版推导。
   用户刻意写的连线用 `Note.tieForward` 表示（例如和弦里只连一部分音）。
5. **实际音高（concert pitch）**：音符存发声音高并带拼写；移调乐器的记谱音高由推导得到。
   AIlegro 直接使用发声 MIDI 音高。
6. **隐式休止符**：声部里的空隙就是休止符，排版按拍号把它们写成合适的休止符。
7. **纯 JSON**：没有类、没有 Map；序列化是确定的，在 git 里能干净地比较。

## 结构总览

```text
ScoreDoc
├─ format: "ailegro-score", version: 1, id
├─ meta        标题、副标题、作曲、编曲、作词、版权、createdAt / modifiedAt
├─ settings    谱表间距 staffSpaceMm、纸张与页边距、默认是否显示实际音高、默认速度
├─ parts[]     乐器（总谱顺序，从上到下）
│   └─ staves[]   谱表：id、起始谱号、线数
├─ groups[]    括号：bracket / brace / square，按谱表 id 指定首尾，barlineThrough
├─ measures[]  全局小节列表（所有谱表共享）
│   └─ timeSig? keySig? actualLength? barline? repeatStart/End? rehearsalMark? tempo[]? breakAfter?
├─ content     staffId → measureId → StaffMeasure（缺省 = 空小节）
│   └─ voices[0..3]（事件列表）、tuplets?、clefChanges?、dynamics?
└─ harmony[]   和弦记号（也是 AIlegro 的和声条件）
```

## 时间

- `Rational = { n, d }`，已约分，`d > 0`。四分音符 `1/4`，附点八分 `3/16`，三连音八分 `1/12`。
- 事件的 `offset` 是**在所属小节内**的位置；绝对时间 = 小节起点 + offset（`measureInfos(doc)`
  给出每小节的起点、长度、生效的拍号和调号）。
- 事件可以比小节剩余部分更长：一个从 4/4 第 4 拍开始的二分音符是**一个**事件，
  排版时画成两个连起来的四分音符。
- 小节长度 = 拍号长度，除非有 `actualLength`（弱起小节、华彩段）。
- 浮点数只用于图形坐标和音频秒数，永远不要用浮点数存时值。

## 音高

- `Pitch = { step: 'C'…'B', alter: -2…2, octave }`，科学音高记法（中央 C = C4）。
  文件里写成 `"C#4"`、`"Bb3"`、`"F##5"`。
- 存**发声音高**。移调乐器（单簧管、圆号、小号、短笛、低音提琴……）的 `transposition`
  是“记谱 → 发声”的音程 `{ diatonic, chromatic }`：降 B 调单簧管是 `{-1, -2}`（发声比记谱低大二度）。
  不写则用乐器目录里的默认值。
- 调号 `keySig = { fifths, mode? }` 是**实际音高的调号**；移调乐器的记谱调号由推导得到。
- 拼写很重要：AIlegro 返回的 MIDI 音高在导入时按调号和和弦拼写（`bridge/spelling.ts`）。

## 乐器、谱表、括号

- `Part.instrument` 是乐器目录的 id（`instruments/catalog.ts`，约 50 种乐器，含中英文名、
  音域、GM 音色、AIlegro 乐器组、总谱顺序）。
- 多谱表乐器（钢琴、竖琴、管风琴）有多个 `staves`，用 brace 连起来。
- `groups` 用首尾谱表 id 表示范围，必须按总谱顺序；删除乐器时会自动收缩或删除括号。

## 小节

- `measures` 是**全局**的，所有谱表共享同一组小节线（总谱的标准做法）。
- 拍号、调号只写在**变化处**（第一小节必须有）；`measureInfos` 负责向后传播。
- `barline` 指本小节**结尾**的小节线（`single`、`double`、`final`、`dashed`、`none`）。
- `tempo[]`：速度标记（offset、bpm、beatUnit 默认四分音符、文字如 “Allegro”）。

## 内容（content）

```jsonc
"content": {
  "st_1": {                     // 谱表 id
    "m_1": {                    // 小节 id
      "voices": [               // 最多 4 个声部（1、3 符干向上；2、4 向下）
        [
          {"id":"e_1","kind":"note","offset":"0","duration":"1/4","notes":[{"id":"n_1","pitch":"D5"}]},
          {"id":"e_2","kind":"note","offset":"1/4","duration":"1/8","notes":[{"id":"n_2","pitch":"G4"}]}
        ]
      ],
      "tuplets": [{"id":"tu_1","voice":0,"offset":"1/2","length":"1/4","actual":3,"normal":2}],
      "dynamics": [{"id":"dy_1","offset":"0","value":"mf"}],
      "clefChanges": [{"id":"cl_1","offset":"1/2","clef":"bass"}]
    }
  }
}
```

- **NoteEvent**：`id`、`offset`、`duration`（发声长度）、`notes`（同一符干的音，按音高升序）、
  `articulations?`（staccato、staccatissimo、accent、tenuto、marcato、fermata）、`stem?`、`source?`。
- **Note**：`id`、`pitch`、`tieForward?`、`accidental?`（auto / show / cautionary / hide，尚未全部生效）、
  `velocity?`。
- 一个声部内事件按 offset 排序、**互不重叠**；空隙即休止符。
- **连音（tuplet）**：`TupletSpan` 记在声部上，`length` 是整个连音组的**实际**长度，
  `actual:normal` 是比例（三连音 3:2）。里面事件的时值是实际值（三连音八分 = `1/12`）。
  连音组不能跨小节线。
- 谱号变化、力度记号挂在谱表的小节上（`clefChanges`、`dynamics`）。

## 和弦记号（harmony）

```json
{"id":"ch_1","measureId":"m_3","offset":"0","root":{"step":"B","alter":-1},"quality":"dom7","bass":{"step":"D","alter":0}}
```

`quality` 使用 **AIlegro 的和弦性质 id**（`maj`、`min`、`dom7`、`half`、`sus4`……共 40 种，顺序与
AIlegro 的 `chord-qualities.json` 一致，见 `bridge/qualities.ts`），所以和弦记号可以直接作为
AIlegro 的和声条件。

## 来源（provenance）

`source` 可出现在事件、力度、和弦记号上：

- 缺省：用户输入。
- `{ "kind": "import", "format": "musicxml", "file": "…" }`：导入。
- `{ "kind": "ai", "model": "four-pillar-v3.1", "runId": "ai_…", "accepted": false }`：AI 建议。
  `accepted: false` 的内容画成蓝色，**默认不会作为材料再导出给 AIlegro**；
  `provenance.accept` / `provenance.reject` 命令按 runId 接受或删除。

## id

- 格式 `<前缀>_<12 位 base36>`：`sc` 乐谱、`pt` 乐器、`st` 谱表、`gr` 括号、`m` 小节、`e` 事件、
  `n` 音符、`tu` 连音、`cl` 谱号变化、`dy` 力度、`tm` 速度、`ch` 和弦、`ai` AIlegro 请求/运行。
- **由调用方生成并放进命令里**（编辑器用随机 id，测试用 `sequentialIds()` 得到 `e_1`、`n_1`）。
  这是命令可重放、可协作的前提。

## 结构校验

`validateScore(doc)` 返回问题列表（空 = 合法）：格式标记、至少一个小节和一个乐器、第一小节有
拍号和调号、id 不重复、括号引用合法且有序、声部数 ≤ 4、事件非空且时值为正、offset 在小节内、
事件有序且不重叠、不超出乐谱末尾、连音不跨小节线、和弦记号位置合法。
**命令保证这些不变量**；导入的文件、AI 生成的文档要先校验。

## 文件格式 `.ailegro.json`

- 规范化的 JSON：键顺序固定，内容按总谱顺序（谱表）和小节顺序排列；同一文档保存两次字节相同。
- 有理数写成字符串（`"1/4"`），音高写成名字（`"C#4"`）。
- **每个事件一行**（还有连音、力度、谱号变化、和弦、速度、谱表、括号各一行），
  所以 `git diff` 能逐个音符显示修改。`.gitattributes` 把 `*.ailegro.json` 设为 LF 文本。
- `version: 1`。**任何字段的增删改都要**：升版本号、在 `io/json.ts` 写从旧版本的迁移、
  加测试、更新本文档。读取更新版本的文件时报错，而不是猜。

## 例子

降 B 调单簧管记谱 D5、发声 C5 的一个四分音符：

```json
{"id":"e_9","kind":"note","offset":"0","duration":"1/4","notes":[{"id":"n_9","pitch":"C5"}]}
```

（`Part.instrument = "clarinet-bb"`，记谱音高由乐器的移调推导；“实际音高”视图直接显示 C5。）

4/4 第 4 拍开始、跨小节线的二分音符：一个事件 `offset "3/4"`、`duration "1/2"`，
排版画成“四分音符 ⁀ 四分音符”。

## 尚未建模（路线图）

连线（slur）、渐强渐弱（hairpin）、歌词、装饰音（grace note）、装饰记号、反复房子（volta）、
D.C./D.S.、八度记号、踏板、打击乐映射、声部（parts）提取的版面、小节内的显式休止符隐藏/移动。
加任何一个都要遵守上面的版本规则。
