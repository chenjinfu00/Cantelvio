#!/usr/bin/env python3
"""Learning curves of the joint prototypes (structured vs generic baselines).

Reads <run>/<model>/training.json (or the JSON lines in <run>/<model>.log while a
run is still going) and <run>/benchmark.json (seconds per step, measured one model
at a time). Only the Lieder fine-tuning phase is drawn: during the 800 synthetic
pretraining steps the Lieder loss sits between 4 and 6 and would flatten the rest.
Writes <run>/learning-curves.png and <run>/stream-curves.png.
"""
import json, sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

INK, INK2, MUTED, GRID, AXIS, SURFACE = '#0b0b0b', '#52514e', '#898781', '#e1e0d9', '#c3c2b7', '#fcfcfb'
# (run name, label, color, dashed) — categorical slots 1-3; the ablation is a muted dashed reference line
SERIES = [('structured', '结构化四轨模型', '#2a78d6', False), ('flat-params', '通用·同等参数量', '#1baf7a', False),
          ('flat-compute', '通用·同等计算量', '#eb6834', False), ('flat-compute-basic', '消融：通用·同等计算量·无位置控制', MUTED, True)]
PRETRAIN = 800
plt.rcParams.update({'font.family': ['Noto Sans CJK JP', 'DejaVu Sans'], 'font.size': 10,
                     'axes.edgecolor': AXIS, 'axes.labelcolor': INK2, 'xtick.color': MUTED, 'ytick.color': MUTED,
                     'axes.facecolor': SURFACE, 'figure.facecolor': SURFACE, 'savefig.facecolor': SURFACE})


def curve(run, name):
    tj = run / name / 'training.json'
    rows = json.loads(tj.read_text())['curve'] if tj.exists() else None
    if rows is None:
        log = run / f'{name}.log'
        if not log.exists():
            return None
        rows = [json.loads(l) for l in log.read_text().splitlines() if l.startswith('{"step"')]
    by_step = {r['step']: r for r in rows if r.get('step', 0) > PRETRAIN}  # a resumed run may log a step twice
    return [by_step[s] for s in sorted(by_step)] or None


def style(ax):
    ax.grid(True, color=GRID, linewidth=1, linestyle='-'); ax.set_axisbelow(True)
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    ax.tick_params(length=0)


def draw(ax, xs, ys, color, label, dashed):
    ax.plot(xs, ys, color=color, linewidth=1.6 if dashed else 2, linestyle=(0, (4, 3)) if dashed else '-',
            solid_capstyle='round', solid_joinstyle='round', label=label, zorder=3)
    ax.scatter(xs[-1:], ys[-1:], s=64, color=color, edgecolors=SURFACE, linewidths=2, zorder=4)
    return (xs[-1], ys[-1])


def end_labels(ax, ends, fmt='{:.2f}', gap_px=12):
    """Value labels at the line ends, nudged apart vertically so they never overlap."""
    if not ends:
        return
    fig = ax.figure; fig.canvas.draw()
    to_px, to_data = ax.transData.transform, ax.transData.inverted().transform
    pts = sorted(((to_px((x, y)), y) for x, y in ends), key=lambda p: p[0][1])
    placed = []
    for (px, py), y in pts:
        if placed and py - placed[-1] < gap_px:
            py = placed[-1] + gap_px
        placed.append(py)
        ax.annotate(fmt.format(y), to_data((px, py)), xytext=(7, 0), textcoords='offset points', va='center',
                    color=INK2, fontsize=9, annotation_clip=False)


def main():
    run = Path(sys.argv[1])
    bench = json.loads((run / 'benchmark.json').read_text()) if (run / 'benchmark.json').exists() else {}
    curves = {n: curve(run, n) for n, *_ in SERIES}
    shown = [s for s in SERIES if curves.get(s[0])]
    # Figure 1: weighted Lieder validation loss vs step and vs training time.
    fig, axes = plt.subplots(1, 2, figsize=(11, 4.6), sharey=True)
    ends = [[], []]
    for name, label, color, dashed in shown:
        c = curves[name]
        steps = [r['step'] for r in c]; loss = [r['lieder']['weighted'] for r in c]
        ends[0].append(draw(axes[0], steps, loss, color, label, dashed))
        if name in bench:
            ends[1].append(draw(axes[1], [s * bench[name] / 60 for s in steps], loss, color, label, dashed))
    for ax in axes:
        style(ax)
    axes[0].set_xlabel('训练步数（batch = 16 个窗口；前 800 步为合成数据预训练，未画出）')
    axes[1].set_xlabel('训练时间（分钟；2 个 CPU 线程，按逐个单独测得的每步耗时换算）' if bench else '训练时间（尚无单独测得的每步耗时）')
    axes[0].set_ylabel('Lieder 验证集损失（四轨加权交叉熵）')
    fig.suptitle('Lieder 微调阶段的验证损失：结构化模型 vs 通用 Transformer', x=0.015, ha='left', color=INK, fontsize=13)
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='upper left', bbox_to_anchor=(0.01, 0.93), ncol=len(labels), frameon=False,
               labelcolor=INK2, fontsize=9.5, handlelength=2.4)
    fig.tight_layout(rect=(0, 0, 0.97, 0.88))
    for ax, e in zip(axes, ends):
        end_labels(ax, e, fmt='{:.3f}')
    fig.savefig(run / 'learning-curves.png', dpi=160); plt.close(fig)
    # Figure 2: per-stream curves (small multiples, one axis each).
    names = {'R': '节奏 R', 'H': '和声 H', 'B': '低音 B', 'M': '旋律 M'}
    fig, axes = plt.subplots(1, 4, figsize=(13.5, 3.9))
    for ax, s in zip(axes, 'RHBM'):
        e = []
        for name, label, color, dashed in shown:
            c = curves[name]
            e.append(draw(ax, [r['step'] for r in c], [r['lieder'][s] for r in c], color, label, dashed))
        style(ax); ax.set_title(names[s], loc='left', color=INK, fontsize=11); ax.set_xlabel('训练步数')
        ax.set_xticks([1000, 2000, 3000]); ax.margins(x=0.04)
        ax._ends = e
    axes[0].set_ylabel('Lieder 验证集交叉熵')
    handles, labels = axes[0].get_legend_handles_labels()
    fig.legend(handles, labels, loc='upper left', bbox_to_anchor=(0.01, 0.99), ncol=len(labels), frameon=False,
               labelcolor=INK2, fontsize=9.5, handlelength=2.4)
    fig.tight_layout(rect=(0, 0, 0.975, 0.9), w_pad=3.4)
    for ax in axes:
        end_labels(ax, ax._ends)
    fig.savefig(run / 'stream-curves.png', dpi=160); plt.close(fig)
    print(json.dumps({'series': [s[0] for s in shown], 'benchmark': sorted(bench)}))


if __name__ == '__main__':
    main()
