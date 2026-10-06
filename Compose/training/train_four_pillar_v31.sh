#!/bin/bash
# AIlegro 四大件 v3.1 训练。在 Mac 的“终端”里、于 AIlegro 文件夹运行；默认训练 7 个半小时（整个过程约 7 小时 40 分）。
#
#   bash training/train_four_pillar_v31.sh          开始训练；中断后再运行同一命令，会从最近的保存点接着训练
#   bash training/train_four_pillar_v31.sh status   查看进度：步数、损失、剩余时间
#   bash training/train_four_pillar_v31.sh log      接着看日志（Ctrl-C 只是不再显示，训练不受影响）
#   bash training/train_four_pillar_v31.sh stop     在当前一步结束时保存并停止（之后可以接着训练）
#   bash training/train_four_pillar_v31.sh sample   用当前的权重生成 3 段试听 MIDI
#
# 训练在后台进行：关掉终端窗口或按 Ctrl-C 都不会中断训练；训练期间 Mac 不会自动睡眠（请接上电源，
# 不要合上盖子）。第一次运行依次做：单元测试 → 预检（每个数据来源都取窗口做前向+反向；有 Apple GPU 时
# 比较它与 CPU 的速度和结果，选更快且结果一致的）→ 建立第 0 步（随机初始化）→ 训练。训练进程出错时，
# 自动从最近的保存点接着训练（GPU 出错就改用 CPU），最多重试 3 次。训练结束后自动生成 3 段试听 MIDI，
# 放在 training/logs/<运行名>/samples/。
#
# 可选：AILEGRO_V31_HOURS=7.5（训练的小时数，按已保存的训练时间累计；开头的检查和最后生成试听另需约 10 分钟）、
# AILEGRO_V31_DEVICE=cpu|mps（不自动选择）、AILEGRO_V31_WORKERS（准备样本的进程数）。训练开始后把
# AILEGRO_V31_HOURS 改大再运行，会以最低学习率接着训练。
# 测试用：AILEGRO_V31_RUN、AILEGRO_V31_SOURCES、AILEGRO_V31_CHECKPOINT_SECONDS、AILEGRO_V31_SAMPLE_BARS、
# AILEGRO_V31_RETRY_SECONDS。
# (Variables are always written as ${NAME}: macOS's bash 3.2 would otherwise read the Chinese
#  characters that follow a name as part of it.)
set -euo pipefail

SELF="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)/$(basename -- "${BASH_SOURCE[0]}")"
PROJECT_ROOT="$(cd -- "$(dirname -- "${SELF}")/.." && pwd)"
cd "${PROJECT_ROOT}"
REL="training/$(basename -- "${SELF}")"
PY="${PROJECT_ROOT}/.venv-training/bin/python"
TRAINER="training/scripts/train_four_pillar_v31.py"
RUN="${AILEGRO_V31_RUN:-four-pillar-v31-ready-20261001}"
RUN_DIR="training/runs/${RUN}"
STATE="training/logs/${RUN}"
LOG="${STATE}/train.log"
STOP="${STATE}/stop-requested"
HOURS="${AILEGRO_V31_HOURS:-7.5}"
CHECKPOINT_SECONDS="${AILEGRO_V31_CHECKPOINT_SECONDS:-600}"
SAMPLE_BARS="${AILEGRO_V31_SAMPLE_BARS:-16}"
RETRY_SECONDS="${AILEGRO_V31_RETRY_SECONDS:-60}"
EXTRA_ARGS=""            # word-split on purpose: none of these values contain spaces
if [ -n "${AILEGRO_V31_SOURCES:-}" ]; then EXTRA_ARGS="--sources ${AILEGRO_V31_SOURCES}"; fi
WORKER_ARGS=""
if [ -n "${AILEGRO_V31_WORKERS:-}" ]; then WORKER_ARGS="--workers ${AILEGRO_V31_WORKERS}"; fi
BUDGET="$(awk -v h="${HOURS}" 'BEGIN { if (h + 0 <= 0) exit 1; printf "%d", h * 3600 + .5 }')" \
  || { echo "AILEGRO_V31_HOURS 必须是正数" >&2; exit 1; }      # training seconds (--max-seconds)
case "${AILEGRO_V31_DEVICE:-}" in ''|cpu|mps) ;; *) echo "AILEGRO_V31_DEVICE 只能是 cpu 或 mps" >&2; exit 1 ;; esac
DETACH=$'import os, sys\ntry:\n    os.setsid()\nexcept OSError:\n    pass\nos.execvp(sys.argv[1], sys.argv[1:])'

