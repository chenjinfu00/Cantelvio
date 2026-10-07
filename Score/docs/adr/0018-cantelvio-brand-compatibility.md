# 0018. Cantelvio 品牌与已有曲谱兼容

- 状态：已接受
- 日期：2026-10-08

## 背景

用户要求所有软件模块统一使用 Cantelvio 名称。更换界面名称不能使以前保存的曲谱、自动保存和最近文件失效，也不能破坏 Score 与 Compose 的数据交换。

## 决定

- 现行界面、文档、页面标题、PDF 元数据和推荐命令统一为 Cantelvio。
- Workspace 包使用 `@cantelvio-score/*`，桥接包使用 `@cantelvio-score/compose-bridge`；锁文件和所有包引用一起更新。
- 新保存和另存为使用 `.cantelvio.json`，直接打开旧 `.ailegro.json` 保持可用。已有文件的“保存”仍写回用户所选择的同一个文件。
- 原音乐数据的 `format: "ailegro-score"`、版本 2 及 `ailegro.*` 交换协议保持兼容，不通过品牌更新重写数据契约。
- 既有 IndexedDB、localStorage、文件选择器标识和内部兼容路径保持原值，避免丢失自动保存、设置和文件访问句柄。
- 自动恢复的内置示例仅在旧作者、固定创建时间、内置曲名全部匹配时更新品牌作者；显式演示草稿仅在演示 id、原生成标题和副标题匹配时更新标题。自定义作者与标题不改。
- 新推荐的 `cantelvio:serve`、`cantelvio:examples` 命令与 `--cantelvio`、`CANTELVIO_ROOT` 参数可用，原命令、参数及环境变量保留为别名。
- 历史 ADR 和验证记录保留当时使用的名称。

## 后果

使用者看到统一的新品牌，同时可以继续打开、编辑和保存旧曲谱。内部协议改名如有需要，应作为独立的版本迁移工作处理。
