#!/usr/bin/env python3
"""Generate orchestral music with the Cantelvio Compose orchestral model and write a MIDI file.

Instrument groups: woodwinds brass percussion keys high_strings low_strings. For each group
say 'on' (available, not guaranteed to sound), 'off' (silent) or 'auto' (the model decides, bar by bar). A plan
file can change this per section:
  [{"from": 1, "to": 8, "groups": {"high_strings": "on", "brass": "off"}}, {"from": 9, "to": 32, "groups": {}}]
Whether something happens (a new bar, a note's position, which group) is sampled from the
model as it is; the temperature and top-p only act on pitch, duration and velocity.

  python training/orchestra/sample.py <run>/best.pt out.mid --bars 32 --tempo 96 --meter 4/4 \
      --groups brass=off,percussion=auto --temperature 0.9 --seed 1
"""
import argparse, json, sys, time
from pathlib import Path
import numpy as np
import torch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import groups as G
from model import OrchestraTransformer
from data import FIELDS

MAX_NOTES_PER_BAR = 256   # guard against a runaway bar


def load(path, device):
    ck = torch.load(path, map_location='cpu', weights_only=False)
    m = OrchestraTransformer(**ck['config']); m.load_state_dict(ck['state_dict'])
    return m.to(device).eval()


def sample_from(logits, allowed, temperature, top_p, rng):
    lg = logits.double().cpu().numpy()
    lg = np.where(allowed, lg / max(1e-3, temperature), -np.inf)
    if not np.isfinite(lg).any():
        return int(np.argmax(allowed))
    p = np.exp(lg - lg.max()); p /= p.sum()
    order = np.argsort(-p, kind='stable'); c = np.cumsum(p[order])
    keep = order[:int(np.searchsorted(c, top_p)) + 1] if top_p < 1 else order[p[order] > 0]
    q = p[keep] / p[keep].sum()
    return int(keep[rng.choice(len(keep), p=q)])


