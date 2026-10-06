import test from 'node:test';
import assert from 'node:assert/strict';
import {HARMONY_TRANSFORMER_WEIGHTS as W} from '../public/tonnetz/lib/harmony-transformer.js';
import {CHORD_VOCAB,BASE_CHORDS,QUALITIES,getChord,transposeChord,romanFor} from '../public/tonnetz/lib/chord-vocabulary.js';
import {transformerForward,predictNext,voiceChord,PALETTES} from '../public/tonnetz/lib/harmony-models.js';
import {KEYS,advanceTonality,keyNeighbors} from '../public/tonnetz/lib/tonality.js';
import {buildBarEvents} from '../public/tonnetz/accompaniment.js';
const near=(a,b,tol=1e-5)=>{assert.equal(a.length,b.length);a.forEach((x,i)=>Array.isArray(x)?near(x,b[i],tol):assert.ok(Math.abs(x-b[i])<tol, `${x} != ${b[i]}`));};

test('480 base harmonies, all 2172 chord-tone inversions and strict bass across all voicings',()=>{
  assert.equal(QUALITIES.length,40);assert.equal(BASE_CHORDS.length,480);assert.equal(CHORD_VOCAB.length,2172);
  assert.equal(new Set(CHORD_VOCAB.map(c=>c.id)).size,2172);
  for(const c of CHORD_VOCAB){
    const notes=voiceChord(c.id,[48,55,60,64]);
    assert.equal(notes[0]%12,c.bass,c.id);
    assert.deepEqual(new Set(notes.map(n=>n%12)),new Set(c.pcs),c.id);
    assert.ok(notes.every(n=>Number.isInteger(n)&&n>=40&&n<=88),c.id);
    assert.ok(notes.every((n,i)=>!i||n>notes[i-1]));
    for(const style of ['pop','jazz','classical']){
      const events=buildBarEvents(notes,{style,pattern:'bass-chord'});
      assert.ok(events.every(e=>Number.isFinite(e.midi)&&e.midi>=36));
      assert.equal(events[0].midi%12,c.bass,c.id);
    }
    assert.equal(transposeChord(transposeChord(c.id,7),-7),c.id);
  }
  assert.equal(romanFor('C/E'),'I6');assert.equal(romanFor('G7/F'),'V42');assert.equal(romanFor('C6/E'),'I6/E');
  assert.equal(romanFor('D♭/F'),'♭II6');assert.equal(getChord('C♯dim7').id,'D♭dim7');
});

test('exported inference matches independently computed PyTorch logits, inversion logits and all attention heads',()=>{
  assert.equal(W.architecture.layers,4);assert.equal(W.architecture.heads,8);assert.equal(W.architecture.contextLength,24);
  assert.equal(W.training.parameterCount,204391);
  assert.equal(W.training.coveredChordInversions,CHORD_VOCAB.length);
  assert.equal(getChord("A/C♯").label,"A/C♯");
  assert.ok(W.training.validationMetrics.crossEntropy<W.training.unigramValidationCrossEntropy);
  assert.match(W.training.corpus,/synthetic/);
  for(const p of W.parityProbes){const f=transformerForward(p.tokens,p);near(f.logits,p.logits);near(f.inversionLogits,p.inversionLogits);near(f.attentionLayers,p.attention);}
});

test('all 32 attention heads are causal, normalized and invariant to future chord changes',()=>{
  const a=transformerForward([0,5,127,0]);const b=transformerForward([0,5,132,17]);
  a.attentionLayers.forEach((layer,l)=>layer.forEach((head,h)=>head.forEach((row,t)=>{
    assert.ok(Math.abs(row.reduce((x,y)=>x+y,0)-1)<1e-10);
    row.forEach((p,j)=>assert.ok(j<=t?p>=0:p===0));
    if(t<2)near(row,b.attentionLayers[l][h][t],1e-12);
  })));
  const headSignatures=a.attentionLayers.flatMap(l=>l.map(h=>JSON.stringify(h.at(-1))));
  assert.equal(new Set(headSignatures).size,32,'heads must contain distinct learned attention');
});

test('all palettes keep the full vocabulary and must change harmony even across inversions',()=>{
  for(const palette of PALETTES){
    const result=predictNext(['C','Dm7','G7/B'],{palette:palette.id,temperature:.9});
    assert.equal(result.distribution.length,2172);assert.equal(palette.chordIds.length,2172);
    assert.ok(Math.abs(result.distribution.reduce((s,x)=>s+x.probability,0)-1)<1e-10);
    for(const x of result.distribution){assert.ok(Number.isFinite(x.probability));assert.equal(x.probability===0,getChord(x.id).baseIndex===getChord('G7/B').baseIndex);}
  }
});

test('key and chord inversions transpose equivariantly through all 24 keys',()=>{
  for(const mode of ['major','minor']){
    const history=mode==='major'?['C/E','Dm7/F','G7/B']:['Cm/E♭','Dø7/F','G7/B'];
    const source=predictNext(history,{key:{tonic:0,mode},palette:'classical'});
    for(let tonic=1;tonic<12;tonic++){
      const shifted=predictNext(history.map(c=>transposeChord(c,tonic)),{key:{tonic,mode},palette:'classical'});
      const lookup=new Map(shifted.distribution.map(p=>[p.id,p.probability]));
      for(const p of source.distribution)assert.ok(Math.abs(lookup.get(transposeChord(p.id,tonic))-p.probability)<1e-12);
    }
  }
});

test('temperature, minor mode and earlier history affect the learned predictions',()=>{
  const run=(history,options={})=>predictNext(history,{palette:'jazz',...options}).distribution;
  const entropy=d=>-d.reduce((s,x)=>s+(x.probability?x.probability*Math.log(x.probability):0),0);
  assert.ok(entropy(run(['C','Dm7','G7'],{temperature:1.6}))>entropy(run(['C','Dm7','G7'],{temperature:.6})));
  assert.notDeepEqual(run(['C','G']),run(['Am','G']));
  assert.notDeepEqual(run(['C','G']),run(['C','G'],{key:{tonic:0,mode:'minor'}}));
  const cadence=run(['Cmaj7','Dm7','G7/B']).slice(0,3);
  assert.ok(cadence.every(c=>getChord(c.id).root===0),'ii-V should strongly favor tonic jazz resolutions');
});

test('key walk uses its own slow clock, supports 24 keys and never changes the fixed key',()=>{
  assert.equal(KEYS.length,24);
  for(const key of KEYS){
    const fixed=advanceTonality({key,keyAge:7,keyWalk:false,keyEvery:8},'C',()=>{throw Error('Must not draw');});
    assert.deepEqual(fixed,{key,keyAge:0});
    for(let keyAge=0;keyAge<7;keyAge++)assert.deepEqual(advanceTonality({key,keyAge,keyWalk:true,keyEvery:8},'C',()=>{throw Error('Too early');}),{key,keyAge:keyAge+1});
    const changed=advanceTonality({key,keyAge:7,keyWalk:true,keyEvery:8},'C',()=>.99);
    assert.notDeepEqual(changed.key,key);assert.equal(changed.keyAge,0);
    assert.ok(keyNeighbors(key).some(n=>JSON.stringify(n.key)===JSON.stringify(changed.key)));
  }
  assert.throws(()=>advanceTonality({keyWalk:true,keyEvery:0}),/Invalid/);
});
