# Kitaev → Tonnetz：当前本地演示

更新：2026-09-23。本文件记录最新修订，取代初版方案中与之冲突的内容。

## 内容与呈现

- 演示幻灯片采用全英文界面；正文与标题使用无衬线字体，公式使用本地 KaTeX 渲染。底部显示当前页 / 11；不重复页脚标题或章节数字。独立乐器的原有设置界面保留。
- 独立封面以 **The Kitaev Honeycomb Model** 和蜂窝图开场。下一页用公式展示自旋到 Majorana 算符的映射、守恒规范场、固定规范场下的二次费米子哈密顿量及物理空间约束。
- 蜂窝与对偶晶格保留连续转场，随后进入可弹奏 Tonnetz。
- **Shape of chord**：八种和弦以大图展示；删除字典、音高类数字、增长规则和 Hamiltonian 类比文字。一次点击触发完整和弦。
- 和弦进行使用六个播放按钮，只保留罗马数字、和弦标记与连接箭头；和弦名位于各图外的上方，紧凑图形随播放变化。移除变换符号、说明段落和底部唯一性结论。
- 周期性页分为 Pure fifth、Twelve fifths、12-TET、Repeating grid 四步；解释频率比、五度、纯律与十二平均律，逐个说明公式。移除 Euler 特征公式。六角键显示音名，单键、五度循环和两种调律的五度均可试听。
- 页面名称改为 **Isomorphic keyboard（同构键盘）**；Harmonic 使用 harmonic-table layout。Classic / Harmonic 对比保留真实键位与整和弦按钮。
- Live demo 仅保留作曲家与 “You play the soloist” / “You play the chords”。两套约一分钟的主题片段与同步提示已在本地生成，详见 [音乐片段来源](concerto-excerpts.md)。使用合成音色；没有冒充真人录音。
- Coda 展示 **AIgimon**，提供 [AIgimon 首页](https://www.aigimon.com)与 [Tonnetz 在线乐器](https://www.aigimon.com/tonnetz/)链接，最下方为 **Thank you**。

## 六条进行

| 罗马数字 | 和弦 |
|---|---|
| I–IV–V–I | C–F–G–C |
| I–vi–IV–V–I | C–Am–F–G–C |
| ii–V–I | Dm–G–C |
| ii7–V7–Imaj7 | Dm7–G7–Cmaj7 |
| I–i–♭VI | C–Cm–A♭ |
| I–V–vi–IV | C–G–Am–F |

## 物理依据

参考 A. Kitaev, *Anyons in an exactly solved model and beyond*, **Annals of Physics 321** (2006), 2–111：[论文 DOI](https://doi.org/10.1016/j.aop.2005.10.005)，[arXiv](https://arxiv.org/abs/cond-mat/0506438)。映射与投影依据第 2.1–2.2 节，式 (9)–(14)。

采用每条有向最近邻键只计一次的约定：

\[
H=-\sum_{\langle ij\rangle_\alpha}J_\alpha\sigma_i^\alpha\sigma_j^\alpha,
\qquad \sigma_i^\alpha=i b_i^\alpha c_i.
\]

\[
u_{ij}=i b_i^\alpha b_j^\alpha=\pm1,\qquad [u_{ij},H]=0,
\qquad H(u)=i\sum_{\langle ij\rangle_\alpha}J_\alpha u_{ij}c_i c_j.
\]

固定规范场后对角化二次型；物理状态满足
\(D_i|\psi\rangle=|\psi\rangle\)，其中 \(D_i=b_i^x b_i^y b_i^z c_i\)。这一区分保留在演示中。

## 运行与渲染

本地地址：`http://127.0.0.1:4173/`。运行 `npm start`；空白处鼠标左键前进、右键后退；方向键与 PageUp / PageDown 翻页，空格前进，Home / End 跳转首尾，`F` 全屏，方形按钮停止声音。音乐按钮、公式、链接等内容区域不触发空白翻页。

KaTeX 0.18.7 固定在依赖文件中；运行所需脚本、样式、字体及许可证保存在 `public/vendor/katex/`，浏览时无需 CDN。依赖更新后可运行 `node scripts/vendor-katex.mjs` 重新复制。实现方式依据 [KaTeX 官方浏览器文档](https://katex.org/docs/browser.html)。

保留原 Tonnetz 音频引擎。停止、切页、失焦和离页清理声部及计时器。宽窗口采用演示画布，窄窗口按内容重排并允许滚动，优先保留大图和可读字号。首次演示阶段仅本地调试；2026-09-23 经用户明确要求，已发布至 [AIgimon /Kitaev](https://www.aigimon.com/Kitaev)，Sites 第 59 版。

## 调律与键盘名称来源

- [UNSW Music Acoustics：调律](https://www.phys.unsw.edu.au/jw/tartini-temperament.html)：纯五度为 3:2；十二平均律中为 2^(7/12)。
- [Lumatone 官方 FAQ](https://www.lumatone.io/faq)、[Playmodes](https://www.lumatone.io/playmodes)：isomorphic 指相同音程在不同位置保持同一形状；移调对应整体平移。
