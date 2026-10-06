import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { PianoSampler, PIANO_SAMPLES, nearestPianoSample } from '../public/karaoke/piano-sampler.js';

test('bundled piano recordings match the pinned provenance and cover the demonstration register', async () => {
  const base = new URL('../public/media/karaoke/piano/', import.meta.url);
  const manifest = JSON.parse(await readFile(new URL('manifest.json', base)));
  assert.deepEqual(manifest.samples.map(s => s.midi), PIANO_SAMPLES.map(s => s.midi));
  for (const sample of manifest.samples) {
    const bytes = await readFile(new URL(sample.src, base));
    assert.equal(bytes.length, sample.bytes);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), sample.sha256);
    assert.ok(bytes.length > 10000);
  }
  for (let midi = 36; midi <= 84; midi++) assert.ok(Math.abs(nearestPianoSample(midi).midi - midi) <= 1);
});

function fakeContext() {
  const events = [];
  const param = () => ({ value: 0, setValueAtTime: (...x) => events.push(['set', ...x]), linearRampToValueAtTime: () => {}, exponentialRampToValueAtTime: () => {}, cancelScheduledValues: () => {} });
  const node = () => ({ connect(destination) { return destination; }, disconnect() {} });
  return {
    state: 'suspended', currentTime: 2, destination: {}, events,
    async resume() { this.state = 'running'; },
    createGain() { return { ...node(), gain: param() }; },
    createDynamicsCompressor() { return { ...node(), threshold: param(), knee: param(), ratio: param(), attack: param(), release: param() }; },
    async decodeAudioData() { return { duration: 5 }; },
    createBufferSource() { return { ...node(), playbackRate: { setValueAtTime: (rate) => events.push(['rate', rate]) }, addEventListener() {}, start: at => events.push(['start', at]), stop: at => events.push(['stop', at]) }; }
  };
}

test('piano preparation does not sound a note; playback transposes nearest sample and stop mutes scheduled voices', async () => {
  const context = fakeContext();
  let fetched = 0;
  const sampler = new PianoSampler({ contextFactory: () => context, fetcher: async () => { fetched++; return { ok: true, arrayBuffer: async () => new ArrayBuffer(8) }; } });
  assert.equal(sampler.playMidi(61), false);
  await sampler.prepare();
  await sampler.prepare();
  assert.equal(fetched, 17);
  assert.equal(context.events.filter(e => e[0] === 'start').length, 0);
  assert.equal(sampler.playMidi(61, 800), true);
  assert.deepEqual(context.events.find(e => e[0] === 'rate'), ['rate', 2 ** (1 / 12)]);
  assert.equal(sampler.voices.size, 1);
  sampler.stopAll();
  assert.equal(sampler.voices.size, 0);
  assert.ok(context.events.some(e => e[0] === 'stop' && e[1] < 2.1));
});

test('failed piano fetch remains retryable and never reports a ready instrument', async () => {
  let fail = true;
  const sampler = new PianoSampler({ contextFactory: fakeContext, fetcher: async () => ({ ok: !fail, status: 503, arrayBuffer: async () => new ArrayBuffer(8) }) });
  await assert.rejects(sampler.prepare(), /503/);
  assert.equal(sampler.ready, false);
  fail = false;
  await sampler.prepare();
  assert.equal(sampler.ready, true);
});

test('tones can unlock the piano context without downloading samples, then recover after interruption', async () => {
  const context = fakeContext();
  context.state = 'interrupted';
  let fetched = 0;
  const sampler = new PianoSampler({ contextFactory: () => context, fetcher: async () => { fetched++; return { ok:true, arrayBuffer:async()=>new ArrayBuffer(8) }; } });
  assert.equal(await sampler.prepareContext(), context);
  assert.equal(context.state, 'running');
  assert.equal(fetched, 0);
  context.state = 'interrupted';
  await sampler.prepare();
  assert.equal(context.state, 'running');
  assert.equal(sampler.playMidi(60), true);
});

test('a closed output is rebuilt and can reuse the decoded piano buffers', async () => {
  const contexts = [];
  const sampler = new PianoSampler({
    contextFactory: () => {
      const context = fakeContext();
      contexts.push(context);
      return context;
    },
    fetcher: async () => ({ ok:true, arrayBuffer:async()=>new ArrayBuffer(8) })
  });
  await sampler.prepare();
  const originalOutput = sampler.output;
  contexts[0].state = 'closed';
  await sampler.prepareContext();
  assert.equal(contexts.length,2);
  assert.notEqual(sampler.output,originalOutput);
  assert.equal(sampler.context,contexts[1]);
  assert.equal(sampler.playMidi(60),true);
  assert.equal(contexts[1].events.filter(event => event[0] === 'start').length,1);
});
