import {
  CHORD_VOCAB,
  PALETTES,
  prepareModels,
  predictNext,
  sampleDistribution,
  voiceChord
} from "./harmony-models.js";

const MODEL_TABS = Object.freeze([
  Object.freeze({ id: "markov1", label: "Markov · 1", explanation: "Current chord" }),
  Object.freeze({ id: "markov2", label: "Markov · 2", explanation: "Previous two chords" }),
  Object.freeze({ id: "transformer", label: "Transformer", explanation: "Up to eight chords" })
]);

const chordById = new Map(CHORD_VOCAB.map((chord) => [chord.id, chord]));
const paletteById = new Map(PALETTES.map((palette) => [palette.id, palette]));

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

const chordLabel = (id) => chordById.get(id)?.label || id;
const chordRoman = (id) => chordById.get(id)?.roman || "";
const percent = (value) => value > 0 && value < .01 ? "&lt;1%" : `${Math.round(Number(value || 0) * 100)}%`;

export function formulaForModel(model) {
  if (model === "markov2") return "P(c_{t+1}\\mid c_{t-1},c_t)";
  if (model === "transformer") return "P(c_{t+1}\\mid c_{\\leq t})";
  return "P(c_{t+1}\\mid c_t)";
}

export function summarizeDistribution(distribution, limit = 5) {
  const normalized = [...(distribution || [])]
    .filter((item) => Number.isFinite(item?.probability) && item.probability >= 0)
    .sort((a, b) => b.probability - a.probability);
  const visible = normalized.filter((item) => item.probability > 0).slice(0, limit);
  const shownIds = new Set(visible.map((item) => item.id));
  const other = normalized.reduce((sum, item) => sum + (shownIds.has(item.id) ? 0 : item.probability), 0);
  return { visible, other };
}

export function createArpeggioLoop({ audio, tempo = 260, setTimer = setTimeout }) {
  if (!audio || typeof audio.preparePiano !== "function" || typeof audio.playMidiNow !== "function") {
    throw new TypeError("Arpeggio loop requires the shared audio player");
  }
  let loopGeneration = 0;
  let active = false;

  async function run(token, midis, label) {
    const audioGeneration = audio.generation;
    let prepared = false;
    try { prepared = await audio.preparePiano(audioGeneration); } catch { prepared = false; }
    if (!prepared) {
      if (token === loopGeneration) active = false;
      return false;
    }
    if (!active || token !== loopGeneration || audioGeneration !== audio.generation) return false;
    let index = 0;
    const playStep = () => {
      if (!active || token !== loopGeneration || audioGeneration !== audio.generation) return;
      if (!audio.playMidiNow(midis[index], Math.max(480, tempo * 1.8), .68)) {
        active = false;
        loopGeneration += 1;
        audio.stop();
        audio.setStatus?.("Sound is unavailable — tap to retry");
        return;
      }
      audio.setStatus?.(`Looping: ${label}`);
      index = (index + 1) % midis.length;
      const timer = setTimer(() => {
        audio.timers?.delete(timer);
        playStep();
      }, tempo);
      audio.timers?.add(timer);
    };
    playStep();
    return true;
  }

  function start(midis, label) {
    if (!Array.isArray(midis) || !midis.length || midis.some((midi) => !Number.isFinite(midi))) return false;
    const token = ++loopGeneration;
    active = true;
    audio.stop();
    void run(token, [...midis], label);
    return true;
  }

  function stop({ silence = true } = {}) {
    active = false;
    loopGeneration += 1;
    if (silence) audio.stop();
  }

  return { start, stop, get active() { return active; } };
}

function initialChord() {
  const classical = paletteById.get("classical");
  return classical?.chordIds?.includes("C") ? "C" : classical?.chordIds?.[0] || CHORD_VOCAB[0]?.id;
}

