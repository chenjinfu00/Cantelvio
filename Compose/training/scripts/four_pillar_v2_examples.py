"""Auditable long-bar windows, four supplied-material tasks and source sidecars.

Future notes are targets only, except the explicitly selected supplied voice.
No chord/dynamic/tempo labels are inferred here from otherwise unlabelled MIDI.
"""
from __future__ import annotations

import gzip
import json
import math
from bisect import bisect_right
from collections import defaultdict
from dataclasses import replace
from fractions import Fraction
from pathlib import Path

import torch

from four_pillar_codec import (BAR, END_BAR, END_ONSET, GROUPS, ONSET, _Reader,
                               encode_score)
from four_pillar_midi_data import MidiItem
from four_pillar_trial_model import PLAN_BARS, SUMMARY_DIM
from four_pillar_v1_alignment import verified_bar_steps, past_window_before_bar
from four_pillar_v1_codec import causal_teacher_forcing_inputs
from four_pillar_v2_data import add_expression_targets, add_key_direction_targets, add_motif_targets
from joint_data import load_corpus

ROOT = Path(__file__).resolve().parents[1]
LABELS = ROOT / 'data/performance-labels-v1/score-events.jsonl.gz'
JOINT = ROOT / 'data/joint/lieder-joint.npz'
TASKS = ('free', 'given_melody', 'given_chords', 'given_motif')


class UnusableExample(ValueError):
    """Explicit resource/data rejection; caller records it, never hides a bug."""


def bar_chunks(encoded, bar, context):
    """Partition every token, including END_BAR, at complete onset boundaries.

    Prefer half a context of targets, leaving room for actual preceding events.
    A single large onset may use the full context. Oversized onsets reject the
    sample explicitly instead of silently dropping simultaneous instruments.
    """
    start, end = encoded.bar_spans[bar]
    boundaries = [start] + [i + 1 for i in range(start, end)
                           if encoded.tokens[i] in (END_ONSET, END_BAR)]
    chunks = []
    left = start
    for a, b in zip(boundaries, boundaries[1:]):
        if b - a > context:
            raise UnusableExample(f'onset/header needs {b-a} tokens, context is {context}')
        if a > left and b - left > context // 2:
            chunks.append((left, a))
            left = a
    if left < end:
        chunks.append((left, end))
    return chunks


def timeline_features(item, start, stop):
    """Features after each emitted token, including sounding held notes.

    Full-score sidecars locate field boundaries; values become visible only
    when the corresponding causal header/onset/note payload has been emitted.
    """
    encoded = item.encoded
    clocks = {}
    for a, b in encoded.bar_spans:
        reader = _Reader(encoded.tokens)
        reader.i = a + 1
        on, duration = reader.fraction(), reader.fraction()
        reader.uint(); reader.uint()
        clocks[reader.i - 1] = (on, on, duration)
        cursor = on
        for i in range(reader.i, min(b, stop)):
            if encoded.tokens[i] == ONSET:
                reader.i = i + 1
                cursor += reader.fraction()
                clocks[reader.i - 1] = (cursor, on, duration)
    notes = {n.source_index: n for n in item.score.events}
    completed = {b - 1: notes[source] for (a, b), source in
                 zip(encoded.note_spans, encoded.source_indices) if b <= stop}
    active = list(getattr(item, 'carried_notes', ()))
    now = bar_on = Fraction(0)
    duration = Fraction(1)
    result = torch.zeros(1, stop - start, 24)
    for i in range(stop):
        if i in clocks:
            now, bar_on, duration = clocks[i]
        active = [n for n in active if n.end > now]
        if i in completed and completed[i].end > now:
            active.append(completed[i])
        if i < start:
            continue
        row = result[0, i - start]
        pitches = [n.pitch for n in active if n.pitch is not None]
        for pitch in pitches:
            row[pitch % 12] += 1 / len(pitches)
        for n in active:
            if n.group in GROUPS:
                row[12 + GROUPS.index(n.group)] += 1 / max(len(active), 1)
        row[18] = math.log1p(len(active)) / math.log(129)
        row[19] = sum(pitches) / max(len(pitches), 1) / 127
        row[20] = float((now - bar_on) / duration)
        row[21] = math.log1p(float(duration)) / 4
        row[22] = math.log1p(max((float(n.end - now) for n in active), default=0)) / 8
        row[23] = float(bool(active))
    return result