cores() {   # performance cores on Apple silicon (all physical cores elsewhere), 1..8
  local n=""
  n="$(sysctl -n hw.perflevel0.physicalcpu 2>/dev/null || true)"
  if [ -z "${n}" ]; then n="$(sysctl -n hw.physicalcpu 2>/dev/null || true)"; fi
  if [ -z "${n}" ]; then n="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"; fi
  case "${n}" in ''|*[!0-9]*) n=4 ;; esac
  if [ "${n}" -gt 8 ]; then n=8; fi
  if [ "${n}" -lt 1 ]; then n=1; fi
  echo "${n}"
}
CPU_THREADS="$(cores)"
MPS_THREADS=4
if [ "${CPU_THREADS}" -lt 4 ]; then MPS_THREADS="${CPU_THREADS}"; fi

say() { printf '[%s] %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }
hms() { printf '%d:%02d:%02d' $(( $1 / 3600 )) $(( $1 % 3600 / 60 )) $(( $1 % 60 )); }

alive() {   # alive <pid file> <text its command line must contain>
  local pid command
  [ -f "$1" ] || return 1
  pid="$(cat "$1" 2>/dev/null || true)"
  case "${pid}" in ''|*[!0-9]*) return 1 ;; esac
  kill -0 "${pid}" 2>/dev/null || return 1
  command="$(ps -ww -p "${pid}" -o command= 2>/dev/null || true)"
  case "${command}" in *"$2"*) return 0 ;; esac
  return 1
}
runner_alive() { alive "${STATE}/runner.pid" "$(basename -- "${SELF}") _run"; }
trainer_alive() { alive "${STATE}/trainer.pid" "train_four_pillar_v31.py --output-dir ${RUN_DIR}"; }

info() {   # info step|finished|progress|status <run dir> <budget seconds> [running device rel]
  "${PY}" -B - "$@" <<'PYEOF'
import datetime, json, os, statistics, sys
mode, run, budget = sys.argv[1], sys.argv[2], float(sys.argv[3])
path = os.path.join(run, 'metrics.jsonl')
NAMES = (('pitch', '音高'), ('onset', '起音'), ('duration', '时值'), ('group', '乐器组'), ('voice', '声部'),
         ('chord_root', '和弦根音'), ('chord_quality', '和弦性质'), ('bar_ref', '参考小节'), ('bar_key', '调'))

def rows(limit=400):
    if not os.path.exists(path):
        return []
    with open(path, 'rb') as stream:
        stream.seek(0, 2)
        size = stream.tell()
        block = min(size, 4 << 20)
        stream.seek(size - block)
        lines = stream.read().splitlines()
    if block < size:
        lines = lines[1:]                      # the first line of the block may be partial
    out = []
    for line in lines[-limit:]:
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if 'loss' in row and 'step' in row:
            out.append(row)
    return out

def first():
    with open(path, 'rb') as stream:
        for line in stream:
            try:
                row = json.loads(line)
            except ValueError:
                continue
            if 'loss' in row:
                return row

def hms(seconds):
    seconds = max(0, int(round(seconds)))
    return f'{seconds // 3600}:{seconds % 3600 // 60:02d}:{seconds % 60:02d}'

recent = rows()
last = recent[-1] if recent else None
step = last['step'] if last else 0
elapsed = float(last['elapsedSeconds']) if last else 0.
done = bool(last) and elapsed >= budget - 30
if mode == 'step':
    print(step)
elif mode == 'finished':
    print(int(done))
elif mode == 'progress':
    print(f'第 {step:,} 步，已训练 {hms(elapsed)} / {hms(budget)}')
elif mode == 'status':
    running, device, rel = sys.argv[4] == '1', sys.argv[5], sys.argv[6]
    started = os.path.exists(os.path.join(run, 'manifest.json'))
    if done:
        print(f'状态：已完成（设备 {device}）')
    elif running:
        print(f'状态：训练中（设备 {device}）' if last else '状态：正在做训练前的检查，或训练刚刚开始')
    else:
        print('状态：没有在运行。' + (f'接着训练：bash {rel}' if started else f'开始训练：bash {rel}'))
    if last:
        share = min(1., elapsed / budget) if budget > 0 else 1.
        line = f'进度：第 {step:,} 步 · 已训练 {hms(elapsed)} / {hms(budget)}（{share:.0%}）'
        if running and not done:
            remaining = max(0., budget - elapsed)
            end = datetime.datetime.now() + datetime.timedelta(seconds=remaining)
            line += f' · 还需约 {hms(remaining)}，预计 {end:%m-%d %H:%M} 结束'
        print(line)
        window = recent[-200:]
        mean = statistics.fmean(r['loss'] for r in window)
        speed = statistics.median(r['stepSeconds'] for r in window)
        wait = statistics.median(r['dataWaitSeconds'] for r in window)
        print(f'损失：最近 {len(window)} 步平均 {mean:.3f}（第 1 步 {first()["loss"]:.2f}）· 每步 {speed:.2f} 秒'
              f'（其中等数据 {wait:.2f} 秒）· 学习率 {last["lr"]:.1e}')
        parts = []
        for key, name in NAMES:
            values = [r['objectives'][key] for r in window if key in r.get('objectives', {})]
            if values:
                parts.append(f'{name} {statistics.fmean(values):.2f}')
        print('各项：' + ' · '.join(parts))
        if running and not done and speed > 0 and wait > .3 * speed:
            print(f'提示：每步有不少时间在等数据。可以先 stop，再用 AILEGRO_V31_WORKERS=8 bash {rel} 接着训练。')
PYEOF
}

