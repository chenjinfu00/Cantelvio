#!/bin/bash
# Cantelvio Compose 四大件 v3.1：在已经训练的 17.5 小时（第 101,129 步）之后再训练 9 小时（累计 26.5 小时）。
# 在 Mac 的“终端”里、于 Cantelvio Compose 文件夹运行：
#
#   bash training/train_four_pillar_v31_more_9h.sh          开始：先把现在的权重另存一份，再接着训练 9 小时
#   bash training/train_four_pillar_v31_more_9h.sh status   查看进度：步数、损失、剩余时间
#   bash training/train_four_pillar_v31_more_9h.sh log      接着看日志（Ctrl-C 只是不再显示，训练不受影响）
#   bash training/train_four_pillar_v31_more_9h.sh stop     在当前一步结束时保存并停止（再运行第一条命令会接着训练）
#   bash training/train_four_pillar_v31_more_9h.sh sample   用当前的权重生成 3 段试听 MIDI
#
# 这是 train_four_pillar_v31.sh 的包装。训练时长按已保存的训练时间累计，所以这里设 AILEGRO_V31_HOURS=26.5
# （17.5 + 9），以最低学习率接着训练；其余都和原来一样：在后台训练（关掉终端或按 Ctrl-C 都不会中断），
# 训练期间 Mac 不睡眠（请接上电源，不要合上盖子），出错自动从保存点续训，结束后生成 3 段试听 MIDI。
# 开始前先把现在的 weights.pt 复制到 training/runs/four-pillar-v31-step<步数>/（已有就不再复制）：
# 训练会不断覆盖运行目录里的 weights.pt，这份副本就是试听页现在用的模型。
# (Variables are written as ${NAME}: macOS's bash 3.2 would otherwise read the Chinese characters that follow a
#  name as part of it.)
set -euo pipefail

SELF_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd -- "${SELF_DIR}/.." && pwd)"
cd "${PROJECT_ROOT}"
HOURS="26.5"
RUN="${AILEGRO_V31_RUN:-four-pillar-v31-ready-20261001}"
RUN_DIR="training/runs/${RUN}"
STATE="training/logs/${RUN}"
PY="${PROJECT_ROOT}/.venv-training/bin/python"

alive() {   # alive <pid file>: the process it names is running
  local pid
  pid="$(cat "$1" 2>/dev/null || true)"
  case "${pid}" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "${pid}" 2>/dev/null
}

if [ "${1:-start}" = "start" ] && [ -f "${RUN_DIR}/weights.pt" ] \
    && ! alive "${STATE}/runner.pid" && ! alive "${STATE}/trainer.pid"; then
  STEP="$("${PY}" -B -c 'import sys, torch; print(torch.load(sys.argv[1], map_location="cpu", weights_only=False)["step"])' \
    "${RUN_DIR}/weights.pt")"
  KEEP="training/runs/four-pillar-v31-step${STEP}"
  if [ ! -f "${KEEP}/weights.pt" ]; then
    mkdir -p "${KEEP}"
    cp -p "${RUN_DIR}/weights.pt" "${KEEP}/weights.pt"
    echo "现在的权重（第 ${STEP} 步）另存在 ${KEEP}/weights.pt"
  fi
fi
AILEGRO_V31_HOURS="${HOURS}" exec /bin/bash training/train_four_pillar_v31.sh "$@"
