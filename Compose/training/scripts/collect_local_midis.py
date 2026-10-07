#!/usr/bin/env python3
"""Copy the already-curated external MIDI subset into a private project corpus.

The same selection logic as the arrangement trainer is used. Nothing is
removed from the source tree, and the active training run is not redirected.
"""
import argparse
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import shutil

from train_joint_arrangement import Prepared, file_hash, local_midis, ROOT


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--source-root', type=Path, required=True)
    parser.add_argument('--orchestra-data', type=Path, default=ROOT / 'orchestra/work/data')
    parser.add_argument('--output-dir', type=Path, default=ROOT / 'data/local-midi-curated-v1')
    args = parser.parse_args()
    source_root = args.source_root.resolve()
    destination = args.output_dir.resolve()
    staging = destination.with_name(destination.name + '-staging')
    if destination.exists() or staging.exists():
        parser.error('destination or partial staging directory already exists; inspect it before retrying')
    if destination.is_relative_to(source_root) is False:
        parser.error('destination must remain inside the selected iCloud source root')

    corpus = Prepared(args.orchestra_data)
    pieces, rejected, selection_hash, hashes, audit = local_midis(
        source_root, corpus.heldout_hashes())
    if not pieces or len(pieces) != len(hashes):
        parser.error('curation returned no files or inconsistent hash rows')
    source_hashes = dict(hashes)
    total_bytes = sum(piece['path'].stat().st_size for piece in pieces)
    free_bytes = shutil.disk_usage(destination.parent).free
    print(json.dumps({'phase': 'copy-plan', 'selected': len(pieces), 'bytes': total_bytes,
                      'excluded': rejected, 'freeBytes': free_bytes}, ensure_ascii=False), flush=True)
    if total_bytes + 4 * 1024**3 > free_bytes:
        parser.error('insufficient free space with a 4 GiB safety margin')

    staging.mkdir(parents=True)
    entries = []
    for piece in sorted(pieces, key=lambda p: p['name']):
        relative = Path(piece['name'])
        if relative.is_absolute() or '..' in relative.parts:
            raise ValueError(f'unsafe source-relative path: {relative}')
        target = staging / 'files' / relative
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(piece['path'], target)
        digest = file_hash(target)
        if digest != source_hashes[piece['name']]:
            raise ValueError(f'copied file hash differs from curated source: {relative}')
        entries.append({'path': str(Path('files') / relative),
                        'sourceRelativePath': piece['name'], 'sha256': digest,
                        'bytes': target.stat().st_size, 'multiGroup': bool(piece['multi'])})
    manifest = {'schema': 'ailegro-curated-local-midi-v1',
                'createdUTC': datetime.now(timezone.utc).isoformat(),
                'selectionSha256': selection_hash,
                'selectionMethod': 'train_joint_arrangement.local_midis',
                'trainingOnly': True, 'count': len(entries),
                'bytes': sum(entry['bytes'] for entry in entries),
                'multiGroup': sum(entry['multiGroup'] for entry in entries),
                'excludedCounts': rejected, 'files': entries}
    (staging / 'manifest.json').write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + '\n')
    (staging / 'README.md').write_text(
        '# Curated local MIDI (private research copy)\n\n'
        'These are byte-identical copies of selected iCloud MIDI files. '
        'See `manifest.json` for paths, hashes and selection counts. '
        'The doctoral-phase directory, obvious raw transcription outputs, '
        'and older or near-duplicate versions were excluded by the current '
        'Cantelvio Compose selection rule. This does not establish redistribution rights '
        'or guarantee that every subtle near-duplicate was detected. '
        'Do not publish this corpus without a separate rights review.\n')
    os.replace(staging, destination)
    print(json.dumps({'phase': 'copy-complete', 'directory': str(destination),
                      'files': len(entries), 'bytes': manifest['bytes'],
                      'selectionSha256': selection_hash}, ensure_ascii=False), flush=True)


if __name__ == '__main__':
    main()
