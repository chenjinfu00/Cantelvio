#!/bin/bash
# Cantelvio Compose 四大件 v3.1：学习率衰减 + 权重滑动平均（EMA）的 9 小时收尾训练。在 Mac 的“终端”里、于 Cantelvio Compose 文件夹运行：
#
#   bash training/train_four_pillar_v31_anneal.sh            开始（从第 101,129 步的权重起，新运行；Mac 不睡眠，请接电源）
#   bash training/train_four_pillar_v31_anneal.sh status     进度：步数、学习率、近 500 步平均损失
#   bash training/train_four_pillar_v31_anneal.sh stop       在当前一步结束时保存并停止（再运行第一条命令会接着训练）
#
# 为什么：之前的 17.5 小时在固定学习率 1e-4 上结束，保存的是最后一步的原始权重（每批损失在 4.5–5.8 之间摆动）。
# 这里学习率从 1.5e-4 余弦衰减到 4.5e-6（9 小时刚好走完），同时保存权重的滑动平均。
# 输出在 training/runs/four-pillar-v31-anneal-20261004/：weights.pt 是 EMA 权重（所有 v3.1 工具直接可用），
# weights-raw.pt 是最后一步的原始权重。原来的 four-pillar-v31-ready-20261001 不会被改动，
# 想回到旧模型就继续用它的 weights.pt。
set -euo pipefail
cd -- "$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/.."
PY="$PWD/.venv-training/bin/python"
RUN="training/runs/four-pillar-v31-anneal-20261004"
PARENT="training/runs/four-pillar-v31-ready-20261001/weights.pt"
LOGDIR="training/logs/four-pillar-v31-anneal-20261004"
mkdir -p "${LOGDIR}"

alive() { local pid; pid="$(cat "${LOGDIR}/runner.pid" 2>/dev/null || true)"; case "${pid}" in ''|*[!0-9]*) return 1;; esac; kill -0 "${pid}" 2>/dev/null; }

case "${1:-start}" in
  status)
    if alive; then echo "运行中（pid $(cat "${LOGDIR}/runner.pid")）"; else echo "没有在运行"; fi
    "${PY}" -B - "${RUN}/metrics.jsonl" <<'PYEOF'
import json, sys, statistics
try:
    rows = [json.loads(l) for l in open(sys.argv[1])]
except FileNotFoundError:
    sys.exit('还没有记录')
r = rows[-1]; last = rows[-500:]
print(f"第 {r['step']:,} 步 · 已训练 {r['elapsedSeconds']/3600:.2f}/9 小时 · 学习率 {r['lr']:.2e}")
print(f"近 {len(last)} 步平均损失 {statistics.mean(x['loss'] for x in last):.3f}"
      f"（和弦根音 {statistics.mean(x['objectives'].get('chord_root', 0) for x in last):.3f}，"
      f"音高 {statistics.mean(x['objectives'].get('pitch', 0) for x in last):.3f}）")
PYEOF
    ;;
  stop)
    pid="$(cat "${LOGDIR}/trainer.pid" 2>/dev/null || true)"
    if [ -n "${pid}" ] && kill -0 "${pid}" 2>/dev/null; then kill -INT "${pid}"; echo "已请求停止，当前一步结束后保存。"; else echo "没有在运行"; fi
    ;;
  _run)
    # 出错自动续训（60 秒后）；正常结束（时间到或被 stop）退出。
    while true; do
      if [ -f "${RUN}/state.pt" ]; then ARGS="--resume"; else ARGS="--init-checkpoint ${PARENT}"; fi
      "${PY}" -B training/scripts/train_four_pillar_v31_anneal.py --output-dir "${RUN}" ${ARGS} --hours 9 \
        --threads 4 --checkpoint-seconds 600 >> "${LOGDIR}/train.log" 2>&1 &
      echo $! > "${LOGDIR}/trainer.pid"
      if wait $!; then break; fi
      if [ -f "${LOGDIR}/stop-requested" ]; then break; fi
      echo "训练出错，60 秒后从保存点续训" >> "${LOGDIR}/train.log"; sleep 60
    done
    ;;
  start)
    if alive; then echo "已经在运行（bash training/train_four_pillar_v31_anneal.sh status）"; exit 0; fi
    [ -f "${PARENT}" ] || { echo "找不到 ${PARENT}" >&2; exit 1; }
    nohup caffeinate -ims bash "$0" _run > /dev/null 2>&1 &
    echo $! > "${LOGDIR}/runner.pid"
    echo "已在后台开始训练，日志：${LOGDIR}/train.log；进度：bash $0 status"
    ;;
  *) echo "用法：$0 [start|status|stop]" >&2; exit 2 ;;
esac
