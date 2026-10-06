#!/usr/bin/env python3
"""Curves of the 12-TET symmetry experiment: validation loss per step, and how much worse each
model does when the validation windows are transposed (+5 and -4 semitones).

  python training/orchestra/plot_ablation.py work/runs ablation-curves.png
"""
import json, sys
from pathlib import Path
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt

INK, INK2, MUTED, GRID, AXIS, SURFACE = '#0b0b0b', '#52514e', '#898781', '#e1e0d9', '#c3c2b7', '#fcfcfb'
BLUE, ORANGE, AQUA = '#2a78d6', '#eb6834', '#1baf7a'
SERIES = [('abl-rotary-aug', '音高旋转 + 音区 + 移调增强', BLUE, '-'),
          ('abl-rotary', '音高旋转 + 音区', BLUE, (0, (4, 3))),
          ('abl-rotary-exact-aug', '严格等变（无音区）+ 移调增强', AQUA, '-'),
          ('abl-absolute', '绝对音高', ORANGE, '-'),
          ('abl-absolute-aug', '绝对音高 + 移调增强', ORANGE, (0, (4, 3)))]
from matplotlib import font_manager
_have = {f.name for f in font_manager.fontManager.ttflist}
CJK = [f for f in ('PingFang SC', 'Hiragino Sans GB', 'Heiti SC', 'Noto Sans CJK JP', 'Noto Sans CJK SC') if f in _have][:1]
plt.rcParams.update({'font.family': CJK + ['DejaVu Sans'], 'font.size': 10,
                     'axes.edgecolor': AXIS, 'axes.labelcolor': INK2, 'xtick.color': MUTED, 'ytick.color': MUTED,
                     'axes.facecolor': SURFACE, 'figure.facecolor': SURFACE, 'savefig.facecolor': SURFACE})


def evals(run, name):
    rows = [json.loads(l) for l in (run / name / 'log.jsonl').read_text().splitlines() if l.strip()]
    return [(r['step'], r['eval']) for r in rows if 'eval' in r]


def style(ax):
    ax.grid(True, color=GRID, linewidth=1); ax.set_axisbelow(True)
    for side in ('top', 'right'):
        ax.spines[side].set_visible(False)
    ax.tick_params(length=0)


def main():
    run, out = Path(sys.argv[1]), Path(sys.argv[2])
    fig, axes = plt.subplots(1, 2, figsize=(12, 4.6))
    ends = []
    for name, label, color, ls in SERIES:
        ev = evals(run, name)
        steps = [s for s, _ in ev]
        val = [e['val']['nll'] for _, e in ev]
        gap = [(e['val+5']['nll'] + e['val-4']['nll']) / 2 - e['val']['nll'] for _, e in ev]
        for ax, ys in ((axes[0], val), (axes[1], gap)):
            ax.plot(steps, ys, color=color, linestyle=ls, linewidth=2, label=label, zorder=3)
            ax.scatter(steps[-1:], ys[-1:], s=48, color=color, edgecolors=SURFACE, linewidths=2, zorder=4)
        ends.append((steps[-1], val[-1]))
    for ax in axes:
        style(ax); ax.set_xlabel('训练步数（batch = 16 × 1,024 token）')
    axes[0].set_ylabel('验证集损失（每个 token 各字段负对数似然之和）')
    axes[0].set_ylim(1.6, 4.4)
    axes[1].set_ylabel('移调后损失增加（+5 与 −4 半音的平均）')
    axes[1].axhline(0, color=AXIS, linewidth=1)
    # value labels at the end of the loss curves, nudged apart
    fig.canvas.draw()
    placed = []
    for x, y in sorted(ends, key=lambda p: p[1]):
        px, py = axes[0].transData.transform((x, y))
        if placed and py - placed[-1] < 12:
            py = placed[-1] + 12
        placed.append(py)
        axes[0].annotate(f'{y:.3f}', axes[0].transData.inverted().transform((px, py)), xytext=(7, 0),
                         textcoords='offset points', va='center', color=INK2, fontsize=9, annotation_clip=False)
    fig.suptitle('12 平均律对称性对照实验（同一数据、同一 440 万参数模型、各 6,000 步）', x=0.015, ha='left', color=INK, fontsize=13)
    h, l = axes[0].get_legend_handles_labels()
    fig.legend(h, l, loc='upper left', bbox_to_anchor=(0.01, 0.93), ncol=3, frameon=False, labelcolor=INK2, fontsize=9.5, handlelength=2.6)
    fig.tight_layout(rect=(0, 0, 0.975, 0.84), w_pad=3)
    fig.savefig(out, dpi=160)
    print('written', out)


if __name__ == '__main__':
    main()
