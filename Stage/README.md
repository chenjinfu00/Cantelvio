# Volta · 听谱翻页

一个用 iPad 或电脑读谱的工具。导入 PDF，学习一遍参考演奏并标记翻页点，之后通过麦克风跟随你的实际演奏自动翻页。也支持手动翻页、演出模式和触控笔批注。

**打开就能用：<https://chenjinfu00.github.io/volta/>**

没有账号，没有密码，没有服务器。曲谱是你自己电脑上的一个文件夹，Volta 只是读它。你的 PDF、录音和批注都不会离开你的设备。

---

## 三步开始

1. 打开上面的网址（iPad 建议 Safari → 分享 → 添加到主屏幕）。
2. 从左边缘向内划出谱架，点 **选择本地曲谱文件夹**，选中你放曲谱的文件夹。
3. 曲谱库里就是你的全部曲目了。

第一次用、还没有整理好文件夹的话，往下看。

---

## 你的曲谱文件夹长什么样

Volta 读的是一个普通文件夹。它需要两样东西：**按曲子分好的 PDF**，和一个叫 `曲谱库数据` 的子文件夹，里面放两份描述文件。

```
我的曲谱/
├── 肖邦/
│   └── 练习曲/
│       └── 练习曲 Op.10 No.1/
│           ├── 钢琴独奏 · 1fdb0518.pdf
│           ├── 钢琴与小提琴 · 6f8ea4b2.pdf
│           └── 练习曲.mid
├── 原神/
│   └── 璃月/
│       └── 神女劈观/
│           └── 总谱 · 3a7c91d0.pdf
└── 曲谱库数据/
    ├── catalog.json      曲名、作曲、编曲、版本
    ├── manifest.json     每份 PDF 的指纹 → 它的路径
    ├── fit/              每页的内容边界（可选）
    └── 批注/             你的手写批注（应用自己写）
```

几条规则：

- **一首曲子一个文件夹。** 同一首的不同版本 PDF 放在一起，应用里会归成同一个曲目的多个版本。
- **中间分几层随你。** 上面是「书架／分类／作品」，你也可以只用「作曲家／作品」。应用直接照着文件夹显示。
- **MIDI 放在 PDF 旁边。** 同一个文件夹里的 `.mid` 会被当成这首曲子的源文件，可以在应用里用钢琴音色播放。`.sib`、`.mscz` 等源文件放在一起也没关系，不影响。
- **文件名里的 `· xxxxxxxx`** 是这份 PDF 的 SHA-256 前 8 位。不是必须的，但带上它以后你重命名、搬动文件都能靠内容重新对上。

### 曲谱库数据/manifest.json

把每份 PDF 的**完整 SHA-256**对应到它相对于文件夹根目录的路径。这是应用找文件的唯一依据，所以你随便怎么改文件名都不会丢。

```json
{
  "version": 1,
  "files": {
    "1fdb0518d88d708438bc9bcc8040f6c3602aa9c16ddb7486c796d028fecce6e2":
      "肖邦/练习曲/练习曲 Op.10 No.1/钢琴独奏 · 1fdb0518.pdf"
  }
}
```

### 曲谱库数据/catalog.json

描述每份 PDF 是什么。`id` 就是上面的 SHA-256。

```json
{
  "version": 1,
  "items": [
    {
      "id": "1fdb0518d88d708438bc9bcc8040f6c3602aa9c16ddb7486c796d028fecce6e2",
      "title": "练习曲 Op.10 No.1",
      "edition": "钢琴独奏",
      "composer": "弗雷德里克·肖邦",
      "arranger": "",
      "style": "练习曲",
      "format": "pdf",
      "available": true,
      "bytes": 482913,
      "aliases": ["肖邦/练习曲/练习曲 Op.10 No.1/钢琴独奏 · 1fdb0518.pdf"],
      "sources": ["练习曲.mid"]
    }
  ]
}
```

必填的只有 `id`、`title`、`format: "pdf"`、`available: true`。其余是用来分类和显示的：