function shellHTML() {
  return `<section class="harmony-explorer" data-harmony-explorer aria-label="Harmony generator">
    <div class="harmony-topline">
      <div class="harmony-tabs" role="tablist" aria-label="Harmony model">
        ${MODEL_TABS.map(({ id, label }) => `<button type="button" role="tab" data-model="${id}">${label}</button>`).join("")}
      </div>
      <div class="harmony-formula"><span data-model-caption></span><em>New chord every step</em><b data-model-formula></b></div>
    </div>
    <div class="harmony-control-row">
      <label class="harmony-temperature" data-no-advance>
        <span>Temperature</span>
        <input type="range" min="0.25" max="2" step="0.01" data-temperature aria-label="Temperature">
        <output data-temperature-output>0.82</output>
      </label>
      <p>If you want to play some melody, please visit <a href="https://www.aigimon.com/tonnetz/" target="_blank" rel="noopener noreferrer">aigimon.ai/tonnetz</a></p>
    </div>
    <div class="harmony-workspace" data-workspace aria-live="polite"></div>
    <div class="harmony-history-row">
      <span class="harmony-history-label">History</span>
      <div class="harmony-history" data-history></div>
    </div>
    <div class="harmony-actions">
      <button type="button" class="harmony-primary" data-action="play">▶ Play 8</button>
      <button type="button" data-action="next">Next chord</button>
      <button type="button" data-action="palette">New palette</button>
      <button type="button" data-action="parameters">Parameters</button>
    </div>
    <div class="harmony-drawer" data-drawer data-no-advance hidden></div>
  </section>`;
}

function graphHTML(prediction, currentId, selectedId, busy) {
  const { visible } = summarizeDistribution(prediction?.distribution, 5);
  const positions = visible.map((_, index) => 52 + index * (visible.length > 1 ? 272 / (visible.length - 1) : 0));
  const edges = visible.map((item, index) => `<line x1="170" y1="190" x2="420" y2="${positions[index]}" class="${item.id === selectedId ? "is-selected" : ""}"/><text x="294" y="${(190 + positions[index]) / 2 - 5}">${percent(item.probability)}</text>`).join("");
  const nodes = visible.map((item, index) => `<g class="harmony-next-node ${item.id === selectedId ? "is-selected" : ""}" transform="translate(470 ${positions[index]})" role="button" tabindex="${busy ? -1 : 0}" aria-disabled="${busy}" aria-label="Play ${escapeHTML(chordLabel(item.id))}, ${percent(item.probability)} probability" data-next-chord="${escapeHTML(item.id)}"><rect x="-47" y="-26" width="94" height="52" rx="15"/><text y="1">${escapeHTML(chordLabel(item.id))}</text><title>${escapeHTML(chordLabel(item.id))}: ${percent(item.probability)}</title></g>`).join("");
  return `<div class="harmony-graph-card">
    <span class="harmony-kicker">LIKELY PATHS</span>
    <svg class="harmony-graph" viewBox="0 0 560 360" role="group" aria-label="Current chord and strongest next chord probabilities">
      <defs><marker id="harmonyArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto"><path d="M0 0L10 5L0 10Z"/></marker></defs>
      <g class="harmony-graph-edges">${edges}</g>
      <g class="harmony-current-node" transform="translate(122 190)"><circle r="61"/><text class="harmony-current-name" y="2">${escapeHTML(chordLabel(currentId))}</text><text class="harmony-current-roman" y="34">${escapeHTML(chordRoman(currentId))}</text></g>
      ${nodes}
    </svg>
  </div>`;
}

function distributionHTML(prediction, selectedId) {
  const { visible, other } = summarizeDistribution(prediction?.distribution, 5);
  const rows = visible.map((item) => `<div class="harmony-prob-row ${item.id === selectedId ? "is-selected" : ""}">
    <span>${escapeHTML(chordLabel(item.id))}</span><i><b style="--prob:${Math.max(0, Math.min(1, item.probability))}"></b></i><strong>${percent(item.probability)}</strong>
  </div>`).join("");
  const otherRow = other > 0.0005 ? `<div class="harmony-prob-row is-other"><span>Other</span><i><b style="--prob:${Math.min(1, other)}"></b></i><strong>${percent(other)}</strong></div>` : "";
  return `<div class="harmony-distribution"><div class="harmony-panel-heading"><span>Next-chord probability</span><small>same distribution used to sample</small></div>${rows}${otherRow}</div>`;
}