class SourceLabels:
    def __init__(self):
        with gzip.open(LABELS, 'rt') as stream:
            self.performance = {r['scoreId']: r for r in map(json.loads, stream)}
        self.joint = {p['meta']['scoreId']: p for p in load_corpus(JOINT)}
        self.alignment = {}

    def prior(self, full_score, target, shift):
        piece = self.joint.get(full_score.score_id)
        if piece is None or self.alignment.get(full_score.score_id) is None:
            return {}
        arrays = dict(piece['arrays'])
        for name in ('ch_root','key_tonic','bass_pitch','mel_pitch'):
            value = arrays[name].astype('int16').copy()
            known = value >= 0
            value[known] += shift
            if name in ('ch_root','key_tonic'):
                value[known] %= 12
            elif ((value[known] < 0) | (value[known] > 127)).any():
                return {}
            arrays[name] = value
        result = past_window_before_bar(full_score, {'meta':piece['meta'], 'arrays':arrays}, target)
        if result is None:
            return {}
        result.pop('source')
        return result

    def harmony(self, full_score, first, bar, shift):
        piece = self.joint.get(full_score.score_id)
        if piece is None:
            return []
        if full_score.score_id not in self.alignment:
            try:
                self.alignment[full_score.score_id] = verified_bar_steps(full_score, piece)
            except ValueError:
                self.alignment[full_score.score_id] = None
        starts = self.alignment[full_score.score_id]
        if starts is None:
            return []
        rows = []
        for offset in range(min(PLAN_BARS, len(starts) - first - bar)):
            source_bar = first + bar + offset
            a = starts[source_bar]
            b = starts[source_bar + 1] if source_bar + 1 < len(starts) else len(piece['arrays']['bar'])
            previous = None
            for step in range(a, b):
                root, quality = (int(piece['arrays'][name][step]) for name in ('ch_root', 'ch_q'))
                if not (0 <= root < 12 and 0 <= quality < 40):
                    previous = None
                    continue
                pair = ((root + shift) % 12, quality)
                if pair != previous:
                    rows.append((offset, Fraction(step - a, 4), *pair))
                previous = pair
        return rows

    def expression(self, full_score):
        record = self.performance.get(full_score.score_id)
        if record is None:
            return {}, (None,) * len(full_score.measures)
        # These two source XMLs required timeline repairs absent in the older
        # numeric-label extraction. Keep their numeric sidecars unknown.
        if full_score.score_id in ('lc6598318', 'lc5026266'):
            return {}, (None,) * len(full_score.measures)
        tempos, dynamics = defaultdict(set), defaultdict(lambda: defaultdict(set))
        for event in record['events']:
            bar = event['bar']
            if not 0 <= bar < len(full_score.measures):
                raise ValueError('numeric sidecar has a mismatched source bar')
            m = full_score.measures[bar]
            offset = Fraction(event['offsetQuarter'])
            if not 0 <= offset <= m.duration:
                continue
            at = m.onset + offset
            value = float(event['value'])
            if not math.isfinite(value) or value < 0:
                continue
            if event['kind'] == 'tempo-qpm' and value > 0:
                tempos[at].add(value)
            elif event['kind'] == 'sound-dynamics':
                for part in event['parts']:
                    dynamics[part][at].add(value / 100.0)

        def series(mapping):
            times = sorted(mapping)
            # Conflicts invalidate the interval until another unambiguous mark.
            return times, [next(iter(mapping[t])) if len(mapping[t]) == 1 else None for t in times]

        def at(timeline, time):
            times, values = timeline
            index = bisect_right(times, time) - 1
            return values[index] if index >= 0 else None

        tempo_series = series(tempos)
        per_part = {p: series(v) for p, v in dynamics.items()}
        numeric = {n.source_index: value for n in full_score.events
                   if n.part in per_part and (value := at(per_part[n.part], n.onset)) is not None}
        return numeric, tuple(at(tempo_series, m.onset) for m in full_score.measures)


def _tempo_targets(tempos, bar, inputs, targets):
    level = torch.zeros(1, PLAN_BARS)
    level_known = torch.zeros_like(level, dtype=torch.bool)
    delta, change = torch.zeros_like(level), torch.zeros_like(level)
    known = torch.zeros_like(level_known)
    previous = tempos[bar - 1]
    if previous is not None:
        inputs['log_qpm'] = torch.tensor([math.log(previous)])
        inputs['tempo_known'] = torch.tensor([True])
    for i in range(min(PLAN_BARS, len(tempos) - bar)):
        current = tempos[bar + i]
        if current is not None:
            level[0, i], level_known[0, i] = math.log(current), True
        if current is not None and previous is not None:
            delta[0, i] = math.log(current / previous)
            change[0, i], known[0, i] = float(abs(float(delta[0, i])) > 1e-6), True
        previous = current
    targets.update(tempo_level=level, tempo_level_known=level_known,
                   tempo_change=change, tempo_change_known=known,
                   tempo_delta=delta, tempo_delta_known=known)


