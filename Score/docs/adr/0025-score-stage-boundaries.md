# 0025. Score与Stage的职责更正

- 状态：已接受，取代0023/0024中将PDF阅读器放在Score下的入口决定
- 日期：2026-10-25

用户澄清Stage链接和新版阅谱界面已正确，本轮不改Stage。Score专用于打谱、编辑、回放与导入导出；删除其顶栏误加的独立PDF谱库入口，停止在`score/library/`重复发布Stage阅读器。

旧`score/library/`和`score/update.html`链接仅作兼容，最终进入`score/`编辑器。旧阅读器worker立即退役，后续导航走兼容入口，不主动跳转仍在阅读/批注的其他标签页。仅注销旧Score阅谱scope；保留Stage及其他注册、IndexedDB、设置、曲谱、批注、书签、文件夹句柄和离线PDF缓存。

Stage程序、布局、目录和数据迁移均不在本次更正范围内。原作品和批注不删除，也不因入口归属变化重新编号。
