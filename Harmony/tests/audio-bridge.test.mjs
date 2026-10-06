import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

class FakeEventTarget {
  constructor() { this.listeners = new Map(); }
  addEventListener(type, callback) {
    const callbacks = this.listeners.get(type) || [];
    callbacks.push(callback);
    this.listeners.set(type, callbacks);
  }
  dispatchEvent(event) {
    (this.listeners.get(event.type) || []).forEach((callback) => callback.call(this, event));
    return true;
  }
}

class FakeClassList {
  constructor() { this.values = new Set(); }
  add(...names) { names.forEach((name) => this.values.add(name)); }
  remove(...names) { names.forEach((name) => this.values.delete(name)); }
  toggle(name, force) {
    const enabled = force === undefined ? !this.values.has(name) : Boolean(force);
    if (enabled) this.values.add(name);
    else this.values.delete(name);
    return enabled;
  }
  contains(name) { return this.values.has(name); }
}

class FakeElement extends FakeEventTarget {
  constructor(id = "") {
    super();
    this.id = id;
    this.value = id === "volumeSlider" ? "72" : id === "voiceSelect" ? "concert" : "";
    this.dataset = {};
    this.style = { setProperty() {}, removeProperty() {} };
    this.classList = new FakeClassList();
    this.attributes = new Map();
    this.children = [];
    this.clientWidth = 1024;
    this.clientHeight = 700;
    this.offsetWidth = 220;
    this.offsetHeight = 48;
    this.hidden = false;
    this.disabled = false;
    this.innerHTML = "";
    this.textContent = "";
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.get(name) ?? null; }
  appendChild(child) { this.children.push(child); return child; }
  closest() { return null; }
  setPointerCapture() {}
  getBoundingClientRect() {
    return { left: 0, top: 0, right: this.clientWidth, bottom: this.clientHeight, width: this.clientWidth, height: this.clientHeight };
  }
  emit(type, detail = {}) { this.dispatchEvent({ type, target: this, preventDefault() {}, ...detail }); }
  getContext() { return null; }
}

class FakeAudioParam {
  constructor(value = 0) { this.value = value; }
  setValueAtTime(value) { this.value = value; }
  linearRampToValueAtTime(value) { this.value = value; }
  exponentialRampToValueAtTime(value) { this.value = value; }
  setTargetAtTime(value) { this.value = value; }
  cancelScheduledValues() {}
}

class FakeAudioNode extends FakeEventTarget {
  constructor() {
    super();
    this.gain = new FakeAudioParam(1);
    this.frequency = new FakeAudioParam(440);
    this.detune = new FakeAudioParam(0);
    this.playbackRate = new FakeAudioParam(1);
    this.threshold = new FakeAudioParam();
    this.knee = new FakeAudioParam();
    this.ratio = new FakeAudioParam();
    this.attack = new FakeAudioParam();
    this.release = new FakeAudioParam();
    this.Q = new FakeAudioParam();
  }
  connect(target) { return target; }
  disconnect() {}
  start(when) { this.startedAt = when; }
  stop(when) { this.stoppedAt = when; }
}

class FakeAudioContext extends FakeEventTarget {
  constructor() {
    super();
    this.state = "suspended";
    this.currentTime = 0;
    this.sampleRate = 8000;
    this.destination = new FakeAudioNode();
    this.oscillators = [];
    this.sources = [];
  }
  async resume() {
    if (this.state === "closed") throw new Error("Cannot resume a closed AudioContext");
    this.state = "running";
    this.dispatchEvent({ type: "statechange" });
  }
  createGain() { return new FakeAudioNode(); }
  createConvolver() { return new FakeAudioNode(); }
  createDynamicsCompressor() { return new FakeAudioNode(); }
  createBiquadFilter() { return new FakeAudioNode(); }
  createWaveShaper() { return new FakeAudioNode(); }
  createBufferSource() { const source = new FakeAudioNode(); this.sources.push(source); return source; }
  createOscillator() {
    const oscillator = new FakeAudioNode();
    this.oscillators.push(oscillator);
    return oscillator;
  }
  createBuffer(channels, length, sampleRate) {
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { duration: length / sampleRate, getChannelData: (channel) => data[channel] };
  }
  async decodeAudioData() { return { duration: 2 }; }
}

