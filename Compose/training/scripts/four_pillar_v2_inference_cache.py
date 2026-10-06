"""Inference-only caches; reuse exact causal decoder prefixes and static planning.

No weight or feature encoding changes. Rebuild on prefix eviction, changed
memory, or changed inputs. Kept separate from the checkpoint/training model.
"""
import torch
import math
from types import MethodType
from torch import nn
from torch.nn import functional as F


def clone_tree(value):
    if isinstance(value,torch.Tensor): return value.clone()
    if isinstance(value,tuple): return tuple(clone_tree(v) for v in value)
    if isinstance(value,dict): return {k:clone_tree(v) for k,v in value.items()}
    return value


def same(a,b):
    if isinstance(a,torch.Tensor): return isinstance(b,torch.Tensor) and torch.equal(a,b)
    if isinstance(a,tuple): return isinstance(b,tuple) and len(a)==len(b) and all(same(x,y) for x,y in zip(a,b))
    if isinstance(a,dict): return isinstance(b,dict) and a.keys()==b.keys() and all(same(a[k],b[k]) for k in a)
    return a==b


class StaticCache(nn.Module):
    def __init__(self,module):
        super().__init__();self.module=module;self.inputs=None;self.result=None
    def forward(self,*args,**kwargs):
        inputs=(args,kwargs)
        if not same(inputs,self.inputs):
            self.result=self.module(*args,**kwargs);self.inputs=clone_tree(inputs)
        return self.result


class CausalDecoderCache(nn.Module):
    def __init__(self,module,last_only=False):
        super().__init__();self.last_only=last_only;self.module=module;self.previous=None;self.memory=None
        self.pad=None;self.keys=[];self.values=[];self.output=None
        self.cross_keys=[];self.cross_values=[]

    def forward(self,tgt,memory,tgt_mask=None,memory_key_padding_mask=None,**kwargs):
        if self.training: raise ValueError('Inference cache cannot train')
        length=tgt.shape[1]
        memory_same=same(memory,self.memory) and same(memory_key_padding_mask,self.pad)
        # A clock update can alter the latest token at unchanged sequence length.
        # Keep only a prefix whose embeddings and cross-attention memory match.
        prefix=0
        if self.previous is not None and memory_same:
            candidate=min(self.previous.shape[1],length-1)
            if torch.equal(tgt[:,:candidate],self.previous[:,:candidate]):prefix=candidate
        x=tgt[:,prefix:]
        fresh_keys=[];fresh_values=[]
        for i,layer in enumerate(self.module.layers):
            if not layer.norm_first:raise ValueError('Cache needs norm-first decoder')
            normalized=layer.norm1(x)
            attn=layer.self_attn
            q,k,v=F.linear(normalized,attn.in_proj_weight,attn.in_proj_bias).chunk(3,dim=-1)
            batch,steps,width=q.shape;heads=attn.num_heads;dim=width//heads
            def split(t):return t.view(batch,steps,heads,dim).transpose(1,2)
            q,k,v=map(split,(q,k,v))
            if prefix:
                k=torch.cat((self.keys[i][:,:,:prefix],k),dim=2)
                v=torch.cat((self.values[i][:,:,:prefix],v),dim=2)
            mask=torch.arange(length)[None,:]<=torch.arange(prefix,length)[:,None]
            attended=F.scaled_dot_product_attention(q,k,v,attn_mask=mask,dropout_p=0.)
            attended=attended.transpose(1,2).reshape(batch,steps,width)
            x=x+layer.dropout1(attn.out_proj(attended))
            # The planner/chord memory is constant throughout a generated bar.
            # Project its keys and values once, rather than for every token.
            cross_attn=layer.multihead_attn
            width=cross_attn.embed_dim;heads=cross_attn.num_heads;dim=width//heads
            def cross_split(t):return t.view(t.shape[0],t.shape[1],heads,dim).transpose(1,2)
            weight=cross_attn.in_proj_weight;bias=cross_attn.in_proj_bias
            query=cross_split(F.linear(layer.norm2(x),weight[:width],None if bias is None else bias[:width]))
            if not memory_same or len(self.cross_keys)<=i:
                key,value=F.linear(memory,weight[width:],None if bias is None else bias[width:]).chunk(2,dim=-1)
                key,value=cross_split(key),cross_split(value)
                if len(self.cross_keys)<=i:
                    self.cross_keys.append(key);self.cross_values.append(value)
                else:self.cross_keys[i],self.cross_values[i]=key,value
            cross_mask=None if memory_key_padding_mask is None else ~memory_key_padding_mask[:,None,None,:]
            cross=F.scaled_dot_product_attention(query,self.cross_keys[i],self.cross_values[i],attn_mask=cross_mask,dropout_p=0.)
            cross=cross.transpose(1,2).reshape(x.shape[0],x.shape[1],width)
            cross=cross_attn.out_proj(cross)
            x=x+layer.dropout2(cross)
            x=x+layer.dropout3(layer.linear2(layer.dropout(layer.activation(layer.linear1(layer.norm3(x))))))
            fresh_keys.append(k);fresh_values.append(v)
        if self.module.norm is not None:x=self.module.norm(x)
        self.output=torch.cat((self.output[:,:prefix],x),dim=1) if prefix else x
        self.keys,self.values=fresh_keys,fresh_values
        self.previous=tgt.clone();self.memory=memory.clone();self.pad=clone_tree(memory_key_padding_mask)
        return self.output[:,-1:] if self.last_only else self.output


