import test from 'node:test';
import assert from 'node:assert/strict';
import { KaraokeAudio } from '../public/karaoke/karaoke-audio.js';

function deferred() {
  let resolve;
  const promise = new Promise(r => { resolve = r; });
  return { promise, resolve };
}

function stubGlobals(t, replacements) {
  for (const [key, value] of Object.entries(replacements)) {
    const original = globalThis[key];
    globalThis[key] = value;
    t.after(() => { if (original === undefined) delete globalThis[key]; else globalThis[key] = original; });
  }
}

for (const method of ['frequencies', 'frequencySteps']) {
  test(`stop while ${method} resumes cannot create a later voice`, async t => {
    const pending = deferred();
    let voices = 0;
    class Context {
      state = 'suspended'; currentTime = 0;
      resume() { return pending.promise; }
      createOscillator() { voices++; throw new Error('a cancelled voice was created'); }
    }
    stubGlobals(t, { document:{querySelectorAll:()=>[]}, window:{AudioContext:Context}, cancelAnimationFrame:()=>{} });
    const audio = new KaraokeAudio(null);
    const playing = audio[method]([220], null);
    audio.stop();
    pending.resolve();
    assert.equal(await playing, false);
    assert.equal(voices, 0);
    assert.equal(audio.timers.size, 0);
  });
}

test('stopping while media.play is pending settles the voice order', async t => {
  const pending = deferred();
  const started = deferred();
  class Media extends EventTarget {
    play() { started.resolve(); return pending.promise; }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  stubGlobals(t, { document:{querySelectorAll:()=>[],baseURI:'http://localhost/karaoke/'}, Audio:Media, cancelAnimationFrame:()=>{} });
  const audio = new KaraokeAudio(null);
  audio.manifest = {clips:{ah:{src:'ah.wav'}}};
  const playing = audio.playClipSequence(['ah'], null);
  await started.promise;
  audio.stop();
  pending.resolve();
  const outcome = await Promise.race([playing, new Promise(resolve=>setTimeout(()=>resolve('still pending'),50))]);
  assert.equal(outcome, false);
  assert.equal(audio.sequenceCancel, null);
});

test('a vocal clip reports completion only after its natural media end', async t => {
  class Media extends EventTarget {
    currentTime = 0; duration = 1;
    play() { queueMicrotask(() => this.dispatchEvent(new Event('ended'))); return Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  stubGlobals(t, {
    document:{querySelectorAll:()=>[],baseURI:'http://localhost/karaoke/'}, Audio:Media,
    requestAnimationFrame:()=>1, cancelAnimationFrame:()=>{}
  });
  const audio = new KaraokeAudio(null);
  audio.manifest = {clips:{voice:{src:'voice.wav',duration:1,cues:[]}}};
  assert.equal(await audio.playClip('voice', null), true);
  assert.equal(audio.media, null);
});

test('a sampler failure aborts a chord sequence instead of silently unlocking', async t => {
  stubGlobals(t, { document:{querySelectorAll:()=>[]}, cancelAnimationFrame:()=>{} });
  const sampler = { prepare:async()=>true, playMidi:()=>false, stopAll:()=>{} };
  const audio = new KaraokeAudio(null);
  audio.setSampler(sampler);
  assert.equal(await audio.sequence([[60,64,67]], null, null, 1), false);
  assert.equal(audio.timers.size, 0);
});

test('a partially started chord is silenced and unwatched when a later note fails', async t => {
  stubGlobals(t, { document:{querySelectorAll:()=>[]}, cancelAnimationFrame:()=>{} });
  const context = new EventTarget();
  context.state = 'running';
  let attempts = 0, stops = 0;
  const sampler = {
    context,
    prepare: async () => true,
    playMidi: () => ++attempts === 1,
    stopAll: () => { stops++; }
  };
  const status = { textContent:'' };
  const audio = new KaraokeAudio(null,status);
  audio.setSampler(sampler);
  assert.equal(await audio.chord([60,64],null),false);
  assert.equal(attempts,2);
  assert.equal(stops,2, 'the initial reset and partial-chord cleanup both stop active voices');
  assert.equal(audio.unwatchContext,null);
  assert.match(status.textContent,/unavailable/);
});

test('a late error from a stopped clip cannot cancel the new clip frame', async t => {
  const media = [];
  let frame = 0, cancelled = 0;
  class Media extends EventTarget {
    currentTime = 0; duration = 1;
    constructor() { super(); media.push(this); }
    play() { return Promise.resolve(); }
    pause() {}
    removeAttribute() {}
    load() {}
  }
  stubGlobals(t, {
    document:{querySelectorAll:()=>[],baseURI:'http://localhost/karaoke/'}, Audio:Media,
    requestAnimationFrame:()=>++frame, cancelAnimationFrame:()=>{ cancelled += 1; }
  });
  const audio = new KaraokeAudio(null);
  audio.manifest = {clips:{old:{src:'old.wav',duration:1,cues:[]},fresh:{src:'fresh.wav',duration:1,cues:[]}}};
  const oldRun = audio.playClip('old', null);
  await Promise.resolve();
  const freshRun = audio.playClip('fresh', null);
  await Promise.resolve();
  const baseline = cancelled;
  media[0].dispatchEvent(new Event('error'));
  assert.equal(cancelled, baseline, 'stale error must not touch the fresh requestAnimationFrame');
  media[1].dispatchEvent(new Event('ended'));
  assert.equal(await oldRun, false);
  assert.equal(await freshRun, true);
});

test('realtime interruption stops visual cues and cannot complete the guided step', async t => {
  const ctx = new EventTarget();
  ctx.state = 'running';
  stubGlobals(t, { document:{querySelectorAll:()=>[]}, cancelAnimationFrame:()=>{} });
  const sampler = { context:ctx, prepare:async()=>true, playMidi:()=>true, stopAll:()=>{} };
  const status = { textContent:'' };
  const audio = new KaraokeAudio(null,status);
  audio.setSampler(sampler);
  const playing = audio.chord([60],null,10000);
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  ctx.state = 'interrupted';
  ctx.dispatchEvent(new Event('statechange'));
  assert.equal(await playing,false);
  assert.equal(audio.timers.size,0);
  assert.match(status.textContent,/paused/);
});

test('Tonnetz reuses the instrument context and refuses a suspended output before any cue', async t => {
  stubGlobals(t, { document:{querySelectorAll:()=>[]}, cancelAnimationFrame:()=>{} });
  let osc = 0, cue = 0;
  const ctx = new EventTarget();
  ctx.state = 'running';
  ctx.createOscillator = () => { osc++; throw Error('must not schedule after interruption'); };
  const audio = new KaraokeAudio(null,{textContent:''});
  audio.setSampler({ prepareContext:async()=>ctx,stopAll:()=>{} });
  const playing = audio.frequencySteps([220],null,()=>cue++,20,10);
  await Promise.resolve(); await Promise.resolve();
  assert.equal(audio.context,ctx);
  ctx.state = 'interrupted';
  ctx.dispatchEvent(new Event('statechange'));
  assert.equal(await playing,false);
  assert.equal(osc,0);
  assert.equal(cue,0);
});
