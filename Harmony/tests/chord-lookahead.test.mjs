import test from "node:test";
import assert from "node:assert/strict";
import { createChordLookahead } from "../public/tonnetz/chord-lookahead.js";
import { predictNext, sampleDistribution, prepareModels, PALETTES, MODEL_IDS } from "../public/tonnetz/lib/harmony-models.js";

test("loop lookahead wraps any length and the next three advertised chords are consumed in order", () => {
  const queue = createChordLookahead({ predict: () => { throw Error("Not needed"); } });
  for (const sequence of [["C", "G", "Am", "F"], ["Dm", "G", "C"], ["F", "G", "Em", "Am", "Dm", "G", "C"]]) {
    queue.reset({ mode: "progression", current: sequence.at(-1), sequence, step: sequence.length - 1, history: [sequence.at(-1)] });
    for (let i = 0; i < sequence.length * 2; i++) {
      const advertised = queue.view().slice(1);
      assert.deepEqual(queue.advance(), advertised[0]);
      assert.deepEqual(queue.view().slice(0, 3), advertised);
      assert.equal(queue.view().length, 4);
    }
  }
});

test("generated preview uses virtual history, stays stable on reads, and samples only one replacement per bar", () => {
  const calls = [];
  const order = { C: "G", G: "Am", Am: "F", F: "C" };
  const queue = createChordLookahead({
    predict: (history, options) => { calls.push({ history, options }); return { distribution: [{ id: order[history.at(-1)] }] }; },
    sample: (distribution) => distribution[0].id
  });
  const history = ["F", "C"];
  queue.reset({ mode: "generate", current: "C", history, options: { model: "transformer", temperature: .82 } });
  assert.deepEqual(queue.view().map(x => x.id), ["C", "G", "Am", "F"]);
  assert.deepEqual(history, ["F", "C"], "lookahead cannot pollute the sounding history");
  assert.deepEqual(calls[2].history, ["F", "C", "G", "Am"]);
  queue.view(); queue.view();
  assert.equal(calls.length, 3, "UI renders cannot reroll the future");
  queue.advance();
  assert.equal(calls.length, 4);
  assert.deepEqual(queue.view().map(x => x.id), ["G", "Am", "F", "C"]);
});

test("manual changes and model parameters replace the future, while Hold repeats the current chord", () => {
  const queue = createChordLookahead({ predict: (_, options) => ({ distribution: [{ id: options.palette }] }), sample: (d) => d[0].id });
  queue.reset({ mode: "generate", current: "C", history: ["C"], options: { palette: "G" } });
  queue.reset({ mode: "generate", current: "F", history: ["C", "F"], options: { palette: "Am" } });
  assert.deepEqual(queue.view().map(x => x.id), ["F", "Am", "Am", "Am"]);
  queue.reset({ mode: "hold", current: "Dm7", history: ["Dm7"] });
  queue.advance();
  assert.deepEqual(queue.view().map(x => x.id), ["Dm7", "Dm7", "Dm7", "Dm7"]);
  const copy = queue.view(); copy[0].id = "C";
  assert.equal(queue.view()[0].id, "Dm7");
});

test("all real models and palettes generate playable committed futures without consecutive repeats", async () => {
  await prepareModels();
  for (const model of MODEL_IDS) for (const palette of PALETTES) {
    const queue = createChordLookahead({ predict: predictNext, sample: d => sampleDistribution(d, () => .47) });
    queue.reset({ mode: "generate", current: "C", history: ["G", "C"], options: { model, palette: palette.id, temperature: 1.1 } });
    for (let bar = 0; bar < 12; bar++) {
      const view = queue.view();
      view.slice(1).forEach((entry, i) => {
        assert.ok(palette.chordIds.includes(entry.id));
        assert.notEqual(entry.id, view[i].id);
      });
      assert.deepEqual(queue.advance(), view[1]);
    }
  }
});

