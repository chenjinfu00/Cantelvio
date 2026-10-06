import test from "node:test";
import assert from "node:assert/strict";

import {
  RHYTHMS,
  PATTERNS,
  STYLES,
  INSTRUMENTS, BASS_INSTRUMENTS, BASS_LINES,
  buildBarEvents,
  createAccompaniment
} from "../public/tonnetz/accompaniment.js";

class FakeClock {
  constructor() {
    this.time = 0;
    this.nextId = 1;
    this.tasks = new Map();
  }

  now = () => this.time;

  setTimeout = (callback, delay = 0) => {
    const id = this.nextId++;
    this.tasks.set(id, { id, at: this.time + Math.max(0, Number(delay) || 0), callback });
    return id;
  };

  clearTimeout = (id) => this.tasks.delete(id);

  get pending() { return this.tasks.size; }

  tick(milliseconds) {
    const target = this.time + milliseconds;
    while (true) {
      const next = [...this.tasks.values()]
        .filter((task) => task.at <= target)
        .sort((a, b) => a.at - b.at || a.id - b.id)[0];
      if (!next) break;
      this.tasks.delete(next.id);
      this.time = next.at;
      next.callback();
    }
    this.time = target;
  }

  jump(milliseconds) {
    this.time += milliseconds;
    const due = [...this.tasks.values()]
      .filter((task) => task.at <= this.time)
      .sort((a, b) => a.at - b.at || a.id - b.id);
    due.forEach((task) => {
      if (!this.tasks.delete(task.id)) return;
      task.callback();
    });
  }
}

function fakeAudio(clock = null) {
  const calls = [];
  const context = { state: "running", get currentTime() { return (clock?.now() || 0)/1000; } };
  return {
    calls,
    context,
    ensureReady: async () => true,
    getContext: () => context,
    playNote: (midi, options) => calls.push({ type: "play", midi, options }),
    stopGroup: (group) => calls.push({ type: "stop", group }),
    setGroupVolume: (group, volume) => calls.push({ type: "volume", group, volume })
  };
}

test("metadata exposes stable bilingual ids and explicit meter", () => {
  for (const entries of [RHYTHMS, PATTERNS, STYLES, INSTRUMENTS, BASS_INSTRUMENTS, BASS_LINES]) {
    assert.ok(Object.isFrozen(entries));
    assert.ok(entries.length >= 3);
    entries.forEach((entry) => {
      assert.match(entry.id, /^[a-z][a-z-]*$/);
      assert.ok(entry.name.en);
      assert.ok(entry.name.zh);
    });
  }
  assert.equal(RHYTHMS.find((item) => item.id === "waltz").beatsPerBar, 3);
  assert.ok(RHYTHMS.filter((item) => item.id !== "waltz").every((item) => item.beatsPerBar === 4));
});

test("styles, rhythms, patterns and BPM create materially different bars", () => {
  const chord = [60, 64, 67];
  const styleBars = Object.fromEntries(STYLES.map((style) => [
    style.id,
    buildBarEvents(chord, { style: style.id, bpm: 92 })
  ]));
  const signature = (events) => events.map((event) => `${event.time.toFixed(3)}:${event.midi}:${event.duration.toFixed(3)}:${event.instrument}`).join("|");
  assert.equal(new Set(Object.values(styleBars).map(signature)).size, STYLES.length);

  const expectedStarts = {
    ascending: [60, 64, 67, 60],
    descending: [67, 64, 60, 67],
    updown: [60, 64, 67, 64],
    alberti: [60, 67, 64, 67]
  };
  for (const [pattern, expected] of Object.entries(expectedStarts)) {
    const events = buildBarEvents(chord, { rhythm: "quarter", pattern, style: "classical", bassInstrument: "off", feel: 0, variation: 0 });
    assert.deepEqual(events.map((event) => event.midi).slice(0, 4), expected);
  }
  assert.equal(buildBarEvents(chord, { rhythm: "quarter", pattern: "block", bassInstrument: "off" }).length, 12);
  const alternating = buildBarEvents(chord, { rhythm: "quarter", pattern: "bass-chord" });
  assert.equal(alternating.filter(event => event.role === "chord").length, 6);
  assert.ok(alternating.filter(event => event.role === "bass").every(event => event.instrument === "electric-bass"));

  const slow = buildBarEvents(chord, { bpm: 40, rhythm: "quarter" });
  const fast = buildBarEvents(chord, { bpm: 200, rhythm: "quarter" });
  assert.equal(slow[0].barDuration, 6);
  assert.equal(fast[0].barDuration, 1.2);
  const triple = buildBarEvents(chord, { bpm: 120, rhythm: "waltz" });
  assert.equal(triple[0].beatsPerBar, 3);
  assert.equal(triple[0].barDuration, 1.5);
  assert.ok(triple.every((event) => event.beat < 3));
});

