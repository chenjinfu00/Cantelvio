export class DeckAudio {
  constructor(frame, status = null) {
    this.frame = frame;
    this.status = status;
    this.timers = new Set();
    this.active = null;
    this.context = null;
    this.localVoices = new Set();
  }
  get bridge() {
    try { return this.frame?.contentWindow?.TonnetzDemoBridge || null; } catch { return null; }
  }
  stop() {
    this.timers.forEach((timer) => clearTimeout(timer));
    this.timers.clear();
    this.bridge?.stopAll("Demo stopped");
    const now = this.context?.currentTime || 0;
    this.localVoices.forEach((voice) => {
      try { voice.gain.gain.cancelScheduledValues(now); voice.gain.gain.setValueAtTime(0.0001, now); voice.oscillator.stop(now + 0.02); } catch {}
    });
    this.localVoices.clear();
    document.querySelectorAll(".is-sounding,.is-playing,.is-current,.is-previous,.is-cycle-current").forEach((el) => el.classList.remove("is-sounding","is-playing","is-current","is-previous","is-cycle-current"));
    document.querySelectorAll("[data-reset-label]").forEach((el) => { el.textContent = el.dataset.resetLabel; });
    this.active = null;
    if (this.status) this.status.textContent = "Sound: stopped";
  }
  midiForPcs(pcs, root = 60) {
    let previous = root - 1;
    return pcs.map((pc, index) => {
      let midi = index === 0 ? root : 60 + pc;
      while (midi <= previous) midi += 12;
      previous = midi;
      return midi;
    });
  }
  noteName(midi) {
    const names = ["C","C♯","D","E♭","E","F","F♯","G","A♭","A","B♭","B"];
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  }
  chord(midi, element, duration = 900, label = "") {
    this.stop();
    if (!this.bridge) { if (this.status) this.status.textContent = "Sound engine is loading — try again"; return false; }
    element?.classList.add("is-sounding");
    midi.forEach((note) => this.bridge.playMidi(note, duration));
    if (this.status) this.status.textContent = `Playing: ${label || midi.map((note) => this.noteName(note)).join(" · ")}`;
    const timer = setTimeout(() => { this.timers.delete(timer); element?.classList.remove("is-sounding"); if (this.status) this.status.textContent = "Sound: ready"; }, duration + 120);
    this.timers.add(timer);
    return true;
  }
  async frequencies(values, element, duration = 1100, label = "") {
    this.stop();
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) { if (this.status) this.status.textContent = "Audio is unavailable in this browser"; return false; }
    this.context ||= new Context();
    if (this.context.state === "suspended") await this.context.resume();
    const now = this.context.currentTime;
    element?.classList.add("is-sounding");
    values.forEach((frequency) => {
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(0.075 / Math.sqrt(values.length), now + 0.025);
      gain.gain.setValueAtTime(0.075 / Math.sqrt(values.length), now + Math.max(0.05, duration / 1000 - 0.12));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + duration / 1000);
      oscillator.connect(gain).connect(this.context.destination);
      const voice = { oscillator, gain };
      this.localVoices.add(voice);
      oscillator.addEventListener("ended", () => this.localVoices.delete(voice), { once: true });
      oscillator.start(now);
      oscillator.stop(now + duration / 1000 + 0.03);
    });
    if (this.status) this.status.textContent = `Playing: ${label}`;
    const timer = setTimeout(() => { this.timers.delete(timer); element?.classList.remove("is-sounding"); if (this.status) this.status.textContent = "Sound: ready"; }, duration + 120);
    this.timers.add(timer);
    return true;
  }
  sequence(chords, element, onStep, tempo = 850) {
    this.stop();
    if (!this.bridge) { if (this.status) this.status.textContent = "Sound engine is loading — try again"; return false; }
    this.active = element;
    element?.classList.add("is-playing");
    chords.forEach((notes, index) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        notes.forEach((note) => this.bridge.playMidi(note, Math.max(420, tempo * .72)));
        if (this.status) this.status.textContent = `Playing: ${notes.map((note) => this.noteName(note)).join(" · ")} · ${index + 1}/${chords.length}`;
        onStep?.(index);
      }, index * tempo);
      this.timers.add(timer);
    });
    const end = setTimeout(() => { this.timers.delete(end); element?.classList.remove("is-playing"); onStep?.(-1); this.active = null; if (this.status) this.status.textContent = "Sound: ready"; }, chords.length * tempo + 100);
    this.timers.add(end);
    return true;
  }
}
