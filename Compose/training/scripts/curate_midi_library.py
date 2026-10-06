#!/usr/bin/env python3
"""Quarantine reviewed excess MIDI copies; leave the original sources untouched."""

import argparse
import hashlib
import json
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
LIBRARY = ROOT / 'data/MIDI-Library'
QUARANTINE = ROOT / 'data/MIDI-Library-Excluded-20260929'
POLICY = ROOT / 'data/midi-library-curation.json'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def selected_hash(entries):
    payload = '\n'.join(f"{row['file']}\t{row['sha256']}" for row in entries) + '\n'
    return hashlib.sha256(payload.encode()).hexdigest()


def review_policy(manifest, policy):
    if manifest['selectionSha256'] != policy['sourceSelectionSha256']:
        raise ValueError('Source selection differs from reviewed 145-file set')
    reasons = {}
    for group in policy['excludedGroups']:
        for name in group['files']:
            if name in reasons:
                raise ValueError(f'Repeated exclusion: {name}')
            reasons[name] = group['reason']
    entries = {entry['file']: entry for entry in manifest['files']}
    if len(entries) != len(manifest['files']) or set(reasons) - set(entries):
        raise ValueError('Manifest and review policy do not match')
    renames = policy.get('renames', {})
    if set(renames) - set(entries) or set(renames) & set(reasons):
        raise ValueError('Review rename points to an unknown or excluded file')
    proposed = [renames.get(name, name) for name in entries if name not in reasons]
    if len(proposed) != len(set(proposed)):
        raise ValueError('Review renames create duplicate filenames')
    return reasons


def write_json(path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--apply', action='store_true', help='Move copies after full preflight')
    args = parser.parse_args()
    manifest = json.loads((LIBRARY / 'manifest.json').read_text())
    policy = json.loads(POLICY.read_text())
    reasons = review_policy(manifest, policy)
    renames = policy.get('renames', {})
    included = [{**row, 'file': renames.get(row['file'], row['file'])}
                for row in manifest['files'] if row['file'] not in reasons]
    excluded = [{**row, 'reason': reasons[row['file']]} for row in manifest['files']
                if row['file'] in reasons]
    if not excluded:
        raise ValueError('No files to curate')
    if QUARANTINE.exists():
        raise FileExistsError(f'Quarantine already exists: {QUARANTINE}')
    if manifest['count'] != len(manifest['files']):
        raise ValueError('Manifest count is wrong')
    missing = []
    upstream = json.loads((ROOT / 'data/local-midi-curated-v1/manifest.json').read_text())
    upstream_by_source = {row['sourceRelativePath']: row for row in upstream['files']}
    for row in manifest['files']:
        path = LIBRARY / row['file']
        renamed = LIBRARY / renames[row['file']] if row['file'] in renames else None
        if renamed and renamed.is_file():
            if path.exists():
                raise ValueError(f'Both original and renamed MIDI exist: {row["file"]}')
            path = renamed
        if not path.is_file():
            if row['file'] not in reasons:
                raise ValueError(f'Included MIDI is missing: {row["file"]}')
            source = upstream_by_source.get(row['sourceRelativePath'])
            if not source or source['sha256'] != row['sha256']:
                raise ValueError(f'Missing MIDI has no matching upstream copy: {row["file"]}')
            upstream_path = ROOT / 'data/local-midi-curated-v1' / source['path']
            if not upstream_path.is_file() or digest(upstream_path) != row['sha256']:
                raise ValueError(f'Missing MIDI has no recoverable upstream copy: {row["file"]}')
            missing.append(row['file'])
        elif path.stat().st_size != row['bytes'] or digest(path) != row['sha256']:
            raise ValueError(f'Changed MIDI: {row["file"]}')
    print(json.dumps({'before': len(manifest['files']), 'keep': len(included),
                      'exclude': len(excluded), 'alreadyMissing': missing,
                      'moveToQuarantine': len(excluded) - len(missing),
                      'quarantineDirectory': str(QUARANTINE),
                      'files': [row['file'] for row in excluded]}, ensure_ascii=False, indent=2))
    if not args.apply:
        return
    QUARANTINE.mkdir()
    for row in excluded:
        if row['file'] not in missing:
            (LIBRARY / row['file']).rename(QUARANTINE / row['file'])
    for old_name, new_name in renames.items():
        old = LIBRARY / old_name
        if old.exists():
            old.rename(LIBRARY / new_name)
    active_manifest = {'schema': manifest['schema'], 'count': len(included),
                       'selectionSha256': selected_hash(included),
                       'sourceSelectionSha256': policy['sourceSelectionSha256'],
                       'curationPolicy': '../midi-library-curation.json',
                       'files': included}
    excluded_manifest = {'schema': 'ailegro-visible-midi-library-exclusions-v1',
                         'count': len(excluded), 'quarantinedCount': len(excluded) - len(missing),
                         'alreadyMissingCount': len(missing),
                         'sourceSelectionSha256': policy['sourceSelectionSha256'],
                         'files': [{**row, 'disposition': 'already-missing-from-visible'
                                    if row['file'] in missing else 'moved-to-quarantine',
                                    'recoverableUpstream': '../local-midi-curated-v1/files/'
                                    + row['sourceRelativePath']}
                                   for row in excluded]}
    write_json(QUARANTINE / 'manifest-before-review.json', manifest)
    write_json(QUARANTINE / 'manifest.json', excluded_manifest)
    write_json(LIBRARY / 'manifest.json', active_manifest)
    print('Applied; original source files and upstream curated corpus were not changed.')


if __name__ == '__main__':
    main()