test("controller sounds the initial chord first, then applies onBar at the next sounding boundary", async () => {
  const clock = new FakeClock();
  const audio = fakeAudio(clock);
  const bars = [];
  const beats = [];
  const controller = createAccompaniment({
    audio,
    clock,
    onBar(info) {
      bars.push(info);
      return info.bar === 1 ? [62, 65, 69] : null;
    },
    onBeat: (info) => beats.push(info)
  });

  assert.equal(await controller.start([60, 64, 67]), true);
  assert.equal(bars.length, 0, "start must not advance harmony before the initial bar sounds");
  clock.tick(0);
  assert.equal(audio.calls.find((call) => call.type === "play").midi, 36);

  const barMs = 4 * 60000 / 92;
  clock.tick(barMs);
  const playsAtSecondBoundary = audio.calls.filter((call) => call.type === "play");
  assert.equal(playsAtSecondBoundary.filter(call => call.options.group === "accompaniment-bass").at(-1).midi, 38);
  assert.deepEqual(bars[0].chord, [60, 64, 67]);
  assert.deepEqual(beats.slice(0, 5).map((beat) => beat.beat), [0, 1, 2, 3, 0]);
});

test("manual chord selection restarts only accompaniment and immediately schedules the selected harmony", async () => {
  const clock = new FakeClock();
  const audio = fakeAudio(clock);
  let boundaryCalls = 0;
  const controller = createAccompaniment({
    audio,
    clock,
    onBar: () => { boundaryCalls += 1; return [67, 71, 74]; }
  });
  await controller.start([60, 64, 67]);
  clock.tick(0);
  const playsBefore = audio.calls.filter((call) => call.type === "play").length;

  controller.setChord([62, 65, 69]);
  clock.tick(0);
  const plays = audio.calls.filter((call) => call.type === "play");
  assert.equal(boundaryCalls, 0, "manual restart must not advance a progression or generator");
  assert.deepEqual(plays.slice(playsBefore).map(call => call.midi).sort((a,b)=>a-b), [38,62,65,69]);
  assert.ok(audio.calls.some((call) => call.type === "stop" && call.group === "accompaniment"));
  assert.ok(audio.calls.every((call) => call.group !== "melody"));
});

test("stop and restart cancel all scheduler timers without touching melody", async () => {
  const clock = new FakeClock();
  const audio = fakeAudio(clock);
  const states = [];
  const controller = createAccompaniment({ audio, clock, onState: (state) => states.push(state) });

  await controller.start([60, 64, 67]);
  clock.tick(0);
  controller.update({ style: "jazz", rhythm: "quarter", pattern: "block", bpm: 200 });
  assert.equal(audio.calls.filter((call) => call.type === "stop").length, 3, "style changes must not stop either voice group");
  assert.equal(controller.getState().beatsPerBar, 4);
  controller.stop();
  assert.equal(clock.pending, 0);
  assert.deepEqual(audio.calls.filter((call) => call.type === "stop").map((call) => call.group), ["accompaniment", "accompaniment-bass", "auto-solo", "accompaniment", "accompaniment-bass", "auto-solo"]);
  assert.equal(states.at(-1).playing, false);

  const playsBefore = audio.calls.filter((call) => call.type === "play").length;
  clock.tick(20000);
  assert.equal(audio.calls.filter((call) => call.type === "play").length, playsBefore);
  await controller.start([65, 69, 72]);
  clock.tick(0);
  assert.equal(audio.calls.filter((call) => call.type === "play").length, playsBefore + 4);
});

test("a stop during async unlock prevents hidden playback", async () => {
  const clock = new FakeClock();
  let resolveReady;
  const audio = fakeAudio(clock);
  audio.ensureReady = () => new Promise((resolve) => { resolveReady = resolve; });
  const controller = createAccompaniment({ audio, clock });
  const starting = controller.start([60, 64, 67]);
  controller.stop();
  resolveReady(true);
  assert.equal(await starting, false);
  assert.equal(controller.getState().playing, false);
  assert.equal(clock.pending, 0);
  assert.equal(audio.calls.filter((call) => call.type === "play").length, 0);
});