| 字段 | 作用 |
|---|---|
| `composer` / `arranger` | 决定曲目归到哪个书架，两首同名曲也靠它区分 |
| `edition` | 同一首曲子的版本名，例如「钢琴独奏」「简易版」 |
| `style` | 书架里的第二层分类 |
| `region` | 给游戏音乐用的地区分类（蒙德、璃月…），没有就省略 |
| `bytes` | 显示文件大小，并用于校验本地文件是否完整 |
| `aliases` | 这份 PDF 的来源与曾用名，只在「查看来源」里显示 |
| `sources` | 同文件夹里可播放的源文件名，例如 MIDI |

两份 JSON 都是纯文本，手写也行。曲子多了以后，用下面的脚本扫描生成更省事。

---

## 用脚本生成

需要 Node 22 以上。

```bash
git clone https://github.com/chenjinfu00/volta.git
cd volta && npm install
```

把曲谱文件夹放在 volta 旁边并命名为 `本地曲谱`，或者用环境变量指到别处：

```bash
export VOLTA_LIBRARY=~/我的曲谱
```

常用脚本（都默认只预览，加 `--apply` 才真正动文件）：

| 脚本 | 做什么 |
|---|---|
| `node scripts/reorganize-library.mjs` | 按 catalog 里的资料重排文件夹，同步 manifest |
| `node scripts/index-sources.mjs` | 扫描 MIDI 等源文件，写进每首曲子的 `sources` |
| `node scripts/retitle-scores.mjs` | 批量清理曲名（去掉 `(1)`、`·副本 2`、下载站前缀等） |
| `node scripts/tag-regions.mjs` | 给游戏音乐打 `region` 标签 |
| `node scripts/retire-scores.mjs` | 把不要的曲谱移进 `retired/`，可回退 |
| `node scripts/preview.mjs 4320 --library` | 本机起一个服务预览整个应用 |

自己的曲谱第一次入库，`scripts/build-local-library.mjs` 会逐份算 SHA-256、按内容去重、生成两份 JSON。

---

## 批注怎么保存

批注在书写时先保存到本机数据库。批注工具栏只有一个“同步”按钮；选择了支持写入的本地曲谱文件夹后，第一次点击它会申请写入权限，之后自动写进 `曲谱库数据/批注/<id>.json`，一首一份。

Safari/iPad 的网页文件夹选择通常只能读取《文件》App 中的文件，不能申请写入权限；批注工具栏的“导出”会生成一个 `volta-annotations.json`，在系统分享面板中选择“存储到文件”，再放进 `曲谱库数据/批注/` 即可。原生 Volta 应用可以使用系统文件权限长期写回曲谱库。

---

## 离线

`选择文件夹` 之后就不需要网络了。应用本体由 Service Worker 缓存，目录、PDF、MIDI、页面边界全部从文件夹读；曲谱不会上传到服务器。

设置里的 **一键部署到本机** 只保存应用本体和离线运行所需的程序资源，不会复制曲谱。之后仍需指定本地曲谱文件夹；iPad Safari 重开后若要求重新授权，选择同一个文件夹即可。

---

## 开发

```bash
npm test                      # 130 项，不需要网络
node scripts/cache-manifest.mjs   # 改过 docs/ 之后重建离线清单
```

网站源文件在 `docs/`，GitHub Pages 设置为「从 `main` 分支的 `/docs` 目录部署」。改过 `docs/` 里的文件后记得在 `docs/sw.js` 顶部改一下 `SHELL` 的版本号，否则老用户不会拿到新版本。

## 关于曲谱本身

这个仓库不含任何曲谱。示例里的曲名只是说明目录结构。你用自己的 PDF，版权与来源声明也仍然是你自己的事。

## 第三方

钢琴音色来自 [Salamander Grand Piano](https://archive.org/details/SalamanderGrandPianoV3)（Alexander Holm，CC BY 3.0），采样了 Yamaha C5。PDF 渲染用 [pdf.js](https://mozilla.github.io/pdf.js/)。
