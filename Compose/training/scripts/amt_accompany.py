"""AMT (music-medium-800k) accompanies the three eval tunes; same metrics as the v3.1 accompany section,
plus accompaniment chord fit against the human chords and rhythmic grid alignment. KV-cached sampling that
reproduces anticipation.sample.generate (offset stays 0: a REST at time 0 anchors the sequence)."""
import sys, json, math, time, argparse
from fractions import Fraction as F
sys.path.insert(0, '/tmp/amt/source'); sys.path.insert(0, '/tmp/w/training/scripts')
import torch, torch.nn.functional as Fn
from transformers import AutoModelForCausalLM
from anticipation import ops
from anticipation.config import *
from anticipation.vocab import *
from anticipation.sample import safe_logits, nucleus, future_logits, instr_logits
import eval_four_pillar_v31_tasks as E

BPM = 92.; SPB = 60. / BPM
MEL_INSTR = 73   # flute carries the given melody (a voice-like solo line in GM)

def ticks(beats): return int(round(beats * SPB * TIME_RESOLUTION))

def melody_controls(melody, shift=6, lead=0):
    out = []
    for b, bar in enumerate(melody):
        for o, p, d in bar:
            t = shift + ticks(lead + 4 * b + float(o)); dur = max(1, ticks(float(d)) - 2)
            out += [CONTROL_OFFSET + TIME_OFFSET + t, CONTROL_OFFSET + DUR_OFFSET + dur,
                    CONTROL_OFFSET + NOTE_OFFSET + MEL_INSTR * 128 + p]
    return out

class Cached:
    """KV cache over z + relativized history. When the history would exceed the model's window, it keeps the
    last ~half (official sampling slides the window by one event at every step; we slide in chunks)."""
    def __init__(self, model, z): self.m, self.z, self.past, self.fed, self.base, self.offset = model, z, None, 0, 0, 0
    def view(self, tokens):
        if len(tokens) - self.base > 1017 - 6:
            self.base = len(tokens) - 510; self.base -= self.base % 3
            self.past, self.fed = None, 0
            self.offset = ops.min_time(tokens[self.base:], seconds=False)
        h = tokens[self.base:]
        return self.z + [t - self.offset if i % 3 == 0 else t for i, t in enumerate(h)]
    def logits(self, seq):
        new = seq[self.fed:]
        x = torch.tensor(new).unsqueeze(0)
        with torch.no_grad():
            o = self.m(x, past_key_values=self.past, use_cache=True)
        self.past, self.fed = o.past_key_values, len(seq)
        return o.logits[0, -1].clone()

def generate(model, end_time, controls, top_p, piano_only, rng, prompt=(), lead=0):
    end = int(TIME_RESOLUTION * end_time)
    z = [ANTICIPATE]
    tokens = [TIME_OFFSET + 0, DUR_OFFSET + 0, REST] + list(prompt)
    controls = ops.sort(controls)
    atime, adur, anote = controls[0:3]; rest = controls[3:]; at = atime - ATIME_OFFSET
    cur, delta = ops.max_time(tokens, seconds=False), DELTA * TIME_RESOLUTION
    cache = Cached(model, z)
    while True:
        while cur >= at - delta:
            tokens += [atime, adur, anote]
            if rest: atime, adur, anote = rest[0:3]; rest = rest[3:]; at = atime - ATIME_OFFSET
            else: at = math.inf
        new = []
        prefix = cache.view(tokens)
        for i in range(3):
            seq = prefix + new
            lg = safe_logits(cache.logits(seq), len(seq) - 1)
            if i == 0: lg = future_logits(lg, cur - cache.offset)
            elif i == 2:
                lg = instr_logits(lg, tokens)
                if piano_only:
                    keep = lg[NOTE_OFFSET:NOTE_OFFSET + 128].clone(); r = lg[REST].clone()
                    lg[NOTE_OFFSET:NOTE_OFFSET + MAX_NOTE] = -float('inf'); lg[NOTE_OFFSET:NOTE_OFFSET + 128] = keep
                    lg[REST] = r
                else:
                    lg[NOTE_OFFSET + MEL_INSTR * 128:NOTE_OFFSET + (MEL_INSTR + 1) * 128] = -float('inf')
            lg = nucleus(lg, top_p)
            new.append(int(torch.multinomial(Fn.softmax(lg, -1), 1, generator=rng)))
        new[0] += cache.offset
        t = new[0] - TIME_OFFSET
        if t >= end: break
        tokens += new; cur = t
    events, _ = ops.split(tokens)
    events = events[3 + len(prompt):]
    out = []
    for tt, d, n in zip(events[0::3], events[1::3], events[2::3]):
        if n == REST: continue
        n -= NOTE_OFFSET; instr, p = n // 128, n % 128
        if instr == 128: continue          # drums: no pitch
        out.append(((tt - TIME_OFFSET - 6) / TIME_RESOLUTION / SPB - lead, (d - DUR_OFFSET) / TIME_RESOLUTION / SPB, p, instr))
    return out, len(tokens)

