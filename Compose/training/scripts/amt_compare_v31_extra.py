import sys, json, time
sys.path.insert(0,'/tmp/amt'); sys.path.insert(0,'/tmp/w/training/scripts')
import torch; torch.set_num_threads(1)
import eval_four_pillar_v31_tasks as E
from amt_accompany import extra_metrics
from pathlib import Path
model, vocab, w = E.load(Path('/tmp/w/training/runs/four-pillar-v31-ready-20261001/weights.pt'))
orig = E.TaskComposer.best_of
out = {}
for name, k, chords, pen in [('v3.1 melody locked', 1, False, 0), ('v3.1 best of 8', 8, False, 0),
                             ('v3.1 best of 8, clash penalty 4', 8, False, 4), ('v3.1 best of 32, clash penalty 4', 32, False, 4),
                             ('v3.1 + human chords, best of 8', 8, True, 0)]:
    E.TaskComposer.best_of = lambda self, c, _p=pen, **kw: orig(self, c, clash_penalty=_p, **kw)
    rows = []
    for tune in E.TUNES:
        for seed in range(1, 5):
            bars, logp = E.accompany(model, vocab, tune, seed, k, chords)
            r = dict(E.melody_metrics(E.TUNES[tune][0], bars)); r.update(extra_metrics(tune, bars)); rows.append(r)
    out[name] = {m: round(sum(x[m] for x in rows) / len(rows), 4) for m in rows[0]}
    print(name, out[name], flush=True)
json.dump(out, open('/tmp/amt/out/v31-extra.json', 'w'), indent=1)