# ---------------------------------------------------------------- background pipeline (internal: _run)
fail() { say "错误：$*"; echo "$*" > "${STATE}/failed"; rm -f "${STATE}/runner.pid"; exit 1; }
check_stop() { if [ -f "${STOP}" ]; then say "已按要求停止。"; rm -f "${STATE}/runner.pid"; exit 0; fi; }

preflight_summary() {   # preflight_summary <json file>
  "${PY}" -B - "$1" <<'PYEOF'
import json, sys
r = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
rejected = f"；被拒绝的样本 {r['rejected']}" if r['rejected'] else ''
print(f"预检通过：{r['parameters']:,} 个参数；{r['batch']} 个窗口（{len(r['sources'])} 个数据来源）共 {r['events']:,} 个事件；"
      f"初始损失 {r['loss']:.2f}；准备数据 {r['dataSeconds']:.1f} 秒；每次前向+反向 {r['modelSeconds']:.2f} 秒{rejected}")
PYEOF
}

decide() {   # decide <preflight json> <requested device>: prints "<device> <reason>"
  "${PY}" -B - "$1" "$2" <<'PYEOF'
import json, sys
r = json.loads(open(sys.argv[1]).read().strip().splitlines()[-1])
p = r['deviceParity']
same = p['relativeDifference'] < 2e-3 and p['gradientRelativeDifference'] < 2e-2
faster = r['modelSeconds'] < .8 * p['cpuModelSeconds']
device = 'mps' if same and (faster or sys.argv[2] == 'mps') else 'cpu'
reason = (f"Apple GPU 每次前向+反向 {r['modelSeconds']:.2f} 秒，CPU {p['cpuModelSeconds']:.2f} 秒；"
          f"损失相对差 {p['relativeDifference']:.1e}，梯度范数相对差 {p['gradientRelativeDifference']:.1e}")
if not same:
    reason += '（结果不一致）'
print(device, reason)
PYEOF
}

choose_device() {   # runs the preflight and writes cpu or mps to ${STATE}/device
  local mps verdict
  mps="$("${PY}" -B -c 'import torch; print(1 if torch.backends.mps.is_available() else 0)' 2>/dev/null || echo 0)"
  if [ "${AILEGRO_V31_DEVICE:-}" != "cpu" ] && { [ "${mps}" = "1" ] || [ "${AILEGRO_V31_DEVICE:-}" = "mps" ]; }; then
    say "预检：Apple GPU（MPS）与 CPU（${CPU_THREADS} 个线程）各做几次前向+反向……"
    if "${PY}" -B -u "${TRAINER}" --output-dir "${RUN_DIR}" ${EXTRA_ARGS} --preflight --device mps \
         --threads "${CPU_THREADS}" > "${STATE}/preflight-mps.json"; then
      say "$(preflight_summary "${STATE}/preflight-mps.json")"
      verdict="$(decide "${STATE}/preflight-mps.json" "${AILEGRO_V31_DEVICE:-}")"
      echo "${verdict%% *}" > "${STATE}/device"
      say "${verdict#* }"
      if [ "${verdict%% *}" = "mps" ]; then say "用 Apple GPU（MPS）训练。"; else say "用 CPU 训练。"; fi
      return
    fi
    say "Apple GPU 预检出错（上面是错误信息），改用 CPU。"
  elif [ "${mps}" != "1" ]; then
    say "没有可用的 Apple GPU（MPS），用 CPU。"
  fi
  "${PY}" -B -u "${TRAINER}" --output-dir "${RUN_DIR}" ${EXTRA_ARGS} --preflight --threads "${CPU_THREADS}" \
    > "${STATE}/preflight-cpu.json" || fail "预检失败（上面是错误信息），训练没有开始。"
  say "$(preflight_summary "${STATE}/preflight-cpu.json")"
  echo cpu > "${STATE}/device"
}

