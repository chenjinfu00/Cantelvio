#!/bin/bash
# Cantelvio Compose 管弦乐模型：在 Mac 的“终端”里运行。所有数据和训练结果都放在 iCloud Drive 项目内的 work/。
#
#   bash mac.sh setup          选定 Python（默认用已装好 PyTorch 的 Anaconda），补装两个小依赖并自检
#   bash mac.sh check          检测芯片、内存、GPU 速度和剩余磁盘，写入 work/hardware.json
#   bash mac.sh data           下载 SymphonyNet 交响乐 MIDI 数据集并预处理
#   bash mac.sh ablation       后台依次训练 5 个对照模型（12 平均律对称性实验）
#   bash mac.sh train <配置>   后台训练 configs/<配置>.json；中断后再运行同一命令即可接着训练
#   bash mac.sh status         查看所有训练的进度
#   bash mac.sh stop <配置>    在下一个保存点停止该训练
#   bash mac.sh sample <配置> [小节数]   用该训练当前最好的模型生成一段 MIDI
#
# 指定别的 Python：AILEGRO_PYTHON=/path/to/python bash mac.sh setup
# (Variables are always written as ${NAME}: macOS's bash 3.2 would otherwise read the
#  Chinese characters that follow a name as part of it.)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="${HERE}/work"
PY_FILE="${WORK}/python-path"
DATASET_ID="1j9Pvtzaq8k_QIPs8e2ikvCR-BusPluTb"   # SymphonyNet dataset (symphonynet.github.io)
ABLATION="abl-absolute abl-absolute-aug abl-rotary abl-rotary-aug abl-rotary-exact-aug"
mkdir -p "${WORK}/runs" "${WORK}/samples"

workers() { local n; n=$(sysctl -n hw.ncpu 2>/dev/null || echo 4); echo $(( n > 2 ? n - 2 : 1 )); }

