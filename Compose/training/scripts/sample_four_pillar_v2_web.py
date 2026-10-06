"""Local web audition of the trained v2 checkpoint using free event decoding."""
import argparse
import json
from pathlib import Path
import torch
from four_pillar_midi_data import slice_score, sha256
from four_pillar_score_index import open_index, get_score
from four_pillar_v2_model import FourPillarExpressiveV2
from four_pillar_v2_decode import generate

p = argparse.ArgumentParser(description=__doc__)
p.add_argument('--score-id', required=True)
p.add_argument('--seed', type=int, required=True)
p.add_argument('--temperature', type=float, required=True)
p.add_argument('--groups', required=True)
p.add_argument('--tempo', type=int, required=True)
a = p.parse_args()
root = Path(__file__).resolve().parents[1]
checkpoint = root / 'runs/four-pillar-v2-preview-20261001-step19193/state.pt'
manifest_path = checkpoint.with_name('manifest.json')
manifest = json.loads(manifest_path.read_text())
if manifest['schema'] != 'four-pillar-v2-complete-training-paths-2':
    raise ValueError('Unsupported v2 manifest')
torch.set_num_threads(4)
state = torch.load(checkpoint, map_location='cpu', weights_only=False)
if state['schema'] != 'four-pillar-v2-state-2' or state['manifestSha256'] != sha256(manifest_path):
    raise ValueError('Checkpoint/manifest mismatch')
model = FourPillarExpressiveV2(**manifest['runConfig']['architecture'])
model.load_state_dict(state['model'], strict=True)
db = open_index(root / 'data/four-pillar-score-all-train-v1.sqlite')
try:
    score = get_score(db, a.score_id)
finally:
    db.close()
prompt = slice_score(score, 0, 2)
result, audit = generate(model, prompt, bars=2, seed=a.seed,
    temperature=a.temperature, qpm=a.tempo, groups=tuple(a.groups.split(',')), max_notes=128)
notes = [{'quarter': float(n.onset), 'duration': float(n.duration),
          'pitch': n.pitch, 'group': n.group or 'keys',
          'velocity': audit['velocities'].get(n.source_index, 72),
          'generated': n.bar >= 2} for n in result.events if n.pitch is not None]
end = float(result.measures[-1].onset + result.measures[-1].duration)
print(json.dumps({'promptBars': 2, 'generatedBars': 2, 'notes': notes,
    'totalQuarters': max(end, max((n['quarter'] + n['duration'] for n in notes), default=end)),
    'barEvents': [{'quarter': float(m.onset), 'bpm': a.tempo} for m in result.measures],
    'checkpointStep': state['step'], 'checkpointSha256': sha256(checkpoint),
    'resourceClosures': audit['resourceClosures'],
    'unpitchedOmitted': sum(n.pitch is None for n in result.events),
    'evaluationStatus': 'Training-source prompt; not independent evaluation'}))
