#!/usr/bin/env python3
"""Create a normal, flat Finder-browsable copy of the curated MIDI corpus."""
import hashlib
import json
from pathlib import Path
import shutil

from curate_midi_library import POLICY, review_policy, selected_hash

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / 'data/local-midi-curated-v1'
DESTINATION = ROOT / 'data/MIDI-Library'


def digest(path):
    h = hashlib.sha256()
    with path.open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            h.update(block)
    return h.hexdigest()


def main():
    if DESTINATION.exists():
        raise FileExistsError(f'visible library already exists: {DESTINATION}')
    source_manifest = json.loads((SOURCE / 'manifest.json').read_text())
    if source_manifest['count'] != len(source_manifest['files']):
        raise ValueError('curated manifest count differs from entries')
    policy = json.loads(POLICY.read_text())
    # Rebuilding the browsable copy must not silently reintroduce excluded MIDI.
    reviewed_names = [f'{index:03d} - {Path(entry["path"]).stem[:65]}'
                      f'{Path(entry["path"]).suffix.lower()}'
                      for index, entry in enumerate(source_manifest['files'], 1)]
    review_manifest = {'selectionSha256': source_manifest['selectionSha256'],
                       'files': [{'file': name} for name in reviewed_names]}
    excluded = review_policy(review_manifest, policy)
    DESTINATION.mkdir()
    entries = []
    for index, entry in enumerate(source_manifest['files'], 1):
        source = SOURCE / entry['path']
        stem = Path(entry['path']).stem[:65]
        name = f'{index:03d} - {stem}{source.suffix.lower()}'
        if name in excluded:
            continue
        name = policy.get('renames', {}).get(name, name)
        target = DESTINATION / name
        if target.exists():
            raise FileExistsError(target)
        shutil.copyfile(source, target)  # Do not preserve the old hidden Finder flag.
        if digest(target) != entry['sha256']:
            raise ValueError(f'copy differs from curated MIDI: {name}')
        entries.append({'file': name, 'sourceRelativePath': entry['sourceRelativePath'],
                        'sha256': entry['sha256'], 'bytes': entry['bytes'],
                        'multiGroup': entry['multiGroup']})
    result = {'schema': 'ailegro-visible-midi-library-v1', 'count': len(entries),
              'selectionSha256': selected_hash(entries),
              'sourceSelectionSha256': source_manifest['selectionSha256'],
              'curationPolicy': '../midi-library-curation.json', 'files': entries}
    (DESTINATION / 'manifest.json').write_text(json.dumps(result, ensure_ascii=False, indent=2) + '\n')
    (DESTINATION / 'README.md').write_text(
        '# Cantelvio Compose MIDI Library\n\n'
        f'{len(entries)} reviewed MIDI copies are listed directly in this folder for browsing. '
        'The three-digit prefix only makes filenames unique; `manifest.json` '
        'records each original relative path and SHA-256. The review exclusions '
        'are recorded in `../midi-library-curation.json`. This is a private '
        'research copy, not a license to redistribute the music.\n')
    print(json.dumps({'directory': str(DESTINATION), 'midiFiles': len(entries),
                      'bytes': sum(entry['bytes'] for entry in entries)}, ensure_ascii=False))


if __name__ == '__main__':
    main()
