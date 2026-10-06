> Superseded on 24 September 2026 by [guided-seven-slide-v73.md](guided-seven-slide-v73.md). The latest request removes individual voice checks and restores the closing thanks, new domain, and touchscreen hint.

# Musical Karaoke：逐步揭示的 7 页演示

最新用户要求，2026-09-23。此文件取代旧的页序、一次展示所有选项和点击空白直接翻页规则。

## 共同规则

- 恰好 7 页：无字封面 / Choir / Process / Tonnetz / Shape of chords / Isomorphic keyboard / Authentic cadence。
- 英文、黑体、大字。每页只保留标题、当前必要动作与音乐标签。不要辅助口号、页脚解释和技术状态长句。页面计数保留。
- 按确定的状态机逐步揭示；空白点击、主行动按钮、下一步、方向键前进都走同一入口。每次只执行当前一步，不可因冒泡或快速连点跳步。音频结束前不接受下一步；Stop 取消但不算完成，再次点击从当前步骤重播。每页完成后再明确允许翻页。
- 回退可以复查已完成内容。音乐键可弹、已经揭示的示例可重播，不能误翻页。切页、失焦、Stop 清除声音与排程，不能使后台回调偷偷解锁下一步。
- 现有 1440×810 固定画布缩放和 <=680px 纵向流保持，避免重叠。所有改动仅在 karaoke 独立版本；原 /Kitaev 和乐器应用不改。
- 不录音、不用麦克风、不做自动音准评分。参与者音准由演讲者耳听确认。

## 1. Cover

保留现有纯插画。点击进入 Choir。

## 2. Choir

最初只显示标题 Choir、最短招募提示（如 “One volunteer.”）和 Voice 1 的播放控件/四个无音名键。不能泄露 C/G/Am/F 或任何单音名，包括辅助状态、aria-label 和 tooltip。

1. 请第一人站起来，播放并跟随 Voice 1；可使用已有三轮练习音频。完成后才揭示 Voice 2。
2. 同样练习 Voice 2，完成后才揭示 Voice 3。
3. 完成 Voice 3 后进入逐人核对。依次使用已有 solo-check 起音→静音独唱→参考音流程；每人结束后给简洁的 “Again” 与 “✓” 演讲者确认按钮，不能把播放器结束当作唱准。
4. 三人均经确认后才出现 “Together”。一起唱完后再揭示所有音名、四个和弦名及 C→G→Am→F 的完整和声图。隐藏期 cue 文本必须去除曲调/和弦名。
5. 揭示后可重播整个进行，然后前往下一页。无多余底部段落。

既有声部：C3 B2 C3 C3 / E3 D3 E3 F3 / G3 G3 A3 A3。列集合必须是完整的 C、G、Am、F 三和弦。

## 3. Process

保留六种既有进行，初始仅展示第一种 C→G→Am→F；用户播放完整一次才解锁第二种，以此类推。不要一开始展示六个选择。一次完整播放最多解锁一个；重播旧示例不能反复解锁未来示例。和弦名在图形外顶部，罗马数字简洁，当前图同步高亮。六个都演示完成后才允许正常前进。

## 4. Tonnetz（取代旧调律页，移至 Shape 前）

连续、可播放、一步一步：

1. 12 个半音按音高顺序围成圆（C C♯ D E♭ E F F♯ G A♭ A B♭ B）。播放相邻半音。
2. 保留这 12 个身份，以每次 +7 半音连接/排序成为五度循环 C G D A E B F♯ C♯ A♭ E♭ B♭ F；按声音同步指示行进。
3. 把同一批 12 音映到 Tonnetz 的一个周期单元，展示五度与大三度两个方向，音名不能随机重排/重复遗漏。12-TET 下 pc(i,j)=(7i+4j) mod 12；可用 i=0..3,j=0..2 的 12 音代表元。解释性 UI 仅需 “12 notes / Fifths / One cell / Repeat” 这种短动作词。
4. 平移复制这个单元，展开为更大的 Tonnetz；可用周期向量 (0,3)、(4,-1)，二者保持音高类且行列式绝对值为 12。不要把一个只有 3 个音的三角形叫 12 音周期晶胞；三角形只是三和弦局部形状。
5. 简短可听的 Pure fifth 3:2 与 12-TET 2^(7/12) 比较，用 KaTeX，保持正文极少。不能声称纯五度绕 12 次严格闭合；周期单元说明用于 12-TET。避免变成新长篇调律页。

## 5. Shape of chords

标题严格为 Shape of chords。现有八种和弦一次引入一种；初始只有 C 的大图和播放入口，演示完一个再引入下一个。已揭示的和弦可回听；音名在准确的格子上，一次按完整和弦。不能先显示完整八项列表。

## 6. Isomorphic keyboard

先 Harmonic，再 Classic；初始不显示 Classic。Harmonic 沿用前面 Tonnetz 的相邻三角形布局。选择一个具体 C–E–G 紧邻三角形，不再按 MIDI 独立找最近格子而把三音散开。高亮的每个具体键和发声音符一致。

提供 C / G / Am / F，及合理额外 Dm / G7 等和弦，使演讲者可奏前面的进行。Harmonic 选局部三角形/对应四音图形；若同一近邻音高跨八度，尊重几何映射，不能只改音名。

Classic 仍基于原应用 classic 同构映射，按钢琴的自然音白键、变化音黑键处理；同一和弦采用一致的升序、紧凑音区选择，不能独立随意选远处分身。可加简洁实际钢琴式音域/排列帮助理解，但不要冒充另一个经典布局。讲完 Harmonic 的示例后才显示 Classic，按序可奏 C–G–Am–F。删除 “A major triad can fit under one finger”、底部 Lumatone link 和其他解释段落。

## 7. Authentic cadence

删除 CODA、Thank you 和 AIgimon 宣传。标题 Authentic cadence，保留可听可点的 F→G7→C（IV→V7→I）。最后只有 “Now play your own song:” 与 https://www.aigimon.com/tonnetz/ 的链接。最终的 G7→C 是正格终止；不要额外声称 perfect authentic cadence，除非配置与声部满足其条件。

## 工作分配和验收

- GPT-5.6 sol 实现逐步演示、页面、交互状态、几何映射、必要回归测试，只编辑 karaoke 文件及专属新模块/测试，不碰共享旧版和 Site checkout。
- 主代理独立核验音乐/几何、寻找并接入合适的音源、逐页浏览器验证与发布。源站授权延续。
- 用数据测试检查 12 音一一映射、周期平移、和弦音集合、紧邻三角形；用行为测试检查未结束不解锁、Stop/错误不完成、重播不跨级、最后一步才可翻页。
- 所有阶段在实际窗口检查，不只看首屏；尤其核对揭示后的 Choir 大图、六个 Process 示例、八种和弦、Tonnetz 展开、两种键盘的排版。
- 音源由主代理另增独立 sampler 模块，实现代理可保留现有音频 API；接入前协商避免同时编辑 karaoke-audio.js。人声不能用钢琴替代，维持唱音示范。