test("starting again replaces the prior loop instead of stacking another scheduler", async () => {
  const clock = new FakeClock();
  const audio = fakeAudio(clock);
  const controller = createAccompaniment({ audio, clock });
  await controller.start([60, 64, 67]);
  await controller.start([62, 65, 69]);
  clock.tick(0);
  const plays = audio.calls.filter((call) => call.type === "play");
  assert.deepEqual(plays.map(call => call.midi).sort((a,b)=>a-b), [38,62,65,69]);
  const pendingBeforeStop = clock.pending;
  assert.ok(pendingBeforeStop > 0 && pendingBeforeStop < 32, "one bounded bar of timers should remain");
  controller.stop();
  assert.equal(clock.pending, 0);
});

test("late callbacks are dropped and an interrupted context halts instead of catching up", async () => {
  const clock = new FakeClock();
  const audio = fakeAudio(clock);
  const controller = createAccompaniment({ audio, clock });
  await controller.start([60, 64, 67]);

  clock.jump(1200);
  assert.equal(audio.calls.filter((call) => call.type === "play").length, 0, "overdue notes must not burst after throttling");
  audio.context.state = "interrupted";
  clock.tick(2000);
  assert.equal(controller.getState().playing, false);
  assert.equal(clock.pending, 0);
  audio.context.state = "running";
  clock.tick(10000);
  assert.equal(audio.calls.filter((call) => call.type === "play").length, 0, "context recovery must require another start gesture");
});

test("timeline transport follows the sounding bar through pending BPM and meter changes", async () => {
  const clock = new FakeClock();
  const starts = [];
  const controller = createAccompaniment({ audio: fakeAudio(), clock, onBarStart: info => starts.push(info) });
  controller.update({ bpm: 120, rhythm: "quarter" });
  await controller.start([60, 64, 67]);
  clock.tick(1000);
  assert.equal(controller.getTransport().progress, .5);
  controller.update({ bpm: 60, rhythm: "waltz" });
  assert.equal(controller.getTransport().durationMs, 2000);
  assert.equal(controller.getTransport().beatsPerBar, 4);
  clock.tick(1000);
  assert.equal(controller.getTransport().durationMs, 3000);
  assert.equal(controller.getTransport().beatsPerBar, 3);
  assert.equal(controller.getTransport().progress, 0);
  clock.tick(1500);
  assert.equal(controller.getTransport().progress, .5);
  assert.deepEqual(starts.map(x => x.startMs), [0, 2000]);
});

test("manual swaps, stop/restart and late bars cannot leave the timeline running on an old clock", async () => {
  const clock = new FakeClock();
  const controller = createAccompaniment({ audio: fakeAudio(), clock });
  controller.update({ bpm: 120 });
  await controller.start([60, 64, 67]);
  clock.tick(900);
  controller.setChord([65, 69, 72]);
  assert.equal(controller.getTransport().progress, 0);
  assert.equal(controller.getTransport().startMs, 900);
  clock.jump(4000);
  assert.equal(controller.getTransport().startMs, 4900);
  assert.equal(controller.getTransport().progress, 0);
  controller.stop();
  clock.tick(1000);
  assert.equal(controller.getTransport().playing, false);
  assert.equal(controller.getTransport().progress, 0);
  await controller.start([60, 64, 67]);
  assert.equal(controller.getTransport().startMs, 5900);
});


test("every style and pattern has an independent low voice with the inversion on the downbeat", () => {
  for (const style of STYLES) for (const pattern of PATTERNS) {
    const events = buildBarEvents([52,55,60], {style:style.id,pattern:pattern.id,root:0,nextChord:[43,59,62],bar:2});
    const bass = events.filter(event=>event.role === "bass");
    assert.ok(bass.length > 0);
    assert.equal(bass[0].midi % 12,4,"C/E must start with E in the low voice");
    assert.equal(bass[0].time,0);
    assert.ok(events.filter(event=>event.role!=="bass").every(event=>event.midi>=55));
    assert.ok(buildBarEvents([52,55,60], {style:style.id,pattern:pattern.id,bassInstrument:"off"}).every(event=>event.role!=="bass"));
  }
});

test("walking bass connects to the committed next bass; rock pairs sampled guitar with bass", () => {
  const bass = buildBarEvents([48,64,67], {style:"jazz",nextChord:[43,59,62]}).filter(e=>e.role==="bass");
  assert.equal(bass.length,4);
  assert.equal(Math.abs(bass.at(-1).midi-43),1);
  const rock=buildBarEvents([48,64,67],{style:"rock"});
  assert.equal(rock.filter(e=>e.role==="bass").length,8);
  assert.ok(rock.filter(e=>e.role!=="bass").every(e=>e.instrument==="electric-guitar"));
  assert.ok(rock.filter(e=>e.role==="bass").every(e=>e.instrument==="electric-bass"));
  assert.ok(rock.some(e=>e.role!=="bass"&&e.duration<.16));
});