sample_one() {   # sample_one <output base> <sampler arguments...>
  local base="$1"
  shift
  if "${PY}" -B training/scripts/four_pillar_v31_sample.py --checkpoint "${RUN_DIR}/weights.pt" \
       --bars "${SAMPLE_BARS}" --tempo 92 --top-p 0.95 --output "${base}.json" "$@" \
     && "${PY}" -B training/scripts/four_pillar_v31_midi.py --input "${base}.json" --output "${base}.mid" --tempo 92; then
    say "试听：${base}.mid"
  else
    say "生成 ${base} 没有成功（不影响训练结果）。"
  fi
}

make_samples() {
  local out="${STATE}/samples" step
  mkdir -p "${out}"
  step="$(info step "${RUN_DIR}" "${BUDGET}")"
  say "用第 ${step} 步的权重生成试听（每段 ${SAMPLE_BARS} 小节，92 BPM）"
  sample_one "${out}/step${step}-orchestra-C" --key C --style symphony-classical --seed 1
  sample_one "${out}/step${step}-piano-Am" --key Am --style Lieder --groups keys --request-groups --seed 2
  sample_one "${out}/step${step}-contemporary-D" --key D --style symphony-contemporary --model-keys --seed 3
}

run_pipeline() {
  trap '' INT HUP          # only `stop` (a signal to the trainer) ends this pipeline
  mkdir -p "${STATE}"
  echo "$$" > "${STATE}/runner.pid"
  rm -f "${STATE}/failed"
  say "===== 四大件 v3.1：${RUN_DIR}；训练时间目标 $(hms "${BUDGET}")（已保存的训练时间累计）====="
  say "$("${PY}" -B -c 'import platform, sys, torch; print("Python", sys.version.split()[0], "· torch", torch.__version__, "·", platform.platform())')"
  if [ -f "${RUN_DIR}/manifest.json" ] && [ ! -f "${RUN_DIR}/state.pt" ]; then
    local aside
    aside="${RUN_DIR}.incomplete-$(date +%Y%m%d-%H%M%S)"
    mv "${RUN_DIR}" "${aside}"
    say "上次建立第 0 步时被中断，运行目录不完整；已移到 ${aside}，重新建立。"
  fi
  local device threads trainer status attempts=0 chosen=0
  if [ ! -f "${RUN_DIR}/manifest.json" ]; then
    say "第 1 步（共 4 步）：单元测试"
    "${PY}" -B training/tests/four-pillar-v31.test.py 2>&1 || fail "单元测试没有通过，训练没有开始。"
    check_stop
    say "第 2 步：预检，并选择训练设备"
    choose_device
    chosen=1
    check_stop
    say "第 3 步：建立第 0 步（随机初始化）"
    "${PY}" -B -u "${TRAINER}" --output-dir "${RUN_DIR}" ${EXTRA_ARGS} --initialize-only --max-seconds "${BUDGET}" \
      --threads "${CPU_THREADS}" || fail "建立第 0 步失败（上面是错误信息）。"
    say "第 4 步：训练"
  else
    say "接着已有的训练（$(info progress "${RUN_DIR}" "${BUDGET}")）"
    if [ ! -f "${STATE}/device" ] && [ -z "${AILEGRO_V31_DEVICE:-}" ]; then
      say "还没有选过训练设备，先做预检"
      choose_device
      chosen=1
    fi
  fi
  if [ "${chosen}" = "0" ] && [ -n "${AILEGRO_V31_DEVICE:-}" ]; then echo "${AILEGRO_V31_DEVICE}" > "${STATE}/device"; fi
  device="$(cat "${STATE}/device" 2>/dev/null || echo cpu)"
  while :; do
    check_stop
    threads="${CPU_THREADS}"
    if [ "${device}" = "mps" ]; then threads="${MPS_THREADS}"; fi
    say "训练进程启动（设备 ${device}，${threads} 个线程；每 ${CHECKPOINT_SECONDS} 秒保存一次）"
    "${PY}" -B -u "${TRAINER}" --output-dir "${RUN_DIR}" ${EXTRA_ARGS} ${WORKER_ARGS} --resume \
      --max-seconds "${BUDGET}" --device "${device}" --threads "${threads}" \
      --checkpoint-seconds "${CHECKPOINT_SECONDS}" &
    trainer=$!
    echo "${trainer}" > "${STATE}/trainer.pid"
    status=0
    wait "${trainer}" || status=$?
    rm -f "${STATE}/trainer.pid"
    if [ -f "${STOP}" ]; then
      say "已保存并停止（$(info progress "${RUN_DIR}" "${BUDGET}")）。接着训练：bash ${REL}"
      rm -f "${STATE}/runner.pid"
      exit 0
    fi
    if [ "${status}" -eq 0 ] && [ "$(info finished "${RUN_DIR}" "${BUDGET}")" = "1" ]; then
      break
    fi
    attempts=$(( attempts + 1 ))
    if [ "${status}" -eq 0 ]; then
      say "训练进程提前结束了（例如收到系统的终止信号），进度已保存。"
    else
      say "训练进程出错（退出码 ${status}，错误信息在上面）。"
    fi
    if [ "${attempts}" -gt 3 ]; then
      fail "已经重试 3 次，停止。进度保存在最近的保存点；查明原因后再运行 bash ${REL} 会接着训练。"
    fi
    if [ "${device}" = "mps" ]; then
      device=cpu
      echo cpu > "${STATE}/device"
      say "改用 CPU，从最近的保存点接着训练（第 ${attempts} 次重试）。"
    else
      say "${RETRY_SECONDS} 秒后从最近的保存点接着训练（第 ${attempts} 次重试）。"
      sleep "${RETRY_SECONDS}"
    fi
  done
  say "训练完成：$(info progress "${RUN_DIR}" "${BUDGET}")"
  make_samples
  say "===== 全部完成。进度与试听：bash ${REL} status ====="
  rm -f "${STATE}/runner.pid"
}