class Generator:
    def __init__(self, model, device, max_len, rng, temperature=0.9, top_p=0.95):
        self.m, self.dev, self.max_len, self.rng = model, device, max_len, rng
        self.T, self.top_p = temperature, top_p
        self.tokens = []            # dicts: type, meter, tempo, prog, mask, pos, group, pitch (abs or None), drum, dur, vel, t
        self.bar_len = []

    # ---------------------------------------------------------------- window encoding (as in data.py)
    def window(self):
        toks = self.tokens
        if len(toks) > self.max_len:   # restart the window at a bar line, keeping about 3/4 of the context
            start = len(toks) - (3 * self.max_len) // 4
            while start < len(toks) and toks[start]['type'] != G.BAR:
                start += 1
            if start == len(toks):     # no bar line in that part: start at the current bar
                start = max(i for i, x in enumerate(toks) if x['type'] == G.BAR)
            toks = toks[start:]
            if len(toks) > self.max_len:   # one bar longer than the window: keep its bar line and the latest notes
                toks = toks[:1] + toks[-(self.max_len - 1):]
            self.tokens = toks
        L = len(toks)
        b = {f: np.zeros((1, L), np.int64) for f in FIELDS}
        t = np.zeros((1, L), np.float32)
        t0 = toks[0]['t']; prev = G.ANCHOR
        for i, x in enumerate(toks):
            b['type'][0, i] = x['type']; t[0, i] = x['t'] - t0
            if x['type'] == G.BAR:
                for f in ('meter', 'tempo', 'prog', 'mask'):
                    b[f][0, i] = x[f]
            elif x['type'] == G.NOTE:
                for f in ('pos', 'group', 'dur', 'vel'):
                    b[f][0, i] = x[f]
                if x['drum']:
                    b['pitchf'][0, i] = G.N_INTERVAL + x['pitch']; b['pabs'][0, i] = 128 + x['pitch']
                else:
                    b['pitchf'][0, i] = int(np.clip(x['pitch'] - prev, -G.MAX_INTERVAL, G.MAX_INTERVAL)) + G.MAX_INTERVAL
                    b['pabs'][0, i] = x['pitch']; prev = x['pitch']
            b['pi'][0, i] = prev
            b['next_prog'][0, i] = x.get('next_prog', 0)
        out = {k: torch.as_tensor(v, device=self.dev) for k, v in b.items()}
        out['t'] = torch.as_tensor(t, device=self.dev)
        return out, prev

    @torch.no_grad()
    def step(self, next_prog, bar_groups, meter_fixed, tempo_fixed, can_end):
        """Sample one token and append it. Returns its type."""
        m = self.m
        for x in self.tokens[-1:]:
            x['next_prog'] = next_prog
        b, ref = self.window()
        h = m.hidden(b)[0, -1]
        cur = next(x for x in reversed(self.tokens) if x['type'] == G.BAR)
        allowed = np.zeros(G.N_TYPE, bool); allowed[[G.BAR, G.NOTE]] = True; allowed[G.EOS] = can_end
        mask = cur['mask']
        notes_in_bar = [x for x in self.tokens[self.tokens.index(cur):] if x['type'] == G.NOTE]
        last_pos = notes_in_bar[-1]['pos'] if notes_in_bar else 0
        L = self.bar_len[-1]
        if mask == 0 or last_pos >= L or len(notes_in_bar) >= MAX_NOTES_PER_BAR:
            allowed[G.NOTE] = False
        ty = sample_from(m.h_type(h), allowed, 1.0, 1.0, self.rng)
        if ty == G.EOS:
            self.tokens.append({'type': G.EOS, 't': cur['t'] + L / G.GRID}); return ty
        if ty == G.BAR:
            hb = h + m.c_type.weight[G.BAR] + m.c_prog.weight[next_prog]
            allowed_m = np.ones(G.N_METER, bool)
            meter = meter_fixed if meter_fixed is not None else sample_from(m.h_meter(hb), allowed_m, 1.0, 1.0, self.rng)
            hb = hb + m.c_meter.weight[meter]
            tempo = tempo_fixed if tempo_fixed is not None else sample_from(m.h_tempo(hb), np.ones(G.N_TEMPO, bool), 1.0, 1.0, self.rng)
            hb = hb + m.c_tempo.weight[tempo]
            bits = 0
            for g in range(G.N_GROUPS):
                want = bar_groups[g]
                bit = 1 if want == 'on' else 0 if want == 'off' else sample_from(m.h_bits[g](hb), np.ones(2, bool), 1.0, 1.0, self.rng)
                bits |= bit << g
                hb = hb + m.c_bits[g][bit]
            num, den = G.METERS[meter] if meter < len(G.METERS) else (4, 4)
            self.tokens.append({'type': G.BAR, 'meter': meter, 'tempo': tempo, 'prog': next_prog, 'mask': bits,
                                't': cur['t'] + L / G.GRID})
            self.bar_len.append(G.bar_steps(num, den))
            return ty
        hn = h + m.c_type.weight[G.NOTE]
        allowed_p = np.zeros(G.MAX_BAR, bool); allowed_p[last_pos:L] = True
        pos = sample_from(m.h_pos(hn), allowed_p, 1.0, 1.0, self.rng); hn = hn + m.c_pos.weight[pos]
        allowed_g = np.array([(mask >> g) & 1 == 1 for g in range(G.N_GROUPS)])
        group = sample_from(m.h_group(hn), allowed_g, 1.0, 1.0, self.rng); hn = hn + m.c_group.weight[group]
        n_pf = m.c_pitch.num_embeddings
        allowed_pf = np.zeros(n_pf, bool)
        if m.rotary_pitch:
            iv = np.arange(G.N_INTERVAL) - G.MAX_INTERVAL
            allowed_pf[:G.N_INTERVAL] = (ref + iv >= G.PITCH_LO) & (ref + iv <= G.PITCH_HI)
            if group == G.PERC:
                allowed_pf[G.N_INTERVAL:] = True
        else:
            allowed_pf[G.PITCH_LO:G.PITCH_HI + 1] = True
            if group == G.PERC:
                allowed_pf[128:] = True
        pf = sample_from(m.h_pitch(hn), allowed_pf, self.T, self.top_p, self.rng); hn = hn + m.c_pitch.weight[pf]
        if m.rotary_pitch:
            drum = pf >= G.N_INTERVAL; pitch = pf - G.N_INTERVAL if drum else ref + pf - G.MAX_INTERVAL
        else:
            drum = pf >= 128; pitch = pf - 128 if drum else pf
        dur = sample_from(m.h_dur(hn), np.ones(G.N_DUR, bool), self.T, self.top_p, self.rng); hn = hn + m.c_dur.weight[dur]
        vel = sample_from(m.h_vel(hn), np.ones(G.N_VEL, bool), self.T, self.top_p, self.rng)
        self.tokens.append({'type': G.NOTE, 'pos': pos, 'group': group, 'pitch': int(pitch), 'drum': bool(drum),
                            'dur': dur, 'vel': vel, 't': cur['t'] + pos / G.GRID})
        return ty


