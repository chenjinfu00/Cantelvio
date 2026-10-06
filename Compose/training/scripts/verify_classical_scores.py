#!/usr/bin/env python3
"""Check prepared score/manifest integrity without loading whole corpus in memory."""
import argparse
from collections import Counter
from fractions import Fraction
import gzip
import json
from pathlib import Path

from prepare_classical_scores import G


def verify(directory):
    directory = Path(directory)
    report = json.loads((directory / 'prepare.json').read_text())
    catalog = json.loads((directory / 'catalog.json').read_text())
    expected = {row['scoreId']: row for row in catalog if row['status'] == 'candidate'}
    if len(expected) != report['candidateScores']:
        raise ValueError('catalog count or score IDs differ from summary')
    observed = set()
    notes = Counter()
    sources = Counter()
    with gzip.open(directory / 'scores.jsonl.gz', 'rt') as stream:
        for line in stream:
            score = json.loads(line)
            score_id = score['scoreId']
            if score_id not in expected or score_id in observed:
                raise ValueError(f'unexpected or duplicate score ID: {score_id}')
            observed.add(score_id)
            entry = expected[score_id]
            if (entry['scoreSha256'] != score['scoreSha256'] or
                    entry['compositionKey'] != score['compositionKey'] or
                    entry['notes'] != len(score['notes']) or
                    entry['measures'] != len(score['measures'])):
                raise ValueError(f'catalog/score mismatch: {score_id}')
            previous = -1
            for measure in score['measures']:
                on = Fraction(measure['on'])
                dur = Fraction(measure['dur'])
                if on < previous or dur <= 0 or measure['meter'][0] <= 0 or measure['meter'][1] <= 0:
                    raise ValueError(f'invalid measure timing: {score_id}')
                previous = on
            previous = -1
            for note in score['notes']:
                on = Fraction(note['on'])
                dur = Fraction(note['dur'])
                if on < previous or dur < 0 or (dur == 0 and not note['grace']):
                    raise ValueError(f'invalid note timing: {score_id}')
                if note['pitch'] is not None and not 0 <= note['pitch'] <= 127:
                    raise ValueError(f'invalid sounding pitch: {score_id}')
                if note['group'] is not None and note['group'] not in G.GROUPS:
                    raise ValueError(f'invalid instrument group: {score_id}')
                previous = on
            notes['total'] += len(score['notes'])
            notes['dynamics'] += sum(note['dynamic'] is not None for note in score['notes'])
            notes['roles'] += sum(note['role'] is not None for note in score['notes'])
            sources[score['source']] += 1
    if observed != set(expected):
        raise ValueError(f'missing score records: {len(set(expected) - observed)}')
    if (notes['total'] != report['totalNotes'] or
            notes['dynamics'] != report['knownDynamicNotes'] or
            notes['roles'] != report['roleLabeledNotes'] or
            dict(sources) != report['sources']):
        raise ValueError('record totals differ from summary')
    return {'scores': len(observed), 'notes': notes['total'], 'sources': dict(sources)}


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('directory', type=Path)
    args = parser.parse_args()
    print(json.dumps(verify(args.directory), ensure_ascii=False))
