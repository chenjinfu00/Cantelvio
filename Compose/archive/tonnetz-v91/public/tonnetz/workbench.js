import { createRandomArranger } from './arrangement-random.js';
import { SOLO_STYLES, SOLO_INSTRUMENTS, SOLO_PATTERNS } from './improvisation.js';
import { createPerformanceControls, DICE_ICON } from './performance-controls.js';
import {
  RHYTHMS,
  PATTERNS,
  STYLES,
  INSTRUMENTS,
  BASS_INSTRUMENTS,
  BASS_LINES,
  createAccompaniment
} from "./accompaniment.js";
import {
  CHORD_VOCAB,
  PALETTES,
  MODEL_METADATA,
  BASE_CHORDS,
  prepareModels,
  predictNext,
  sampleDistribution,
  voiceChord
} from "./lib/harmony-models.js";
import { ROOT_NAMES, QUALITIES, getChord, romanFor, transposeChord } from "./lib/chord-vocabulary.js";
import { KEYS, keyLabel, advanceTonality } from "./lib/tonality.js";
import { createLearnPanel } from "./learn.js";
import { createChordLookahead } from "./chord-lookahead.js";
import { createChordTimeline } from "./chord-timeline.js";
import {
  PROGRESSIONS,
  AUTHENTIC_CADENCE,
  CHORDS_BY_ID,
  WORKBENCH_COPY,
  copyFor
} from "./workbench-data.js";

const root = document.querySelector("#harmonyWorkbench");
const instrumentRoot = document.querySelector("#instrument");
const grabber = document.querySelector("#wbGrabber");
const backdrop = document.querySelector("#wbBackdrop");
const toggleButton = document.querySelector("#wbToggle");
const statusElement = document.querySelector("#wbStatus");
const settingsHandle = document.querySelector("#settingsHandle");
const settingsHandleLabel = document.querySelector("#settingsHandleLabel");
const accompanimentPanel = document.querySelector("#wbAccompaniment");
const harmonyPanel = document.querySelector("#wbHarmony");
const learnContainer = document.querySelector("#wbLearn");
const audio = window.TonnetzAudio;

const htmlEscape = (value) => String(value ?? "").replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const byId = (collection, id) => collection.find((item) => item.id === id);
const getLanguage = () => window.TonnetzI18n?.getLanguage?.() || "en";
const text = (key) => copyFor(getLanguage(), WORKBENCH_COPY[key]);
const itemName = (item) => {
  const language = getLanguage();
  if (typeof item?.name === "string") return item.name;
  return item?.name?.[language] ?? (language === "zh-CN" ? item?.name?.zh : item?.name?.en) ?? item?.label ?? item?.id ?? "";
};
const chordLabel = (id) => CHORDS_BY_ID.get(id)?.label || id;
const chordRoman = (id, key = state.key) => romanFor(id, key);
const sequenceChords = sequence => sequence.chords.map(id => transposeChord(id, state.key.tonic));
const percent = (probability) => probability > 0 && probability < 0.005 ? "<1%" : `${Math.round(probability * 100)}%`;
const formulaForModel = () => "P(c_{t+1},b_{t+1}\\mid c_{\\leq t},b_{\\leq t},k_t,s)";
const mathHTML = (formula) => {
  try { return window.katex?.renderToString(formula, { throwOnError: false }) || htmlEscape(formula); }
  catch { return htmlEscape(formula); }
};

const sequences = new Map([...PROGRESSIONS, AUTHENTIC_CADENCE].map((sequence) => [sequence.id, sequence]));
const state = {
  expanded: false,
  starting: false,
  tab: "accompaniment",
  playing: false,
  currentChord: "C",
  currentMidis: voiceChord("C"),
  barMode: "hold",
  autoMode: "generate",
  sequenceId: PROGRESSIONS[0].id,
  sequenceStep: 0,
  key: { tonic: 0, mode: "major" },
  keyWalk: false,
  keyEvery: 8,
  keyAge: 0,
  chordRoot: 0,
  chordInversion: 0,
  chordFamily: "all",
  distributionRoot: 0,
  palette: "pop",
  temperature: byId(PALETTES, "pop")?.temperature || 0.82,
  history: ["C"],
  prediction: null,
  selectedCandidate: null,
  modelReady: false,
  modelError: null,
  selectedHead: 0,
  selectedLayer: MODEL_METADATA.architecture.layers - 1,
  panels: {random:false,solo:false},
  random: {enabled:false,every:8,wild:false,tempo:false},
  solo: {enabled:false,style:"pop",instrument:"piano",rhythm:"auto",pattern:"motif",density:.55,register:"middle",volume:.45,temperature:.78,interaction:.35},
  editedFuture:false,
  melodyFeedback:null,
  accompaniment: {
    style: "pop",
    rhythm: null,
    pattern: null,
    bpm: 92,
    instrument: null,
    bassInstrument: null,
    bassLine: null,
    bassVolume: .8,
    feel: .65,
    variation: .65,
    resolvedRhythm: "syncopated",
    resolvedPattern: "bass-chord",
    resolvedInstrument: "piano",
    volume: 0.62,
    beatsPerBar: 4,
    beat: 0
  }
};
let previewGeneration = 0;
let startGeneration = 0;
let pullGesture = null;
let suppressToggleClick = false;
const randomArranger = createRandomArranger();
const editorElement = document.querySelector("#wbChordEditor");
let editor = null;
let temperatureTimer = null;
function predictWithMelody(history,options={}) {
  return predictNext(history,{...options,melodyFeedback:state.solo.enabled&&state.melodyFeedback?{...state.melodyFeedback,strength:state.solo.interaction}:null});
}
const lookahead = createChordLookahead({ predict: predictWithMelody, sample: sampleDistribution });
const timeline = createChordTimeline({
  container: document.querySelector("#wbTimeline"),
  getTransport: () => controller.getTransport(),
  getControls: () => ({ playing: state.playing, starting: state.starting,
    mode: state.barMode, bpm: state.accompaniment.bpm, style: state.accompaniment.style,
    styles: STYLES.map(style => ({ id: style.id, label: itemName(style) })) }),
  onToggle: () => state.playing || state.starting ? stopAccompaniment() : void startAccompaniment(),
  onAutoToggle: toggleAutomaticChords,
  onTempo: setAccompanimentTempo,
  onStyle: setAccompanimentStyle,
  onEdit: openChordEditor
});

const quickControls = createPerformanceControls({
  container:document.querySelector("#wbQuick"),
  getState:()=>({language:getLanguage(),keys:KEYS.map(k=>({id:`${k.tonic}:${k.mode}`,label:keyLabel(k,getLanguage())})),key:`${state.key.tonic}:${state.key.mode}`,keyWalk:state.keyWalk,temperature:state.temperature,random:state.random.enabled,solo:state.solo.enabled}),
  onKey:setMainKey,onWalk:toggleKeyWalk,onTemperature:setHarmonyTemperature,onRandom:toggleRandom,onSolo:toggleSolo
});

function renderTimeline() {
  timeline.render({
    entries: lookahead.view().map((entry) => ({ ...entry,
      label: chordLabel(entry.id), roman: chordRoman(entry.id, entry.key), keyLabel: keyLabel(entry.key, getLanguage()),
      notes: CHORDS_BY_ID.get(entry.id)?.noteNames.join(" ") || "", inversion: CHORDS_BY_ID.get(entry.id)?.inversion || 0
    })),
    language: getLanguage(), mode: text(state.barMode)
  });
}