function attentionHTML(prediction, selectedHead) {
  const heads = Array.isArray(prediction?.attention) ? prediction.attention : [];
  if (!heads.length) return `<div class="harmony-attention-empty">Attention is unavailable for this prediction.</div>`;
  const headIndex = Math.max(0, Math.min(selectedHead, heads.length - 1));
  const matrix = heads[headIndex] || [];
  const tokens = (prediction.tokens || []).slice(-8);
  const headButtons = heads.map((_, index) => `<button type="button" data-head="${index}" class="${index === headIndex ? "is-active" : ""}" aria-pressed="${index === headIndex}">Head ${index + 1}</button>`).join("");
  const header = tokens.map((token) => `<th scope="col" title="${escapeHTML(chordLabel(token))}">${escapeHTML(chordLabel(token))}</th>`).join("");
  const rows = tokens.map((token, query) => `<tr><th scope="row">${escapeHTML(chordLabel(token))}</th>${tokens.map((_, key) => {
    const allowed = key <= query;
    const value = allowed ? Number(matrix[query]?.[key] || 0) : 0;
    return `<td class="${allowed ? "" : "is-masked"}" style="--attention:${Math.max(0, Math.min(1, value))}" title="${allowed ? value.toFixed(3) : "Causal mask"}">${allowed ? value.toFixed(2) : "—"}</td>`;
  }).join("")}</tr>`).join("");
  return `<div class="harmony-attention"><div class="harmony-attention-top"><span>Attention weights</span><div>${headButtons}</div></div><div class="harmony-matrix-scroll"><table aria-label="Causal attention matrix, rows are queries and columns are keys"><thead><tr><th>q \\ k</th>${header}</tr></thead><tbody>${rows}</tbody></table></div></div>`;
}

function workspaceHTML(state) {
  if (state.modelError) return `<div class="harmony-load-error" role="alert"><strong>Model could not load.</strong><span>${escapeHTML(state.modelError.message || "Please try again.")}</span><button type="button" data-action="retry">Retry</button></div>`;
  if (!state.prediction) return `<div class="harmony-loading" role="status"><span></span>Preparing ${escapeHTML(MODEL_TABS.find((item) => item.id === state.model)?.label || "model")}…</div>`;
  return `<div class="harmony-main-grid ${state.model === "transformer" ? "has-attention" : ""}">
    ${graphHTML(state.prediction, state.prediction.tokens?.at(-1) || state.history.at(-1), state.selectedId, state.busy)}
    <div class="harmony-evidence">${distributionHTML(state.prediction, state.selectedId)}${state.model === "transformer" ? attentionHTML(state.prediction, state.selectedHead) : ""}</div>
  </div>`;
}

function historyHTML(history) {
  return history.slice(-8).map((id, index, items) => `<span class="${index === items.length - 1 ? "is-current" : ""}"><b>${escapeHTML(chordLabel(id))}</b><small>${escapeHTML(chordRoman(id))}</small></span>`).join("");
}

function parameterValueHTML(value) {
  if (Array.isArray(value)) return escapeHTML(value.join(" × "));
  if (value && typeof value === "object") return escapeHTML(Object.entries(value).map(([key, item]) => `${key}: ${Array.isArray(item) ? item.join(" × ") : item}`).join(" · "));
  return escapeHTML(value ?? "—");
}

function drawerHTML(state) {
  const palette = paletteById.get(state.palette);
  const params = state.prediction?.parameters || {};
  const provenance = params.provenance || "Authored teaching model; probabilities are authored musical choices.";
  const entries = Object.entries(params).filter(([key]) => !["provenance", "mustChangeChord"].includes(key));
  return `<div class="harmony-drawer-head"><div><small>CHORDS & PARAMETERS</small><strong>${escapeHTML(palette?.label || state.palette)}</strong><span>${escapeHTML(palette?.description || "")}</span></div><button type="button" data-action="close" aria-label="Close parameters">×</button></div>
    <div class="harmony-drawer-body">
      <section><h4>Playable palette <span>${palette?.chordIds?.length || 0}</span></h4><div class="harmony-chord-palette">${(palette?.chordIds || []).map((id) => `<button type="button" data-chord="${escapeHTML(id)}"><b>${escapeHTML(chordLabel(id))}</b><small>${escapeHTML(chordRoman(id))}</small></button>`).join("")}</div></section>
      <section class="harmony-parameter-list"><h4>Current model</h4><dl><div><dt>Model</dt><dd>${escapeHTML(MODEL_TABS.find((item) => item.id === state.model)?.label || state.model)}</dd></div><div><dt>Context</dt><dd>${escapeHTML(state.prediction?.tokens?.length || 1)} / ${state.model === "markov1" ? 1 : state.model === "markov2" ? 2 : 8} chords</dd></div><div><dt>Must change chord</dt><dd>${params.mustChangeChord === false ? "No" : "Yes"}</dd></div>${entries.map(([key, value]) => `<div><dt>${escapeHTML(key.replace(/([a-z])([A-Z])/g, "$1 $2"))}</dt><dd>${parameterValueHTML(value)}</dd></div>`).join("")}</dl><p><b>Provenance</b>${escapeHTML(provenance)}</p><p>Probabilities are authored musical choices. The Transformer was trained on synthetic teaching phrases, not real recordings.</p></section>
    </div>`;
}