test("phrase variation changes density and voicing without replacing the advertised harmony", () => {
  for(const style of STYLES) {
    const bars=Array.from({length:4},(_,bar)=>buildBarEvents([48,64,67,71],{style:style.id,bar,feel:0}));
    assert.ok(new Set(bars.map(events=>events.map(e=>`${e.beat}:${e.midi}:${e.velocity}:${e.duration}`).join("|"))).size>=3);
    for(const events of bars) for(const e of events) {
      assert.ok(Number.isFinite(e.time)&&e.time>=0&&e.time+e.duration<e.barDuration);
      assert.ok(e.velocity>=.08&&e.velocity<=.96);
      if(e.role!=="bass")assert.ok([0,4,7,11].includes(e.midi%12));
    }
    const straight=buildBarEvents([48,64,67],{style:style.id,bar:0,feel:0,variation:0});
    assert.deepEqual(straight,buildBarEvents([48,64,67],{style:style.id,bar:3,feel:0,variation:0}));
    assert.ok(straight.every(e=>Math.abs(e.time-e.beat*60/92)<1e-10));
  }
});

test("audio-clock scheduling keeps exact onset while dispatching early and cancels both voices", async () => {
  const clock=new FakeClock(), audio=fakeAudio(clock);
  const controller=createAccompaniment({audio,clock});
  controller.update({bpm:120,pattern:"ascending",rhythm:"quarter",feel:0,variation:0});
  await controller.start([60,64,67]);
  clock.tick(460);
  const ahead=audio.calls.filter(c=>c.type==="play"&&c.options.group==="accompaniment").at(-1);
  assert.equal(ahead.midi,64);
  assert.equal(ahead.options.when,.5);
  controller.update({bassVolume:.3});
  assert.equal(audio.calls.filter(c=>c.type==="volume"&&c.group==="accompaniment-bass").at(-1).volume,.62*.3);
  controller.update({bassInstrument:"off"});
  assert.equal(audio.calls.filter(c=>c.type==="stop").at(-1).group,"accompaniment-bass");
  const count=audio.calls.filter(c=>c.type==="play"&&c.options.group==="accompaniment-bass").length;
  clock.tick(1000);
  assert.equal(audio.calls.filter(c=>c.type==="play"&&c.options.group==="accompaniment-bass").length,count);
  controller.stop();
  assert.equal(clock.pending,0);
  assert.ok(audio.calls.filter(c=>c.type==="stop").every(c=>c.group!=="melody"));
});

test('automatic solo shares the bar clock, cancels immediately, and cannot resume old notes after off/on',async()=>{
 const clock=new FakeClock(),audio=fakeAudio(clock);
 const controller=createAccompaniment({audio,clock,getSoloOptions:()=>({style:'classical',rhythm:'eighth',density:1})});
 controller.update({bpm:120,soloEnabled:true,soloVolume:.3});await controller.start([60,64,67]);clock.tick(0);
 assert.ok(audio.calls.some(c=>c.type==='play'&&c.options.group==='auto-solo'));
 controller.update({soloEnabled:false});const count=audio.calls.filter(c=>c.type==='play'&&c.options.group==='auto-solo').length;
 assert.equal(audio.calls.filter(c=>c.type==='stop').at(-1).group,'auto-solo');
 controller.update({soloEnabled:true});clock.tick(1900);
 assert.equal(audio.calls.filter(c=>c.type==='play'&&c.options.group==='auto-solo').length,count);
 clock.tick(200);assert.ok(audio.calls.filter(c=>c.type==='play'&&c.options.group==='auto-solo').length>count);
 controller.stop();assert.equal(clock.pending,0);assert.ok(audio.calls.filter(c=>c.type==='stop').every(c=>c.group!=='melody'));
});
test('random arrangement parameters become effective exactly at the next bar including meter and tempo',async()=>{
 const clock=new FakeClock(),audio=fakeAudio(clock);let boundaries=0,controller;
 controller=createAccompaniment({audio,clock,beforeBar:()=>{boundaries++;controller.update({style:'classical',rhythm:'waltz',bpm:60});}});
 controller.update({bpm:120});await controller.start([60,64,67]);clock.tick(1999);
 assert.equal(boundaries,0);assert.equal(controller.getTransport().durationMs,2000);
 clock.tick(1);assert.equal(boundaries,1);assert.equal(controller.getTransport().startMs,2000);assert.equal(controller.getTransport().durationMs,3000);
 controller.stop();clock.tick(20000);assert.equal(boundaries,1);
});