function resetLookahead() {
  state.editedFuture = false;
  lookahead.reset({ mode: state.barMode, current: state.currentChord,
    history: state.history, sequence: sequenceChords(activeSequence()), step: state.sequenceStep,
    options: { palette: state.palette, temperature: state.temperature, key: state.key, keyAge: state.keyAge, keyWalk: state.keyWalk, keyEvery: state.keyEvery }
  });
  if (state.modelReady) updatePrediction();
  renderTimeline();
}

function setExpanded(expanded) {
  state.expanded = Boolean(expanded);
  if (state.expanded) closeChordEditor();
  if (!state.expanded) learnPanel?.cancel?.();
  if (state.expanded && instrumentRoot.classList.contains("settings-open")) {
    document.querySelector("#closeSettings")?.click();
  }
  root.classList.toggle("is-expanded", state.expanded);
  instrumentRoot.classList.toggle("wb-expanded", state.expanded);
  instrumentRoot.classList.toggle("wb-collapsed", !state.expanded);
  if (!state.expanded && root.contains(document.activeElement)) toggleButton.focus({ preventScroll: true });
  root.inert = !state.expanded;
  root.setAttribute("aria-hidden", String(!state.expanded));
  toggleButton.setAttribute("aria-expanded", String(state.expanded));
  toggleButton.setAttribute("aria-label", state.expanded ? text("collapse") : text("expand"));
  toggleButton.querySelector(".wb-chevron").textContent = state.expanded ? "⌄" : "⌃";
}

function setStatus(message = "", kind = "") {
  statusElement.textContent = message;
  statusElement.hidden = !message;
  statusElement.dataset.kind = kind;
}

function renderStaticText() {
  root.setAttribute("aria-label", text("workbench"));
  grabber.setAttribute("aria-label", text("collapse"));
  toggleButton.querySelector(".wb-title").textContent = text("accompaniment");
  if (settingsHandleLabel) settingsHandleLabel.textContent = getLanguage() === "zh-CN" ? "乐器设置" : "Settings";
  const tabLabels = { accompaniment: "accompaniment", harmony: "harmony", learn: "learn" };
  root.querySelectorAll("[data-wb-tab]").forEach((tab) => { tab.textContent = text(tabLabels[tab.dataset.wbTab]); });
  setExpanded(state.expanded);
}

function renderCurrentChord() {
  root.classList.toggle("is-playing", state.playing);
  root.classList.toggle("is-starting", state.starting);
  timeline.syncControls();
  quickControls.render();
}

function renderSelectItems(items, selected, includeDefault = false, defaultId = null) {
  const defaultName = defaultId ? itemName(byId(items, defaultId)) : null;
  const defaultOption = includeDefault ? `<option value="">${defaultName ? htmlEscape(defaultName) + (getLanguage() === "zh-CN" ? " · 自动" : " · Auto") : (getLanguage() === "zh-CN" ? "跟随风格" : "Style default")}</option>` : "";
  return `${defaultOption}${items.map((item) => `<option value="${htmlEscape(item.id)}" ${item.id === selected ? "selected" : ""}>${htmlEscape(itemName(item))}</option>`).join("")}`;
}

function renderBeatIndicator() {
  const beatIndicator = accompanimentPanel.querySelector("[data-beats]");
  if (!beatIndicator) return;
  const count = state.accompaniment.beatsPerBar || 4;
  beatIndicator.innerHTML = Array.from({ length: count }, (_, index) => `<i class="${index === state.accompaniment.beat ? "is-active" : ""}"></i>`).join("");
  const badge = accompanimentPanel.querySelector("[data-meter]");
  if (badge) badge.textContent = count === 3 ? text("beatsThree") : text("beatsFour");
}

function renderAccompaniment() {
  const scrollHost=accompanimentPanel.closest(".wb-panel-scroll"),scrollTop=scrollHost?.scrollTop||0;
  const styleDefaults = byId(STYLES, state.accompaniment.style);
  accompanimentPanel.innerHTML = `${performanceExtrasHTML()}<div class="wb-style-row">
      <div class="wb-style-grid" role="group" aria-label="${htmlEscape(text("style"))}">
        ${STYLES.map((style) => `<button type="button" data-style="${style.id}" class="${style.id === state.accompaniment.style ? "is-active" : ""}" aria-pressed="${style.id === state.accompaniment.style}"><b>${htmlEscape(itemName(style))}</b></button>`).join("")}
      </div>
      <div class="wb-meter"><span data-meter>${state.accompaniment.beatsPerBar === 3 ? text("beatsThree") : text("beatsFour")}</span><div data-beats></div></div>
    </div>
    <div class="wb-control-grid wb-performance-controls">
      <label><span>${htmlEscape(text("rhythm"))}</span><select data-accompaniment="rhythm">${renderSelectItems(RHYTHMS, state.accompaniment.rhythm, true, styleDefaults.rhythm)}</select></label>
      <label><span>${htmlEscape(text("pattern"))}</span><select data-accompaniment="pattern">${renderSelectItems(PATTERNS, state.accompaniment.pattern, true, styleDefaults.pattern)}</select></label>
      <label><span>${getLanguage()==="zh-CN" ? "和弦乐器" : "Chord instrument"}</span><select data-accompaniment="instrument">${renderSelectItems(INSTRUMENTS, state.accompaniment.instrument, true, styleDefaults.instrument)}</select></label>
      <label><span>${getLanguage()==="zh-CN" ? "低音乐器" : "Bass instrument"}</span><select data-accompaniment="bassInstrument">${renderSelectItems(BASS_INSTRUMENTS, state.accompaniment.bassInstrument, true, styleDefaults.bassInstrument)}</select></label>
      <label><span>${getLanguage()==="zh-CN" ? "低音走向" : "Bass line"}</span><select data-accompaniment="bassLine">${renderSelectItems(BASS_LINES, state.accompaniment.bassLine, true, styleDefaults.bassLine)}</select></label>
      <label class="wb-range"><span>${getLanguage()==="zh-CN" ? "低音比例" : "Bass balance"}</span><input data-accompaniment="bassVolume" type="range" min="0" max="1" step="0.01" value="${state.accompaniment.bassVolume}"><output data-bassVolume>${Math.round(state.accompaniment.bassVolume*100)}%</output></label>
    </div>
    <div class="wb-range-grid"><label class="wb-range"><span>${htmlEscape(text("tempo"))}</span><input data-accompaniment="bpm" type="range" min="40" max="200" step="1" value="${state.accompaniment.bpm}"><output><b data-bpm>${state.accompaniment.bpm}</b> ${htmlEscape(text("bpm"))}</output></label>
    <label class="wb-range"><span>${htmlEscape(text("accompanimentVolume"))}</span><input data-accompaniment="volume" type="range" min="0" max="1" step="0.01" value="${state.accompaniment.volume}"><output data-volume>${Math.round(state.accompaniment.volume * 100)}%</output></label>
    <label class="wb-range"><span>${getLanguage()==="zh-CN" ? "演奏感" : "Human feel"}</span><input data-accompaniment="feel" type="range" min="0" max="1" step="0.01" value="${state.accompaniment.feel}"><output data-feel>${Math.round(state.accompaniment.feel*100)}%</output></label>
    <label class="wb-range"><span>${getLanguage()==="zh-CN" ? "乐句变化" : "Phrase variation"}</span><input data-accompaniment="variation" type="range" min="0" max="1" step="0.01" value="${state.accompaniment.variation}"><output data-variation>${Math.round(state.accompaniment.variation*100)}%</output></label></div>
    <details class="wb-audio-credit"><summary>${getLanguage()==="zh-CN" ? "音源" : "Sound credits"}</summary><p>${getLanguage()==="zh-CN" ? "本地钢琴、电吉他与电贝斯采样；采样未就绪时使用内置音色。" : "Bundled piano, electric guitar and electric bass samples, with built-in voices while samples load."}</p><small><a href="https://github.com/Tonejs/audio/tree/efd8296360f9526e379bfbe5c1698ff54d6a1d34/salamander" target="_blank" rel="noreferrer">Salamander piano · Alexander Holm</a><br><a href="https://github.com/nbrosowsky/tonejs-instruments" target="_blank" rel="noreferrer">Guitar & bass · Karoryfer / N. P. Brosowsky</a> · <a href="https://creativecommons.org/licenses/by/3.0/" target="_blank" rel="noreferrer">CC BY 3.0</a><br><a href="https://github.com/OpenScore/Lieder" target="_blank" rel="noreferrer">${getLanguage()==="zh-CN" ? "旋律训练乐谱" : "Melody training scores"} · OpenScore Lieder · CC0</a></small></details>`;
  renderBeatIndicator();
  if(scrollHost)scrollHost.scrollTop=scrollTop;
}