# ---------------------------------------------------------------- commands
follow() {   # follow <first line>: show the log from that line while the pipeline runs
  local tail_pid waited=0
  tail -n "+$1" -f "${LOG}" &
  tail_pid=$!
  trap 'kill "${tail_pid}" 2>/dev/null; printf "\n（不再显示日志；训练仍在后台进行。看进度：bash %s status）\n" "${REL}"; exit 0' INT TERM HUP
  while [ ! -f "${STATE}/runner.pid" ] && [ "${waited}" -lt 20 ]; do sleep 1; waited=$(( waited + 1 )); done
  while runner_alive; do sleep 3; done
  sleep 1
  kill "${tail_pid}" 2>/dev/null || true
  trap - INT TERM HUP
}

start() {
  if [ ! -x "${PY}" ]; then echo "找不到项目的 Python：${PY}" >&2; exit 1; fi
  mkdir -p "${STATE}"
  : >> "${LOG}"
  if runner_alive || trainer_alive; then
    echo "已经在训练中（日志 ${LOG}）。"
    show_status
    echo "—— 实时日志（Ctrl-C 只是不再显示）——"
    follow "$(( $(wc -l < "${LOG}") > 30 ? $(wc -l < "${LOG}") - 30 : 1 ))"
    return
  fi
  if [ -f "${RUN_DIR}/manifest.json" ] && [ "$(info finished "${RUN_DIR}" "${BUDGET}")" = "1" ]; then
    echo "这次训练已经完成。"
    show_status
    echo "想再多训练：AILEGRO_V31_HOURS=10 bash ${REL}（会以最低学习率接着训练）"
    return
  fi
  rm -f "${STOP}" "${STATE}/runner.pid" "${STATE}/trainer.pid"
  local from
  from=$(( $(wc -l < "${LOG}") + 1 ))
  echo "四大件 v3.1 训练"
  echo "  运行目录：${RUN_DIR}"
  if [ -f "${RUN_DIR}/state.pt" ]; then
    echo "  接着上次的训练：$(info progress "${RUN_DIR}" "${BUDGET}")"
  else
    echo "  时长：训练 $(hms "${BUDGET}")；开头的检查和最后生成试听 MIDI 另需约 10 分钟"
  fi
  echo "  训练在后台进行：关掉这个窗口或按 Ctrl-C 都不会中断训练。训练期间 Mac 不会自动睡眠（请接上电源，不要合上盖子）。"
  echo "  看进度：bash ${REL} status      停止（先保存）：bash ${REL} stop"
  echo "  日志：${LOG}"
  echo "—— 实时日志（Ctrl-C 只是不再显示）——"
  if command -v caffeinate >/dev/null 2>&1; then
    "${PY}" -B -c "${DETACH}" caffeinate -ims /bin/bash "${SELF}" _run >> "${LOG}" 2>&1 < /dev/null &
  else
    "${PY}" -B -c "${DETACH}" /bin/bash "${SELF}" _run >> "${LOG}" 2>&1 < /dev/null &
  fi
  follow "${from}"
}