def make_training_example(item, bar, rng, *, context=2048, history_bars=512, task=None,
                          chunk_index=None, harmony=(), numeric=None, tempos=None):
    if not 1 <= history_bars <= 512:
        raise ValueError("history_bars must be between 1 and 512")
    chunks = bar_chunks(item.encoded, bar, context)
    chunk_index = rng.randrange(len(chunks)) if chunk_index is None else chunk_index
    a, b = chunks[chunk_index]
    # Local autoregression now sees preceding events as well as bar summaries.
    left = max(0, b - context - 1)
    boundaries = [0] + [i for i in range(left, a) if item.encoded.tokens[i] in (END_ONSET, END_BAR)]
    left = next((i for i in boundaries if i >= left), a - 1)
    stop = b - 1
    teacher = causal_teacher_forcing_inputs(item.encoded, start=left, stop=stop)
    history = torch.zeros(1, history_bars, SUMMARY_DIM)
    count = min(history_bars, bar)
    history[0, :count] = torch.from_numpy(item.summaries[bar-count:bar])
    history_known = torch.arange(history_bars)[None] < count
    inputs = {k: teacher[k] for k in ('decoder_input', 'voice_features', 'voice_known', 'voice_pointer_input')}
    inputs.update(history=history, history_known=history_known,
                  material=torch.empty(1, 0, dtype=torch.long),
                  material_known=torch.empty(1, 0, dtype=torch.bool),
                  intent_id=torch.zeros(1, dtype=torch.long),
                  timeline=timeline_features(item, left, stop))
    targets = {k: teacher[k] for k in ('voice_pointer_target', 'voice_pointer_target_known')}
    targets = {'event': teacher['event_target'], 'event_known': teacher['event_known'],
               'voice_pointer': targets['voice_pointer_target'],
               'voice_pointer_known': targets['voice_pointer_target_known']}
    prefix = a - left - 1
    targets['event_known'][:, :prefix] = False
    targets['voice_pointer_known'][:, :prefix] = False
    future = item.summaries[bar:bar+PLAN_BARS]
    summary = torch.zeros(1, PLAN_BARS, SUMMARY_DIM)
    summary[0, :len(future)] = torch.from_numpy(future)
    sk = torch.zeros_like(summary, dtype=torch.bool)
    sk[0, :len(future)] = True
    if isinstance(item, MidiItem):
        for i in range(len(future)):
            if not item.meter_known[bar+i]:
                sk[0, i] = False
    targets.update(form_summary=summary, form_summary_known=sk,
                   form_density=summary[..., 18:19], form_density_known=sk[..., 18:19])
    # Register is an observable min/max pitch, not a fabricated texture label.
    register = torch.zeros(1, PLAN_BARS, 2)
    rk = torch.zeros_like(register, dtype=torch.bool)
    activity = torch.zeros(1, PLAN_BARS, len(GROUPS))
    ak = torch.zeros_like(activity, dtype=torch.bool)
    for i in range(len(future)):
        measure = item.score.measures[bar+i]
        notes = [n for n in (*item.score.events,*getattr(item,'carried_notes',())) if n.onset < measure.onset+measure.duration
                 and n.end > measure.onset]
        pitches = [n.pitch for n in notes if n.pitch is not None]
        if pitches:
            register[0,i] = torch.tensor([min(pitches)/127, max(pitches)/127])
            rk[0,i] = True
        for g, group in enumerate(GROUPS):
            present = any(n.group == group for n in notes)
            activity[0,i,g] = float(present)
            ak[0,i,g] = present or all(n.group is not None for n in notes)
    targets.update(form_register=register, form_register_known=rk,
                   group_activity=activity, group_activity_known=ak)
    add_motif_targets(item, inputs, targets, bar, history_bars=history_bars)
    if 'motif_tokens' in inputs and inputs['motif_tokens'].shape[-1] > context:
        # Small synthetic tests may use contexts shorter than a whole motif.
        inputs.pop('motif_tokens'); inputs.pop('motif_known')
        for name in ('motif_recall', 'motif_pitch_shift', 'motif_log_duration'):
            targets.pop(name, None); targets.pop(name+'_known', None)
    add_key_direction_targets(item.score, targets, bar)
    if isinstance(item, MidiItem):
        add_expression_targets(item, targets, bar)
        tempos = item.bar_tempos
        numeric_values, numeric_name = item.velocities, 'midi_velocity'
        divisor = 127.0
    else:
        numeric_values, numeric_name, divisor = numeric or {}, 'numeric_dynamic', 1.0
    value = torch.zeros_like(targets['event'], dtype=torch.float)
    known = torch.zeros_like(value, dtype=torch.bool)
    for (na, nb), source in zip(item.encoded.note_spans, item.encoded.source_indices):
        position = nb - 1 - left  # predicts expression after complete note payload
        if a <= na and nb <= b and 0 <= position < value.shape[1] and source in numeric_values:
            value[0,position], known[0,position] = numeric_values[source]/divisor, True
    targets[numeric_name], targets[numeric_name+'_known'] = value, known
    if tempos is not None:
        _tempo_targets(tempos, bar, inputs, targets)
    roots, qualities = torch.zeros(1,PLAN_BARS,dtype=torch.long), torch.zeros(1,PLAN_BARS,dtype=torch.long)
    hk = torch.zeros(1,PLAN_BARS,dtype=torch.bool)
    for offset, at, root, quality in harmony:
        if at == 0:
            roots[0,offset], qualities[0,offset], hk[0,offset] = root, quality, True
    targets.update(harmony_root=roots, harmony_root_known=hk,
                   harmony_quality=qualities, harmony_quality_known=hk.clone())
    available = ['free']
    by_source = {n.source_index:n for n in item.score.events}
    visible = [(by_source[s], na, nb) for (na,nb),s in zip(item.encoded.note_spans,item.encoded.source_indices)
               if a <= na and nb <= b]
    voices = {n.voice_id for n,_,_ in visible}
    if len(voices) > 1:
        available.append('given_melody')
    if harmony:
        available.append('given_chords')
    if 'motif_tokens' in inputs:
        available.append('given_motif')
    if task is not None and task not in available:
        raise UnusableExample('requested task unavailable: '+task)
    task = task or rng.choice(available)
    locked_sources = []
    if task == 'given_melody':
        pitched = {v: [n.pitch for n,_,_ in visible if n.voice_id == v and n.pitch is not None] for v in voices}
        # A supplied high voice proxy, explicitly not a human melody annotation.
        voice = max(voices, key=lambda v: (sum(pitched[v])/len(pitched[v]) if pitched[v] else -1, v))
        selected = [n for n,_,_ in visible if n.voice_id == voice]
        supplied = replace(item.score, events=tuple(selected),
                           measures=(replace(item.score.measures[bar], index=0),))
        supplied = replace(supplied, events=tuple(replace(n,bar=0) for n in selected))
        wire = encode_score(supplied)
        if len(wire.tokens) > context:
            raise UnusableExample('supplied voice exceeds material context')
        inputs['material'] = torch.tensor(wire.tokens,dtype=torch.long)[None]
        inputs['material_known'] = torch.ones_like(inputs['material'],dtype=torch.bool)
        lock = torch.zeros_like(targets['event_known'])
        for n, na, nb in visible:
            if n.voice_id == voice:
                lock[0,na-left-1:nb-left-1] = True
                locked_sources.append(n.source_index)
        targets['event_locked'] = lock
        targets['voice_pointer_locked'] = lock.clone()
    elif task == 'given_chords':
        chords = {name: torch.tensor([[row[index] for row in harmony]], dtype=torch.long)
                  for name,index in (('bar',0),('root',2),('quality',3))}
        chords['offset_num'] = torch.tensor([[r[1].numerator for r in harmony]],dtype=torch.long)
        chords['offset_den'] = torch.tensor([[r[1].denominator for r in harmony]],dtype=torch.long)
        chords['known'] = torch.ones_like(chords['root'],dtype=torch.bool)
        chords['hard_lock'] = chords['known'].clone()
        inputs['chords'] = chords
        targets['harmony_root_locked'], targets['harmony_quality_locked'] = hk.clone(), hk.clone()
    elif task == 'given_motif':
        slots = inputs['motif_known'][0].any(dim=-1).nonzero().flatten().tolist()
        slot = rng.choice(slots)
        keep = inputs['motif_known'][:,slot]
        inputs['material'] = inputs['motif_tokens'][:,slot][:,keep[0]]
        inputs['material_known'] = torch.ones_like(inputs['material'],dtype=torch.bool)
    inputs['task_id'] = torch.tensor([TASKS.index(task)])
    audit = {'historyBars':history_bars, 'knownHistoryBars':count, 'bar':bar, 'chunkIndex':chunk_index, 'chunkCount':len(chunks),
             'targetStart':a, 'targetStop':b, 'decoderStart':left,
             'completeTargetBar': a == item.encoded.bar_spans[bar][0] and b == item.encoded.bar_spans[bar][1],
             'reachesBarEnd': b == item.encoded.bar_spans[bar][1],
             'task':task, 'lockedSourceNotes':locked_sources,
             'harmonySource':'source-aligned AugmentedNet proxy' if harmony else None}
    return inputs, targets, audit