function sequenceCardHTML(sequence, cadence = false) {
  const active = sequence.id === state.sequenceId;
  return `<article class="wb-sequence ${active ? "is-active" : ""}" data-sequence-card="${htmlEscape(sequence.id)}">
    <button type="button" class="wb-sequence-head" data-sequence="${htmlEscape(sequence.id)}">
      <span><small>${cadence ? htmlEscape(text("cadence")) : htmlEscape(sequence.romans.join(" · "))}</small><b>${htmlEscape(copyFor(getLanguage(), sequence.name))}</b></span><i aria-hidden="true">${active ? "●" : "○"}</i>
    </button>
    <div class="wb-sequence-chords">${sequenceChords(sequence).map((id, index) => `<button type="button" data-sequence-step="${htmlEscape(sequence.id)}:${index}" class="${active && index === state.sequenceStep ? "is-current" : ""}"><b>${htmlEscape(chordLabel(id))}</b><small>${htmlEscape(sequence.romans[index])}</small></button>`).join("")}</div>
  </article>`;
}

function paletteLabel(palette) {
  if (getLanguage() !== "zh-CN") return palette.label;
  return { pop: "流行", classical: "古典", jazz: "爵士", chromatic: "半音色彩" }[palette.id] || palette.label;
}

function candidateHTML() {
  if (state.modelError) return `<p class="wb-model-error" role="alert">${htmlEscape(state.modelError.message || state.modelError)}</p>`;
  if (!state.prediction) return `<p class="wb-model-loading">${htmlEscape(text("preparing"))}</p>`;
  const visible = state.prediction.distribution.filter((item) => item.probability > 0).slice(0, 6);
  if (!visible.length) return `<p class="wb-model-loading">${htmlEscape(text("empty"))}</p>`;
  const visibleIds = new Set(visible.map(({ id }) => id));
  const other = state.prediction.distribution.reduce((sum, item) => sum + (visibleIds.has(item.id) ? 0 : item.probability), 0);
  const otherRow = other > 0.0005 ? `<div class="wb-candidate-other"><span>${getLanguage() === "zh-CN" ? "其他" : "Other"}</span><i style="--probability:${clamp(other, 0, 1)}"></i><strong>${percent(other)}</strong></div>` : "";
  return `<div class="wb-candidates">${visible.map((item) => `<button type="button" data-candidate="${htmlEscape(item.id)}" class="${state.selectedCandidate === item.id ? "is-selected" : ""}"><span><b>${htmlEscape(chordLabel(item.id))}</b><small>${htmlEscape(chordRoman(item.id, state.prediction.key))}</small></span><i style="--probability:${clamp(item.probability, 0, 1)}"></i><strong>${percent(item.probability)}</strong></button>`).join("")}${otherRow}</div>`;
}

function parametersHTML() {
  const parameters = state.prediction?.parameters || {};
  const entries = Object.entries(parameters).filter(([key]) => key !== "provenance");
  return `<section class="wb-parameters"><h4>${htmlEscape(text("parameters"))}</h4><dl>
    ${entries.map(([key, value]) => `<div><dt>${htmlEscape(key.replace(/([a-z])([A-Z])/g, "$1 $2"))}</dt><dd>${htmlEscape(typeof value === "object" ? JSON.stringify(value) : value)}</dd></div>`).join("")}
  </dl><p>${htmlEscape(parameters.provenance || text("authoredModel"))}</p>
  <div class="wb-formula">${mathHTML(formulaForModel())}</div><label class="wb-distribution-root">${getLanguage() === "zh-CN" ? "概率 · 根音" : "Probabilities · root"}<select data-harmony="distributionRoot">${ROOT_NAMES.map((name, i) => `<option value="${i}" ${i === state.distributionRoot ? "selected" : ""}>${name}</option>`).join("")}</select></label><div class="wb-full-distribution">${(state.prediction?.distribution || []).filter(item => CHORDS_BY_ID.get(item.id)?.root === state.distributionRoot).map((item) => `<span><b>${htmlEscape(chordLabel(item.id))}</b><i>${percent(item.probability)}</i></span>`).join("")}</div></section>`;
}

function attentionHTML() {
  const layers = state.prediction?.attentionLayers || [];
  if (!layers.length) return "";
  const layerIndex = clamp(state.selectedLayer, 0, layers.length - 1);
  const heads = layers[layerIndex];
  const headIndex = clamp(state.selectedHead, 0, heads.length - 1);
  const matrix = heads[headIndex], tokens = state.prediction.tokens || [], zh = getLanguage() === "zh-CN";
  return `<section class="wb-attention"><div class="wb-attention-head"><h4>${htmlEscape(text("attention"))}</h4><div class="wb-attention-selects">
    <label>${zh ? "层" : "Layer"}<select data-harmony="layer">${layers.map((_, i) => `<option value="${i}" ${i === layerIndex ? "selected" : ""}>${i + 1}</option>`).join("")}</select></label>
    <label>${zh ? "头" : "Head"}<select data-harmony="head">${heads.map((_, i) => `<option value="${i}" ${i === headIndex ? "selected" : ""}>${i + 1}</option>`).join("")}</select></label></div></div>
    <div class="wb-matrix"><table><thead><tr><th>q \\ k</th>${tokens.map(token => `<th>${htmlEscape(chordLabel(token))}</th>`).join("")}</tr></thead><tbody>${tokens.map((token, row) => `<tr><th>${htmlEscape(chordLabel(token))}</th>${tokens.map((_, column) => {
      const allowed = column <= row, value = allowed ? Number(matrix[row]?.[column] || 0) : 0;
      return `<td class="${allowed ? "" : "is-masked"}" style="--attention:${clamp(value, 0, 1)}">${allowed ? value.toFixed(2) : "—"}</td>`;
    }).join("")}</tr>`).join("")}</tbody></table></div></section>`;
}

function keyControlHTML() {
 const zh=getLanguage()==="zh-CN";
 return state.keyWalk?`<label class="wb-key-clock">${zh?"主调游走间隔":"Key-walk interval"}<select data-harmony="keyEvery">${[4,8,16,32].map(n=>`<option value="${n}" ${n===state.keyEvery?"selected":""}>${n} ${zh?"个和弦":"chords"}</option>`).join("")}</select></label>`:"";
}