class PrefixLinearCache(nn.Module):
    def __init__(self,module):
        super().__init__();self.module=module;self.previous=None;self.output=None
    def forward(self,value):
        prefix=0
        if self.previous is not None and self.previous.shape[2:]==value.shape[2:]:
            candidate=min(self.previous.shape[1],value.shape[1]-1)
            if torch.equal(self.previous[:,:candidate],value[:,:candidate]):prefix=candidate
        tail=self.module(value[:,prefix:])
        self.output=torch.cat((self.output[:,:prefix],tail),dim=1) if prefix else tail
        self.previous=value.clone()
        return self.output


class PointerBroadcast(nn.Module):
    """The existing pointer head scatters against full-prefix registry counts.
    Only its final row is sampled, so broadcast the final NEW_VOICE score.
    """
    def __init__(self,module,decoder):
        super().__init__();self.module=module
        # Avoid registering the decoder twice in the module tree.
        object.__setattr__(self,'decoder',decoder)
    def forward(self,event):
        value=self.module(event)
        return value.expand(-1,self.decoder.previous.shape[1],-1)


class EventInferenceCache:
    """Inference-only final-event path, retaining the original forward as oracle.

    Planning and cross-attention memory are taken from the original model once
    per conditioning change. Causal feedback is projected only for new rows,
    and the pointer head scores only the row that will actually be sampled.
    """
    causal_names={'decoder_input','voice_features','voice_known','voice_pointer_input','timeline'}
    unsupported={'allowed_groups','allowed_roles','allowed_pitches','locked_tokens','locked_mask',
                 'voice_allowed','allow_new_voice','causal_additions','planner_additions'}
    def __init__(self,model):
        self.original=model.forward;self.signature=None;self.static=None;self.previous=None
    def fallback(self,model,inputs):
        self.signature=None
        decoder=model.score.decoder;last_only=decoder.last_only
        decoder.last_only=False
        try:return self.original(**inputs)
        finally:decoder.last_only=last_only
    def forward(self,model,**inputs):
        if model.training:raise ValueError('Event inference cache cannot train')
        if any(inputs.get(k) is not None for k in self.unsupported):
            return self.fallback(model,inputs)
        signature={k:v for k,v in inputs.items() if k not in self.causal_names}
        if not same(signature,self.signature):
            output=self.original(**inputs)
            self.signature=clone_tree(signature);self.static=output
            self.memory=model.score.decoder.memory.clone();self.pad=clone_tree(model.score.decoder.pad)
            self.previous=None
            return output
        tokens=inputs['decoder_input'];features=inputs['voice_features'];known=inputs['voice_known']
        pointer=inputs['voice_pointer_input'];timeline=inputs.get('timeline')
        if features.ndim!=4 or tokens.shape[0]!=1:
            return self.fallback(model,inputs)
        length=tokens.shape[1];voices=features.shape[2];width=model.score.config['width']
        counts=known.long().sum(-1)
        selected=(features.gather(2,pointer.clamp(0,max(0,voices-1))[...,None,None].expand(-1,-1,1,16)).squeeze(2)
                  if voices else torch.zeros(1,length,16))
        values=(tokens,pointer,counts,selected,timeline)
        prefix=0
        if self.previous is not None:
            candidate=min(self.target.shape[1],length-1)
            if all((a is None and b is None) or (a is not None and b is not None and torch.equal(a[:,:candidate],b[:,:candidate]))
                   for a,b in zip(values,self.previous)):prefix=candidate
        positions=torch.arange(prefix,length,device=tokens.device)
        tail=model.score.token(tokens[:,prefix:])+model.score.token_position(positions)[None]
        voice_linear=model.voice_key.module
        feedback=voice_linear(selected[:,prefix:])
        dimensions=torch.arange(0,width,2,device=tokens.device)
        frequencies=torch.exp(-math.log(10000.)*dimensions/width)
        phase=pointer[:,prefix:].clamp(min=0)[...,None]*frequencies
        identity=torch.zeros_like(feedback);identity[...,0::2]=phase.sin();identity[...,1::2]=phase.cos()
        feedback=feedback+identity
        from four_pillar_v1_codec import VOICE_CHOICE
        feedback=torch.where((pointer[:,prefix:]==counts[:,prefix:])[...,None],model.new_voice_feedback[None,None],feedback)
        feedback=feedback*(tokens[:,prefix:]==VOICE_CHOICE)[...,None]
        if timeline is not None:feedback=feedback+model.timeline_input.module(timeline[:,prefix:])
        tail=tail+feedback
        self.target=torch.cat((self.target[:,:prefix],tail),1) if prefix else tail
        self.previous=clone_tree(values)
        event=model.score.decoder(self.target,self.memory,memory_key_padding_mask=self.pad)
        last_features=features[:,-1:];keys=voice_linear(last_features)
        phase=torch.arange(voices,device=tokens.device)[:,None]*frequencies[None]
        identity=torch.zeros(voices,width,device=tokens.device)
        identity[:,0::2],identity[:,1::2]=phase.sin(),phase.cos()
        keys=keys+identity[None,None]
        query=model.voice_query(event)
        pointers=torch.einsum('bld,blnd->bln',query,keys)/math.sqrt(width)
        pointers=pointers.masked_fill(~known[:,-1:],torch.finfo(pointers.dtype).min)
        logits=torch.full((1,1,voices+1),torch.finfo(pointers.dtype).min,device=tokens.device)
        logits[...,:voices]=pointers
        logits.scatter_(2,counts[:,-1:,None],model.new_voice.module(event))
        dynamic=model.numeric_dynamic(event);velocity=model.midi_velocity(event)
        dynamic=torch.stack((dynamic[...,0],dynamic[...,1].clamp(-4,2)),-1)
        velocity=torch.stack((velocity[...,0],velocity[...,1].clamp(-4,2)),-1)
        return {**self.static,'tokens':model.score.logits(event),'event_hidden':event,
                'voice_pointer':logits,'numeric_dynamic':dynamic,'midi_velocity':velocity}


def install(model,*,last_only=False,event_only=False):
    model.eval()
    model.score.planner=StaticCache(model.score.planner).eval()
    model.score.material_encoder=StaticCache(model.score.material_encoder).eval()
    model.score.decoder=CausalDecoderCache(model.score.decoder,last_only=last_only).eval()
    model.voice_key=PrefixLinearCache(model.voice_key).eval()
    model.timeline_input=PrefixLinearCache(model.timeline_input).eval()
    if last_only:model.new_voice=PointerBroadcast(model.new_voice,model.score.decoder).eval()
    if event_only:
        if not last_only:raise ValueError('Event cache requires last-token decoding')
        cache=EventInferenceCache(model)
        model.forward=MethodType(cache.forward,model)
    return model
