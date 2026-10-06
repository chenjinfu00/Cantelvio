"""Persistent local v2 session: exact score context and RNG across four-bar chunks."""
import json
import sys
from dataclasses import replace
from pathlib import Path
import torch
from four_pillar_midi_data import slice_score, sha256
from four_pillar_score_index import open_index, get_score
from four_pillar_v2_model import FourPillarExpressiveV2
from four_pillar_v2_decode import generate


def compact(score, history_bars):
    """Bound retained score; carry still-sounding notes into the first retained bar."""
    drop = max(0, len(score.measures) - history_bars)
    if not drop:
        return score
    boundary = score.measures[drop].onset
    notes = tuple(replace(n, onset=max(n.onset, boundary),
        duration=n.end-max(n.onset, boundary), bar=max(0, n.bar-drop))
        for n in score.events if n.end > boundary or (n.grace and n.onset >= boundary))
    parts_used = {n.part for n in notes}
    parts = tuple(replace(p, index=i) for i, p in enumerate(
        p for p in score.parts if p.id in parts_used))
    return replace(score, parts=parts,
        measures=tuple(replace(m, index=i) for i,m in enumerate(score.measures[drop:])), events=notes)


def sample_chunk(score, audit, first, first_bar, seed):
    start = score.measures[first].onset
    end = score.measures[-1].onset + score.measures[-1].duration
    # Notes already played retain their sounding tails in the preceding audio
    # buffer, so do not retrigger them at the next segment boundary.
    notes = [{'quarter': float(n.onset-start), 'duration': float(n.duration),
              'pitch': n.pitch, 'group': n.group or 'keys',
              'velocity': audit['velocities'].get(n.source_index,72), 'generated': n.bar>=2}
             for n in score.events if n.bar >= first and n.pitch is not None]
    return {'notes': notes, 'bars':4, 'firstBar':first_bar, 'seed':seed,
        'totalQuarters':float(end-start),
        'barEvents':[{'quarter':float(m.onset-start),'bpm':audit['tempoMap'][0][1]}
                     for m in score.measures[first:]],
        'resourceClosures':audit['resourceClosures'],
        'unpitchedOmitted':sum(n.pitch is None and n.bar>=first for n in score.events)}


def main():
    init=json.loads(sys.stdin.readline())
    root=Path(__file__).resolve().parents[1]
    checkpoint=root/'runs/four-pillar-v2-preview-20261001-step19193/state.pt'
    manifest_path=checkpoint.with_name('manifest.json')
    manifest=json.loads(manifest_path.read_text())
    torch.set_num_threads(4)
    state=torch.load(checkpoint,map_location='cpu',weights_only=False)
    if (manifest['schema']!='four-pillar-v2-complete-training-paths-2'
        or state['schema']!='four-pillar-v2-state-2'
        or state['manifestSha256']!=sha256(manifest_path)):
        raise ValueError('Checkpoint/manifest mismatch')
    model=FourPillarExpressiveV2(**manifest['runConfig']['architecture'])
    model.load_state_dict(state['model'],strict=True)
    from four_pillar_v2_inference_cache import install
    install(model)
    db=open_index(root/'data/four-pillar-score-all-train-v1.sqlite')
    try: score=slice_score(get_score(db,init['scoreId']),0,2)
    finally: db.close()
    rng=torch.Generator().manual_seed(init['seed'])
    index=0
    for line in sys.stdin:
        options=json.loads(line)
        first=len(score.measures)
        # First segment includes the two original prompt bars; later chunks
        # contain four new bars, all conditioned on committed earlier music.
        score,audit=generate(model,score,bars=2 if index==0 else 4,
            seed=init['seed'],generator=rng,temperature=options['temperature'],
            qpm=options['tempo'],groups=tuple(options['groups']),max_notes=128)
        sample=sample_chunk(score,audit,0 if index==0 else first,index*4,init['seed'])
        sample['checkpointStep']=state['step']
        print(json.dumps({'index':index,'sample':sample}),flush=True)
        score=compact(score,model.score.config['history_bars'])
        index+=1


if __name__=='__main__':
    main()
