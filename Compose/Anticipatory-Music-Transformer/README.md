# Anticipatory Music Transformer 本地完整下载

来源：官方 `jthickstun/anticipation` 代码及 Stanford CRFM 公开模型。
下载日期：2026-10-04。

- `source/`：完整官方代码仓库，含生成、MIDI 编解码、例子、测试、预处理及许可证。
- `training-backend/levanter/`：官方训练说明指定的 `split_lakh` 分支。
- `models/`：官方目前公开的 10 个模型仓库的完整文件快照；各版本独立保存。
- `metadata/`：Hugging Face 原始仓库元信息，含提交版本、文件尺寸及 LFS SHA-256。
- `DOWNLOAD_MANIFEST.json`：逐文件本地 SHA-256、上游校验值、固定版本与下载完成状态。
- `SOURCE_REVISIONS.json`：两份代码仓库的来源与固定提交。
- `download_official_models.py`：可恢复下载；四个线程动态领取文件，逐文件发布校验结果。

| 官方版本 | 下载大小（十进制） |
| --- | ---: |
| music-small-100k | 512.4 MB |
| music-small-800k | 512.4 MB |
| music-small-ar-100k | 512.4 MB |
| music-small-ar-800k | 512.4 MB |
| music-small-ar-inter-100k | 447.9 MB |
| music-medium-100k | 1438.9 MB |
| music-medium-200k | 1438.9 MB |
| music-medium-800k | 1438.9 MB |
| music-large-100k | 3120.6 MB |
| music-large-800k | 3120.6 MB |

模型文件合计约 13.06 GB，另有代码仓库与元信息。`DOWNLOAD_MANIFEST.json`
中的 `complete: true` 表示所有文件已下载并校验，未完成的文件保留 `.partial`。
Hugging Face 的 Git LFS 指针不作为权重文件；此处保存的是实际二进制权重。

恢复下载（在本地 AIlegro 项目根目录运行）：

```sh
/opt/anaconda3/bin/python Anticipatory-Music-Transformer/download_official_models.py
```

官方加载示例选择 medium-800k。可把 `from_pretrained` 的模型名替换为
`models/music-medium-800k` 的绝对路径，加载本地权重。实际生成还需要安装
`source/requirements.txt` 中的依赖和 `anticipation` 包；本次只下载与校验，
未改动 AIlegro 的运行模型或安装环境。下载内容不等于已经验证可在本机推理。

许可证保留在 `source/LICENSE.txt`、训练后端许可证及各模型原始卡片和元信息中。
训练数据 Lakh MIDI 是另行获取的语料，不属于预训练模型文件，本次未下载。
历史中间训练检查点若官方未公开，不能由发布权重还原。
