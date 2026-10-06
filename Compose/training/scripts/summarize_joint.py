#!/usr/bin/env python3
"""Markdown tables for REPORT.md from a joint run directory.

Reads <run>/evaluation.json, <run>/<model>/training.json and <run>/benchmark.json.
"""
import json, sys
from pathlib import Path

LABEL = {'structured': '结构化四轨模型', 'flat-compute': '通用·同等计算量', 'flat-params': '通用·同等参数量',
         'flat-compute-basic': '消融：通用·同等计算量·无位置控制'}
ORDER = ['structured', 'flat-params', 'flat-compute', 'flat-compute-basic']
THRESHOLDS = [2.0, 1.9, 1.8, 1.75]


def main():
    run = Path(sys.argv[1])
    ev = json.loads((run / 'evaluation.json').read_text())['models']
    bench = {k: v for k, v in json.loads((run / 'benchmark.json').read_text()).items() if not k.startswith('_')} if (run / 'benchmark.json').exists() else {}
    tr = {m: json.loads((run / m / 'training.json').read_text()) for m in ORDER if (run / m / 'training.json').exists()}
    models = [m for m in ORDER if m in ev]
    print('| 模型 | 参数 | 每步耗时 | 选中步 | 验证 R | 验证 H | 验证 B | 验证 M | 验证加权 | 测试加权 |')
    print('|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|')
    for m in models:
        v, t = ev[m]['validation'], ev[m]['test']
        print(f"| {LABEL[m]} | {ev[m]['parameters'] / 1e6:.2f}M | {bench.get(m, float('nan')):.2f}s | {tr[m]['selectedStep'] if m in tr else '-'} | "
              f"{v['R']:.3f} | {v['H']:.3f} | {v['B']:.3f} | {v['M']:.3f} | **{v['weighted']:.3f}** | {t['weighted']:.3f} |")
    print()
    # learning speed
    steps = [1000, 1600, 2400, 3200]
    print('| 模型 | ' + ' | '.join(f'第 {s} 步' for s in steps) + ' |')
    print('|---|' + '---:|' * len(steps))
    curves = {m: {r['step']: r['lieder']['weighted'] for r in tr[m]['curve'] if r['step'] > 0} for m in models if m in tr}
    for m in models:
        if m in curves:
            print(f'| {LABEL[m]} | ' + ' | '.join(f"{curves[m].get(s, float('nan')):.3f}" for s in steps) + ' |')
    print()
    # steps (and minutes, from the isolated benchmark) until the validation loss first reaches a level
    print('| 模型 | ' + ' | '.join(f'≤ {x:.2f}' for x in THRESHOLDS) + ' |')
    print('|---|' + '---:|' * len(THRESHOLDS))
    for m in models:
        if m not in curves:
            continue
        cells = []
        for x in THRESHOLDS:
            st = next((k for k in sorted(curves[m]) if k > 800 and curves[m][k] <= x), None)
            cells.append('—' if st is None else (f'{st:,} 步（{st * bench[m] / 60:.0f} 分钟）' if m in bench else f'{st:,} 步'))
        print(f'| {LABEL[m]} | ' + ' | '.join(cells) + ' |')
    print()
    if 'structured' in curves:
        s_curve = sorted(curves['structured'].items())
        for m in models:
            if m == 'structured' or m not in curves:
                continue
            best = min(curves[m].values())
            reach = next((st for st, v in s_curve if v <= best and st > 800), None)
            if reach:
                best_step = min(curves[m], key=lambda k: curves[m][k])
                timing = ''
                if m in bench and 'structured' in bench:
                    timing = f"，按单独基准的每步耗时约 {reach * bench['structured'] / 60:.1f} 分钟 vs {best_step * bench[m] / 60:.1f} 分钟"
                print(f"- {LABEL[m]} 的最好验证损失 {best:.3f}（第 {best_step} 步）；结构化模型在第 {reach} 步就达到这个水平"
                      f"（步数约为其 1/{best_step / reach:.1f}{timing}）")
            else:
                print(f"- {LABEL[m]} 的最好验证损失 {best:.3f}，结构化模型在记录的检查点中没有更早达到（看曲线）")
    print()
    print('| 模型 | 旋律 CE（v5 同事件） | 旋律 top-1 | 和声 CE（v2 同换和弦点） | 和声 top-1 | 和声 CE·只知当前调 | 和声 top-1·只知当前调 |')
    print('|---|---:|---:|---:|---:|---:|---:|')
    any_m = ev[models[0]]
    mv, hv, hl = any_m['melodyVsV5']['v5'], any_m['harmonyVsV2']['v2'], any_m['harmonyVsV2_keyLagged']['v2']
    print(f"| 现有 Melody v5 / Harmony v2 | {mv['pitchCE']:.3f} | {mv['top1']:.1%} | {hv['nextChordCE']:.3f} | {hv['top1']:.1%} | {hl['nextChordCE']:.3f} | {hl['top1']:.1%} |")
    for m in models:
        e = ev[m]; mj, hj, hk = e['melodyVsV5']['joint'], e['harmonyVsV2']['joint'], e['harmonyVsV2_keyLagged']['joint']
        print(f"| {LABEL[m]} | {mj['pitchCE']:.3f} | {mj['top1']:.1%} | {hj['nextChordCE']:.3f} | {hj['top1']:.1%} | {hk['nextChordCE']:.3f} | {hk['top1']:.1%} |")
    print(f"\n旋律事件 {mv['events']} 个（{any_m['melodyVsV5']['windows']} 个窗口），换和弦 {hv['changes']} 次。")


if __name__ == '__main__':
    main()