async function loadBridge({ fetcher = async () => ({ ok: false, status: 404 }) } = {}) {
  const source = await readFile(new URL("../public/tonnetz/app.js", import.meta.url), "utf8");
  const elements = new Map();
  const getElement = (selector) => {
    const id = selector.startsWith("#") ? selector.slice(1) : selector;
    if (!elements.has(selector)) elements.set(selector, new FakeElement(id));
    return elements.get(selector);
  };
  const document = new FakeEventTarget();
  document.hidden = false;
  document.documentElement = new FakeElement("documentElement");
  document.querySelector = getElement;
  document.querySelectorAll = () => [];
  document.createElement = () => new FakeElement();

  const window = new FakeEventTarget();
  window.AudioContext = FakeAudioContext;
  window.webkitAudioContext = FakeAudioContext;
  window.localStorage = { getItem: () => null, setItem() {} };
  window.setTimeout = setTimeout;
  window.clearTimeout = clearTimeout;
  window.innerHeight = 800;
  window.devicePixelRatio = 1;
  window.atob = (value) => Buffer.from(value, "base64").toString("binary");
  window.window = window;

  class FakeCustomEvent {
    constructor(type, init = {}) { this.type = type; this.detail = init.detail; }
  }
  const sandbox = {
    window,
    document,
    navigator: { audioSession: { type: "auto" } },
    location: { protocol: "file:" },
    CustomEvent: FakeCustomEvent,
    Uint8Array,
    Float32Array,
    Map,
    Set,
    Math,
    Number,
    String,
    Boolean,
    Object,
    Array,
    JSON,
    Promise,
    Error,
    fetch: fetcher,
    requestAnimationFrame: () => 1,
    cancelAnimationFrame() {},
    setTimeout,
    clearTimeout,
    console
  };
  vm.runInNewContext(source, sandbox, { filename: "app.js" });
  return { audio: window.TonnetzAudio, elements, window };
}

test("real app bridge exposes the contract, preserves fractional sine tuning and isolates groups", async () => {
  const { audio, elements } = await loadBridge();
  assert.deepEqual(
    Object.keys(audio).sort(),
    ["ensureReady", "getContext", "getDiagnostics", "highlightChord", "panic", "playNote", "setGroupVolume", "stopGroup"].sort()
  );
  assert.equal(audio.playNote(60, { group: "accompaniment" }), null, "scheduled groups cannot queue notes before user unlock");
  assert.equal(audio.getDiagnostics().contextState, "uninitialized");
  assert.equal(await audio.ensureReady(), true);
  assert.equal(audio.getContext().state, "running");

  const pureFifthMidi = 60 + 12 * Math.log2(3 / 2);
  audio.playNote(pureFifthMidi, { instrument: "sine", group: "learn", velocity: 0.5 });
  const pureFrequency = audio.getContext().oscillators.at(-1).frequency.value;
  assert.ok(Math.abs(pureFrequency - 261.625565 * 1.5) < 0.001);

  for (let index = 0; index < 20; index += 1) {
    audio.playNote(60 + index % 5, { instrument: "sine", group: "melody" });
  }
  for (let index = 0; index < 4; index += 1) {
    audio.playNote(48 + index, { instrument: "sine", group: "accompaniment" });
  }
  assert.equal(audio.getDiagnostics().groups.melody, 16, "melody keeps its own 16-voice budget");
  assert.equal(audio.getDiagnostics().groups.accompaniment, 4);
  assert.equal(audio.getDiagnostics().groups.learn, 1);

  audio.stopGroup("accompaniment");
  assert.equal(audio.getDiagnostics().groups.accompaniment, 0);
  assert.equal(audio.getDiagnostics().groups.melody, 16, "stopping accompaniment must not steal held melody voices");
  assert.equal(audio.getDiagnostics().groups.learn, 1);

  audio.playNote(48, { instrument: "sine", group: "accompaniment" });
  elements.get("#layoutSelect").value = "harmonic";
  elements.get("#layoutSelect").emit("change");
  assert.equal(audio.getDiagnostics().groups.melody, 0, "layout changes reset only keyboard-owned voices");
  assert.equal(audio.getDiagnostics().groups.accompaniment, 1);
  assert.equal(audio.getDiagnostics().groups.learn, 1);

  audio.panic();
  assert.equal(audio.getDiagnostics().activeVoices, 0);
});

test("voice selection resets melody but leaves accompaniment sounding", async () => {
  const { audio, elements } = await loadBridge();
  await audio.ensureReady();
  audio.playNote(60, { instrument: "sine", group: "melody" });
  audio.playNote(48, { instrument: "sine", group: "accompaniment" });
  const voiceSelect = elements.get("#voiceSelect");
  voiceSelect.value = "epiano";
  voiceSelect.emit("change");
  assert.equal(audio.getDiagnostics().groups.melody, 0);
  assert.equal(audio.getDiagnostics().groups.accompaniment, 1);
  audio.panic();
});

