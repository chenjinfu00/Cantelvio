# Volta 项目入口

此目录是 Volta 读谱与翻页应用，与 `../Harmony/`、`../Compose/` 同级。网页代码在 `docs/`；不是此前包住三个项目的外层容器。

```sh
npm test
npm run preview
```

预览端口与地址以启动输出为准。需要本地曲谱预览时：

```sh
node scripts/preview.mjs 4320 --library
```

现有曲谱库在 iCloud 的 `曲谱&编曲/本地曲谱/`，没有被搬动；项目旁边找不到时会自动回退到这个位置。也可以通过 `VOLTA_LIBRARY` 显式指定目录。没有曲谱库时，应用本身仍可启动；相关测试会按原有规则跳过本地库检查。

2026-09-27 将原 `volta/ui-redesign/` 提升为此项目根目录，保留其 `.git`、所有未提交修改与新文件。原外层 `output/` 和 `tmp/` 完整保存在 `archive/working-files/`，其中是本地曲谱工作材料，不提交到 Git。

Git 的 origin 仍指向原有的 `曲谱&编曲/volta` 仓库，那份独立仓库未被移动或修改。继续开发请以此目录的实际工作文件为准；不要为消除未提交状态而重置它们。

自动伴奏和模型训练的后续开发在 `../Compose/`。Volta 的运行方式和读谱功能见 [README.md](README.md)。