test('advertised keys commit only when consumed, and Hold freezes the tonal clock',()=>{
  let keyDraws=0;
  const options={key:{tonic:0,mode:'major'},keyAge:2,keyWalk:true,keyEvery:4};
  const queue=createChordLookahead({predict:()=>({distribution:[{id:'G'}]}),sample:d=>d[0].id,randomKey:()=>{keyDraws++;return .99;}});
  queue.reset({mode:'generate',current:'C',history:['C'],options});
  const advertised=queue.view();
  assert.deepEqual(advertised[0].key,options.key);assert.equal(advertised[1].key.mode,'major');assert.equal(advertised[2].key.mode,'minor');
  const reads=keyDraws;queue.view();queue.view();assert.equal(keyDraws,reads);
  queue.advance();assert.deepEqual(queue.view().slice(0,3),advertised.slice(1));
  queue.view()[0].key.tonic=7;assert.equal(queue.view()[0].key.tonic,0);
  queue.reset({mode:'hold',current:'C/E',history:['C/E'],options});
  const draws=keyDraws;for(let n=0;n<20;n++)queue.advance();assert.equal(keyDraws,draws);assert.ok(queue.view().every(x=>x.keyAge===2&&x.key.tonic===0));
});

test('editing a future chord preserves prefix and reconditions only the downstream future',()=>{
 const calls=[],order={C:'G',G:'Am',Am:'F',F:'C','D♭/F':'G7',G7:'C'};
 const queue=createChordLookahead({predict:(h,o)=>{calls.push([...h]);return {distribution:[{id:order[h.at(-1)]||'C'}]};},sample:d=>d[0].id});
 queue.reset({mode:'generate',current:'C',history:['Dm','G7','C']});
 const before=queue.view(),count=calls.length;
 queue.replaceFuture(before[2].uid,'D♭/F');
 const after=queue.view();assert.deepEqual(after.slice(0,2),before.slice(0,2));
 assert.equal(after[2].id,'D♭/F');assert.equal(after[2].uid,before[2].uid);assert.equal(after[3].id,'G7');
 assert.equal(calls.length,count+1);assert.deepEqual(calls.at(-1),['Dm','G7','C','G','D♭/F']);
 queue.advance();assert.equal(queue.view()[1].id,'D♭/F');queue.advance();assert.equal(queue.view()[0].id,'D♭/F');
 assert.equal(queue.replaceFuture(before[2].uid,'Am'),false,'a sounding chord cannot be overwritten through a stale future dialog');
});
test('future edit follows stable identity as bars advance and converts only the downstream part of a loop',()=>{
 const queue=createChordLookahead({predict:h=>({distribution:[{id:h.at(-1)==='Fm'?'G7':'C'}]}),sample:d=>d[0].id});
 queue.reset({mode:'progression',current:'C',history:['C'],sequence:['C','G','Am','F']});
 const before=queue.view();queue.advance();
 assert.equal(queue.contextFor(before[2].uid).index,1);
 queue.replaceFuture(before[2].uid,'Fm');
 assert.deepEqual(queue.view().map(e=>e.id),['G','Fm','G7','C']);
 assert.equal(queue.contextFor(before[0].uid),null);
 const ids=queue.view().map(e=>e.uid);queue.view();assert.deepEqual(queue.view().map(e=>e.uid),ids);
});

test('a chromatic intervention reconditions the real Transformer distribution without rewriting its prefix',async()=>{
 await prepareModels();
 const calls=[];
 const queue=createChordLookahead({predict:(history,options)=>{const result=predictNext(history,options);calls.push({history:[...history],result});return result;},sample:d=>sampleDistribution(d,()=>.34)});
 queue.reset({mode:'generate',current:'C',history:['Dm','G7','C'],options:{key:{tonic:0,mode:'major'},palette:'jazz',temperature:.85}});
 const before=queue.view(),original=calls.at(-1).result.distribution;
 queue.replaceFuture(before[2].uid,'Dbmaj7/F');
 assert.deepEqual(queue.view().slice(0,2),before.slice(0,2));
 assert.equal(calls.at(-1).history.at(-1),'Dbmaj7/F');
 const revised=calls.at(-1).result.distribution;
 assert.ok(Math.abs(revised.reduce((s,x)=>s+x.probability,0)-1)<1e-10);
 const old=new Map(original.map(x=>[x.id,x.probability]));
 assert.ok(revised.reduce((s,x)=>s+Math.abs(x.probability-(old.get(x.id)||0)),0)>.01);
});