python_candidates() {   # every Python that might have PyTorch, most likely first
  if [ -n "${AILEGRO_PYTHON:-}" ]; then echo "${AILEGRO_PYTHON}"; fi
  if [ -x "${HERE}/../../.venv-training/bin/python" ]; then echo "${HERE}/../../.venv-training/bin/python"; fi
  if [ -n "${CONDA_PREFIX:-}" ]; then echo "${CONDA_PREFIX}/bin/python"; fi
  if [ -n "${CONDA_EXE:-}" ] && [ -x "${CONDA_EXE}" ]; then   # all environments conda knows about
    "${CONDA_EXE}" env list 2>/dev/null | awk '!/^#/ && NF > 0 {print $NF "/bin/python"}' || true
  fi
  local root e
  for root in "${HOME}/anaconda3" "${HOME}/opt/anaconda3" "/opt/anaconda3" "/usr/local/anaconda3" \
              "${HOME}/miniconda3" "${HOME}/opt/miniconda3" "/opt/miniconda3" "${HOME}/miniforge3" "${HOME}/mambaforge" \
              "/opt/homebrew/anaconda3" "/opt/homebrew/Caskroom/miniconda/base" "/opt/homebrew/Caskroom/miniforge/base"; do
    if [ -d "${root}" ]; then
      echo "${root}/bin/python"
      for e in "${root}"/envs/*/bin/python; do
        if [ -x "${e}" ]; then echo "${e}"; fi
      done
    fi
  done
  command -v python3 2>/dev/null || true
  command -v python 2>/dev/null || true
}

find_python() {   # prints the chosen Python on stdout, what it looked at on stderr
  local p out last
  while IFS= read -r p; do
    if [ -z "${p}" ] || [ ! -x "${p}" ]; then continue; fi
    if out="$("${p}" -c 'import torch; print(torch.__version__)' 2>&1)"; then
      last="$(printf '%s\n' "${out}" | tail -n 1)"
      echo "  ${p}  →  PyTorch ${last}" >&2
      echo "${p}"; return 0
    fi
    last="$(printf '%s\n' "${out}" | tail -n 1)"
    echo "  ${p}  →  没有可用的 PyTorch（${last}）" >&2
  done < <(python_candidates | awk '!seen[$0]++')
  return 1
}

need_env() {
  [ -f "${PY_FILE}" ] || { echo "请先运行：bash \"${HERE}/mac.sh\" setup"; exit 1; }
  PY="$(cat "${PY_FILE}")"
}

start_bg() {   # start_bg <log file> <command...>: keeps running after Terminal is closed; the Mac stays awake
  local log="$1"; shift
  nohup caffeinate -ims "$@" >> "${log}" 2>&1 &
  echo "$!"
}

case "${1:-help}" in
  setup)
    echo "查找装有 PyTorch 的 Python："
    PY="$(find_python)" || {
      echo "没有找到装有 PyTorch 的 Python（上面列出了检查过的位置）。"
      echo "如果 PyTorch 装在某个 conda 环境里，请先激活它再运行："
      echo "  conda activate <环境名>"
      echo "  AILEGRO_PYTHON=\"\$(which python)\" bash mac.sh setup"
      exit 1; }
    "${PY}" - <<'EOF'
import platform, sys
import torch
print(f"Python {sys.version.split()[0]}  ({sys.executable})")
print(f"架构 {platform.machine()}  PyTorch {torch.__version__}  MPS(GPU) 可用: {torch.backends.mps.is_available()}")
v = tuple(int(x) for x in torch.__version__.split('+')[0].split('.')[:2])
if sys.platform == 'darwin' and platform.machine() != 'arm64':
    print("注意：这个 Python 不是 Apple 芯片原生版本（在 Rosetta 下运行），用不到 GPU，训练会慢很多。"
          "建议安装 arm64 版 Anaconda/Miniforge 后再运行 setup。")
if v < (2, 1):
    sys.exit("PyTorch 版本太旧，需要 2.1 或更新：conda install pytorch -c pytorch  或  pip install -U torch")
if sys.platform == 'darwin' and not torch.backends.mps.is_available():
    print("注意：MPS 不可用，训练会用 CPU。")
EOF
    echo "${PY}" > "${PY_FILE}"
    "${PY}" -c 'import symusic, gdown' 2>/dev/null || "${PY}" -m pip install --quiet symusic gdown
    "${PY}" -c 'import numpy' 2>/dev/null || "${PY}" -m pip install --quiet numpy
    echo "使用 ${PY}。运行自检……"
    T="${WORK}/selftest"; rm -rf "${T}"; mkdir -p "${T}"
    "${PY}" "${HERE}/tests/make_test_midis.py" "${T}/midi" --synthetic 30 --scores 0 > /dev/null
    "${PY}" "${HERE}/prepare.py" "${T}/midi" "${T}/data" --workers 2 --holdout 10 > "${T}/prepare.log"
    "${PY}" "${HERE}/tests/test_pipeline.py" "${T}/data" "${T}/midi"
    "${PY}" "${HERE}/tests/test_model.py" "${T}/data"
    "${PY}" "${HERE}/train.py" "${HERE}/configs/tiny.json" --data "${T}/data" --runs "${T}/runs" --set train.steps=40 train.eval_every=40 > "${T}/train.log"
    "${PY}" "${HERE}/sample.py" "${T}/runs/tiny/best.pt" "${T}/sample.mid" --bars 4 --tempo 100
    echo "自检通过。下一步：bash \"${HERE}/mac.sh\" check"
    ;;
  check)
    need_env
    "${PY}" "${HERE}/hwcheck.py" "${WORK}/hardware.json"
    ;;
  data)
    need_env
    RAW="${WORK}/raw"; mkdir -p "${RAW}"
    if [ -z "$(find "${RAW}" \( -iname '*.mid' -o -iname '*.midi' \) -print -quit)" ]; then
      archive="$(find "${RAW}" -maxdepth 1 \( -name '*.zip' -o -name '*.tar' -o -name '*.tar.gz' -o -name '*.tgz' \) -print -quit)"
      if [ -z "${archive}" ]; then
        echo "下载 SymphonyNet 数据集（Google Drive）……"
        if ! (cd "${RAW}" && "${PY}" -m gdown "${DATASET_ID}"); then
          echo "自动下载失败（Google Drive 有时限制下载次数）。请用浏览器打开"
          echo "  https://drive.google.com/file/d/${DATASET_ID}/view"
          echo "下载后把文件放进 ${RAW} ，再运行一次：bash \"${HERE}/mac.sh\" data"
          exit 1
        fi
        archive="$(find "${RAW}" -maxdepth 1 -type f ! -name '.*' -print -quit)"
      fi
      echo "解压 ${archive} ……"
      case "${archive}" in
        *.zip) unzip -q -o "${archive}" -d "${RAW}/extracted" ;;
        *.tar|*.tar.gz|*.tgz) mkdir -p "${RAW}/extracted"; tar -xf "${archive}" -C "${RAW}/extracted" ;;
        *) echo "不认识的压缩格式：${archive}。请手动解压到 ${RAW}/extracted/ 后再运行一次。"; exit 1 ;;
      esac
    fi
    echo "预处理（$(workers) 个进程），日志：${WORK}/prepare.log"
    "${PY}" "${HERE}/prepare.py" "${RAW}" "${WORK}/data" --workers "$(workers)" 2>&1 | tee "${WORK}/prepare.log"
    ;;
  train)
    need_env; name="${2:?用法：mac.sh train <配置名>}"
    [ -f "${HERE}/configs/${name}.json" ] || { echo "没有 configs/${name}.json"; exit 1; }
    [ -f "${WORK}/data/prepare.json" ] || { echo "请先运行：bash \"${HERE}/mac.sh\" data"; exit 1; }
    if pgrep -f "train.py.*configs/${name}.json" > /dev/null; then echo "${name} 已经在训练中"; exit 0; fi
    pid="$(start_bg "${WORK}/runs/${name}.out" "${PY}" "${HERE}/train.py" "${HERE}/configs/${name}.json" --data "${WORK}/data" --runs "${WORK}/runs")"
    echo "开始训练 ${name}（进程 ${pid}）。可以关掉终端；Mac 会保持唤醒直到训练结束。查看进度：bash \"${HERE}/mac.sh\" status"
    ;;
  ablation)
    need_env
    [ -f "${WORK}/data/prepare.json" ] || { echo "请先运行：bash \"${HERE}/mac.sh\" data"; exit 1; }
    if pgrep -f "orchestra-ablation" > /dev/null; then echo "对照实验已经在运行"; exit 0; fi
    script="${WORK}/runs/orchestra-ablation.sh"
    { echo "#!/bin/bash"; for n in ${ABLATION}; do
        printf '"%s" "%s" "%s" --data "%s" --runs "%s" >> "%s" 2>&1\n' "${PY}" "${HERE}/train.py" "${HERE}/configs/${n}.json" "${WORK}/data" "${WORK}/runs" "${WORK}/runs/${n}.out"
      done; } > "${script}"
    pid="$(start_bg "${WORK}/runs/ablation.out" bash "${script}")"
    echo "对照实验开始（进程 ${pid}）：${ABLATION}。可以关掉终端。查看进度：bash \"${HERE}/mac.sh\" status"
    ;;
  status)
    need_env
    "${PY}" - "${WORK}/runs" <<'EOF'
import json, sys, time
from pathlib import Path
for log in sorted(Path(sys.argv[1]).glob('*/log.jsonl')):
    rows = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    start = next((r for r in rows if r.get('start')), {})
    steps = [r for r in rows if 'step' in r and 'loss' in r]
    evals = [r for r in rows if 'eval' in r]
    done = any(r.get('done') for r in rows)
    total = start.get('config', {}).get('train', {}).get('steps', '?')
    last = steps[-1] if steps else {}
    ev = evals[-1]['eval'] if evals else {}
    age = time.time() - last.get('time', time.time())
    print(f"{log.parent.name:24s} step {last.get('step', 0)}/{total}  loss {last.get('loss', '-')}  "
          f"val {ev.get('val', {}).get('nll', '-')}  val+5 {ev.get('val+5', {}).get('nll', '-')}  "
          f"{last.get('tokensPerSec', '-')} tok/s  {'done' if done else f'last update {age/60:.0f} min ago'}")
EOF
    ;;
  stop)
    name="${2:?用法：mac.sh stop <配置名>}"; touch "${WORK}/runs/${name}/STOP"; echo "${name} 会在下一步后保存并停止"
    ;;
  sample)
    need_env; name="${2:?用法：mac.sh sample <配置名> [小节数]}"; bars="${3:-32}"
    out="${WORK}/samples/${name}-$(date +%Y%m%d-%H%M%S).mid"
    "${PY}" "${HERE}/sample.py" "${WORK}/runs/${name}/best.pt" "${out}" --bars "${bars}"
    echo "已写入 ${out}"
    ;;
  *)
    sed -n '2,13p' "$0"
    ;;
esac