show_status() {
  local running=0 device="未选"
  if runner_alive; then running=1; fi
  if [ -f "${STATE}/device" ]; then device="$(cat "${STATE}/device")"; fi
  info status "${RUN_DIR}" "${BUDGET}" "${running}" "${device}" "${REL}"
  if [ "${running}" = "0" ] && [ -f "${STATE}/failed" ]; then
    echo "上次停止的原因：$(cat "${STATE}/failed")"
    echo "日志最后 15 行（${LOG}）："
    tail -n 15 "${LOG}"
  fi
  if ls "${STATE}"/samples/*.mid >/dev/null 2>&1; then
    echo "试听 MIDI（${STATE}/samples）："
    ls -1t "${STATE}"/samples/*.mid | head -n 6 | sed 's/^/  /' || true
  fi
}

show_log() {
  if [ ! -f "${LOG}" ]; then echo "还没有日志：${LOG}"; return; fi
  if runner_alive; then
    follow "$(( $(wc -l < "${LOG}") > 40 ? $(wc -l < "${LOG}") - 40 : 1 ))"
  else
    tail -n 60 "${LOG}"
    echo "（现在没有在训练）"
  fi
}

stop_run() {
  local pid pgid own waited=0
  if trainer_alive; then
    touch "${STOP}"
    pid="$(cat "${STATE}/trainer.pid")"
    echo "正在停止：当前一步结束后保存（通常几秒；如果训练进程还在启动，最多一两分钟）……"
    while kill -0 "${pid}" 2>/dev/null; do
      kill -INT "${pid}" 2>/dev/null || true
      sleep 3
      waited=$(( waited + 3 ))
      if [ "${waited}" -ge 600 ]; then echo "10 分钟内没有停下来，请看日志：${LOG}" >&2; exit 1; fi
    done
    waited=0
    while runner_alive && [ "${waited}" -lt 30 ]; do sleep 1; waited=$(( waited + 1 )); done
    echo "已保存并停止：$(info progress "${RUN_DIR}" "${BUDGET}")"
    echo "接着训练：bash ${REL}"
  elif runner_alive; then
    touch "${STOP}"
    pid="$(cat "${STATE}/runner.pid")"
    pgid="$(ps -o pgid= -p "${pid}" 2>/dev/null | tr -d ' ' || true)"
    own="$(ps -o pgid= -p $$ 2>/dev/null | tr -d ' ' || true)"
    if [ -n "${pgid}" ] && [ "${pgid}" != "${own}" ]; then
      kill -TERM -- "-${pgid}" 2>/dev/null || true
    else
      kill -TERM "${pid}" 2>/dev/null || true
    fi
    rm -f "${STATE}/runner.pid"
    echo "已停止（当时没有训练进程在运行，没有未保存的进度）。"
  else
    echo "现在没有在训练。"
  fi
}

case "${1:-start}" in
  start) start ;;
  status) show_status ;;
  log) show_log ;;
  stop) stop_run ;;
  sample)
    if [ ! -f "${RUN_DIR}/weights.pt" ]; then echo "还没有权重：${RUN_DIR}/weights.pt" >&2; exit 1; fi
    mkdir -p "${STATE}"
    make_samples ;;
  _run) run_pipeline ;;
  help|-h|--help) sed -n '2,25p' "${SELF}" ;;
  *) echo "不认识的命令：$1（可用：start、status、log、stop、sample）" >&2; exit 1 ;;
esac
