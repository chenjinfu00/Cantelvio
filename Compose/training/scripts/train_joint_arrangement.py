#!/usr/bin/env python3
"""Train a note-to-six-group arrangement adapter from observed MIDI.

This learns only observed MIDI instrument groups. The updated four-track model
can initialize tonal note embeddings, but remains separate. MIDI does not
provide score dynamics, explicit tuplets, harmony analyses, or role labels.
"""
import argparse
from collections import Counter
import hashlib
import itertools
import json
import os
from pathlib import Path
import random
import re
import sys
import time

import numpy as np
import torch
from torch import nn
from torch.nn import functional as F

ROOT = Path(__file__).resolve().parents[1]
PROJECT = ROOT.parent
sys.path.insert(0, str(ROOT / 'orchestra'))
import groups as G
from prepare import BAR_FIELDS, NOTE_FIELDS, parse

MAX_NOTES = 64
MODEL_SCHEMA = 'arrangement-masked-fields-v2-curated-midi'
PITCH_CLS = 128 + G.N_DRUM
PITCH_PAD = PITCH_CLS + 1


def file_hash(path):
    digest = hashlib.sha256()
    with open(path, 'rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


def initialize_pitch_from_joint(adapter, checkpoint):
    """Borrow within-octave B/M pitch embeddings; do not invent MIDI chord labels."""
    source = torch.load(checkpoint, map_location='cpu', weights_only=False)
    if source.get('config', {}).get('kind') != 'structured' or 'state_dict' not in source:
        raise ValueError('joint initialization needs a structured R/H/B/M checkpoint')
    state = source['state_dict']
    bass, melody = state['tok.2.weight'], state['tok.3.weight']
    if bass.shape[1] != adapter.pitch.embedding_dim or melody.shape[1] != adapter.pitch.embedding_dim:
        raise ValueError('joint and arranger embedding widths differ')
    with torch.no_grad():
        for pitch in range(128):
            token = 4 + pitch % 12
            adapter.pitch.weight[pitch].copy_((bass[token] + melody[token]) * 0.5)
    return file_hash(checkpoint)


def fingerprint(notes):
    """Same exact-content identity used by orchestra/prepare.py."""
    digest = hashlib.md5()
    for field in ('bar', 'pos', 'group', 'pitch'):
        digest.update(np.ascontiguousarray(notes[field][:4000]).astype(np.int32).tobytes())
    digest.update(str(len(notes['bar'])).encode())
    return digest.hexdigest()


class Prepared:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.pieces = json.loads((self.directory / 'pieces.json').read_text())
        self.notes = {key: np.memmap(self.directory / f'notes.{key}.bin', dtype=dtype, mode='r')
                      for key, dtype in NOTE_FIELDS.items()}
        self.bars = {key: np.memmap(self.directory / f'bars.{key}.bin', dtype=dtype, mode='r')
                     for key, dtype in BAR_FIELDS.items()}
        self.by_split = {s: [p for p in self.pieces if p['split'] == s]
                         for s in ('train', 'validation', 'test')}
        if not self.by_split['train'] or not self.by_split['validation']:
            raise ValueError('prepared MIDI corpus needs train and validation works')

    def bar(self, piece, index):
        bo, no = piece['barOffset'], piece['noteOffset']
        first = int(self.bars['first'][bo + index])
        last = (int(self.bars['first'][bo + index + 1]) if index + 1 < piece['bars']
                else piece['notes'])
        return ({key: arr[no + first:no + last] for key, arr in self.notes.items()},
                int(self.bars['meter'][bo + index]), int(self.bars['len'][bo + index]))

    def heldout_hashes(self):
        result = set()
        for piece in self.by_split['validation'] + self.by_split['test']:
            a = piece['noteOffset']; b = a + piece['notes']
            result.add(fingerprint({key: arr[a:b] for key, arr in self.notes.items()}))
        return result

    def signature(self):
        digest = hashlib.sha256()
        for name in ('pieces.json', 'prepare.json'):
            digest.update(file_hash(self.directory / name).encode())
        for field in NOTE_FIELDS:
            path = self.directory / f'notes.{field}.bin'
            digest.update(path.name.encode())
            digest.update(file_hash(path).encode())
        for field in BAR_FIELDS:
            path = self.directory / f'bars.{field}.bin'
            digest.update(path.name.encode())
            digest.update(file_hash(path).encode())
        return digest.hexdigest()


def exclusion_reason(relative_path):
    """Only explicit user exclusions and unmistakable raw-transcriber outputs."""
    parts = [part.casefold() for part in Path(relative_path).parts]
    name = parts[-1]
    if '我的编曲&打谱' in parts and '博士二阶段' in parts:
        return 'user-excluded doctoral phase'
    raw_markers = ('muscriptor', 'basic_pitch', 'yourmt3', 'model_output',
                   'transcription_stems', '整曲模型底稿', '管弦分轨测试结果',
                   '管弦分轨指定编制测试结果')
    if any(marker in str(relative_path).casefold() for marker in raw_markers):
        return 'unmodified transcription output'
    if name.endswith('_raw.mid') or name.endswith('_raw.midi'):
        return 'raw MIDI export'
    return None


def version_number(relative_path):
    values = [int(v) for v in re.findall(r'(?<![a-z0-9])v(?:ersion)?[_-]?(\d+)(?!\d)',
                                          str(relative_path).casefold())]
    for part in Path(relative_path).parts:
        match = re.match(r'^(\d{2})_(?:rebuild|editable_edition)', part.casefold())
        if match:
            values.append(int(match.group(1)))
    return max(values, default=0)


def version_family(path):
    stem = re.sub(r'[_-]+', ' ', Path(path).stem.casefold())
    stem = re.sub(r'(?<![a-z0-9])v(?:ersion)?[_-]?\d+(?!\d)', ' ', stem)
    stem = re.sub(r'\b(?:final|draft|refined|clean|from|import|midi|working|revised)\b', ' ', stem)
    return re.sub(r'[^\w\u4e00-\u9fff]+', '', stem)


def event_signatures(notes):
    """Group-independent MIDI events; second signature tolerates transposition."""
    n = min(len(notes['bar']), 8000)
    bar = notes['bar'][:n].astype(np.int64)
    pos = notes['pos'][:n].astype(np.int64)
    pitch = notes['pitch'][:n].astype(np.int64)
    drum = notes['drum'][:n].astype(bool)
    onset = bar * G.MAX_BAR + pos
    sounding = pitch[~drum]
    anchor = int(sounding[0]) if len(sounding) else 60
    absolute = set((onset * 512 + np.where(drum, 384 + pitch, pitch)).tolist())
    relative = set((onset * 512 + np.where(drum, 384 + pitch, pitch - anchor + 128)).tolist())
    return absolute, relative


def near_similarity(left, right):
    if min(left['noteCount'], right['noteCount']) < 60:
        return 0.0
    if min(left['noteCount'], right['noteCount']) / max(left['noteCount'], right['noteCount']) < 0.7:
        return 0.0
    if min(left['barCount'], right['barCount']) / max(left['barCount'], right['barCount']) < 0.7:
        return 0.0
    values = []
    for key in ('absolute', 'relative'):
        a, b = left[key], right[key]
        if not a or not b:
            continue
        overlap = len(a & b)
        values.append(overlap / (len(a) + len(b) - overlap))
    return max(values, default=0.0)


def same_version_family(left, right):
    if left['family'] != right['family'] or len(left['family']) < 8:
        return False
    a, b = Path(left['name']).parent.parts, Path(right['name']).parent.parts
    shared = 0
    for x, y in zip(a, b):
        if x != y:
            break
        shared += 1
    return shared >= 4


def choose_local_versions(candidates):
    """Cluster high-overlap copies and explicit version families, keep newest."""
    parent = list(range(len(candidates)))

    def find(i):
        while parent[i] != i:
            parent[i] = parent[parent[i]]
            i = parent[i]
        return i

    for i, left in enumerate(candidates):
        for j in range(i):
            right = candidates[j]
            if (left['fingerprint'] == right['fingerprint'] or
                    same_version_family(left, right) or
                    near_similarity(left, right) >= 0.86):
                parent[find(i)] = find(j)
    clusters = {}
    for i in range(len(candidates)):
        clusters.setdefault(find(i), []).append(i)
    selected, skipped, summaries = [], [], []
    for ids in clusters.values():
        # An explicit vN is more trustworthy than a synced file mtime. For
        # unversioned copies, prefer newer modification time; never select a
        # raw model output, since those were filtered before this stage.
        winner = max(ids, key=lambda i: (candidates[i]['version'],
                                         '我的编曲&打谱' in candidates[i]['name'],
                                         candidates[i]['mtime'], candidates[i]['noteCount'],
                                         candidates[i]['name']))
        selected.append(candidates[winner])
        if len(ids) > 1:
            dropped = [candidates[i]['name'] for i in ids if i != winner]
            skipped.extend(dropped)
            summaries.append({'kept': candidates[winner]['name'], 'removed': dropped})
    return selected, skipped, summaries


def local_midis(root, heldout):
    """Read external iCloud MIDI or the reviewed visible library in place."""
    root = Path(root).resolve()
    curated_copy_root = (ROOT / 'data/local-midi-curated-v1/files').resolve()
    visible_copy_root = (ROOT / 'data/MIDI-Library').resolve()
    visible_entries = None
    if root == visible_copy_root:
        manifest = json.loads((root / 'manifest.json').read_text())
        visible_entries = {row['file']: row for row in manifest['files']}
        if manifest['count'] != len(visible_entries):
            raise ValueError('MIDI-Library manifest count differs from its unique entries')
    candidates, failures = [], Counter()
    exclusions = []
    files = sorted(p for p in root.rglob('*') if p.is_file() and p.suffix.lower() in ('.mid', '.midi'))
    if visible_entries is not None:
        if {p.name for p in files} != set(visible_entries):
            raise ValueError('MIDI-Library files differ from the reviewed manifest')
    for path in files:
        if path.resolve().is_relative_to(PROJECT) and root not in (curated_copy_root, visible_copy_root):
            continue
        if visible_entries is not None:
            row = visible_entries[path.name]
            if file_hash(path) != row['sha256']:
                raise ValueError(f'MIDI-Library file changed since review: {path.name}')
            name = row['sourceRelativePath']
        else:
            name = str(path.relative_to(root))
        reason = exclusion_reason(name)
        if reason:
            failures[reason] += 1
            exclusions.append({'relativePath': name, 'reason': reason})
            continue
        arrays, info = parse(path, recover=True)
        if arrays is None:
            failures[info] += 1
            exclusions.append({'relativePath': name, 'reason': info})
            continue
        if info['hash'] in heldout:
            failures['exact held-out duplicate'] += 1
            exclusions.append({'relativePath': name, 'reason': 'exact held-out duplicate'})
            continue
        notes, bars = arrays
        absolute, relative = event_signatures(notes)
        candidates.append({'notes': notes, 'bars': bars, 'name': name,
                           'multi': sum(n > 0 for n in info['groups']) >= 2,
                           'fingerprint': info['hash'], 'absolute': absolute, 'relative': relative,
                           'noteCount': info['notes'], 'barCount': info['bars'],
                           'family': version_family(name), 'version': version_number(name),
                           'mtime': path.stat().st_mtime_ns, 'path': path})
    pieces, dropped, clusters = choose_local_versions(candidates)
    failures['older or near-duplicate version'] += len(dropped)
    exclusions.extend({'relativePath': name, 'reason': 'older or near-duplicate version'} for name in dropped)
    sha_rows = [(piece['name'], file_hash(piece['path'])) for piece in sorted(pieces, key=lambda p: p['name'])]
    digest = hashlib.sha256(json.dumps(sha_rows, ensure_ascii=False).encode()).hexdigest()
    audit = {'selected': [piece['name'] for piece in pieces], 'excluded': exclusions,
             'versionClusters': clusters}
    return pieces, dict(failures), digest, sha_rows, audit


def local_bar(piece, index):
    bars, notes = piece['bars'], piece['notes']
    a = int(bars['first'][index])
    b = int(bars['first'][index + 1]) if index + 1 < len(bars['first']) else len(notes['bar'])
    return ({key: arr[a:b] for key, arr in notes.items()},
            int(bars['meter'][index]), int(bars['len'][index]))


def encode_bar(raw, meter, bar_len, *, rng=None):
    """All pitches/times are observed, but instrument-group labels are targets."""
    n = len(raw['group'])
    if n < 2 or not 1 <= bar_len <= G.MAX_BAR:
        return None
    ids = np.arange(n)
    if n > MAX_NOTES:
        ids = np.sort((rng if rng is not None else np.random.default_rng(0)).choice(n, MAX_NOTES, replace=False))
    k = len(ids)
    out = {name: np.zeros(MAX_NOTES + 1, np.int64) for name in ('pitch', 'pos', 'dur', 'group')}
    out['pitch'][:] = PITCH_PAD
    out['pitch'][0] = PITCH_CLS
    out['pitch'][1:k + 1] = np.where(raw['drum'][ids].astype(bool),
                                    128 + raw['pitch'][ids].astype(np.int64), raw['pitch'][ids])
    out['pos'][1:k + 1] = np.minimum(raw['pos'][ids], G.MAX_BAR - 1)
    out['dur'][1:k + 1] = raw['dur'][ids]
    out['group'][1:k + 1] = raw['group'][ids]
    out['valid'] = np.zeros(MAX_NOTES + 1, bool)
    out['valid'][:k + 1] = True
    out['meter'] = np.int64(meter)
    out['bar_len'] = np.int64(bar_len)
    out['group_mask'] = np.array([(raw['group'][ids] == g).any() for g in range(G.N_GROUPS)], np.float32)
    return out


def batch(rows, device):
    return {key: torch.as_tensor(np.stack([r[key] for r in rows]), device=device)
            for key in rows[0]}


class ArrangementAdapter(nn.Module):
    def __init__(self, d=96):
        super().__init__()
        self.pitch = nn.Embedding(PITCH_PAD + 1, d)
        self.pos = nn.Embedding(G.MAX_BAR, d)
        self.dur = nn.Embedding(G.N_DUR, d)
        self.meter = nn.Embedding(G.N_METER, d)
        self.bar_len = nn.Embedding(G.MAX_BAR + 1, d)
        layer = nn.TransformerEncoderLayer(d, 4, 2 * d, dropout=0.1, batch_first=True, norm_first=True)
        self.encoder = nn.TransformerEncoder(layer, 2, enable_nested_tensor=False)
        self.norm = nn.LayerNorm(d)
        self.group = nn.Linear(d, G.N_GROUPS)
        self.presence = nn.Linear(d, G.N_GROUPS)
        # MIDI pitch, onset and duration are genuine observations. A small
        # masked-reconstruction task uses them as labels without pretending
        # that score dynamics or explicit tuplet marks exist in MIDI.
        self.pitch_head = nn.Linear(d, PITCH_CLS)
        self.pos_head = nn.Linear(d, G.MAX_BAR)
        self.dur_head = nn.Linear(d, G.N_DUR)

    def forward(self, row, *, features=False):
        x = self.pitch(row['pitch']) + self.pos(row['pos']) + self.dur(row['dur'])
        x = x + self.meter(row['meter'])[:, None, :] + self.bar_len(row['bar_len'])[:, None, :]
        h = self.norm(self.encoder(x, src_key_padding_mask=~row['valid']))
        if features:
            return h
        return self.group(h[:, 1:]), self.presence(h[:, 0])

    def losses(self, row):
        logits, present = self(row)
        valid = row['valid'][:, 1:]
        note_loss = F.cross_entropy(logits[valid], row['group'][:, 1:][valid])
        bar_loss = F.binary_cross_entropy_with_logits(present, row['group_mask'])
        correct = (logits[valid].argmax(-1) == row['group'][:, 1:][valid]).float().mean()
        selected = valid & (torch.rand(valid.shape, device=valid.device) < 0.15)
        if not selected.any():
            selected.flatten()[int(valid.flatten().nonzero()[0])] = True
        masked = dict(row)
        for field in ('pitch', 'pos', 'dur'):
            masked[field] = row[field].clone()
        masked['pitch'][:, 1:][selected] = PITCH_PAD
        masked['pos'][:, 1:][selected] = 0
        masked['dur'][:, 1:][selected] = 0
        hidden = self(masked, features=True)[:, 1:][selected]
        pitch_loss = F.cross_entropy(self.pitch_head(hidden), row['pitch'][:, 1:][selected])
        onset_loss = F.cross_entropy(self.pos_head(hidden), row['pos'][:, 1:][selected])
        duration_loss = F.cross_entropy(self.dur_head(hidden), row['dur'][:, 1:][selected])
        total = note_loss + 0.5 * bar_loss + 0.1 * (pitch_loss + onset_loss + duration_loss)
        return total, {'noteCE': float(note_loss.detach()), 'barBCE': float(bar_loss.detach()),
                       'noteAccuracy': float(correct.detach()),
                       'maskedPitchCE': float(pitch_loss.detach()),
                       'maskedOnsetCE': float(onset_loss.detach()),
                       'maskedDurationCE': float(duration_loss.detach())}


def fixed_validation(corpus, seed, size):
    rng = np.random.default_rng(seed)
    works = corpus.by_split['validation']
    rows = []
    for work_index in rng.permutation(len(works)):
        piece = works[int(work_index)]
        if len(rows) >= size:
            break
        order = rng.permutation(piece['bars'])
        for index in order:
            row = encode_bar(*corpus.bar(piece, int(index)), rng=rng)
            if row is not None:
                rows.append(row)
                break
    if len(rows) < 32:
        raise ValueError('too few nonempty validation bars')
    return rows


def evaluate(model, rows, device, batch_size):
    model.eval()
    objective, note_ce, bar_bce, notes_total, notes_correct = 0.0, 0.0, 0.0, 0, 0
    group_total = np.zeros(G.N_GROUPS, np.int64)
    group_correct = np.zeros(G.N_GROUPS, np.int64)
    with torch.no_grad():
        for i in range(0, len(rows), batch_size):
            part = rows[i:i + batch_size]
            row = batch(part, device)
            logits, presence = model(row)
            valid = row['valid'][:, 1:]
            truth = row['group'][:, 1:][valid]
            pred = logits[valid].argmax(-1)
            ce = F.cross_entropy(logits[valid], truth)
            bce = F.binary_cross_entropy_with_logits(presence, row['group_mask'])
            objective += float(ce + 0.5 * bce) * len(part)
            note_ce += float(ce) * len(part)
            bar_bce += float(bce) * len(part)
            notes_total += int(truth.numel())
            notes_correct += int((pred == truth).sum())
            for g in range(G.N_GROUPS):
                where = truth == g
                group_total[g] += int(where.sum())
                group_correct[g] += int(((pred == g) & where).sum())
    model.train()
    return {'loss': round(objective / len(rows), 6),
            'noteCE': round(note_ce / len(rows), 6),
            'barBCE': round(bar_bce / len(rows), 6),
            'noteAccuracy': round(notes_correct / max(1, notes_total), 6),
            'groupRecall': {G.GROUPS[g]: (round(float(group_correct[g] / group_total[g]), 6)
                                          if group_total[g] else None) for g in range(G.N_GROUPS)},
            'groupSupport': dict(zip(G.GROUPS, group_total.tolist()))}


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument('--orchestra-data', type=Path, default=ROOT / 'orchestra/work/data')
    ap.add_argument('--local-root', type=Path,
                    help='external iCloud MIDI tree or reviewed training/data/MIDI-Library; read in place')
    ap.add_argument('--joint-initialization', type=Path,
                    help='fine-tuned old joint checkpoint used to initialize tonal pitch features')
    ap.add_argument('--output-dir', type=Path, required=True)
    ap.add_argument('--steps', type=int, default=None,
                    help='optional step limit; omitted with --max-seconds means time-only training')
    ap.add_argument('--max-seconds', type=float, default=0,
                    help='stop after this cumulative training-time budget, evaluating and saving first')
    ap.add_argument('--batch', type=int, default=24)
    ap.add_argument('--eval-every', type=int, default=200)
    ap.add_argument('--eval-bars', type=int, default=256)
    ap.add_argument('--local-prob', type=float, default=0.2)
    ap.add_argument('--multi-local-share', type=float, default=0.8,
                    help='among local MIDI batches, favor pieces with multiple observed groups')
    ap.add_argument('--lr', type=float, default=3e-4)
    ap.add_argument('--seed', type=int, default=930228)
    ap.add_argument('--threads', type=int, default=2)
    ap.add_argument('--device', choices=('cpu', 'mps'), default='cpu')
    ap.add_argument('--resume', action='store_true')
    ap.add_argument('--preflight', action='store_true', help='audit sources and leave training untouched')
    a = ap.parse_args()
    if a.steps is None:
        a.steps = 0 if a.max_seconds else 2000
    if (a.steps < 0 or (a.steps == 0 and a.max_seconds <= 0) or a.max_seconds < 0 or
            a.batch < 1 or a.eval_every < 1 or
            not 0 <= a.local_prob <= 1 or not 0 <= a.multi_local_share <= 1):
        ap.error('invalid training schedule or local probability')
    if a.local_prob and not a.local_root:
        ap.error('--local-prob > 0 requires --local-root')
    if not a.preflight and a.output_dir.exists() and any(a.output_dir.iterdir()) and not a.resume:
        ap.error('output directory is not empty; use a new path or --resume')
    if a.resume and not (a.output_dir / 'state.pt').exists():
        ap.error('--resume requires state.pt')
    torch.set_num_threads(a.threads)
    random.seed(a.seed); np.random.seed(a.seed); torch.manual_seed(a.seed)
    corpus = Prepared(a.orchestra_data)
    local, rejected, local_hash, local_manifest, local_audit = (
        local_midis(a.local_root, corpus.heldout_hashes())
        if a.local_root else ([], {}, 'none', [], {'selected': [], 'excluded': [], 'versionClusters': []}))
    if a.local_prob and not local:
        ap.error('no usable multi-group external MIDI; do not silently train without them')
    source = {'orchestraWorks': {s: len(v) for s, v in corpus.by_split.items()},
              'modelSchema': MODEL_SCHEMA + ('-joint-pitch-init' if a.joint_initialization else ''),
              'localAccepted': len(local), 'localMultiGroup': sum(p['multi'] for p in local),
              'localSingleGroup': sum(not p['multi'] for p in local),
              'localRejected': rejected, 'localVersionClusters': len(local_audit['versionClusters']),
              'localHash': local_hash,
              'orchestraSignature': corpus.signature(), 'trainOnlyLocal': True,
              'midiKnown': ['pitch', 'onset', 'quantizedDuration', 'group', 'meter'],
              'midiUnknown': ['scoreDynamic', 'explicitTuplet', 'harmonyLabel', 'partRole'],
              'frozenJointBase': True, 'browserCompatible': False,
              'jointInitializationHash': (file_hash(a.joint_initialization)
                                          if a.joint_initialization and not a.preflight else None),
              'jointInitialization': str(a.joint_initialization) if a.joint_initialization else None}
    print(json.dumps({'phase': 'source-audit', **source}, ensure_ascii=False), flush=True)
    if a.preflight:
        print(json.dumps({'phase': 'selection-examples',
                          'clusters': local_audit['versionClusters'][:20],
                          'excludedRawExamples': [e['relativePath'] for e in local_audit['excluded']
                                                  if e['reason'] in ('user-excluded doctoral phase',
                                                                     'unmodified transcription output')][:20]},
                         ensure_ascii=False), flush=True)
    if a.preflight:
        return
    device = torch.device(a.device)
    if a.device == 'mps' and not torch.backends.mps.is_available():
        ap.error('MPS is unavailable')
    rng = np.random.default_rng(a.seed + 1)
    val = fixed_validation(corpus, a.seed + 2, a.eval_bars)
    model = ArrangementAdapter().to(device)
    if a.joint_initialization:
        initialize_pitch_from_joint(model, a.joint_initialization)
    optimizer = torch.optim.AdamW(model.parameters(), lr=a.lr, weight_decay=0.02)
    schedule = {key: getattr(a, key) for key in ('steps', 'batch', 'eval_every', 'eval_bars',
                                                  'local_prob', 'multi_local_share', 'lr', 'seed')}
    a.output_dir.mkdir(parents=True, exist_ok=True)
    state_path = a.output_dir / 'state.pt'
    start, best, best_step, elapsed_before = 1, float('inf'), None, 0.0
    if a.resume:
        state = torch.load(state_path, map_location='cpu', weights_only=False)
        if state['source'] != source or state['schedule'] != schedule:
            ap.error('resume inputs or settings differ')
        model.load_state_dict(state['model']); optimizer.load_state_dict(state['optimizer'])
        rng.bit_generator.state = state['rng']; torch.set_rng_state(state['torch'])
        start, best, best_step = state['step'] + 1, state['best'], state['bestStep']
        elapsed_before = float(state.get('elapsedSeconds', 0.0))
    else:
        (a.output_dir / 'provenance.json').write_text(json.dumps({'source': source, 'schedule': schedule},
                                                                 ensure_ascii=False, indent=1))
        (a.output_dir / 'local-midi-manifest.json').write_text(json.dumps(
            [{'relativePath': name, 'sha256': digest} for name, digest in local_manifest],
            ensure_ascii=False, indent=1))
        (a.output_dir / 'local-midi-selection.json').write_text(json.dumps(
            local_audit, ensure_ascii=False, indent=1))
    model.train()
    train_works = corpus.by_split['train']
    multi_local = [piece for piece in local if piece['multi']]
    single_local = [piece for piece in local if not piece['multi']]
    if (a.steps and start > a.steps) or (a.max_seconds and elapsed_before >= a.max_seconds):
        print(json.dumps({'completed': True, 'step': start - 1, 'bestStep': best_step,
                          'elapsedSeconds': elapsed_before}), flush=True)
        return
    started = time.monotonic()
    iterator = itertools.count(start) if a.steps == 0 else range(start, a.steps + 1)
    for step in iterator:
        rows = []
        while len(rows) < a.batch:
            if local and rng.random() < a.local_prob:
                pool = multi_local if rng.random() < a.multi_local_share else single_local
                if not pool:
                    pool = local
                piece = pool[int(rng.integers(len(pool)))]
                raw = local_bar(piece, int(rng.integers(len(piece['bars']['first']))))
            else:
                piece = train_works[int(rng.integers(len(train_works)))]
                raw = corpus.bar(piece, int(rng.integers(piece['bars'])))
            row = encode_bar(*raw, rng=rng)
            if row is not None:
                rows.append(row)
        loss, train_metrics = model.losses(batch(rows, device))
        optimizer.zero_grad(set_to_none=True)
        loss.backward()
        torch.nn.utils.clip_grad_norm_(model.parameters(), 1.0)
        optimizer.step()
        deadline_reached = bool(a.max_seconds and elapsed_before + time.monotonic() - started >= a.max_seconds)
        steps_done = bool(a.steps and step == a.steps)
        if step % a.eval_every == 0 or steps_done or deadline_reached:
            val_metrics = evaluate(model, val, device, a.batch)
            elapsed = elapsed_before + time.monotonic() - started
            budget_stopped = bool(a.max_seconds and elapsed >= a.max_seconds)
            report = {'step': step, 'train': train_metrics, 'validation': val_metrics}
            print(json.dumps(report), flush=True)
            if val_metrics['loss'] < best:
                best, best_step = val_metrics['loss'], step
                torch.save({'model': model.state_dict(), 'step': step, 'source': source,
                            'version': source['modelSchema']}, a.output_dir / 'best.tmp')
                os.replace(a.output_dir / 'best.tmp', a.output_dir / 'best.pt')
            torch.save({'model': model.state_dict(), 'optimizer': optimizer.state_dict(),
                        'rng': rng.bit_generator.state, 'torch': torch.get_rng_state(),
                        'step': step, 'best': best, 'bestStep': best_step,
                        'source': source, 'schedule': schedule,
                        'elapsedSeconds': elapsed}, a.output_dir / 'state.tmp')
            os.replace(a.output_dir / 'state.tmp', state_path)
            if budget_stopped:
                break
    print(json.dumps({'completed': steps_done or budget_stopped, 'budgetStopped': budget_stopped,
                      'elapsedSeconds': elapsed, 'bestStep': best_step,
                      'output': str(a.output_dir)}), flush=True)


if __name__ == '__main__':
    main()
