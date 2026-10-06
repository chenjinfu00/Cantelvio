import json,sys
from pathlib import Path
from unittest.mock import patch
import torch
root=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'scripts'))
from four_pillar_v2_runtime import model_from_checkpoint
p=root/'runs/four-pillar-v2-preview-20261001-step19193/state.pt'
m=json.loads(p.with_name('manifest.json').read_text());config=m['runConfig']['architecture']
original=torch.load
opened=[]
def guarded(path,*args,**kwargs):
    opened.append(str(path))
    if Path(path).resolve()!=p.resolve():raise AssertionError('unexpected checkpoint read: '+str(path))
    return original(path,*args,**kwargs)
torch.set_num_threads(1)
with patch('torch.load',guarded):model=model_from_checkpoint(p,config=config)
state=original(p,weights_only=False,map_location='cpu')
assert all(torch.equal(v,state['model'][k]) for k,v in model.state_dict().items())
assert not any(p.requires_grad for p in model.legacy.parameters())
assert not model.legacy.training
bad={**config,'history_bars':32}
try:model_from_checkpoint(p,config=bad)
except ValueError:pass
else:raise AssertionError('incompatible architecture accepted')
print(json.dumps({'allTensorsEqual':True,'tensorCount':len(model.state_dict()),'legacyFrozen':True,'onlyCurrentCheckpointRead':opened,'incompatibleArchitectureRejected':True}))
