import { DeckAudio } from "../deck-audio.js";
import { configurePlaybackSession, resumePlaybackContext } from "./audio-session.js";

const MANIFEST_URL = "../media/karaoke/manifest.json";

export class KaraokeAudio extends DeckAudio {
  constructor(frame = null, status = null) {
    super(frame, status);
    this.manifest = null;
    this.manifestPromise = null;
    this.media = null;
    this.mediaFrame = 0;
    this.generation = 0;
    this.pendingResolve = null;
    this.sequenceCancel = null;
    this.sampler = null;
    this.unwatchContext = null;
  }

  setSampler(sampler) { this.sampler = sampler; }
  setStatus(message) { if (this.status) this.status.textContent = message; }

  async getManifest({ retry = false } = {}) {
    if (retry) { this.manifest = null; this.manifestPromise = null; }
    if (this.manifest) return this.manifest;
    this.manifestPromise ||= fetch(MANIFEST_URL, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      })
      .then((manifest) => {
        if (!manifest?.clips || typeof manifest.clips !== "object") throw new Error("missing clips table");
        this.manifest = manifest;
        return manifest;
      })
      .catch((error) => { this.manifestPromise = null; throw error; });
    return this.manifestPromise;
  }

  stop() {
    this.generation += 1;
    this.unwatchContext?.();
    this.unwatchContext = null;
    this.pendingResolve?.(false);
    this.pendingResolve = null;
    this.sequenceCancel = null;
    cancelAnimationFrame(this.mediaFrame);
    this.mediaFrame = 0;
    if (this.media) {
      this.media.pause();
      this.media.removeAttribute("src");
      this.media.load();
      this.media = null;
    }
    this.sampler?.stopAll();
    super.stop();
    document.querySelectorAll(".is-cue,.is-counting").forEach((element) => element.classList.remove("is-cue", "is-counting"));
  }

  clipSource(entry) { return new URL(entry.src, new URL(MANIFEST_URL, document.baseURI)).href; }

  async preparePiano(generation) {
    if (!this.sampler) return Boolean(this.bridge);
    this.setStatus("Preparing piano…");
    try {
      await this.sampler.prepare();
      if (generation !== this.generation) return false;
      this.monitorContext(this.sampler.context, generation);
      return true;
    } catch (error) {
      if (generation === this.generation) this.setStatus("Sound could not start — tap to retry");
      console.error("Piano sampler failed", error);
      return false;
    }
  }

  monitorContext(context, generation) {
    this.unwatchContext?.();
    if (!context?.addEventListener) return;
    const onStateChange = () => {
      if (generation !== this.generation || context.state === "running") return;
      this.stop();
      this.setStatus("Sound paused — tap to retry");
    };
    context.addEventListener("statechange", onStateChange);
    this.unwatchContext = () => context.removeEventListener("statechange", onStateChange);
  }

  playMidiNow(midi, duration, velocity = .8) {
    if (this.sampler) return this.sampler.playMidi(midi, duration, velocity);
    return Boolean(this.bridge?.playMidi(midi, duration));
  }

  completionTimer(generation, duration, element, className = "is-playing") {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        this.unwatchContext?.();
        this.unwatchContext = null;
        if (this.pendingResolve === finish) this.pendingResolve = null;
        element?.classList.remove(className);
        resolve(value);
      };
      this.pendingResolve = finish;
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (generation !== this.generation) return finish(false);
        this.setStatus("Sound: ready");
        finish(true);
      }, duration);
      this.timers.add(timer);
    });
  }

  async chord(midis, element, duration = 900, label = "Chord") {
    this.stop();
    const generation = this.generation;
    element?.classList.add("is-sounding");
    if (!await this.preparePiano(generation) || generation !== this.generation) {
      element?.classList.remove("is-sounding");
      return false;
    }
    if (!midis.every((midi) => this.playMidiNow(midi, duration))) {
      // A failure may occur after earlier notes in the chord have started.
      // Cancel those voices and the context watcher before returning failure.
      this.stop();
      this.setStatus("Sound is unavailable");
      return false;
    }
    this.setStatus(`Playing: ${label}`);
    return this.completionTimer(generation, duration + 120, element, "is-sounding");
  }

  async sequence(chords, element, onStep = null, tempo = 820, label = "Sequence") {
    this.stop();
    const generation = this.generation;
    element?.classList.add("is-playing");
    if (!await this.preparePiano(generation) || generation !== this.generation) {
      element?.classList.remove("is-playing");
      return false;
    }
    chords.forEach((notes, index) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (generation !== this.generation) return;
        const sounded = notes.map((note) => this.playMidiNow(note, Math.max(480, tempo * .78), .76));
        if (sounded.some((ok) => !ok)) {
          this.stop();
          this.setStatus("Sound is unavailable — try again");
          return;
        }
        onStep?.(index);
        this.setStatus(`${label} · ${index + 1}/${chords.length}`);
      }, index * tempo);
      this.timers.add(timer);
    });
    const completed = await this.completionTimer(generation, chords.length * tempo + 120, element);
    if (completed) onStep?.(-1);
    return completed;
  }

  async playClip(stem, element, onCue = null, options = {}) {
    configurePlaybackSession();
    this.stop();
    const generation = this.generation;
    element?.classList.add("is-playing");
    this.setStatus("Loading voice…");
    try {
      const manifest = await this.getManifest({ retry: options.retry });
      if (generation !== this.generation) return false;
      const entry = manifest.clips[stem];
      if (!entry?.src) throw new Error(`clip “${stem}” is absent from the manifest`);
      const media = new Audio(this.clipSource(entry));
      media.preload = "auto";
      media.volume = options.volume ?? .72;
      this.media = media;
      let cueIndex = -1;
      const cues = Array.isArray(entry.cues) ? entry.cues : [];
      const update = () => {
        if (generation !== this.generation || this.media !== media) return;
        const time = media.currentTime;
        const next = cues.findIndex((cue) => time >= cue.time && time < cue.time + cue.duration);
        if (next !== cueIndex) {
          cueIndex = next;
          onCue?.(next >= 0 ? cues[next] : null, next, time);
        }
        options.onTime?.(time, Number(entry.duration) || media.duration || 0);
        this.mediaFrame = requestAnimationFrame(update);
      };
      const completed = new Promise((resolve) => {
        let settled = false;
        const finish = (value) => {
          if (settled) return;
          settled = true;
          if (this.pendingResolve === finish) this.pendingResolve = null;
          resolve(value);
        };
        this.pendingResolve = finish;
        media.addEventListener("ended", () => {
          if (generation !== this.generation) return finish(false);
          cancelAnimationFrame(this.mediaFrame);
          this.mediaFrame = 0;
          this.media = null;
          element?.classList.remove("is-playing");
          onCue?.(null, -1, Number(entry.duration) || media.currentTime);
          options.onTime?.(Number(entry.duration) || media.currentTime, Number(entry.duration) || media.duration || 0);
          options.onEnd?.();
          this.setStatus("Sound: ready");
          finish(true);
        }, { once: true });
        media.addEventListener("error", () => {
          if (generation !== this.generation) return finish(false);
          cancelAnimationFrame(this.mediaFrame);
          this.mediaFrame = 0;
          element?.classList.remove("is-playing");
          if (this.media === media) this.media = null;
          if (generation === this.generation) this.setStatus("Voice could not play — try again");
          finish(false);
        }, { once: true });
      });
      await media.play();
      if (generation !== this.generation) { media.pause(); return false; }
      this.setStatus(options.statusLabel || "Playing voice");
      update();
      return await completed;
    } catch (error) {
      if (generation === this.generation) {
        element?.classList.remove("is-playing");
        this.media = null;
        this.pendingResolve?.(false);
        this.pendingResolve = null;
        this.setStatus("Voice could not load — try again");
        console.error("Karaoke clip failed", error);
      }
      return false;
    }
  }

  async playClipSequence(stems, element, onStep = null) {
    element?.classList.add("is-playing");
    try {
      for (let index = 0; index < stems.length; index += 1) {
        onStep?.(index, stems[index]);
        const ok = await this.playClip(stems[index], element);
        if (!ok) return false;
      }
      element?.classList.remove("is-playing");
      onStep?.(-1, null);
      return true;
    } catch { return false; }
  }

  async frequencySteps(frequencies, element, onStep = null, stepMs = 370, toneMs = 320, label = "Tuning") {
    this.stop();
    const generation = this.generation;
    try {
      if (this.sampler?.prepareContext) {
        this.context = await this.sampler.prepareContext();
      } else {
        configurePlaybackSession();
        const Context = window.AudioContext || window.webkitAudioContext;
        if (!Context) throw new Error("Web Audio is unavailable");
        if (!this.context || this.context.state === "closed") this.context = new Context();
        await resumePlaybackContext(this.context);
      }
    } catch (error) {
      if (generation === this.generation) this.setStatus("Sound could not start — tap to retry");
      return false;
    }
    if (generation !== this.generation) return false;
    this.monitorContext(this.context, generation);
    element?.classList.add("is-playing");
    const playTone = (frequency) => {
      const now = this.context.currentTime;
      const oscillator = this.context.createOscillator();
      const gain = this.context.createGain();
      oscillator.type = "triangle";
      oscillator.frequency.setValueAtTime(frequency, now);
      gain.gain.setValueAtTime(.0001, now);
      gain.gain.exponentialRampToValueAtTime(.055, now + .018);
      gain.gain.setValueAtTime(.055, now + Math.max(.04, toneMs / 1000 - .08));
      gain.gain.exponentialRampToValueAtTime(.0001, now + toneMs / 1000);
      oscillator.connect(gain).connect(this.context.destination);
      const voice = { oscillator, gain };
      this.localVoices.add(voice);
      oscillator.addEventListener("ended", () => this.localVoices.delete(voice), { once: true });
      oscillator.start(now);
      oscillator.stop(now + toneMs / 1000 + .025);
    };
    frequencies.forEach((frequency, index) => {
      const timer = setTimeout(() => {
        this.timers.delete(timer);
        if (generation !== this.generation) return;
        if (this.context.state !== "running") {
          this.stop();
          this.setStatus("Sound paused — tap to retry");
          return;
        }
        playTone(frequency);
        onStep?.(index);
        this.setStatus(`${label} · ${index + 1}/${frequencies.length}`);
      }, index * stepMs);
      this.timers.add(timer);
    });
    const completed = await this.completionTimer(generation, frequencies.length * stepMs + 80, element);
    if (completed) onStep?.(-1);
    return completed;
  }

  frequencies(values, element, duration = 1100, label = "Tuning") {
    return this.frequencySteps(values, element, null, Math.max(180, duration / values.length), Math.max(160, duration / values.length - 20), label);
  }
}
