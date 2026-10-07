# PDF / 图片 → 乐谱（光学识谱）

把印刷乐谱的 PDF 或扫描图片变成 `.cantelvio.json`：先用 **Audiveris**（开源的光学识谱软件）识别成
MusicXML，再用本仓库的 MusicXML 导入（[musicxml-import.md](musicxml-import.md)）。决定与取舍见
[ADR 0012](adr/0012-pdf-import-audiveris.md)。

## 安装 Audiveris（一次）

- 从 <https://github.com/Audiveris/audiveris/releases> 下载最新版（2026-07 为 5.11.0）：
  Apple 芯片的 Mac 用 `Audiveris-<版本>-macosx-arm64.dmg`，Intel Mac 用 `…-macosx-x86_64.dmg`，
  拖进“应用程序”。安装包自带 Java，不需要另装。第一次打开如果被系统拦住，在 Finder 里右键 → 打开。
- **装 OCR 语言**：打开 Audiveris，菜单 Tools › Install languages…，至少装英语（德语、意大利语按需要）。
  没有 OCR 时音符照样识别，但读不出标题、声部名称和歌词——声部名称决定乐器，进而决定移调乐器的换算。
- Audiveris 采用 AGPL-3.0 许可证。我们只把它当作单独的程序调用，不打包、不修改它；识别出来的乐谱
  属于你（原谱本身的版权照旧）。

## 用法

**在编辑器里**：先运行本机服务 `npm run cantelvio:serve`（[try-it.md](try-it.md)），再“打开”或拖入 PDF / 图片，
或在 Cantelvio 面板“从 PDF 或录音开始”→“打开 PDF / 图片…”。服务在后台调用 Audiveris，左下角显示第几页和用时，
完成后作为新乐谱打开；面板的“识谱 / 扒谱选项”可以只读某几页、按实际音高读（[ADR 0013](adr/0013-local-service-imports.md)）。

**命令行**：

```sh
npm run import:pdf -- score.pdf                                  # → score.cantelvio.json，放在 PDF 旁边
npm run import:pdf -- score.pdf --instruments clarinet-bb,piano  # 指定各声部的乐器（目录 id，按顺序）
npm run import:pdf -- page.png --sheets "1 3-4" --keep out/omr   # 只识别某几页；保留 Audiveris 的结果
```

- 找 Audiveris 的顺序：`--audiveris <路径>`、环境变量 `AUDIVERIS`、`PATH`、默认安装位置
  （`/Applications/Audiveris.app`、`/opt/audiveris`、`C:\Program Files\Audiveris`）。
- 输入可以是 PDF 或图片（PNG、JPEG、TIFF）。Audiveris 把乐谱分成几个乐章导出时，每个乐章写一个文件
  （`.mvt1`、`.mvt2`…）。
- 打印的移调乐器声部（单簧管、圆号、小号……）按**记谱音高**读，再换算成实际音高；乐器由声部名称猜，
  猜不出时用 `--instruments` 指定（例如 `--instruments clarinet-bb,piano`，空位表示照常猜）。
  整份乐谱按实际音高印刷时加 `--concert`。
- 识谱结果的小节常有小错（漏了休止符或附点）：某个声部比拍号长、而别的声部正好填满时，按拍号截断；
  所有声部都短于拍号的中间小节补足到拍号长度（弱起小节、最后一小节、两个半小节拼成一小节的除外）。
  这些都会在提示里计数。
- `--keep <目录>` 留下 Audiveris 的 `.mxl` 和 `.omr`。识别错误较多时，可以用 Audiveris 打开 `.omr`
  逐页校对，再导出 `.mxl`，在编辑器里直接打开。
- 浏览器里运行不了 Audiveris：编辑器打开 PDF 要靠本机服务（上面）；没有服务时转换后打开 `.cantelvio.json`，
  或打开 Audiveris 导出的 `.mxl`。命令行的 `--instruments` 在编辑器里还没有对应选项。

## 实测（2026-10-03，Audiveris 5.11.0，Linux，300 dpi，没有 OCR 语言）

输入是本编辑器自己排出来的三份乐谱（从 music21 语料库的 MusicXML 导入后渲染成 300 dpi 的 PDF），
识别结果与原 MusicXML 逐音比较（同一谱表、同一小节、同一位置、同一音高）：

| 乐谱 | 页数 | 用时 | 音符一致（F1） | 时值也一致 |
|---|---:|---:|---:|---:|
| 巴赫众赞歌 BWV 66.6（四声部） | 1 | 16 秒 | 100% | 100% |
| 舒伯特《菩提树》（人声 + 钢琴，三连音、转调） | 4 | 42 秒 | 90.4% | 87.6% |
| 韦伯单簧管小协奏曲前 53 小节（降 B 调单簧管 + 钢琴） | 2 | 27 秒 | 80.3% | 79.7% |
| 同上，`--instruments clarinet-bb,piano` | 2 | 27 秒 | 95.3% | 94.0% |

- 干净的印刷谱效果很好；复杂的钢琴织体（三连音、多声部）错误多一些，主要是漏音、时值和小节长度。
- 韦伯一例没有 OCR，单簧管声部被当作实际音高（差一个大二度），调号也取错；指定乐器后正确。
  在 Mac 上装好 OCR 语言后，声部名称“Clarinet in B♭”能直接认出来。
- 真实扫描件（纸张歪斜、印刷模糊、手写）会明显差一些，建议 300 dpi 以上、黑白或灰度扫描。