function chordLibraryHTML() {
  const zh = getLanguage() === "zh-CN";
  const groups = [["all", "All types", "全部类型"], ["triad", "Triads / suspended", "三和弦／挂留"], ["sixth", "Sixths", "六和弦"], ["seventh", "Sevenths", "七和弦"], ["extension", "Extensions", "扩展和弦"], ["altered", "Altered", "变化和弦"]];
  const chords = CHORD_VOCAB.filter(c => c.root === state.chordRoot && c.inversion === state.chordInversion && (state.chordFamily === "all" || c.family === state.chordFamily));
  return `<details class="wb-chord-drawer wb-library"><summary>${htmlEscape(text("chordVocabulary"))}<span>${CHORD_VOCAB.length}</span></summary>
    <div class="wb-library-controls"><label>${zh ? "根音" : "Root"}<select data-harmony="chordRoot">${ROOT_NAMES.map((n,i) => `<option value="${i}" ${i === state.chordRoot ? "selected" : ""}>${n}</option>`).join("")}</select></label>
    <label>${zh ? "类型" : "Type"}<select data-harmony="chordFamily">${groups.map(([id,en,cn]) => `<option value="${id}" ${id === state.chordFamily ? "selected" : ""}>${zh ? cn : en}</option>`).join("")}</select></label>
    <label>${zh ? "转位" : "Inversion"}<select data-harmony="chordInversion">${[0,1,2,3,4,5,6].map(i => `<option value="${i}" ${i === state.chordInversion ? "selected" : ""}>${i ? (zh ? `第 ${i} 转位` : ["","1st","2nd","3rd","4th","5th","6th"][i]) : (zh ? "原位" : "Root position")}</option>`).join("")}</select></label></div>
    <div class="wb-chord-grid">${chords.map(chord => `<button type="button" data-chord="${htmlEscape(chord.id)}" class="${chord.id === state.currentChord ? "is-current" : ""}"><b>${htmlEscape(chord.label)}</b><small>${htmlEscape(chordRoman(chord.id))}</small></button>`).join("")}</div>
    ${chords.length ? "" : `<p class="wb-provenance">${zh ? "此类型没有该转位，请选择较低转位或其他类型。" : "This chord type has no such inversion. Choose a lower inversion or another type."}</p>`}</details>`;
}

function renderHarmony() {
  const scrollHost = harmonyPanel.closest(".wb-panel-scroll");
  const scrollTop = scrollHost?.scrollTop || 0;
  const openDetails = new Set([...harmonyPanel.querySelectorAll("details[open]")].map((detail) => detail.className));
  const focused = document.activeElement && harmonyPanel.contains(document.activeElement)
    ? Object.entries(document.activeElement.dataset).find(([, value]) => value !== undefined)
    : null;
  harmonyPanel.innerHTML = `<div class="wb-mode-row" role="group" aria-label="${htmlEscape(text("barBehaviour"))}"><button type="button" data-action="auto" class="${state.barMode !== "hold" ? "is-active" : ""}" aria-label="${getLanguage() === "zh-CN" ? "自动换和弦" : "Automatic chord changes"}" aria-pressed="${state.barMode !== "hold"}">${state.barMode !== "hold" ? (getLanguage() === "zh-CN" ? "自动" : "Auto") : (getLanguage() === "zh-CN" ? "保持" : "Hold")}</button>${[
      ["progression", "progression"], ["generate", "generate"]
    ].map(([id, key]) => `<button type="button" data-bar-mode="${id}" class="${state.barMode === id ? "is-active" : ""}" aria-pressed="${state.barMode === id}">${htmlEscape(text(key))}</button>`).join("")}</div>
    ${keyControlHTML()}
    <section class="wb-block wb-generator">
      <div class="wb-control-grid wb-generator-controls"><label><span>${htmlEscape(text("palette"))}</span><select data-harmony="palette">${PALETTES.map((palette) => `<option value="${palette.id}" ${palette.id === state.palette ? "selected" : ""}>${htmlEscape(paletteLabel(palette))}</option>`).join("")}</select></label>
      <label class="wb-temperature"><span>${htmlEscape(text("temperature"))}</span><input data-harmony="temperature" type="range" min="0.25" max="2" step="0.01" value="${state.temperature}"><output data-temperature>${state.temperature.toFixed(2)}</output></label></div>
      <div class="wb-probability-head"><strong>${htmlEscape(text("nextChord"))}${state.prediction && (state.prediction.key.tonic !== state.key.tonic || state.prediction.key.mode !== state.key.mode) ? `<small class="wb-next-key">→ ${htmlEscape(keyLabel(state.prediction.key, getLanguage()))}</small>` : ""}</strong><button type="button" data-action="next">${htmlEscape(text("next"))}</button></div>${candidateHTML()}
      <div class="wb-history"><small>${htmlEscape(text("history"))}</small><div>${state.history.slice(-8).map((id, index, items) => `<span class="${index === items.length - 1 ? "is-current" : ""}"><b>${htmlEscape(chordLabel(id))}</b><i>${htmlEscape(chordRoman(id))}</i></span>`).join("")}</div></div>
      <details class="wb-evidence"><summary>${htmlEscape(text("evidence"))}</summary>${parametersHTML()}${attentionHTML()}</details>
    </section>
    <details class="wb-progression-drawer wb-chord-drawer" ${state.barMode === "progression" ? "open" : ""}><summary>${htmlEscape(text("progressions"))}<span>8 + ${htmlEscape(text("cadence"))}</span></summary><div class="wb-sequences">${PROGRESSIONS.map((sequence) => sequenceCardHTML(sequence)).join("")}</div>${sequenceCardHTML(AUTHENTIC_CADENCE, true)}</details>
    ${chordLibraryHTML()}`;
  harmonyPanel.querySelectorAll("details").forEach((detail) => {
    detail.open = openDetails.has(detail.className)
      || (detail.classList.contains("wb-progression-drawer") && state.barMode === "progression");
  });
  if (scrollHost) scrollHost.scrollTop = scrollTop;
  if (focused) {
    const [key, value] = focused;
    const match = [...harmonyPanel.querySelectorAll(`[data-${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}]`)]
      .find((element) => element.dataset[key] === value);
    match?.focus({ preventScroll: true });
  }
}

function activeSequence() {
  return sequences.get(state.sequenceId) || PROGRESSIONS[0];
}

function setBarMode(mode) {
  state.barMode = mode;
  if (mode !== "hold") state.autoMode = mode;
}

function toggleAutomaticChords() {
  setBarMode(state.barMode === "hold" ? state.autoMode : "hold");
  // Update only the future. The current sounding bar keeps its clock and notes.
  if(!state.editedFuture)resetLookahead();
  else {renderTimeline();renderCurrentChord();}
  if (state.expanded && state.tab === "harmony") renderHarmony();
}

function sequenceVoicing(sequence, index, chordId) {
  if (sequence.id === AUTHENTIC_CADENCE.id) return AUTHENTIC_CADENCE.voicings[index].map(n => n + (state.key.tonic > 6 ? state.key.tonic - 12 : state.key.tonic));
  return voiceChord(chordId, state.currentMidis);
}

function updatePrediction() {
  try {
    state.prediction = predictWithMelody(state.history, {
      palette: state.palette,
      temperature: state.temperature,
      key: state.barMode === "generate" ? (lookahead.view()[1]?.key || state.key) : state.key
    });
    state.modelError = null;
  } catch (error) {
    state.prediction = null;
    state.modelError = error;
  }
}

