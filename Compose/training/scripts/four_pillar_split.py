"""Conservative, provisional score selection for an isolated technical smoke run.

No MIDI-Library or old SymphonyNet source is imported. Composer-level separation
prevents another arrangement of the same composer's work crossing this small
internal train/validation boundary. This is not a completed all-corpus near-
duplicate or rights audit, and must not be used to claim generalization.
"""
from __future__ import annotations

import hashlib
import json
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
CATALOG = ROOT / 'data/classical-score-v1/catalog.json'
OVERLAP = ROOT / 'data/classical-score-v1/overlap-audit.json'
SCORES = ROOT / 'data/classical-score-v1/scores.jsonl.gz'


def digest(path: Path) -> str:
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(chunk)
    return h.hexdigest()


def _stable_hash(value: str) -> int:
    return int.from_bytes(hashlib.sha256(value.encode('utf-8')).digest()[:8], 'big')


def build_split(*, smoke: bool) -> dict:
    catalog = json.loads(CATALOG.read_text())
    audit = json.loads(OVERLAP.read_text())
    if audit.get('warning') is None or len(audit.get('works', ())) == 0:
        raise ValueError('missing overlap audit; refusing score selection')
    matching = {row['compositionKey']: row['matchingSplits'] for row in audit['works']}
    allowed = []
    excluded = Counter()
    for row in catalog:
        key = row.get('compositionKey')
        if not row.get('sixGroupCandidate') or row.get('status') != 'candidate':
            excluded['score_quality_or_vocal'] += 1
            continue
        if not key or key not in matching or not row.get('composer') or not row.get('scoreSha256'):
            excluded['missing_identity_or_audit'] += 1
            continue
        if 'test' in matching[key]:
            excluded['possible_old_test_overlap'] += 1
            continue
        allowed.append(row)
    forced_train = {row['composer'] for row in allowed if matching[row['compositionKey']]}
    # The entire composer is assigned together; possible old train/validation
    # overlaps are train-only so they cannot inflate internal validation.
    buckets = {'train': [], 'validation': []}
    for row in allowed:
        composer = row['composer']
        split = ('train' if composer in forced_train or _stable_hash(composer) % 10 != 0
                 else 'validation')
        buckets[split].append(row)
    if smoke:
        quotas = {
            'train': {'S3 Symbolic Symphony Set': 4,
                      'OpenScore Orchestra / Hauptstimme': 8,
                      'OpenScore String Quartets': 8},
            'validation': {'OpenScore String Quartets': 3},
        }
        selected = {'train': [], 'validation': []}
        for split, by_source in quotas.items():
            for source, count in by_source.items():
                group = sorted((row for row in buckets[split] if row['source'] == source),
                               key=lambda row: (_stable_hash(row['compositionKey']), row['scoreId']))
                distinct = []
                seen_works = set()
                for row in group:
                    if row['compositionKey'] in seen_works:
                        continue
                    seen_works.add(row['compositionKey'])
                    distinct.append(row)
                    if len(distinct) == count:
                        break
                if len(distinct) < count:
                    raise ValueError(f'not enough distinct {split} scores from {source}')
                selected[split].extend(distinct)
        buckets = selected
    train_composers = {row['composer'] for row in buckets['train']}
    val_composers = {row['composer'] for row in buckets['validation']}
    if train_composers & val_composers:
        raise AssertionError('composer leaked between train and validation')
    hashes = defaultdict(set)
    for split, rows in buckets.items():
        for row in rows:
            hashes[row['scoreSha256']].add(split)
    if any(len(splits) > 1 for splits in hashes.values()):
        raise AssertionError('identical score leaked across splits')
    if not buckets['train'] or not buckets['validation']:
        raise ValueError('both train and validation require scores')
    return {
        'schema': 'four-pillar-provisional-score-split-v1',
        'purpose': 'isolated technical smoke, not final model selection',
        'smoke': smoke,
        'source': {'catalogSha256': digest(CATALOG), 'overlapAuditSha256': digest(OVERLAP),
                   'scoresSha256': digest(SCORES)},
        'rule': 'sixGroupCandidate; old test overlap excluded; composer-disjoint 90/10 hash; old overlaps train-only',
        'excluded': dict(excluded),
        'scores': {split: [{k: row[k] for k in ('scoreId', 'compositionKey', 'scoreSha256',
                                                'composer', 'source')} for row in rows]
                   for split, rows in buckets.items()},
    }
