"""Build an immutable minimal ALICE upload archive; never transfer files."""
import ast,hashlib,io,json,tarfile
from pathlib import Path
root=Path(__file__).resolve().parents[2];training=root/'training';scripts=training/'scripts'
output=training/'alice-preparation/AIlegro-four-pillar-v2-20261001.tar.gz'
if output.exists():raise FileExistsError(output)
todo=['train_four_pillar_v2'];modules=set()
while todo:
    name=todo.pop()
    if name in modules:continue
    modules.add(name)
    for node in ast.walk(ast.parse((scripts/(name+'.py')).read_text())):
        imports=([node.module] if isinstance(node,ast.ImportFrom) and node.module else
                 [n.name for n in node.names] if isinstance(node,ast.Import) else [])
        for imported in imports:
            imported=imported.split('.')[0]
            if (scripts/(imported+'.py')).is_file():todo.append(imported)
paths=[scripts/(n+'.py') for n in sorted(modules)]
paths += [training/'orchestra/groups.py',training/'orchestra/prepare.py']
rels=['data/four-pillar-midi-all-train-v1.json','data/four-pillar-v2-source-hashes.json',
'data/four-pillar-score-all-train-v1.sqlite','data/performance-labels-v1/score-events.jsonl.gz',
'data/joint/lieder-joint.npz','data/joint/lieder-joint.json',
'orchestra/work/data/pieces.json','orchestra/work/data/prepare.json',
'data/MIDI-Library/manifest.json',
'runs/four-pillar-v2-preview-20261001-step19193/state.pt',
'runs/four-pillar-v2-preview-20261001-step19193/manifest.json',
'runs/four-pillar-v2-preview-20261001-step19193/PREVIEW.json',
'data/sources/SOURCE.json','data/sources/CLASSICAL-CORPORA.json','data/sources/OpenScore-Lieder-LICENSE.txt',
'data/classical-score-v1/README.md','data/classical-score-v1/prepare.json',
'data/performance-labels-v1/README.md','FOUR-PILLAR-V2-TRAINING.md',
'alice-preparation/verify_checkpoint.py']
paths += [training/p for p in rels]
paths += sorted(p for p in (training/'orchestra/work/raw').rglob('*') if p.is_file() and p.suffix.lower() in ('.mid','.midi'))
paths += sorted(p for p in (training/'data/MIDI-Library').rglob('*') if p.is_file() and p.suffix.lower() in ('.mid','.midi'))
paths=list(dict.fromkeys(paths))
requirements=b'torch==2.14.0\nnumpy==2.4.6\nsymusic==0.6.0\n'
readme=b'''AIlegro ALICE minimal training bundle, 2026-10-01
Extract into /home/chenjc2/AIlegro after archive SHA-256 matches.
Verify members from that directory: sha256sum -c SHA256SUMS
Create a project-specific Python environment on ALICE. Local tested versions
are recorded in requirements-alice.txt; availability on Linux must be checked.
Do not copy the macOS virtual environment. No job is submitted by this bundle.

The current entry point uses CPU only. Do not reserve a GPU for this code.
On a compute allocation (not the login node), after environment setup:
python -B training/alice-preparation/verify_checkpoint.py
python -B -u training/scripts/train_four_pillar_v2.py --output-dir training/runs/alice-v2-20261001 --max-seconds 39600 --context 2048 --history-bars 512 --threads 6 --checkpoint-seconds 300 --init-checkpoint training/runs/four-pillar-v2-preview-20261001-step19193/state.pt --preflight
For training use the same command without --preflight. For interruption recovery
retain exactly the same arguments and add --resume. Choose a fresh output path
for another run. Training resets optimizer, sampling and elapsed time; all model
weights including the frozen prior are loaded strictly from the preview state.
The former best-base.pt is neither included nor required for this path.
Raw MIDI files outside membership exist solely to preserve inventory validation;
only frozen membership rows can be sampled. The corpus is training-only; no
held-out quality claim is made. Existing source rights restrictions still apply.
'''
records=[]
with tarfile.open(output,'w:gz',compresslevel=6) as archive:
    for i,p in enumerate(paths,1):
        name=p.relative_to(root).as_posix();data=p.read_bytes();digest=hashlib.sha256(data).hexdigest()
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644
        archive.addfile(info,io.BytesIO(data));records.append({'path':name,'bytes':len(data),'sha256':digest})
        if i%10000==0:print('packaged',i,flush=True)
    for name,data in [('requirements-alice.txt',requirements),('ALICE-README.txt',readme)]:
        info=tarfile.TarInfo(name);info.size=len(data);info.mode=0o644;archive.addfile(info,io.BytesIO(data));records.append({'path':name,'bytes':len(data),'sha256':hashlib.sha256(data).hexdigest()})
    sums=''.join(r['sha256']+'  '+r['path']+'\n' for r in records).encode()
    info=tarfile.TarInfo('SHA256SUMS');info.size=len(sums);info.mode=0o644;archive.addfile(info,io.BytesIO(sums))
inventory={'files':records,'count':len(records),'uncompressedBytes':sum(r['bytes'] for r in records)}
(output.parent/'upload-inventory.json').write_text(json.dumps(inventory,indent=2,ensure_ascii=False))
h=hashlib.sha256()
with output.open('rb') as stream:
    for block in iter(lambda:stream.read(1024*1024),b''):h.update(block)
(output.parent/(output.name+'.sha256')).write_text(h.hexdigest()+'  '+output.name+'\n')
print(json.dumps({'archive':str(output),'archiveBytes':output.stat().st_size,'sha256':h.hexdigest(),'files':len(records)},ensure_ascii=False),flush=True)
