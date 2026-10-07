# Cantelvio Compose 管弦乐模型：在 Mac 上运行

设计见 [DESIGN.md](DESIGN.md)。所有命令都在 macOS 的"终端"里运行。原始数据、处理后的语料、检查点、模型和日志都写到本目录下的 `work/`。Cantelvio Compose 项目位于 iCloud Drive 内，因此这些文件由 iCloud 同步；首次上传约 5.6 GB，完成时间取决于网络与可用的 iCloud 空间。不要在两台设备上同时训练或修改同一组检查点，以免产生同步冲突。

**Python 环境**：优先用项目已有的 `.venv-training`（已安装 PyTorch）；也可指定其他装有 PyTorch 的 Python。

- **选择顺序**：显式指定的 `AILEGRO_PYTHON`、项目 `.venv-training`、当前激活的 conda 环境，再查常见 Anaconda 位置。
- **补装的包**：只补装 `symusic`（读 MIDI）和 `gdown`（从 Google Drive 下载）两个小包。
- **记录**：选定的 Python 记在 `work/python-path`，之后的命令都用它。
- **换一个 Python**：`AILEGRO_PYTHON=/path/to/python bash mac.sh setup`。
- **速度提示**：
  - 如果这个 Python 是 Intel 版，也就是在 Rosetta 下运行，用不到 GPU，`setup` 会提示；
  - 如果 PyTorch 低于 2.1，`setup` 会停下来，并给出升级命令。

先进入本目录：

```sh
cd "$HOME/software develop/Cantelvio/Compose/training/orchestra"
```

| 步骤 | 命令 | 做什么 | 时间 |
|---|---|---|---|
| 1 | `bash mac.sh setup` | 选定 Python，补装两个小包，用生成的小测试集把数据处理、模型、训练、生成全部跑一遍 | 约 2–5 分钟 |
| 2 | `bash mac.sh check` | 测芯片、内存、GPU 速度和剩余磁盘，写入 `work/hardware.json` | 约 2 分钟 |
| 3 | `bash mac.sh data` | 下载 SymphonyNet 并预处理，写入 `work/data/` | 下载视网速；预处理约半小时到一小时 |
| 4 | `bash mac.sh ablation` | 后台依次训练 5 个对照模型（12 平均律对称性实验） | 见 `check` 的测速 |
| 5 | `bash mac.sh train web` 或 `bash mac.sh train offline` | 训练网页版或离线大模型 | 数小时到数天 |

随时可用：

- `bash mac.sh status`：看所有训练的进度。
- `bash mac.sh stop <配置>`：在下一个保存点停止。再运行一次 `train`，或 `ablation`，会接着训练。
- `bash mac.sh sample <配置> [小节数]`：用当前最好的模型生成一段 MIDI，写入 `work/samples/`。

Cantelvio Compose 的 `/orchestra/` 本地试听页可使用这五组检查点。一次性生成调用 `sample.py`；连续演奏调用 `stream.py`，每四小节将模型上下文和随机状态保存在 `work/sessions/`，并将分段 MIDI/事件写入 `work/samples/`。网页中的两排和弦是音符统计分析，不是这些模型的直接输出。乐器组的 `on` 是允许参与该小节，不保证实际出现；`off` 会将其排除。

后台训练用 `caffeinate` 让 Mac 保持唤醒，终端可以关掉。

- **合盖**：合上盖子或断开电源后，Mac 可能仍会睡眠。睡眠只是暂停，醒来后继续。
- **重启**：重启会中断训练；再运行同一条命令就会从最近保存的状态接着训练，最多损失几分钟。

**如果 Google Drive 限制自动下载**：`data` 会给出链接。用浏览器下载后，把文件放进 `work/raw/`，再运行 `bash mac.sh data`。

Claude 会直接读取 `work/` 里的 `hardware.json`、`data/prepare.json` 和 `runs/*/log.jsonl` 来分析结果，不需要另外发送。

## 文件

| 文件 | 内容 |
|---|---|
| `groups.py` | 6 个乐器组与 GM 音色的对应、量化网格、各种词表 |
| `prepare.py` | MIDI → 数组（量化、分组、合并齐奏、去重、划分） |
| `data.py` | 训练窗口：BAR/NOTE token、音高坐标与音程、移调增强 |
| `model.py` | 通用 Transformer，含时间与音高旋转编码和逐字段输出头 |
| `train.py` | 训练（MPS/CPU 自动选择、断点续跑、验证集含移调版本） |
| `sample.py` | 按乐器组设置生成 MIDI |
| `hwcheck.py` | 硬件与速度检测 |
| `configs/` | `tiny`（自检）、5 个对照、`web`、`offline` |
| `tests/` | 测试 MIDI 生成、数据往返测试、模型因果性与等变性测试 |

## 外部 MIDI 的保守整理（不替换当前模型）

`prepare.py` 默认仍用原来的筛选规则，五组已有模型和其训练语料不受影响。对另外收集的、**明确获准用于训练**的 MIDI，可在单独的输出目录加 `--recover`：最低音符数由 100 降到 60；若超过原来的离格比例，只在按 MIDI 局部速度换算后的起音舍入误差平均不超过 15 毫秒、95% 分位不超过 35 毫秒时接受。原始 MIDI 不会改写，转换误差与修复类型记录在 `pieces.json`，汇总记在 `prepare.json`。严重离格、实际小于 8 小节、或当前 1/12 四分音符网格／128 格上限无法表达的拍号仍会跳过；不要通过填充、重复或无记录的拍号替换来凑数。源文件的授权、乐器标记及生成质量仍需另行检查。

`data.py` 在训练时已从**完整作品的随机小节**取最多 `max_len` 个 token 的窗口，相当于动态片段训练，通常不必另存大量切片 MIDI。它允许最后一个小节在 token 上限处被截断；若以后要做完整乐句窗口，应在这里改采样，而不是先物理切分 MIDI。尤其不能先切片再沿用 `prepare.py` 的内容哈希来分配训练/验证/测试：同一作品的不同片段或改编可能跨集合，造成泄漏。建立混合语料前，先确认作品身份、授权并按作品划分，再生成窗口；单纯打开 `--recover` 不会解决这件事。该管弦乐语料也不会自动进入主演奏页的 R/H/B/M 旧模型。