def to_bars(notes, nbars):
    bars = [{'notes': [], 'chords': [], 'length': '4'} for _ in range(nbars)]
    for on, du, p, ins in notes:
        b = int(on // 4)
        if 0 <= b < nbars:
            bars[b]['notes'].append({'onset': F(on - 4 * b).limit_denominator(96), 'duration': F(max(du, .05)).limit_denominator(96),
                                     'pitch': p, 'instr': ins})
    return bars

def extra_metrics(tune, bars):
    """accompaniment pitch classes sounding on beats 1 and 3 that are tones of the human chord; onsets on a 16th grid"""
    melody, chords, _ = E.TUNES[tune]
    fit = tot = grid = n = 0
    for b, bar in enumerate(bars):
        acc = [x for x in bar['notes'] if not x.get('locked') and x['pitch'] is not None]
        for x in acc:
            n += 1; q = float(F(x['onset'])) * 4; grid += abs(q - round(q)) < .12
        for beat in (0, 2):
            cur = [c for c in chords[b] if F(c[0]) <= beat][-1]
            tones = E.chord_tones(cur[1], cur[2])
            for x in acc:
                if F(x['onset']) <= beat < F(x['onset']) + F(x['duration']):
                    tot += 1; fit += x['pitch'] % 12 in tones
    return {'accChordFit': fit / max(1, tot), 'onGrid16': grid / max(1, n)}

def intro_prompt(key):
    """one bar of tonic half-note chords (piano, left + right hand) before the melody: a neutral opening"""
    tonic = key[0]; out = []
    for beat in (0, 2):
        for p in (36 + tonic, 48 + tonic, 52 + tonic, 55 + tonic):
            pp = p if key[1] == 0 or p % 12 != (tonic + 4) % 12 else p - 1
            out += [TIME_OFFSET + 6 + ticks(beat), DUR_OFFSET + ticks(2) - 2, NOTE_OFFSET + pp]
    return ops.sort(out)

if __name__ == '__main__':
    ap = argparse.ArgumentParser(); ap.add_argument('--seeds', type=int, default=4); ap.add_argument('--top-p', type=float, default=.95)
    ap.add_argument('--mode', default='piano'); ap.add_argument('--intro', action='store_true'); ap.add_argument('--retries', type=int, default=0); ap.add_argument('--out', required=True)
    a = ap.parse_args()
    torch.set_num_threads(1)
    model = AutoModelForCausalLM.from_pretrained('/tmp/amt/m').eval()
    rows, results = [], {}
    for tune in E.TUNES:
        melody = E.TUNES[tune][0]; nb = len(melody)
        for seed in range(1, a.seeds + 1):
            t0 = time.time(); g = torch.Generator().manual_seed(seed)
            lead = 4 if a.intro else 0
            prompt = intro_prompt(E.TUNES[tune][2]) if a.intro else ()
            for attempt in range(1, a.retries + 2):
                notes, ln = generate(model, ((lead + 4 * nb) * SPB) + .06, melody_controls(melody, lead=lead), a.top_p,
                                     a.mode == 'piano', g, prompt, lead)
                if len([x for x in notes if x[0] >= 0]) >= nb: break
            bars = to_bars(notes, nb)
            r = dict(E.melody_metrics(melody, bars)); r.pop('chordTone'); r.update(extra_metrics(tune, bars))
            r['instruments'] = sorted({x[3] for x in notes}); r['seconds'] = round(time.time() - t0); r['attempts'] = attempt
            rows.append(r); results[f'{tune}-{seed}'] = {'metrics': r, 'notes': notes}
            print(tune, seed, {k: (round(v, 3) if isinstance(v, float) else v) for k, v in r.items()}, 'tokens', ln, flush=True)
    keys = ['clash', 'doubled', 'unison', 'accChordFit', 'onGrid16', 'accompanimentNotesPerBar']
    summary = {k: round(sum(r[k] for r in rows) / len(rows), 4) for k in keys}
    print('SUMMARY', a.mode, summary)
    json.dump({'mode': a.mode, 'intro': a.intro, 'retries': a.retries, 'topP': a.top_p, 'melodyInstrument': MEL_INSTR, 'summary': summary, 'pieces': results},
              open(a.out, 'w'), default=str, indent=1)
