"""Real Lieder melodies (OpenScore Lieder, voice line) accompanied by v3.1 (best of 8, clash penalty 4), by AMT with an
intro bar, and compared with the real piano. Metrics are chord-label free except chord fit (ChordTracker chords)."""
import sys, json, random, time, argparse
from fractions import Fraction as F
sys.path.insert(0, '/tmp/w/scripts'); sys.path.insert(0, '/tmp/amt/source')
import torch
import eval_four_pillar_v31_tasks as E
import amt_accompany as A
from four_pillar_v31_tasks import Lock, TaskComposer
from four_pillar_v31_tonal import analyze, key_parts
from four_pillar_v31_sample import load
from anticipation.config import TIME_RESOLUTION
from transformers import AutoModelForCausalLM

NB = 8
def pick(corpus, n, seed):
    rng = random.Random(seed); rows = corpus.rows('Lieder'); rng.shuffle(rows); out = []
    for sid, nbars in rows:
        if len(out) >= n: break
        if nbars < NB + 4: continue
        score = corpus.score(sid)
        voice = [x for x in score.events if x.group is None and x.pitch is not None and not x.grace]
        piano = [x for x in score.events if x.group == 'keys' and x.pitch is not None and not x.grace]
        if len(voice) < 40 or len(piano) < 40: continue
        # first window of NB bars with >= 14 voice notes, all 4/4 or 3/4 and no meter change
        for b0 in range(0, len(score.measures) - NB):
            ms = score.measures[b0:b0 + NB]
            if any(not m.meter for m in ms) or len({tuple(m.meter) for m in ms}) != 1 or tuple(ms[0].meter) not in ((4, 4), (3, 4)): continue
            if sum(b0 <= x.bar < b0 + NB for x in voice) >= 14 and sum(b0 <= x.bar < b0 + NB for x in piano) >= 20: break
        else: continue
        out.append((sid, score, b0)); 
    return out

def window(score, b0):
    ms = score.measures[b0:b0 + NB]; meter = tuple(ms[0].meter); blen = F(4 * meter[0], meter[1]); t0 = ms[0].onset
    def sel(g): return [(F(x.onset - t0), x.pitch, F(x.duration)) for x in score.events if x.pitch is not None and not x.grace
                        and ((x.group is None) if g == 'voice' else (x.group == 'keys')) and b0 <= x.bar < b0 + NB]
    return sel('voice'), sel('piano'), blen, meter

def metrics(voice, acc, blen, chords_at):
    """acc: (onset, end, pitch). chords_at(t) -> set of pitch classes or None."""
    clash = dbl = uni = fit = tot = 0
    for o, p, d in voice:
        s = [q for a, e, q in acc if a <= o < e]
        clash += any((q - p) % 12 in (1, 11) for q in s); dbl += any((q - p) % 12 == 0 for q in s); uni += p in s
    n = len(voice)
    for b in range(NB):
        for beat in range(int(blen) if blen == int(blen) else 0):
            if beat % 2: continue
            t = b * blen + beat; tones = chords_at(t)
            if tones is None: continue
            for a, e, q in acc:
                if a <= t < e: tot += 1; fit += q % 12 in tones
    return dict(clash=clash / n, doubled=dbl / n, unison=uni / n, fit=fit / max(1, tot), nbar=len(acc) / NB,
                grid=sum(abs(a * 4 - round(a * 4)) < .12 for a, _, _ in acc) / max(1, len(acc)))

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--n', type=int, default=12); ap.add_argument('--out'); ap.add_argument('--seed', type=int, default=3)
    ap.add_argument('--skip', default=''); a = ap.parse_args()
    torch.set_num_threads(2)
    corpus = E.Corpus(); pieces = pick(corpus, a.n, a.seed)
    amt = AutoModelForCausalLM.from_pretrained('/tmp/amt/m').eval()
    v31, vocab, _ = load('/tmp/w/runs/four-pillar-v31-ready-20261001/weights.pt')
    res = {}
    for sid, score, b0 in pieces:
        voice, piano, blen, meter = window(score, b0)
        an = analyze(score, 'Lieder', first=b0, last=b0 + NB - 1)
        keys = an['keys']; tonic, mode = key_parts(keys[b0]); key = (tonic, 0 if mode == 0 else 1)
        spans = sorted((float(score.measures[bar].onset - score.measures[b0].onset) + float(o), r, qy)
                       for bar, ch in an['chords'].items() if b0 <= bar < b0 + NB for o, r, qy in ch)
        def chords_at(t, spans=spans):
            c = [s for s in spans if s[0] <= float(t) + 1e-6]
            return E.chord_tones(c[-1][1], c[-1][2]) if c else None
        row = {'sid': sid, 'bar0': b0, 'meter': meter, 'key': key, 'voiceNotes': len(voice)}
        row['real piano'] = metrics(voice, [(o, o + d, p) for o, p, d in piano], blen, chords_at)
        total_q = float(blen) * NB
        # AMT: voice as flute control; one bar of tonic chords as prompt (as in the 3-tune test)
        t1 = time.time(); g = torch.Generator().manual_seed(a.seed)
        lead = float(blen)
        ctrl = []
        for o, p, d in voice:
            t = 6 + A.ticks(lead + float(o)); dur = max(1, A.ticks(float(d)) - 2)
            ctrl += [A.CONTROL_OFFSET + A.TIME_OFFSET + t, A.CONTROL_OFFSET + A.DUR_OFFSET + dur, A.CONTROL_OFFSET + A.NOTE_OFFSET + A.MEL_INSTR * 128 + p]
        prompt = A.intro_prompt(key)
        notes, _ = A.generate(amt, (lead + total_q) * A.SPB + .06, ctrl, .95, True, g, prompt, lead)
        accn = [(o, o + d, p) for o, d, p, i in notes if o >= 0]
        row['AMT intro'] = metrics(voice, accn, blen, chords_at) | {'seconds': round(time.time() - t1)}
        for name, k, pen in (('v3.1 k1', 1, 0.), ('v3.1 k8 pen4', 8, 4.)):
            t1 = time.time(); comp = TaskComposer(v31, vocab, seed=a.seed, key=key); acc31 = []
            for b in range(NB):
                locks = [Lock(onset=o - b * blen, pitch=p, duration=d, group=6, identity=('voice', '1', '1'), dynamic=0)
                         for o, p, d in voice if b * blen <= o < (b + 1) * blen]
                kw = dict(length=blen, meter=meter, groups=('keys',), locks=locks, temperature=.9, top_p=.95, tempo=92.)
                bar = comp.best_of(k, clash_penalty=pen, **kw) if k > 1 else comp.next_bar_locked(**kw)
                for n in bar['notes']:
                    if not n.get('locked') and n['pitch'] is not None:
                        o = b * blen + F(n['onset']); acc31.append((o, o + F(n['duration']), n['pitch']))
            row[name] = metrics(voice, acc31, blen, chords_at) | {'seconds': round(time.time() - t1)}
        res[f'{sid}'] = row | {'amtNotes': notes}
        print(sid, {k: {m: round(v, 2) for m, v in row[k].items()} for k in ('real piano', 'AMT intro', 'v3.1 k1', 'v3.1 k8 pen4')}, flush=True)
        json.dump(res, open(a.out, 'w'), default=str)
