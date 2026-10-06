const kind = new URLSearchParams(location.search).get("demo");
const panel = document.querySelector("#rehearsalPanel");
const bridge = window.TonnetzDemoBridge;
const validKind = kind === "melody" || kind === "harmony";

if (panel && bridge && validKind) {
  panel.hidden = false;
  const instrument = document.querySelector("#instrument");
  instrument?.classList.add("rehearsal-active");
  const $ = (id) => document.querySelector(`#${id}`);
  const els = {
    role: $("rehearsalRole"), kicker: $("rehearsalKicker"), title: $("rehearsalTitle"), status: $("rehearsalStatus"),
    current: $("currentStep"), next: $("nextStep"), count: $("stepCount"), prev: $("practicePrev"), nextButton: $("practiceNext"),
    playAlong: $("practiceDemo"), listen: $("practiceListen"), stop: $("practiceStop"), countIn: $("countIn"), collapse: $("rehearsalCollapse"),
    file: $("trackFile"), fileName: $("trackName"), speed: $("trackSpeed"), continueButton: $("trackPlay"), pause: $("trackPause"),
    restart: $("trackRestart"), trackStop: $("trackStop"), restore: $("restorePractice"), notice: $("trackNotice")
  };
  const mediaBase = new URL("../media/concertos/", import.meta.url);
  const jsonUrl = new URL(`${kind}.json`, mediaBase);
  const builtIn = { backing: null, reference: null };
  let rehearsal = null;
  let activeAudio = null;
  let activeTrack = "backing";
  let importedAudio = null;
  let importedUrl = "";
  let imported = false;
  let step = 0;
  let countTimer = 0;
  let countGeneration = 0;
  let playGeneration = 0;
  let syncFrame = 0;
  let loading = true;
  let pendingPlayback = false;
  let guideVisualKey = "";
  const updatePanelInset = () => {
    const bottom = Math.ceil(panel.getBoundingClientRect().bottom + 10);
    document.documentElement.style.setProperty("--rehearsal-inset-top", `${bottom}px`);
    requestAnimationFrame(() => window.dispatchEvent(new Event("resize")));
  };
  const panelObserver = typeof ResizeObserver === "function" ? new ResizeObserver(updatePanelInset) : null;
  panelObserver?.observe(panel);
  updatePanelInset();

  const rate = () => Number(els.speed.value) || 1;
  const guide = () => rehearsal?.guide || [];
  const cueName = (cue) => cue?.name || (cue?.midis || []).join(" · ") || "—";
  const formatTime = (seconds) => Number.isFinite(seconds) ? `${Math.floor(seconds / 60)}:${String(Math.floor(seconds % 60)).padStart(2, "0")}` : "—:—";

  function setCoreEnabled(enabled) {
    [els.prev, els.nextButton, els.playAlong, els.listen, els.stop, els.restart, els.trackStop].forEach((button) => { button.disabled = !enabled; });
    if (!enabled) { els.continueButton.disabled = true; els.pause.disabled = true; }
  }

  function drawGuide(nextStep = step) {
    if (!rehearsal || imported || !guide().length) return;
    step = Math.max(0, Math.min(nextStep, guide().length - 1));
    const current = guide()[step];
    const following = guide()[step + 1];
    els.current.textContent = cueName(current);
    els.next.textContent = cueName(following);
    els.count.textContent = `${step + 1} / ${guide().length}${current.bar ? ` · bar ${current.bar}` : ""}`;
    els.prev.disabled = step === 0;
    els.nextButton.disabled = step === guide().length - 1;
    bridge.guideStep(current, following);
    guideVisualKey = `manual:${step}`;
  }

  function guideIndexAt(time) {
    const cues = guide();
    let low = 0, high = cues.length - 1, found = -1;
    while (low <= high) {
      const middle = (low + high) >> 1;
      if (cues[middle].time <= time + 0.008) { found = middle; low = middle + 1; }
      else high = middle - 1;
    }
    return found;
  }

  function syncGuideToAudio() {
    cancelAnimationFrame(syncFrame);
    syncFrame = 0;
    if (!activeAudio || imported || activeAudio.paused || activeAudio.ended) return;
    const nextStep = guideIndexAt(activeAudio.currentTime);
    const orientationStep = Math.max(0, nextStep);
    if (orientationStep !== step) drawGuide(orientationStep);
    const currentCue = nextStep >= 0 ? guide()[nextStep] : null;
    const currentIsActive = currentCue && activeAudio.currentTime < currentCue.time + currentCue.duration;
    const upcomingCue = nextStep < 0 ? guide()[0] : guide()[nextStep + 1];
    const nextVisualKey = `${nextStep}:${Boolean(currentIsActive)}`;
    if (nextVisualKey !== guideVisualKey) {
      bridge.guideStep(currentIsActive ? currentCue : null, upcomingCue);
      guideVisualKey = nextVisualKey;
    }
    const mediaDuration = Number.isFinite(activeAudio.duration) ? activeAudio.duration : rehearsal.files?.[activeTrack]?.duration || rehearsal.duration;
    els.status.textContent = `${activeTrack === "reference" ? "Listening" : "Playing along"} · ${formatTime(activeAudio.currentTime)} / ${formatTime(mediaDuration)}`;
    syncFrame = requestAnimationFrame(syncGuideToAudio);
  }

  function cancelCountIn() {
    countGeneration += 1;
    if (countTimer) clearTimeout(countTimer);
    countTimer = 0;
    els.countIn.classList.remove("is-active");
    els.countIn.textContent = "";
  }

  function pauseEveryAudio({ reset = false } = {}) {
    [...Object.values(builtIn), importedAudio].filter(Boolean).forEach((audio) => {
      audio.pause();
      if (reset) {
        try { audio.currentTime = 0; } catch {}
      }
    });
  }

  function stopPlayback({ reset = false, clearGuide = false } = {}) {
    playGeneration += 1;
    pendingPlayback = false;
    cancelCountIn();
    cancelAnimationFrame(syncFrame);
    syncFrame = 0;
    pauseEveryAudio({ reset });
    bridge.stopAll();
    guideVisualKey = "";
    if (clearGuide) bridge.clearGuides();
    els.continueButton.disabled = !activeAudio;
    els.pause.disabled = true;
  }

  function beginCountIn(done) {
    cancelCountIn();
    bridge.enableAudio();
    const generation = countGeneration;
    const beatMs = Math.max(140, (rehearsal.beatSeconds / rate()) * 1000);
    let beat = 1;
    els.countIn.classList.add("is-active");
    const tick = () => {
      if (generation !== countGeneration) return;
      if (beat <= 4) {
        els.countIn.textContent = String(beat);
        bridge.playMidi(beat === 4 ? 88 : 84, 90);
        beat += 1;
        countTimer = window.setTimeout(tick, beatMs);
      } else {
        countTimer = 0;
        els.countIn.classList.remove("is-active");
        els.countIn.textContent = "";
        done();
      }
    };
    tick();
  }

  function waitUntilPlayable(audio) {
    if (audio.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) return Promise.resolve();
    els.status.textContent = "Loading audio…";
    return new Promise((resolve, reject) => {
      const ready = () => { cleanup(); resolve(); };
      const failed = () => { cleanup(); reject(new Error("Audio could not be loaded")); };
      const cleanup = () => { audio.removeEventListener("canplay", ready); audio.removeEventListener("error", failed); };
      audio.addEventListener("canplay", ready, { once: true });
      audio.addEventListener("error", failed, { once: true });
      audio.load();
    });
  }

  async function playBuiltIn(track) {
    if (loading || !rehearsal || imported) return;
    stopPlayback({ reset: true });
    const generation = playGeneration;
    pendingPlayback = true;
    activeTrack = track;
    activeAudio = builtIn[track];
    activeAudio.playbackRate = rate();
    step = 0;
    drawGuide();
    els.fileName.textContent = track === "reference" ? "Reference mix" : "Backing track";
    els.status.textContent = "Loading audio…";
    try {
      await waitUntilPlayable(activeAudio);
      if (generation !== playGeneration) return;
      els.status.textContent = `Four-beat count-in · ${Math.round(rate() * 100)}% speed`;
      els.pause.disabled = false;
      els.continueButton.disabled = true;
      beginCountIn(() => {
        activeAudio.play().then(() => {
          pendingPlayback = false;
          els.pause.disabled = false;
          els.continueButton.disabled = true;
          syncGuideToAudio();
        }).catch(() => { pendingPlayback = false; els.status.textContent = "Playback was blocked. Press Play along or Listen again."; });
      });
    } catch {
      pendingPlayback = false;
      els.status.textContent = "This rehearsal audio could not be loaded.";
    }
  }

  function continuePlayback() {
    if (!activeAudio) return;
    if (imported) bridge.clearGuides();
    activeAudio.playbackRate = rate();
    activeAudio.play().then(() => {
      els.status.textContent = imported ? "Playing local audio · guide disabled" : `Continuing ${activeTrack === "reference" ? "reference" : "backing"}`;
      els.pause.disabled = false;
      els.continueButton.disabled = true;
      if (!imported) syncGuideToAudio();
    }).catch(() => { els.status.textContent = "Playback failed. Reload the audio and try again."; });
  }

  function setImportedState() {
    imported = true;
    stopPlayback({ clearGuide: true });
    activeAudio = importedAudio;
    activeTrack = "imported";
    activeAudio.playbackRate = rate();
    els.kicker.textContent = "LOCAL AUDIO · NO MATCHED GUIDE";
    els.title.textContent = "Free play";
    els.status.textContent = "The concerto guide is disabled because this file has no matched timeline.";
    els.current.textContent = "Free";
    els.next.textContent = "—";
    els.count.textContent = "Not synchronized";
    [els.prev, els.nextButton, els.playAlong, els.listen].forEach((button) => { button.disabled = true; });
    [els.continueButton, els.restart, els.trackStop].forEach((button) => { button.disabled = false; });
    els.pause.disabled = true;
    els.restore.hidden = false;
    els.notice.textContent = "Local audio plays only on this device. Its timeline is unknown, so no concerto cues are shown.";
  }

  function restoreBuiltIn() {
    stopPlayback({ reset: true });
    imported = false;
    activeTrack = "backing";
    activeAudio = builtIn.backing;
    els.kicker.textContent = `${rehearsal.composer.toUpperCase()} · CONCERTO EXCERPT`;
    els.title.textContent = rehearsal.label;
    els.status.textContent = "Ready. Choose Play along or Listen.";
    els.fileName.textContent = "Built-in concerto audio";
    els.notice.textContent = "Play along uses the backing track; Listen uses the reference mix. The highlighted cue follows the audio clock.";
    [els.playAlong, els.listen, els.nextButton, els.stop, els.restart, els.trackStop].forEach((button) => { button.disabled = false; });
    els.continueButton.disabled = true;
    els.pause.disabled = true;
    els.restore.hidden = true;
    step = 0;
    drawGuide();
  }

  function seekCue(delta) {
    if (!rehearsal || imported) return;
    stopPlayback();
    const target = Math.max(0, Math.min(step + delta, guide().length - 1));
    step = target;
    activeAudio ||= builtIn.backing;
    try { activeAudio.currentTime = guide()[step].time; } catch {}
    drawGuide();
    els.status.textContent = `Cue selected at ${formatTime(guide()[step].time)}. Press Continue to resume.`;
    els.continueButton.disabled = false;
  }

  function restartActive() {
    if (!activeAudio) return;
    if (imported) {
      stopPlayback({ reset: true, clearGuide: true });
      els.status.textContent = "Local audio returned to the start. Press Continue to play.";
      els.continueButton.disabled = false;
      return;
    }
    playBuiltIn(activeTrack === "reference" ? "reference" : "backing");
  }

  function attachAudioEvents(audio, track) {
    audio.preload = "auto";
    audio.addEventListener("ended", () => {
      cancelAnimationFrame(syncFrame);
      syncFrame = 0;
      els.pause.disabled = true;
      els.continueButton.disabled = true;
      if (track === "imported") els.status.textContent = "Local audio finished · guide disabled";
      else {
        step = guide().length - 1;
        drawGuide(step);
        bridge.clearGuides();
        els.status.textContent = `${track === "reference" ? "Reference" : "Backing track"} finished.`;
      }
    });
    audio.addEventListener("waiting", () => { if (!audio.paused) els.status.textContent = "Buffering audio…"; });
    audio.addEventListener("error", () => { els.status.textContent = "Audio could not be loaded. Check that the rehearsal media files are present."; });
  }

  els.prev.addEventListener("click", () => seekCue(-1));
  els.nextButton.addEventListener("click", () => seekCue(1));
  els.playAlong.addEventListener("click", () => playBuiltIn("backing"));
  els.listen.addEventListener("click", () => playBuiltIn("reference"));
  els.stop.addEventListener("click", () => {
    stopPlayback({ reset: true, clearGuide: imported });
    if (!imported) { step = 0; drawGuide(); }
    els.status.textContent = imported ? "Local audio stopped · guide disabled" : "Stopped at the beginning.";
    if (!imported) els.continueButton.disabled = true;
  });
  els.collapse.addEventListener("click", () => {
    const collapsed = panel.classList.toggle("is-collapsed");
    els.collapse.textContent = collapsed ? "Expand" : "Collapse";
    els.collapse.setAttribute("aria-expanded", String(!collapsed));
  });
  els.speed.addEventListener("change", () => {
    [...Object.values(builtIn), importedAudio].filter(Boolean).forEach((audio) => { audio.playbackRate = rate(); });
    if (countTimer || pendingPlayback) { stopPlayback(); if (!imported) drawGuide(step); els.continueButton.disabled = true; els.status.textContent = "Speed changed. Start the count-in again."; }
  });
  els.continueButton.addEventListener("click", continuePlayback);
  els.pause.addEventListener("click", () => {
    if (!activeAudio) return;
    const cancellingCountIn = Boolean(countTimer || pendingPlayback);
    stopPlayback();
    if (!imported) drawGuide(step);
    els.pause.disabled = true;
    els.continueButton.disabled = cancellingCountIn ? true : false;
    els.status.textContent = cancellingCountIn ? "Count-in cancelled. Start again when ready." : imported ? "Local audio paused · guide disabled" : `Paused at ${formatTime(activeAudio.currentTime)}.`;
  });
  els.restart.addEventListener("click", restartActive);
  els.trackStop.addEventListener("click", () => els.stop.click());
  els.restore.addEventListener("click", restoreBuiltIn);
  els.file.addEventListener("change", () => {
    const file = els.file.files?.[0];
    if (!file) return;
    stopPlayback({ reset: true });
    if (importedUrl) URL.revokeObjectURL(importedUrl);
    importedUrl = URL.createObjectURL(file);
    importedAudio = new Audio(importedUrl);
    attachAudioEvents(importedAudio, "imported");
    els.fileName.textContent = file.name;
    setImportedState();
  });

  window.addEventListener("blur", () => {
    if (!countTimer && !pendingPlayback && (!activeAudio || activeAudio.paused)) return;
    stopPlayback();
    if (!imported) drawGuide(step);
    els.pause.disabled = true; els.continueButton.disabled = false; els.status.textContent = "Paused when the window lost focus.";
  });
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden || (!countTimer && !pendingPlayback && (!activeAudio || activeAudio.paused))) return;
    stopPlayback();
    if (!imported) drawGuide(step);
    els.pause.disabled = true; els.continueButton.disabled = false;
  });
  window.addEventListener("pagehide", () => {
    stopPlayback({ reset: true, clearGuide: true });
    panelObserver?.disconnect();
    instrument?.classList.remove("rehearsal-active");
    document.documentElement.style.setProperty("--rehearsal-inset-top", "0px");
    if (importedUrl) URL.revokeObjectURL(importedUrl);
  });

  setCoreEnabled(false);
  fetch(jsonUrl, { cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`Guide returned ${response.status}`);
    return response.json();
  }).then((data) => {
    if (!data || data.id !== kind || !Array.isArray(data.guide) || !data.guide.length || !data.files?.backing?.file || !data.files?.reference?.file) throw new Error("Invalid rehearsal guide");
    data.guide = data.guide.filter((cue) => Number.isFinite(cue.time) && (Array.isArray(cue.coords) || Array.isArray(cue.midis))).sort((a, b) => a.time - b.time);
    if (!data.guide.length) throw new Error("Guide has no playable cues");
    rehearsal = data;
    const rehearsalMidis = rehearsal.guide.flatMap((cue) => cue.midis || []);
    const range = bridge.prepareRehearsal({ mode: rehearsal.mode, midis: rehearsalMidis });
    if (range.missing.length) throw new Error(`Keyboard range is missing MIDI ${range.missing.join(", ")}`);
    bridge.setSkin(kind === "melody" ? "piano" : "tonnetz");
    builtIn.backing = new Audio(new URL(rehearsal.files.backing.file, mediaBase));
    builtIn.reference = new Audio(new URL(rehearsal.files.reference.file, mediaBase));
    attachAudioEvents(builtIn.backing, "backing");
    attachAudioEvents(builtIn.reference, "reference");
    activeAudio = builtIn.backing;
    activeAudio.playbackRate = rate();
    loading = false;
    els.role.textContent = kind === "melody" ? "YOU PLAY THE SOLOIST · CLASSIC" : "YOU PLAY THE CHORDS · HARMONIC";
    setCoreEnabled(true);
    restoreBuiltIn();
  }).catch((error) => {
    loading = false;
    bridge.clearGuides();
    setCoreEnabled(false);
    els.kicker.textContent = "REHEARSAL UNAVAILABLE";
    els.title.textContent = kind === "melody" ? "Tchaikovsky" : "Mendelssohn";
    els.status.textContent = "The concerto guide or audio manifest could not be loaded. No fallback exercise was started.";
    els.notice.textContent = error.message;
  });
}