test("WebKit-style interruption clears voices and resumes only through ensureReady", async () => {
  const { audio } = await loadBridge();
  await audio.ensureReady();
  audio.playNote(60, { instrument: "sine", group: "melody" });
  audio.playNote(48, { instrument: "sine", group: "accompaniment" });
  const context = audio.getContext();
  context.state = "interrupted";
  context.dispatchEvent({ type: "statechange" });
  assert.equal(audio.getDiagnostics().activeVoices, 0);
  assert.equal(audio.getDiagnostics().contextState, "interrupted");
  assert.equal(audio.playNote(55, { group: "accompaniment" }), null);

  assert.equal(await audio.ensureReady(), true);
  assert.equal(audio.getDiagnostics().contextState, "running");
  assert.equal(audio.getDiagnostics().activeVoices, 0, "resuming must not replay interrupted notes");
});

test("a closed AudioContext is replaced and becomes playable again", async () => {
  const { audio } = await loadBridge();
  assert.equal(await audio.ensureReady(), true);
  const firstContext = audio.getContext();
  audio.playNote(60, { instrument: "sine", group: "melody" });
  firstContext.state = "closed";
  firstContext.dispatchEvent({ type: "statechange" });

  assert.equal(await audio.ensureReady(), true);
  const replacement = audio.getContext();
  assert.notEqual(replacement, firstContext);
  assert.equal(replacement.state, "running");
  assert.equal(audio.getDiagnostics().activeVoices, 0);
  assert.ok(audio.playNote(64, { instrument: "sine", group: "accompaniment", duration: 0.05 }));
  audio.panic();
});

test("a stalled local piano request never blocks audio readiness", async () => {
  const { audio } = await loadBridge({ fetcher: () => new Promise(() => {}) });
  const result = await Promise.race([
    audio.ensureReady(),
    new Promise((resolve) => setTimeout(() => resolve("timed-out"), 80))
  ]);
  assert.equal(result, true);
  assert.equal(audio.getContext().state, "running");
  assert.ok(audio.playNote(60, { instrument: "sine", group: "learn", duration: 0.05 }));
  audio.panic();
});


test("independent sampled bass and guitar support scheduled onset and cancel future notes", async () => {
  const {audio}=await loadBridge({fetcher:async()=>({ok:true,arrayBuffer:async()=>new ArrayBuffer(8)})});
  await audio.ensureReady();
  audio.playNote(64,{instrument:"electric-guitar",group:"accompaniment"});
  await new Promise(resolve=>setTimeout(resolve,430));
  assert.equal(audio.getDiagnostics().bassSamplesReady,9);
  assert.equal(audio.getDiagnostics().guitarSamplesReady,9);
  audio.playNote(40,{instrument:"electric-bass",group:"accompaniment-bass",when:1});
  const bass=audio.getContext().sources.at(-1);
  assert.equal(bass.startedAt,1);
  audio.playNote(64,{instrument:"electric-guitar",group:"accompaniment",when:1.015});
  assert.equal(audio.getContext().sources.at(-1).startedAt,1.015);
  assert.equal(audio.getDiagnostics().bassSampleStarts,1);
  assert.equal(audio.getDiagnostics().guitarSampleStarts,1);
  audio.playNote(72,{instrument:"sine",group:"melody"});
  audio.stopGroup("accompaniment-bass");
  assert.equal(bass.stoppedAt,0,"future source must be stopped before it begins");
  assert.equal(audio.getDiagnostics().groups.melody,1);
  assert.equal(audio.getDiagnostics().groups.accompaniment,2);
  audio.panic();
});

test("missing bass and guitar samples remain playable immediately using built-in voices", async () => {
  const {audio}=await loadBridge();
  await audio.ensureReady();
  audio.playNote(40,{instrument:"electric-bass",group:"accompaniment-bass",when:.035});
  audio.playNote(64,{instrument:"electric-guitar",group:"accompaniment",when:.04});
  assert.equal(audio.getDiagnostics().bassFallbackStarts,1);
  assert.equal(audio.getDiagnostics().guitarFallbackStarts,1);
  assert.ok(audio.getContext().oscillators.some(o=>o.startedAt===.035));
  assert.ok(audio.getContext().oscillators.some(o=>o.startedAt===.04));
  audio.panic();
});

test("new lead voices follow the audio clock and stopping the solo preserves a held keyboard note", async () => {
  const {audio}=await loadBridge();
  await audio.ensureReady();
  audio.playNote(72,{instrument:"sine",group:"melody"});
  for(const instrument of ["synth-lead","reed-lead"]){
    const before=audio.getContext().oscillators.length;
    assert.ok(audio.playNote(76,{instrument,group:"auto-solo",when:1.25}));
    const voices=audio.getContext().oscillators.slice(before);
    assert.ok(voices.length>=2);
    assert.ok(voices.every(v=>v.startedAt===1.25));
  }
  audio.stopGroup("auto-solo");
  assert.equal(audio.getDiagnostics().groups["auto-solo"],0);
  assert.equal(audio.getDiagnostics().groups.melody,1);
  assert.ok(audio.getContext().oscillators.slice(1).every(v=>v.stoppedAt===0));
  audio.panic();
});