async function previewChord(midis) {
  if (!audio) return;
  if (state.playing) return;
  const request = ++previewGeneration;
  const ready = await audio.ensureReady();
  if (!ready || request !== previewGeneration || state.playing) return;
  audio.stopGroup("workbench-preview");
  midis.forEach((midi, index) => audio.playNote(midi, {
    instrument: state.accompaniment.resolvedInstrument || "piano",
    velocity: 0.58 + Math.min(index, 3) * 0.025,
    duration: 1.25,
    group: "workbench-preview"
  }));
}

function applyChord(id, { midis, preview = false, pushHistory = true, render = true, syncController = true, preserveFuture = false } = {}) {
  const chord = CHORDS_BY_ID.get(id);
  if (!chord) return false;
  state.currentMidis = midis ? [...midis] : voiceChord(id, state.currentMidis);
  state.currentChord = id;
  if (pushHistory && state.history.at(-1) !== id) state.history.push(id);
  if (state.history.length > 32) state.history.splice(0, state.history.length - 32);
  state.selectedCandidate = null;
  if (preserveFuture) renderTimeline();
  else resetLookahead();
  updatePrediction();
  if (syncController) controller.setChord(state.currentMidis);
  audio?.highlightChord?.(chord.pcs);
  renderCurrentChord();
  if (render && state.expanded && state.tab === "harmony") renderHarmony();
  if (preview) void previewChord(state.currentMidis);
  return true;
}

function selectSequence(sequenceId, step = 0, preview = true) {
  const sequence = sequences.get(sequenceId);
  if (!sequence) return;
  state.sequenceId = sequenceId;
  state.sequenceStep = clamp(step, 0, sequence.chords.length - 1);
  setBarMode("progression");
  const id = sequenceChords(sequence)[state.sequenceStep];
  applyChord(id, { midis: sequenceVoicing(sequence, state.sequenceStep, id), preview });
}

function generateNext(explicitId, { preview = true, render = true } = {}) {
  if (!explicitId && state.barMode === "generate") {
    const entry = lookahead.advance();
    state.key = entry.key; state.keyAge = entry.keyAge;
    return applyChord(entry.id, { preview, render, preserveFuture: true });
  }
  if (explicitId && state.barMode === "generate") {
    const advertised = lookahead.view()[1];
    state.key = advertised.key; state.keyAge = advertised.keyAge;
  } else if (!explicitId) {
    const tonal = advanceTonality({key:state.key,keyAge:state.keyAge,keyWalk:state.keyWalk,keyEvery:state.keyEvery}, state.currentChord);
    state.key = tonal.key; state.keyAge = tonal.keyAge;
  }
  updatePrediction();
  const id = explicitId || sampleDistribution(state.prediction.distribution);
  state.selectedCandidate = id;
  return applyChord(id, { preview, render });
}

function chordForNextBar() {
  if(state.barMode==="hold")return [...state.currentMidis];
  const entry = lookahead.advance();
  state.key = entry.key; state.keyAge = entry.keyAge;
  if (state.barMode === "progression") {
    const sequence = activeSequence();
    state.sequenceStep = entry.step;
    applyChord(entry.id, { midis: sequenceVoicing(sequence, state.sequenceStep, entry.id), preview: false, render: false, syncController: false, preserveFuture: true });
  } else if (state.barMode === "generate") {
    applyChord(entry.id, { preview: false, render: false, syncController: false, preserveFuture: true });
  } else {
    renderTimeline();
  }
  if (state.expanded && state.tab === "harmony") renderHarmony();
  return [...state.currentMidis];
}

function setAccompanimentTempo(value) {
  state.accompaniment.bpm = clamp(Number(value) || 92, 40, 200);
  randomArranger.configure({bpm:state.accompaniment.bpm});
  controller.update({ bpm: state.accompaniment.bpm });
  const range = accompanimentPanel.querySelector('[data-accompaniment="bpm"]');
  if (range) range.value = state.accompaniment.bpm;
  const output = accompanimentPanel.querySelector('[data-bpm]');
  if (output) output.textContent = state.accompaniment.bpm;
}

function setAccompanimentStyle(style) {
  if (!byId(STYLES, style)) return;
  state.accompaniment.style = style;
  randomArranger.configure({style});
  const defaults = { rhythm: null, pattern: null, instrument: null, bassInstrument: null, bassLine: null };
  Object.assign(state.accompaniment, defaults);
  controller.update({ style, ...defaults });
  state.accompaniment.beatsPerBar = controller.getState().beatsPerBar;
  renderAccompaniment();
}

const controller = createAccompaniment({
  audio,
  onBar: chordForNextBar,
  getNextChord: () => state.barMode === "hold" ? [...state.currentMidis] : voiceChord(lookahead.view()[1]?.id || state.currentChord, state.currentMidis),
  getChordRoot: () => CHORDS_BY_ID.get(state.currentChord)?.root,
  getKey: () => state.key,
  getSoloOptions: () => state.solo,
  getChordId: () => state.currentChord,
  onMelodyPhrase: feedback => { state.melodyFeedback=feedback; },
  beforeBar: () => applyRandomSettings(randomArranger.tick()),
  onBarStart: () => timeline.refresh(),
  onBeat: ({ beat = 0, beatsPerBar = 4 } = {}) => {
    state.accompaniment.beat = beat;
    state.accompaniment.beatsPerBar = beatsPerBar;
    renderBeatIndicator();
  },
  onState: (nextState = {}) => {
    state.playing = Boolean(nextState.playing);
    if (state.playing) {
      state.starting = false;
      setStatus();
    }
    for (const key of ["style", "bpm", "volume", "beatsPerBar", "bassVolume", "feel", "variation"]) {
      if (nextState[key] !== undefined) state.accompaniment[key] = nextState[key];
    }
    if (nextState.rhythm !== undefined) state.accompaniment.resolvedRhythm = nextState.rhythm;
    if (nextState.pattern !== undefined) state.accompaniment.resolvedPattern = nextState.pattern;
    if (nextState.instrument !== undefined) state.accompaniment.resolvedInstrument = nextState.instrument;
    renderCurrentChord();
    renderBeatIndicator();
    timeline.refresh();
  }
});

async function startAccompaniment() {
  if (state.playing || state.starting) return;
  previewGeneration += 1;
  audio?.stopGroup?.("workbench-preview");
  const request = ++startGeneration;
  state.starting = true;
  setStatus(text("preparing"));
  renderCurrentChord();
  const started = await controller.start(state.currentMidis);
  if (request !== startGeneration) return;
  state.starting = false;
  if (!started) {
    root.classList.add("has-error");
    setStatus(text("soundUnavailable"), "error");
  } else {
    root.classList.remove("has-error");
    setStatus();
  }
  renderCurrentChord();
}

function stopAccompaniment() {
  startGeneration += 1;
  state.starting = false;
  previewGeneration += 1;
  audio?.stopGroup?.("workbench-preview");
  controller.stop();
  state.playing = false;
  state.accompaniment.beat = 0;
  setStatus();
  renderCurrentChord();
  renderBeatIndicator();
}

