#!/usr/bin/env python3
"""Conservative work-name overlap audit against the existing SymphonyNet split.

This is a warning list, not proof that unmatched works are novel and not an
automatic permission to put any score into a validation or test split.
"""
import argparse
from collections import Counter, defaultdict
import json
from pathlib import Path
import re
import unicodedata

ROOT = Path(__file__).resolve().parents[1]
KINDS = ('symphony', 'quartet', 'concerto', 'sonata', 'mass', 'requiem')


def normalize(text):
    text = unicodedata.normalize('NFKD', text).casefold()
    text = ''.join(c for c in text if not unicodedata.combining(c))
    return re.sub(r'[^a-z0-9]+', '_', text).strip('_')


def composer_key(text):
    return normalize(text.split(',', 1)[0])


def signature(text):
    label = normalize(text)
    catalogue = re.search(r'(?:^|_)bwv_?(\d+)(?:_|$)', label)
    opus = re.search(r'(?:^|_)op_?(\d+)(?:_|$)', label)
    kind = next((k for k in KINDS if k in label), None)
    if kind:
        number = re.search(rf'{kind}(?:s)?(?:_no)?_0*(\d+)(?:_|$)', label)
        if number is None:
            number = re.search(rf'{kind}s?_[a-z]+_0*(\d+)(?:_|$)', label)
    else:
        number = None
    return {'bwv': catalogue.group(1) if catalogue else None,
            'opus': opus.group(1) if opus else None,
            'kind': kind, 'number': number.group(1) if number else None}


def match_reason(new, old):
    if new['bwv'] and new['bwv'] == old['bwv']:
        return 'same BWV number'
    if new['kind'] and new['number'] and new['kind'] == old['kind'] and new['number'] == old['number']:
        return 'same named work type and number'
    if new['opus'] and new['opus'] == old['opus'] and new['kind'] == old['kind']:
        return 'possible same opus and work type'
    return None


def audit(catalog, existing):
    old_by_composer = defaultdict(list)
    surnames = {composer_key(row['composer']) for row in catalog if row.get('status') == 'candidate'}
    for piece in existing:
        name = Path(piece['name']).stem
        normalized = normalize(name)
        for surname in surnames:
            if re.search(rf'(?:^|_){re.escape(surname)}(?:_|$)', normalized):
                old_by_composer[surname].append((piece, signature(name)))
    works = {}
    for row in catalog:
        if row.get('status') != 'candidate':
            continue
        key = row['compositionKey']
        if key in works:
            continue
        surname = composer_key(row['composer'])
        new = signature(row['work'])
        matches = []
        for old, old_signature in old_by_composer[surname]:
            reason = match_reason(new, old_signature)
            if reason:
                matches.append({'name': old['name'], 'split': old['split'], 'reason': reason})
        works[key] = {'compositionKey': key, 'scoreFiles': 0, 'matches': len(matches),
                      'matchingSplits': dict(Counter(m['split'] for m in matches)),
                      'examples': matches[:8]}
    for row in catalog:
        if row.get('status') == 'candidate':
            works[row['compositionKey']]['scoreFiles'] += 1
    matched = [work for work in works.values() if work['matches']]
    heldout = [work for work in matched if work['matchingSplits'].get('validation') or
               work['matchingSplits'].get('test')]
    return {'method': 'Conservative composer + BWV / work-number / opus filename match; misses aliases and editions.',
            'existingPieces': len(existing), 'newCompositions': len(works),
            'possibleOverlappingCompositions': len(matched),
            'possibleHeldoutOverlapCompositions': len(heldout),
            'warning': 'Do not assign train/validation/test for these scores from this audit alone.',
            'works': sorted(works.values(), key=lambda x: x['compositionKey'])}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--catalog', type=Path, default=ROOT / 'data/classical-score-v1/catalog.json')
    parser.add_argument('--existing', type=Path, default=ROOT / 'orchestra/work/data/pieces.json')
    parser.add_argument('--output', type=Path, default=ROOT / 'data/classical-score-v1/overlap-audit.json')
    args = parser.parse_args()
    if args.output.exists():
        parser.error('output exists; choose a fresh path')
    result = audit(json.loads(args.catalog.read_text()), json.loads(args.existing.read_text()))
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=1))
    print(json.dumps({k: result[k] for k in ('existingPieces', 'newCompositions',
          'possibleOverlappingCompositions', 'possibleHeldoutOverlapCompositions')}), flush=True)


if __name__ == '__main__':
    main()
