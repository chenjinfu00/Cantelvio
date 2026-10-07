# 旧四轨模型的 MIDI 配器候选（训练阶段）

这是一条**最小协调**路线：保留现有四轨 Transformer 权重；精确起音、时值、三／五／六／七连音及有标注的记谱力度，由 OpenScore Lieder 表现层训练；从 MIDI 另外训练一个「给已经写好的音符选择六个乐器组」的配器层。两层是候选检查点，尚未合并到网页解码器，也不替换 `frontend/vendor/` 的原权重。

MIDI 的乐器组由轨道 GM program／鼓轨直接映射，音高、起音、小节拍号及量化时值可作条件；还以少量随机遮蔽的音高、起音和时值做辅助重建训练，让单组 MIDI 也贡献可信信息。记谱力度、显式连音记号、和声分析、旋律／和声／低音／节奏角色在 MIDI 中**不视为已知标签**。模型学习单音乐器组与整小节的组开关；前端的用户指定角色、开关、固定／游走在未来接入时仍必须作为硬约束，不能被预测覆盖。已经写好的和弦、低音、旋律先生成，再为其演奏事件预测乐器组，不改变旧四轨的和声／旋律权重。辅助重建不等于 MIDI 已教会主演奏页生成新连音。

## 数据与预检

- 大语料直接读取 `training/orchestra/work/data/` 的现有 memmap 文件（42,163 训练作品、438 验证作品、435 未使用测试作品），**不复制 2 GB 处理数据**。它只用于学习乐器组，绝不拿它的量化时间冒充五／七连音真值。
- 本机 iCloud Drive 中、Cantelvio Compose 目录外的 MIDI 原位读取，保守 `--recover` 解析；不复制原始文件。当前筛选出 145 个可用文件，其中 20 个多组、125 个单组。`我的编曲&打谱/博士二阶段/` 下的 MIDI 全部排除；明显未修改的扒谱导出、同曲旧版本、近重复版本也不参与训练。只加入训练，验证／测试继续用已有管弦乐语料。与验证／测试作品的精确内容副本会排除；未被识别出的改编或近重复仍是限制。单组作品只占本机样本的一小部分，以免挤掉真正的多组配器学习。
- 当前候选在完整小节中最多随机抽取 64 个音符，预测各音符的六组归属及这些音符涉及的组；另对部分遮蔽音符学习其音高、起音和量化时值。验证从每首验证作品固定抽取一小节，按乐器组报告支持数与召回。选模型的验证目标是乐器组分类和小节组预测损失，**不是好听程度**。
- SymphonyNet 和外部 MIDI 的逐文件授权未完成核实；此次仅用于本机研究／个人评估，不把生成结果公开发布。

最近一次只读预检输出：本机 145 个可用 MIDI；另排除用户指定目录 38 个、明显原始扒谱导出 14 个、旧版或近重复 38 个、严重离格 17 个、拍号不可表示 5 个。筛选结果会保存为 `local-midi-selection.json`；源文件和旧模型权重均不改动。

## 运行（由用户在 Mac 终端执行）

推荐一条顺序运行命令：先执行两组测试和只读预检，再按时间训练表现层 4 小时、MIDI 配器层 4 小时；不设训练步数上限。时间到后完成当前小步、验证、保存检查点并正常结束。数据加载、预检及最终保存可能使终端总耗时略多于 8 小时。只要 `state.pt` 存在，再次运行会对相应阶段追加 `--resume`，并按检查点中累计的训练时间计算剩余预算；没有状态却已有非空结果目录时会停下，不会覆盖它。

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
caffeinate -i bash training/run_joint_expanded.sh
```

`caffeinate -i` 防止 Mac 因空闲而睡眠；整晚训练仍建议接通电源并保持机器不因合盖而休眠。

以下为各阶段的独立命令，适合需要分开运行或诊断时使用。

先检查输入，不创建训练检查点：

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/tests/joint-expression.test.py
.venv-training/bin/python training/tests/joint-arrangement.test.py
.venv-training/bin/python training/scripts/train_joint_arrangement.py \
  --local-root "/Users/chenjinfu/Library/Mobile Documents/com~apple~CloudDocs" \
  --output-dir training/runs/joint-arrangement-v1 --preflight
```

第一阶段，训练旧模型的精确时间／表现层（只用 MusicXML）：

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/scripts/train_joint_expression.py \
  --expression training/data/joint/lieder-expression-v1.npz \
  --base-checkpoint training/runs/backups/joint-v1-before-new-data-20260928/model.pt \
  --output-dir training/runs/joint-expression-known-v2 \
  --max-seconds 14400 --batch 4 --threads 2 --eval-every 200
```

第二阶段，利用已有管弦乐语料及本机新 MIDI 训练配器层：

```sh
cd "/Users/chenjinfu/software develop/Cantelvio/Compose"
.venv-training/bin/python training/scripts/train_joint_arrangement.py \
  --orchestra-data training/orchestra/work/data \
  --local-root "/Users/chenjinfu/Library/Mobile Documents/com~apple~CloudDocs" \
  --output-dir training/runs/joint-arrangement-v1 \
  --max-seconds 14400 --batch 24 --threads 2 --eval-every 200
```

两个命令可以分别运行；**不要同时在两个设备上修改同一 iCloud 检查点**。训练器每次评估后原子替换 `state.pt` 和 `best.pt`。中断后，对相应命令原样追加 `--resume`；开始首次评估前中断还没有 `state.pt`，此时不要覆盖非空目录，应选新输出目录。续训会核对输入数据签名及训练参数。本机 MIDI 内容改了，旧状态会拒绝续训，避免无声换数据。时间预算只统计各阶段训练循环，不包括准备和输入扫描时间。

配器运行目录另存 `local-midi-manifest.json`，只记录被接纳文件相对于 iCloud 根目录的路径与 SHA-256；不复制原始 MIDI。该清单同样会由 iCloud 同步，分享运行目录前请注意其中的私人文件名。

完成两阶段之后仍须做浏览器解码、精确时值排程、角色／开关／游走硬约束、PyTorch↔JS 对照、验证和盲听，才能把候选部署到主演奏页。现阶段不能声称网页已经能播放候选连音或学习式配器。参见 [前端清单](../frontend/MODEL-INTEGRATION-ROADMAP.md)。