def write_midi(notes, bars, path):
    """notes: (onset_quarters, dur_quarters, group, pitch, drum, velocity); bars: (t, meter, tempo)."""
    from symusic import Score, Track, Note, Tempo, TimeSignature
    tpq = 480
    s = Score(tpq)
    last = None
    for t, meter, tempo in bars:
        num, den = G.METERS[meter] if meter < len(G.METERS) else (4, 4)
        if last is None or last[0] != (num, den):
            s.time_signatures.append(TimeSignature(int(round(t * tpq)), num, den))
        if last is None or last[1] != tempo:
            s.tempos.append(Tempo(int(round(t * tpq)), float(G.tempo_of_bucket(tempo))))
        last = ((num, den), tempo)
    tracks = {}
    for on, du, g, pitch, drum, vel in notes:
        key = ('drums', 0, True) if drum else (G.GROUPS[g], G.playback_program(g, pitch), False)
        if key not in tracks:
            tracks[key] = Track(f'{key[0]} {key[1]}' if not drum else 'percussion (kit)', key[1], key[2])
        midi_pitch = G.drum_note(pitch) if drum else pitch
        tracks[key].notes.append(Note(int(round(on * tpq)), max(1, int(round(du * tpq))), int(midi_pitch), int(vel)))
    for tr in tracks.values():
        tr.notes.sort(key=lambda n: (n.time, n.pitch)); s.tracks.append(tr)
    s.dump_midi(str(path))


