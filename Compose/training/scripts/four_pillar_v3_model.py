"""Versioned event-stream composer: v2 transfer is partial initialization, not resume."""
from pathlib import Path
import sys
import torch
from torch import nn
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'experiments'))
from streaming_event_model import StreamingEventModel
from four_pillar_codec import GROUP_BASE, PITCH_BASE,DYNAMICS,WEDGES

CONFIG = dict(event_features=32, width=192, heads=6, layers=4, window=256,
              planner_layers=3, history_bars=512, uint_bytes=10, voices=64)

class FourPillarStreamingV3(StreamingEventModel):
    def __init__(self, config=None):
        c = dict(CONFIG if config is None else config)
        self.config = c
        super().__init__(event_features=c['event_features'], width=c['width'], heads=c['heads'],
                         layers=c['layers'], window=c['window'])
        w = c['width']
        self.summary_input = nn.Linear(20, w)
        self.bar_position = nn.Embedding(c['history_bars'], w)
        layer = nn.TransformerEncoderLayer(w, c['heads'], 4*w, dropout=0., batch_first=True, norm_first=True)
        self.planner = nn.TransformerEncoder(layer, c['planner_layers'], enable_nested_tensor=False)
        self.harmony_root = nn.Linear(w, 12)
        self.harmony_quality = nn.Linear(w, 40)
        sizes = {'pitch':129, 'voice':c['voices'], 'delta_num':c['uint_bytes']*256,
                 'delta_den':c['uint_bytes']*256, 'duration_num':c['uint_bytes']*256,
                 'duration_den':c['uint_bytes']*256, 'velocity':128,
                 'drum_identity':128, 'event_kind':3, 'dynamic':len(DYNAMICS)+1,'accent':3,'wedge':len(WEDGES)+1}
        self.attributes = nn.ModuleDict({name:nn.Linear(w,size) for name,size in sizes.items()})
        self.controls = nn.Linear(32, w)
        self.group_embedding = nn.Embedding(7,w) # seventh row is source-unknown, never generated

    def plan_history(self, history, known):
        if history.shape[-1] != 20 or known.shape != history.shape[:2] or not known.any(1).all():
            raise ValueError('planner needs completed past bars and their source-known mask')
        length = history.shape[1]
        if length > self.config['history_bars']: raise ValueError('history exceeds model limit')
        x = self.summary_input(history) + self.bar_position(torch.arange(length,device=history.device))[None]
        causal = torch.triu(torch.ones(length,length,device=x.device,dtype=torch.bool),1)
        h = self.planner(x,mask=causal,src_key_padding_mask=~known)
        indices = torch.arange(length,device=x.device).expand_as(known).masked_fill(~known,-1).max(1).values
        return h[torch.arange(h.shape[0],device=x.device),indices][:,None]

    def heads(self, hidden, plan, group_ids=None):
        out=super().heads(hidden,plan,group_ids)
        out['event_kind']=self.attributes['event_kind'](hidden+self.plan(plan))
        if group_ids is not None:
            for name in ('delta_num','delta_den','duration_num','duration_den'):
                out[name]=out[name].reshape(*out[name].shape[:-1],self.config['uint_bytes'],256)
        return out

    def predict(self, events, history, known, controls, groups, caches=None):
        hidden, caches = self.backbone(events, caches=caches)
        plan = self.plan_history(history, known)
        heads = self.heads(hidden, plan + self.controls(controls), groups)
        heads['harmony_root'] = self.harmony_root(plan).expand(-1,events.shape[1],-1)
        heads['harmony_quality'] = self.harmony_quality(plan).expand(-1,events.shape[1],-1)
        return heads,caches

    def loss(self, batch):
        outputs,_ = self.predict(batch['events'],batch['history'],batch['history_known'],
                                 batch['controls'],batch['targets']['group'].clamp_min(0))
        losses = {}; total = 0
        for name,target in batch['targets'].items():
            known = batch['known'][name]
            count = int(known.sum())
            value = nn.functional.cross_entropy(outputs[name][known],target[known]) if count else outputs[name].sum()*0
            losses[name] = {'loss':float(value.detach()),'known':count}
            total = total + value
        if not torch.isfinite(total): raise FloatingPointError('nonfinite v3 objective')
        return total,losses

    def initialize_v2(self, state):
        if state.get('schema') != 'four-pillar-v2-state-2': raise ValueError('not a v2 training checkpoint')
        source = state['model']; target = self.state_dict(); copied = {}
        def copy(dst,src,rows=None):
            if src not in source: raise ValueError('missing v2 transfer tensor: '+src)
            value = source[src] if rows is None else source[src][rows]
            if value.shape != target[dst].shape: raise ValueError('incompatible transfer: '+dst)
            target[dst] = value.clone(); copied[dst] = src
        for name in target:
            if name.startswith(('summary_input.','bar_position.','planner.')): copy(name,'score.'+name)
            elif name.startswith(('harmony_root.','harmony_quality.')): copy(name,name)
        for i in range(self.config['layers']):
            prefix=f'blocks.{i}.'; old=f'score.decoder.layers.{i}.'
            for new,previous in [('attention.qkv','self_attn.in_proj'),('attention.out','self_attn.out_proj'),
                                 ('norm','norm1'),('ffnorm','norm3'),('ff.0','linear1'),('ff.2','linear2')]:
                for suffix in ('weight','bias'):
                    src=old+previous+('_'+suffix if previous=='self_attn.in_proj' else '.'+suffix)
                    copy(prefix+new+'.'+suffix,src)
        for suffix in ('weight','bias'):
            copy('group.'+suffix,'score.logits.'+suffix,slice(GROUP_BASE,GROUP_BASE+6))
            # Sounding-pitch labels are the same 128 MIDI values; the new unknown
            # row remains newly initialized and is never called an inherited label.
            dst='attributes.pitch.'+suffix; src='score.logits.'+suffix
            target[dst][:128] = source[src][PITCH_BASE:PITCH_BASE+128]; copied[dst+':128']=src
        for i in range(6): target['group_embedding.weight'][i]=source['score.token.weight'][GROUP_BASE+i]
        copied['group_embedding.weight:6']='score.token.weight:group rows'
        self.load_state_dict(target,strict=True)
        count=sum(target[name.split(':')[0]].numel() if ':' not in name else int(name.split(':')[1])*(self.config['width'] if 'weight' in name else 1) for name in copied)
        return {'parentStep':int(state['step']),'copiedParameters':count,
                'totalParameters':sum(p.numel() for p in self.parameters()),'tensorMapping':copied,
                'optimizerReset':True,'strictResumeCompatible':False,
                'changedSemantics':'RoPE and event packing require further training; same tensor shape is not functional parity'}