function showTab(tab) {
  if (!["accompaniment", "harmony", "learn"].includes(tab)) return;
  if (state.tab === "learn" && tab !== "learn") learnPanel.cancel?.();
  state.tab = tab;
  root.classList.toggle("is-learning", tab === "learn");
  instrumentRoot.classList.toggle("wb-learning", tab === "learn");
  root.querySelectorAll("[data-wb-tab]").forEach((button) => {
    const active = button.dataset.wbTab === tab;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-selected", String(active));
    button.tabIndex = active ? 0 : -1;
  });
  root.querySelectorAll("[data-wb-panel]").forEach((panel) => {
    const active = panel.dataset.wbPanel === tab;
    panel.classList.toggle("is-active", active);
    panel.hidden = !active;
  });
  if (tab === "harmony") renderHarmony();
  if (tab === "learn") learnPanel.render();
  root.querySelector(".wb-panel-scroll").scrollTop = 0;
}

toggleButton.addEventListener("click", () => {
  if (suppressToggleClick) {
    suppressToggleClick = false;
    return;
  }
  setExpanded(!state.expanded);
});
settingsHandle?.addEventListener("click", (event) => {
  if (instrumentRoot.classList.contains("settings-open")) {
    event.stopImmediatePropagation();
    document.querySelector("#closeSettings")?.click();
    return;
  }
  if (state.expanded) setExpanded(false);
}, { capture: true });

grabber.addEventListener("click", () => {
  if (suppressToggleClick) { suppressToggleClick = false; return; }
  setExpanded(false);
});
backdrop.addEventListener("click", () => setExpanded(false));
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.expanded) setExpanded(false);
});
for (const handle of [toggleButton, grabber]) {
  handle.addEventListener("pointerdown", (event) => {
    // The keyboard also listens for bottom-edge swipes to open Settings.
    event.stopPropagation();
    suppressToggleClick = false;
    pullGesture = { pointerId: event.pointerId, startY: event.clientY, moved: false };
    handle.setPointerCapture?.(event.pointerId);
  });
  handle.addEventListener("pointermove", (event) => {
    if (!pullGesture || pullGesture.pointerId !== event.pointerId) return;
    const delta = event.clientY - pullGesture.startY;
    if (Math.abs(delta) > 8) pullGesture.moved = true;
    if ((!state.expanded && delta < -46) || (state.expanded && delta > 46)) {
      suppressToggleClick = true;
      setExpanded(!state.expanded);
      pullGesture = null;
    }
  });
  handle.addEventListener("pointerup", (event) => {
    event.stopPropagation();
    if (pullGesture?.moved) event.preventDefault();
    pullGesture = null;
  });
  handle.addEventListener("pointercancel", () => { pullGesture = null; suppressToggleClick = false; });
}

root.querySelector(".wb-tabs").addEventListener("click", (event) => {
  const button = event.target.closest("[data-wb-tab]");
  if (button) showTab(button.dataset.wbTab);
});

accompanimentPanel.addEventListener("click", (event) => {
  if(event.target.closest('[data-performance="shuffle"]')){applyRandomSettings(randomArranger.shuffle());return;}
  const styleButton = event.target.closest("[data-style]");
  if (!styleButton) return;
  setAccompanimentStyle(styleButton.dataset.style);
});

accompanimentPanel.addEventListener("input", (event) => {
  if(handlePerformanceInput(event))return;
  const key = event.target.dataset.accompaniment;
  if (key === "bpm") {
    setAccompanimentTempo(event.target.value);
  } else if (["volume", "bassVolume", "feel", "variation"].includes(key)) {
    state.accompaniment[key] = Number(event.target.value);
    accompanimentPanel.querySelector(`[data-${key}]`).textContent = `${Math.round(state.accompaniment[key] * 100)}%`;
    controller.update({ [key]: state.accompaniment[key] });
  }
});

accompanimentPanel.addEventListener("change", (event) => {
  if(handlePerformanceChange(event))return;
  const key = event.target.dataset.accompaniment;
  if (!["rhythm", "pattern", "instrument", "bassInstrument", "bassLine"].includes(key)) return;
  const value = event.target.value || null;
  state.accompaniment[key] = value;
  controller.update({ [key]: value });
  const controllerState = controller.getState();
  state.accompaniment.beatsPerBar = controllerState.beatsPerBar;
  renderBeatIndicator();
});

harmonyPanel.addEventListener("click", (event) => {
  if (event.target.closest('[data-action="auto"]')) {
    toggleAutomaticChords();
    return;
  }
  const modeButton = event.target.closest("[data-bar-mode]");
  if (modeButton) {
    const mode = modeButton.dataset.barMode;
    if (mode === "progression") selectSequence(state.sequenceId, state.sequenceStep, false);
    else {
      setBarMode(mode);
      resetLookahead();
      renderHarmony();
    }
    return;
  }
  const sequenceButton = event.target.closest("[data-sequence]");
  if (sequenceButton) {
    selectSequence(sequenceButton.dataset.sequence);
    return;
  }
  const stepButton = event.target.closest("[data-sequence-step]");
  if (stepButton) {
    const [id, rawStep] = stepButton.dataset.sequenceStep.split(":");
    selectSequence(id, Number(rawStep));
    return;
  }
  const chordButton = event.target.closest("[data-chord]");
  if (chordButton) {
    setBarMode("hold");
    applyChord(chordButton.dataset.chord, { preview: true });
    return;
  }
  if (event.target.closest('[data-action="key-walk"]')) {
    toggleKeyWalk(); return;
  }
  const candidateButton = event.target.closest("[data-candidate]");
  if (candidateButton) {
    generateNext(candidateButton.dataset.candidate);
    return;
  }
  if (event.target.closest("[data-action='next']")) {
    generateNext();
  }
});

harmonyPanel.addEventListener("input", (event) => {
  if(event.target.dataset.harmony==="temperature")setHarmonyTemperature(Number(event.target.value));
});

harmonyPanel.addEventListener("change", (event) => {
  const field = event.target.dataset.harmony;
  if (field === "temperature") { renderHarmony(); return; }
  if (field === "layer" || field === "head") {
    state[field === "layer" ? "selectedLayer" : "selectedHead"] = Number(event.target.value);
    renderHarmony(); return;
  }
  if (["chordRoot", "chordInversion", "chordFamily", "distributionRoot"].includes(field)) {
    state[field] = field === "chordFamily" ? event.target.value : Number(event.target.value);
    renderHarmony(); return;
  }
  if (field === "key") {setMainKey(event.target.value);return;}
  if (field === "keyEvery") { state.keyEvery = Number(event.target.value); state.keyAge = 0; }
  else if (field === "palette") {
    state.palette = event.target.value;
    state.temperature = byId(PALETTES, state.palette)?.temperature || state.temperature;
  } else return;
  resetLookahead(); updatePrediction(); renderHarmony();
});