def parse_groups(spec):
    out = {}
    for part in filter(None, (spec or '').split(',')):
        k, v = part.split('='); assert k in G.GROUPS and v in ('on', 'off', 'auto'), part
        out[k] = v
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('checkpoint', type=Path); ap.add_argument('out', type=Path)
    ap.add_argument('--bars', type=int, default=32); ap.add_argument('--meter', default='4/4')
    ap.add_argument('--tempo', type=float, default=None, help='BPM (quarter notes); default: the model decides')
    ap.add_argument('--groups', default='', help='e.g. brass=off,high_strings=on (others auto)')
    ap.add_argument('--plan', type=Path, help='JSON list of sections with group settings')
    ap.add_argument('--temperature', type=float, default=0.9); ap.add_argument('--top-p', type=float, default=0.95)
    ap.add_argument('--max-len', type=int, default=None); ap.add_argument('--seed', type=int, default=1)
    ap.add_argument('--device', default='cpu')
    ap.add_argument('--events-json', type=Path, help='also write the generated score events for the local preview page')
    a = ap.parse_args(); t0 = time.time()
    dev = torch.device(a.device)
    model = load(a.checkpoint, dev)
    ck_cfg = json.loads((a.checkpoint.parent / 'config.json').read_text()) if (a.checkpoint.parent / 'config.json').exists() else {}
    max_len = a.max_len or ck_cfg.get('train', {}).get('max_len', 1024)
    rng = np.random.default_rng(a.seed); torch.manual_seed(a.seed)
    base = {g: 'auto' for g in G.GROUPS}; base.update(parse_groups(a.groups))
    plan = json.loads(a.plan.read_text()) if a.plan else []

    def groups_for(bar):   # 1-based bar number
        g = dict(base)
        for sec in plan:
            if sec['from'] <= bar <= sec['to']:
                g.update(sec.get('groups', {}))
        return [g[name] for name in G.GROUPS]

    num, den = (int(x) for x in a.meter.split('/'))
    meter = G.meter_index(num, den)
    tempo = G.tempo_bucket(a.tempo) if a.tempo else None
    gen = Generator(model, dev, max_len, rng, a.temperature, a.top_p)
    first = groups_for(1)
    mask = sum(1 << i for i, v in enumerate(first) if v == 'on' or (v == 'auto' and G.GROUPS[i] in ('high_strings', 'low_strings')))
    gen.tokens.append({'type': G.BAR, 'meter': meter, 'tempo': tempo if tempo is not None else G.tempo_bucket(96),
                       'prog': 0, 'mask': mask, 't': 0.0})
    gen.bar_len.append(G.bar_steps(num, den))
    history_notes, history_bars = [], [(0.0, meter, gen.tokens[0]['tempo'])]
    bars_done, steps = 1, 0
    while True:
        next_bar = bars_done + 1
        can_end = bars_done >= a.bars
        ty = gen.step(min(G.N_PROG - 1, (G.N_PROG * bars_done) // a.bars), groups_for(next_bar), meter, tempo, can_end)
        steps += 1
        x = gen.tokens[-1]
        if ty == G.EOS:
            break
        if ty == G.BAR:
            if bars_done >= a.bars:
                gen.tokens.pop(); break
            bars_done += 1; history_bars.append((x['t'], x['meter'], x['tempo']))
        else:
            history_notes.append((x['t'], G.DURATIONS[x['dur']] / G.GRID, x['group'], x['pitch'], x['drum'], G.vel_of_bucket(x['vel'])))
        if steps > (MAX_NOTES_PER_BAR + 2) * a.bars + 10:   # safety net
            break
    write_midi(history_notes, history_bars, a.out)
    if a.events_json:
        bar_events = []
        for t, meter_id, tempo_id in history_bars:
            bar_num, bar_den = G.METERS[meter_id] if meter_id < len(G.METERS) else (4, 4)
            bar_events.append({'quarter': t, 'meter': f'{bar_num}/{bar_den}',
                               'bpm': round(G.tempo_of_bucket(tempo_id), 3)})
        last_num, last_den = (int(x) for x in bar_events[-1]['meter'].split('/'))
        total_quarters = bar_events[-1]['quarter'] + last_num * 4 / last_den
        events = {
            'format': 'ailegro-orchestra-preview-v1', 'seed': a.seed, 'bars': bars_done,
            'totalQuarters': total_quarters, 'barEvents': bar_events,
            'notes': [{'quarter': on, 'duration': du, 'group': G.GROUPS[g],
                       'pitch': G.drum_note(pitch) if drum else pitch, 'drum': drum, 'velocity': vel}
                      for on, du, g, pitch, drum, vel in history_notes],
        }
        a.events_json.write_text(json.dumps(events, separators=(',', ':')))
    counts = np.bincount([n[2] for n in history_notes], minlength=G.N_GROUPS).tolist() if history_notes else [0] * 6
    print(json.dumps({'out': str(a.out), 'bars': bars_done, 'notes': len(history_notes), 'tokens': steps,
                      'groups': dict(zip(G.GROUPS, counts)), 'seconds': round(time.time() - t0, 1)}))


if __name__ == '__main__':
    main()
