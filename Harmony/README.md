# Tonnetz

键盘、和声网格与互动音乐工具。此项目与 `../Compose/`、`../Stage/` 同级。

## 启动

```sh
npm start
```

打开 <http://127.0.0.1:4174/tonnetz/>。无需安装 npm 依赖。`npm test` 运行回归测试。

## 项目分工

- `public/tonnetz/`：当前完整的 Tonnetz 网页，包括原有自动伴奏功能；此次整理保持运行代码不变。
- `tests/`：当前 Tonnetz 的功能回归检查。
- `demos/MusicalKaraoke/`：原有浏览器演示与说明材料；从该目录启动，使用 4173 端口。其 README 和发布记录描述历史版本。
- 自动伴奏、和声/旋律模型与训练的后续开发统一在 **AIlegro**。训练脚本、原始数据、检查点与评估见 [AIlegro 训练说明](../Compose/training/README.md)。不自动把未来 AIlegro 的修改回写到这里。
- 原有伴奏研发文档已归档到 [AIlegro 历史记录](../Compose/research/tonnetz-history/)，完整旧版快照在 `../Compose/archive/tonnetz-v91/`。

此次只做本地目录整理，没有发布或改变线上版本。