function performanceExtrasHTML() {
 const zh=getLanguage()==='zh-CN';
 return `
 <details class="wb-performance-detail" data-fold="random" ${state.panels.random?'open':''}><summary>${DICE_ICON} ${zh?'随机编配':'Random arrangement'} <span class="wb-state-badge">${state.random.enabled?(zh?'开启':'On'):(zh?'关闭':'Off')}</span></summary><label class="wb-range"><span>${zh?'平均切换间隔':'Average switch interval'}</span><input type="range" min="1" max="32" step="1" data-random="every" value="${state.random.every}"><output data-random-interval>${state.random.every} ${zh?'小节':state.random.every===1?'bar':'bars'}</output></label><div class="wb-checks"><label><input type="checkbox" data-random="wild" ${state.random.wild?'checked':''}>${zh?'自由混搭':'Wild combinations'}</label><label><input type="checkbox" data-random="tempo" ${state.random.tempo?'checked':''}>${zh?'也改变速度':'Vary tempo too'}</label></div><button type="button" class="wb-new-mix" data-performance="shuffle">${zh?'换一套':'New mix'}</button><p class="wb-short-hint">${zh?'在小节线切换；关闭后保留当前编配。':'Switches at bar lines. Turning off keeps the current mix.'}</p></details>
 <details class="wb-performance-detail" data-fold="solo" ${state.panels.solo?'open':''}><summary>♪ ${zh?'即兴旋律设置':'Melody settings'} <span class="wb-state-badge">${state.solo.enabled?(zh?'开启':'On'):(zh?'关闭':'Off')}</span></summary><div class="wb-control-grid">
 <label><span>${zh?'旋律风格':'Melody style'}</span><select data-solo="style">${renderSelectItems(SOLO_STYLES,state.solo.style)}</select></label>
 <label><span>${zh?'旋律乐器':'Melody instrument'}</span><select data-solo="instrument">${renderSelectItems(SOLO_INSTRUMENTS,state.solo.instrument)}</select></label>
 <label><span>${zh?'旋律节奏':'Melody rhythm'}</span><select data-solo="rhythm"><option value="auto" ${state.solo.rhythm==='auto'?'selected':''}>${zh?'跟随风格':'Style default'}</option>${renderSelectItems(RHYTHMS.filter(r=>r.id!=='waltz'),state.solo.rhythm)}</select></label>
 <label><span>${zh?'旋律音型':'Melody pattern'}</span><select data-solo="pattern">${renderSelectItems(SOLO_PATTERNS,state.solo.pattern)}</select></label>
 <label><span>${zh?'音区':'Register'}</span><select data-solo="register"><option value="middle" ${state.solo.register==='middle'?'selected':''}>${zh?'中音区':'Middle'}</option><option value="high" ${state.solo.register==='high'?'selected':''}>${zh?'高音区':'High'}</option></select></label>
 </div><div class="wb-range-grid"><label class="wb-range"><span>${zh?'旋律密度':'Melody density'}</span><input type="range" data-solo="density" min="0.15" max="1" step="0.01" value="${state.solo.density}"><output data-solo-density>${Math.round(state.solo.density*100)}%</output></label><label class="wb-range"><span>${zh?'旋律音量':'Melody volume'}</span><input type="range" data-solo="volume" min="0" max="1" step="0.01" value="${state.solo.volume}"><output data-solo-volume>${Math.round(state.solo.volume*100)}%</output></label><label class="wb-range"><span>${zh?'旋律温度':'Melody temperature'}</span><input type="range" data-solo="temperature" min="0.25" max="1.5" step="0.01" value="${state.solo.temperature}"><output data-solo-temperature>${state.solo.temperature.toFixed(2)}</output></label><label class="wb-range"><span>${zh?'旋律与和声互动':'Melody–harmony interaction'}</span><input type="range" data-solo="interaction" min="0" max="1" step="0.01" value="${state.solo.interaction}"><output data-solo-interaction>${Math.round(state.solo.interaction*100)}%</output></label></div><p class="wb-short-hint">${zh?'开启后从下一小节进入；关闭立即静音，不影响手弹。':'Melody follows the chords; harmony responds to the phrase. Turn off to play your own melody.'}</p></details>`;
}
function toggleRandom(){
 state.random.enabled=!state.random.enabled;if(state.random.enabled)state.panels.random=true;
 randomArranger.configure({...state.random,style:state.accompaniment.style,bpm:state.accompaniment.bpm});
 renderAccompaniment();renderCurrentChord();
}
function toggleSolo(){
 state.solo.enabled=!state.solo.enabled;if(state.solo.enabled)state.panels.solo=true;
 controller.update({soloEnabled:state.solo.enabled,soloVolume:state.solo.volume});
 renderAccompaniment();renderCurrentChord();
 if(state.solo.enabled&&!state.playing&&!state.starting)void startAccompaniment();
}
function applyRandomSettings(result){
 if(!result)return;
 // An actively edited parameter remains under the player's hand.
 const active=document.activeElement;
 if(active?.dataset.accompaniment)delete result.accompaniment[active.dataset.accompaniment];
 if(active?.dataset.solo)delete result.solo[active.dataset.solo];
 Object.assign(state.accompaniment,result.accompaniment);
 if(state.solo.enabled)Object.assign(state.solo,result.solo);
 controller.update({...result.accompaniment,soloEnabled:state.solo.enabled,soloVolume:state.solo.volume});
 syncArrangementControls();renderCurrentChord();
}
// Keep form nodes alive while random changes occur: a drag or open select must not vanish.
function syncArrangementControls(){
 const defaults=byId(STYLES,state.accompaniment.style);
 const choices={rhythm:RHYTHMS,pattern:PATTERNS,instrument:INSTRUMENTS,bassInstrument:BASS_INSTRUMENTS,bassLine:BASS_LINES};
 accompanimentPanel.querySelectorAll('[data-accompaniment]').forEach(element=>{
   const key=element.dataset.accompaniment,value=state.accompaniment[key];
   if(document.activeElement!==element)element.value=value??'';
   if(choices[key]&&element.options?.[0]?.value==='')element.options[0].textContent=`${itemName(byId(choices[key],defaults[key]))} · ${getLanguage()==='zh-CN'?'自动':'Auto'}`;
   const output=accompanimentPanel.querySelector(`[data-${key}]`);
   if(output)output.textContent=key==='bpm'?value:`${Math.round(value*100)}%`;
 });
 accompanimentPanel.querySelectorAll('[data-solo]').forEach(element=>{
   const key=element.dataset.solo;if(document.activeElement!==element)element.value=state.solo[key];
 });
 const density=accompanimentPanel.querySelector('[data-solo-density]');
 if(density)density.textContent=`${Math.round(state.solo.density*100)}%`;
 accompanimentPanel.querySelectorAll('[data-style]').forEach(button=>{
   const active=button.dataset.style===state.accompaniment.style;
   button.classList.toggle('is-active',active);button.setAttribute('aria-pressed',String(active));
 });
 renderBeatIndicator();
}
function handlePerformanceInput(event){
 const random=event.target.dataset.random,solo=event.target.dataset.solo;
 if(random==='every'){
   state.random.every=clamp(Math.round(Number(event.target.value)),1,32);randomArranger.configure(state.random);
   accompanimentPanel.querySelector('[data-random-interval]').textContent=`${state.random.every} ${getLanguage()==='zh-CN'?'小节':state.random.every===1?'bar':'bars'}`;return true;
 }
 if(['density','volume','temperature','interaction'].includes(solo)){
   state.solo[solo]=Number(event.target.value);accompanimentPanel.querySelector(`[data-solo-${solo}]`).textContent=solo==='temperature'?state.solo.temperature.toFixed(2):`${Math.round(state.solo[solo]*100)}%`;
   if(solo==='volume')controller.update({soloVolume:state.solo.volume});return true;
 }
 return false;
}
function handlePerformanceChange(event){
 const random=event.target.dataset.random,solo=event.target.dataset.solo;
 if(random){if(random==='wild'||random==='tempo'){state.random[random]=event.target.checked;randomArranger.configure(state.random);}return true;}
 if(solo){if(['style','instrument','rhythm','pattern','register'].includes(solo))state.solo[solo]=event.target.value;return true;}
 return false;
}
function setHarmonyTemperature(value){
 state.temperature=clamp(value,.25,2);quickControls.render();
 const output=harmonyPanel.querySelector('[data-temperature]');if(output)output.textContent=state.temperature.toFixed(2);
 const range=harmonyPanel.querySelector('[data-harmony="temperature"]');if(range&&document.activeElement!==range)range.value=state.temperature;
 clearTimeout(temperatureTimer);
 temperatureTimer=setTimeout(()=>{resetLookahead();if(state.expanded&&state.tab==='harmony')renderHarmony();},90);
}
function setMainKey(value){
 const [tonic,mode]=value.split(':');
 if(!KEYS.some(k=>k.tonic===Number(tonic)&&k.mode===mode))return;
 state.key={tonic:Number(tonic),mode};state.keyWalk=false;state.keyAge=0;
 state.chordRoot=Number(tonic);state.distributionRoot=Number(tonic);
 // Selecting a tonal center reconditions the future; it never interrupts the sounding chord.
 resetLookahead();renderCurrentChord();if(state.expanded&&state.tab==='harmony')renderHarmony();
}
function toggleKeyWalk(){
 state.keyWalk=!state.keyWalk;state.keyAge=0;
 if(state.keyWalk)setBarMode('generate');
 resetLookahead();renderCurrentChord();if(state.expanded&&state.tab==='harmony')renderHarmony();
}
function openChordEditor(uid){
 const context=lookahead.contextFor(uid);if(!context)return;
 const chord=getChord(context.entry.id);
 editor={uid,root:chord.root,quality:chord.qualityIndex,inversion:chord.inversion,error:''};
 setExpanded(false);renderChordEditor();editorElement.querySelector('select')?.focus({preventScroll:true});
}
function closeChordEditor(){editor=null;editorElement.hidden=true;}
function renderChordEditor(){
 if(!editor)return;
 const zh=getLanguage()==='zh-CN',context=lookahead.contextFor(editor.uid);
 const base=BASE_CHORDS[editor.quality*12+editor.root];
 editor.inversion=Math.min(editor.inversion,base.pcs.length-1);
 const chosen=CHORD_VOCAB.find(c=>c.baseIndex===base.baseIndex&&c.inversion===editor.inversion);
 let candidates=[];if(context)try{candidates=predictWithMelody(context.history,context.options).distribution.slice(0,6);}catch(_){}
 editorElement.setAttribute('aria-label',zh?'修改未来和弦':'Edit upcoming chord');editorElement.hidden=false;
 editorElement.innerHTML=`<div class="wb-editor-head"><strong>${context?`${zh?'修改':'Edit'} +${context.index}: ${htmlEscape(chordLabel(context.entry.id))}`:(zh?'此和弦已播放':'This chord has already played')}</strong><button type="button" data-edit="close" aria-label="${zh?'关闭和弦编辑':'Close chord editor'}">×</button></div>
 <p class="wb-short-hint">${zh?'保留前面的和弦；后续和弦重新生成。':'Earlier chords stay. Later chords regenerate.'}</p>
 <div class="wb-editor-candidates">${candidates.map(c=>`<button type="button" data-edit-chord="${htmlEscape(c.id)}">${htmlEscape(chordLabel(c.id))} <small>${percent(c.probability)}</small></button>`).join('')}</div>
 <div class="wb-editor-fields"><label>${zh?'根音':'Root'}<select data-edit="root">${ROOT_NAMES.map((n,i)=>`<option value="${i}" ${i===editor.root?'selected':''}>${n}</option>`).join('')}</select></label>
 <label>${zh?'类型':'Type'}<select data-edit="quality">${QUALITIES.map((q,i)=>`<option value="${i}" ${i===editor.quality?'selected':''}>${q.id==='maj'?(zh?'大三和弦':'Major'):q.id==='min'?(zh?'小三和弦':'Minor'):htmlEscape(q.suffix)}</option>`).join('')}</select></label>
 <label>${zh?'低音／转位':'Bass / inversion'}<select data-edit="inversion">${base.noteNames.map((n,i)=>`<option value="${i}" ${i===editor.inversion?'selected':''}>${n} ${i===0?(zh?'· 原位':'· Root'):''}</option>`).join('')}</select></label></div>
 <div class="wb-editor-answer"><strong>${htmlEscape(chosen.label)}</strong><span>${htmlEscape(chosen.noteNames.join(' · '))}</span></div>
 <p class="wb-editor-error" role="status">${htmlEscape(editor.error)}</p><button type="button" class="wb-editor-apply" data-edit="apply" ${context?'':'disabled'}>${zh?'替换并重新生成后续':'Replace & regenerate later chords'}</button>`;
}
function applyChordEdit(){
 if(!editor)return;
 const base=BASE_CHORDS[editor.quality*12+editor.root],chosen=CHORD_VOCAB.find(c=>c.baseIndex===base.baseIndex&&c.inversion===editor.inversion);
 const result=lookahead.replaceFuture(editor.uid,chosen.id);
 if(!result){editor.error=getLanguage()==='zh-CN'?'它已经播放，请重新点选一个未来和弦。':'It has already played. Choose an upcoming chord again.';renderChordEditor();return;}
 state.editedFuture=true;state.autoMode='generate';if(state.barMode!=='hold')setBarMode('generate');
 closeChordEditor();renderTimeline();updatePrediction();renderCurrentChord();
 if(state.expanded&&state.tab==='harmony')renderHarmony();
}
editorElement.addEventListener('click',event=>{
 const choice=event.target.closest('[data-edit-chord]');
 if(choice&&editor){const c=getChord(choice.dataset.editChord);Object.assign(editor,{root:c.root,quality:c.qualityIndex,inversion:c.inversion});renderChordEditor();return;}
 const action=event.target.closest('[data-edit]')?.dataset.edit;
 if(action==='close')closeChordEditor();if(action==='apply')applyChordEdit();
});
editorElement.addEventListener('change',event=>{const key=event.target.dataset.edit;if(editor&&['root','quality','inversion'].includes(key)){editor[key]=Number(event.target.value);renderChordEditor();}});
document.addEventListener('keydown',event=>{if(event.key==='Escape'&&editor)closeChordEditor();});
accompanimentPanel.addEventListener('toggle',event=>{const key=event.target.dataset.fold;if(key)state.panels[key]=event.target.open;},true);

const learnPanel = createLearnPanel({ container: learnContainer, audio, getLanguage });

window.addEventListener("tonnetzlanguagechange", () => {
  renderStaticText();
  renderCurrentChord();
  renderAccompaniment();
  if(editor)renderChordEditor();
  if (state.tab === "harmony") renderHarmony();
  learnPanel.render();
  renderTimeline();
});
window.addEventListener("tonnetz:panic", stopAccompaniment);
window.addEventListener("tonnetz:settings", (event) => {
  if (event.detail?.open) {closeChordEditor();if(state.expanded)setExpanded(false);}
});
window.addEventListener("pagehide", () => {
  stopAccompaniment();
  learnPanel.destroy();
  timeline.destroy();
  quickControls.destroy();
  clearTimeout(temperatureTimer);
}, { once: true });

async function initialize() {
  state.expanded = false;
  renderStaticText();
  renderCurrentChord();
  renderAccompaniment();
  resetLookahead();
  showTab(state.tab);
  try {
    await prepareModels();
    state.modelReady = true;
    updatePrediction();
    resetLookahead();
  } catch (error) {
    state.modelError = error;
  }
  if (state.tab === "harmony") renderHarmony();
}

void initialize();