export function createHarmonyExplorer({ container, audio, claimInput, guardedRun, onComplete, renderMath }) {
  if (!container || !audio || typeof guardedRun !== "function") throw new TypeError("Harmony explorer requires container, audio and guardedRun");
  const state = {
    model: "markov1", palette: "pop", history: [initialChord()], lastVoicing: voiceChord(initialChord()), prediction: null,
    temperature: paletteById.get("pop")?.temperature || 1,
    selectedId: null, selectedHead: 0, drawerOpen: false, busy: false, entered: false, pendingArpeggio: false,
    modelError: null, request: 0, lifecycle: 0
  };
  let installed = false;
  const arpeggio = createArpeggioLoop({ audio });

  const currentPalette = () => paletteById.get(state.palette);
  const modelCaption = () => MODEL_TABS.find((item) => item.id === state.model)?.explanation || "";
  const arpeggioNotes = (midis) => [...midis, midis[0] + 12];

  function restoreHistoryVisual() {
    const history = container.querySelector("[data-history]");
    if (history) history.innerHTML = historyHTML(state.history);
  }

  function startArpeggio(lifecycle = state.lifecycle) {
    if (!state.entered || lifecycle !== state.lifecycle) return false;
    const currentId = state.history.at(-1);
    const started = arpeggio.start(arpeggioNotes(state.lastVoicing), chordLabel(currentId));
    restoreHistoryVisual();
    return started;
  }

  function render() {
    if (!installed) {
      container.innerHTML = shellHTML();
      container.addEventListener("click", handleClick);
      container.addEventListener("keydown", handleKeydown);
      container.addEventListener("input", handleTemperatureInput);
      installed = true;
    }
    const root = container.querySelector("[data-harmony-explorer]");
    root?.classList.toggle("is-busy", state.busy);
    root?.classList.toggle("has-drawer", state.drawerOpen);
    root?.setAttribute("aria-busy", String(state.busy));
    container.querySelectorAll("[data-model]").forEach((button) => {
      const active = button.dataset.model === state.model;
      button.classList.toggle("is-active", active);
      button.setAttribute("aria-selected", String(active));
      button.tabIndex = active ? 0 : -1;
      button.disabled = state.busy;
    });
    const caption = container.querySelector("[data-model-caption]");
    if (caption) caption.textContent = modelCaption();
    const temperatureInput = container.querySelector("[data-temperature]");
    if (temperatureInput) {
      if (Number(temperatureInput.value) !== state.temperature) temperatureInput.value = String(state.temperature);
      temperatureInput.disabled = state.busy || !state.prediction;
    }
    const temperatureOutput = container.querySelector("[data-temperature-output]");
    if (temperatureOutput) {
      temperatureOutput.value = state.temperature.toFixed(2);
      temperatureOutput.textContent = state.temperature.toFixed(2);
    }
    const formula = container.querySelector("[data-model-formula]");
    if (formula) {
      formula.textContent = formulaForModel(state.model);
      formula.dataset.tex = formulaForModel(state.model);
      delete formula.dataset.mathRendered;
    }
    const workspace = container.querySelector("[data-workspace]");
    if (workspace) workspace.innerHTML = workspaceHTML(state);
    const history = container.querySelector("[data-history]");
    if (history) history.innerHTML = historyHTML(state.history);
    const paletteButton = container.querySelector('[data-action="palette"]');
    if (paletteButton) paletteButton.textContent = `New palette · ${currentPalette()?.label || state.palette}`;
    container.querySelectorAll(".harmony-actions button").forEach((button) => { button.disabled = state.busy || !state.prediction; });
    const drawer = container.querySelector("[data-drawer]");
    if (drawer) {
      drawer.hidden = !state.drawerOpen;
      drawer.innerHTML = state.drawerOpen ? drawerHTML(state) : "";
      drawer.querySelectorAll("button").forEach((button) => { button.disabled = state.busy; });
    }
    try { renderMath?.(container); } catch (error) { console.error("Harmony formula rendering failed", error); }
    return root;
  }

  async function refreshPrediction({ preservePrediction = false } = {}) {
    const request = ++state.request;
    if (!preservePrediction) state.prediction = null;
    state.modelError = null;
    state.selectedId = null;
    render();
    try {
      await prepareModels();
      const prediction = await predictNext(state.history, { model: state.model, palette: state.palette, temperature: state.temperature });
      if (request !== state.request) return false;
      state.prediction = prediction;
      state.selectedHead = Math.min(state.selectedHead, Math.max(0, (prediction.attention?.length || 1) - 1));
      render();
      if (state.pendingArpeggio && state.entered && !state.busy) {
        state.pendingArpeggio = false;
        startArpeggio();
      }
      return true;
    } catch (error) {
      if (request !== state.request) return false;
      state.modelError = error instanceof Error ? error : new Error(String(error));
      render();
      return false;
    }
  }

  function appendAudibleChord(id) { state.history = [...state.history.slice(-7), id]; }

  async function playNext(chosenId, trigger, restoreGraphFocus = false) {
    if (state.busy || !state.prediction) return false;
    const chosen = chosenId && state.prediction.distribution.find((item) => item.id === chosenId && item.probability > 0);
    if (chosenId && (!chosen || chosenId === state.history.at(-1))) return false;
    const nextId = chosen?.id || sampleDistribution(state.prediction.distribution, Math.random);
    const midis = voiceChord(nextId, state.lastVoicing);
    const lifecycle = state.lifecycle;
    state.entered = true;
    state.pendingArpeggio = false;
    state.selectedId = nextId;
    appendAudibleChord(nextId);
    state.lastVoicing = midis;
    startArpeggio(lifecycle);
    const refreshed = await refreshPrediction();
    if (lifecycle !== state.lifecycle) return false;
    state.selectedId = null;
    if (restoreGraphFocus && refreshed) container.querySelector('[data-next-chord]:not([aria-disabled="true"])')?.focus();
    return refreshed;
  }

  async function planPhrase(count = 8, lifecycle = state.lifecycle) {
    const plannedHistory = [...state.history];
    let previousMidis = [...state.lastVoicing];
    const plan = [];
    for (let step = 0; step < count; step += 1) {
      if (lifecycle !== state.lifecycle) return null;
      const prediction = step === 0 && state.prediction ? state.prediction : await predictNext(plannedHistory, {
        model: state.model, palette: state.palette, temperature: state.temperature
      });
      if (lifecycle !== state.lifecycle) return null;
      const nextId = sampleDistribution(prediction.distribution, Math.random);
      const midis = voiceChord(nextId, previousMidis);
      plan.push({ nextId, midis, prediction });
      previousMidis = midis;
      plannedHistory.push(nextId);
    }
    return plan;
  }

  async function playPhrase() {
    if (state.busy || !state.prediction) return false;
    state.entered = true;
    state.pendingArpeggio = false;
    const lifecycle = state.lifecycle;
    arpeggio.stop();
    state.busy = true;
    state.modelError = null;
    render();
    let completed = false;
    try {
      const plan = await planPhrase(8, lifecycle);
      if (!plan || lifecycle !== state.lifecycle) return false;
      completed = await guardedRun("harmony-phrase", () => audio.sequence(plan.map((step) => step.midis), container.querySelector('[data-action="play"]'), (index) => {
        if (index < 0 || !plan[index]) return;
        if (lifecycle !== state.lifecycle) return;
        const step = plan[index];
        state.prediction = step.prediction;
        state.selectedId = step.nextId;
        appendAudibleChord(step.nextId);
        state.lastVoicing = step.midis;
        render();
      }, 720, "Generated phrase"), () => onComplete?.());
      return completed;
    } catch (error) {
      if (lifecycle === state.lifecycle) state.modelError = error instanceof Error ? error : new Error(String(error));
      return false;
    } finally {
      if (lifecycle === state.lifecycle) {
        state.busy = false;
        state.selectedId = null;
        if (state.modelError) render(); else await refreshPrediction();
        if (completed && lifecycle === state.lifecycle && state.entered) startArpeggio(lifecycle);
      }
    }
  }

  async function playPaletteChord(id, button) {
    if (state.busy || !chordById.has(id)) return false;
    const lifecycle = state.lifecycle;
    state.entered = true;
    state.pendingArpeggio = false;
    arpeggio.stop();
    state.busy = true;
    render();
    const midis = voiceChord(id, state.lastVoicing);
    let committed = false;
    try {
      return await guardedRun(`harmony-chord-${id}`, () => audio.chord(midis, button, 900, chordLabel(id)), () => {
        state.history = [id];
        state.lastVoicing = midis;
        committed = true;
      });
    } finally {
      if (lifecycle === state.lifecycle) {
        state.busy = false;
        if (committed) {
          await refreshPrediction();
          if (lifecycle === state.lifecycle && state.entered) startArpeggio(lifecycle);
        } else render();
      }
    }
  }

  function acceptsInput() { return typeof claimInput !== "function" || claimInput(); }

  function handleClick(event) {
    const control = event.target.closest?.("button,[data-next-chord]");
    if (!control || !container.contains(control) || control.disabled || control.getAttribute("aria-disabled") === "true" || state.busy || !acceptsInput()) return;
    if (control.dataset.nextChord) { playNext(control.dataset.nextChord, control); return; }
    const model = control.dataset.model;
    if (model && model !== state.model) {
      state.model = model;
      state.selectedHead = 0;
      refreshPrediction();
      return;
    }
    if (control.dataset.head !== undefined) { state.selectedHead = Number(control.dataset.head) || 0; render(); return; }
    if (control.dataset.chord) { playPaletteChord(control.dataset.chord, control); return; }
    const action = control.dataset.action;
    if (action === "play") playPhrase();
    if (action === "next") playNext(undefined, control);
    if (action === "palette") {
      const index = Math.max(0, PALETTES.findIndex((palette) => palette.id === state.palette));
      const next = PALETTES[(index + 1) % PALETTES.length];
      state.palette = next.id;
      state.temperature = next.temperature;
      let changedCurrent = false;
      if (!next.chordIds.includes(state.history.at(-1))) {
        state.history = [next.chordIds[0]];
        state.lastVoicing = voiceChord(next.chordIds[0]);
        changedCurrent = true;
      }
      if (changedCurrent && state.entered) startArpeggio();
      refreshPrediction();
    }
    if (action === "parameters") { state.drawerOpen = true; render(); }
    if (action === "close") { state.drawerOpen = false; render(); }
    if (action === "retry") refreshPrediction();
  }

  function handleKeydown(event) {
    if (!['Enter', ' '].includes(event.key)) return;
    const node = event.target.closest?.("[data-next-chord]");
    if (!node || !container.contains(node) || node.getAttribute("aria-disabled") === "true" || state.busy) return;
    event.preventDefault();
    if (acceptsInput()) playNext(node.dataset.nextChord, node, true);
  }

  function handleTemperatureInput(event) {
    const input = event.target.closest?.("[data-temperature]");
    if (!input || !container.contains(input) || state.busy) return;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return;
    state.temperature = Math.max(0.25, Math.min(2, value));
    refreshPrediction({ preservePrediction: true });
  }

  function cancel() {
    state.lifecycle += 1;
    state.request += 1;
    state.entered = false;
    state.pendingArpeggio = false;
    arpeggio.stop({ silence: false });
    state.busy = false;
    state.selectedId = null;
    render();
  }

  function enter() {
    if (state.entered) return;
    state.entered = true;
    if (state.prediction) startArpeggio();
    else {
      state.pendingArpeggio = true;
      void refreshPrediction();
    }
  }

  render();
  refreshPrediction();
  return { render, advance: playPhrase, cancel, enter };
}
