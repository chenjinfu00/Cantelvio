import { appLayoutSnapshot, keyboardSVG, point } from "../shared/lattice.js";
import { pitchClass } from "../shared/music-data.js";
import { renderMath } from "../math.js";
import { KaraokeAudio } from "./karaoke-audio.js";
import { PianoSampler } from "./piano-sampler.js";
import {
  CHORD_DEMOS, CHORD_SHAPES, CLASSIC_CHORDS, CLASSIC_VOICINGS,
  EQUAL_FIFTH_RATIO, FIFTH_PCS, FINAL_CADENCE, HARMONIC_CHORDS,
  KARAOKE_PROGRESSIONS as PROGRESSIONS, PURE_FIFTH_RATIO, TONNETZ_CELL,
  VOICE_PARTS
} from "./karaoke-data.js";
import { GuidedRunGate, SequentialReveal } from "./guided-state.js";
import { ringSVG, tonnetzCellSVG, fixedChordSVG, edgeLegendSVG } from "./karaoke-geometry.js";
import { createHarmonyExplorer } from "./harmony-summary.js";
import { installStageFitter } from "./karaoke-layout.js";

const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
const slides = $$(".slide");
const deck = $("#deck");
const stage = $("#stage");
const stageShell = $(".stage-shell");
const pageCount = $("#pageCount");
const progressBar = $("#progressBar");
const prevButton = $("#prevButton");
const nextButton = $("#nextButton");
const audio = new KaraokeAudio(null, $("#soundStatus"));
const sampler = new PianoSampler();
audio.setSampler(sampler);
sampler.load().catch(() => {});
installStageFitter(stage, stageShell);

const runGate = new GuidedRunGate();
const processReveal = new SequentialReveal(PROGRESSIONS.length);
const shapeReveal = new SequentialReveal(CHORD_DEMOS.length);
const harmonicReveal = new SequentialReveal(HARMONIC_CHORDS.length);
const classicReveal = new SequentialReveal(CLASSIC_CHORDS.length);
let pageIndex = 0;
let maxUnlockedPage = 0;
let choirStep = 0;
let tonnetzStep = 0;
let selectedFlow = 0;
let selectedShape = 0;
let shapeEdgesHeard = 0;
let keyboardMode = "harmonic";
let cadencePlayed = false;
let summaryPlayed = false;
let harmonyExplorer = null;
let lastInputAt = -Infinity;

const claimInput = () => {
  const now = performance.now();
  if (now - lastInputAt < 240 || runGate.busy) return false;
  lastInputAt = now;
  return true;
};

function cancelSound() {
  runGate.cancel();
  audio.stop();
  harmonyExplorer?.cancel?.();
  renderPageState();
}

function cancelAudioOnly() {
  runGate.cancel();
  audio.stop();
  harmonyExplorer?.cancel?.();
}

async function guardedRun(step, runner, onComplete = null) {
  const page = slides[pageIndex].id;
  const token = runGate.begin(page, step);
  if (!token) return false;
  renderNavigation();
  let completed = false;
  try { completed = await runner() === true; } catch (error) { console.error(error); }
  const accepted = runGate.finish(token, page, step, completed);
  if (accepted) onComplete?.();
  renderPageState();
  return accepted;
}

const uniqueCoords = (coords) => [...new Map(coords.map((coord) => [coord.join(","), coord])).values()];
function diagramSVG(shape, { width = 680, height = 470, margin = 2 } = {}) {
  const offsets = [];
  for (let i = -margin; i <= margin; i += 1) for (let j = -margin; j <= margin; j += 1) offsets.push([i, j]);
  const coords = uniqueCoords(shape.coords.flatMap(([i, j]) => offsets.map(([di, dj]) => [i + di, j + dj])));
  const raw = shape.coords.map((coord) => point(coord, 1));
  const minX = Math.min(...raw.map((p) => p.x)), maxX = Math.max(...raw.map((p) => p.x));
  const minY = Math.min(...raw.map((p) => p.y)), maxY = Math.max(...raw.map((p) => p.y));
  const scale = Math.min((width - 70) / (maxX - minX + 3), (height - 55) / (maxY - minY + 3));
  const origin = { x: width / 2 - (minX + maxX) * scale / 2, y: height / 2 - (minY + maxY) * scale / 2 };
  return keyboardSVG({ coords, highlight: shape.coords, width, height, scale, origin, labels: true, quality: shape.quality });
}

function pageComplete(index = pageIndex) {
  return [true, choirStep >= 4, tonnetzStep >= 4, shapeEdgesHeard >= 3 && shapeReveal.done, processReveal.done,
    harmonicReveal.done && classicReveal.done, summaryPlayed, cadencePlayed][index];
}

function setHash() { history.replaceState(null, "", `#${slides[pageIndex].id}`); }
function resetDeckScroll() {
  document.documentElement.scrollTop = 0;
  document.body.scrollTop = 0;
  stageShell.scrollTop = 0;
  slides[pageIndex].scrollTop = 0;
  window.scrollTo?.(0, 0);
}

function navigate(target, { hash = true } = {}) {
  if (target < 0 || target >= slides.length || target > maxUnlockedPage) return;
  runGate.cancel();
  audio.stop();
  harmonyExplorer?.cancel?.();
  pageIndex = target;
  slides.forEach((slide, index) => {
    const active = index === pageIndex;
    slide.classList.toggle("is-active", active);
    slide.setAttribute("aria-hidden", String(!active));
    slide.inert = !active;
  });
  deck.dataset.page = slides[pageIndex].id;
  if (hash) setHash();
  renderPageState();
  if (pageIndex === 6) harmonyExplorer?.enter?.();
  resetDeckScroll();
}

function moveForward() {
  if (!pageComplete()) return false;
  if (pageIndex < slides.length - 1) {
    maxUnlockedPage = Math.max(maxUnlockedPage, pageIndex + 1);
    navigate(pageIndex + 1);
  }
  return true;
}

// Notes and chord identities appear only after the collective singing finishes.
function choirCue(cue) {
  $$(".voice-key", $("#voiceScore")).forEach((key) => key.classList.remove("is-cue"));
  $$('[data-harmony-chord]', $("#harmonyReveal")).forEach((chord) => chord.classList.remove("is-cue"));
  if (!cue) {
    if (choirStep >= 4) $("#choirPrompt").textContent = "The answer";
    return;
  }
  if (cue.kind === "count") {
    $("#choirPrompt").textContent = `${cue.voice ? `Voice ${cue.voice}` : "Together"}: ${cue.label.split(" · ").at(-1)}`;
    return;
  }
  if (!Number.isInteger(cue.step)) return;
  const selector = cue.voice ? `[data-voice="${cue.voice}"] [data-key="${cue.step}"]` : `[data-key="${cue.step}"]`;
  $$(selector, $("#voiceScore")).forEach((key) => key.classList.add("is-cue"));
  if (cue.kind === "answer") {
    $(`[data-harmony-chord="${cue.step}"]`, $("#harmonyReveal"))?.classList.add("is-cue");
    $("#choirPrompt").textContent = "The answer";
  } else {
    $("#choirPrompt").textContent = cue.voice ? `Voice ${cue.voice}: follow · ${cue.round}/2` : cue.kind === "response" ? "Your turn: sing together!" : "Sing together!";
  }
}

function renderChoir() {
  const revealed = choirStep >= 4;
  const visibleCount = Math.min(choirStep + 1, 3);
  const score = $("#voiceScore");
  const headings = revealed ? `<div class="score-heading"><span></span>${PROGRESSIONS[0].chords.map((name) => `<b>${name}</b>`).join("")}</div>` : "";
  score.innerHTML = headings + VOICE_PARTS.slice(0, visibleCount).map((part) => `<div class="voice-part" data-voice="${part.id}">
    <strong>Voice ${part.id}</strong>${part.midis.map((midi, index) => `<button type="button" class="voice-key" data-midi="${midi}" data-key="${index}" aria-label="Voice ${part.id}, key ${index + 1}">${revealed ? part.notes[index] : "●"}</button>`).join("")}
  </div>`).join("");
  $$(".voice-key", score).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    cancelAudioOnly();
    audio.playClip(`voice-note-${button.dataset.midi}`, button);
  }));
  const prompt = $("#choirPrompt"), actions = $("#choirActions");
  $("#choirHelp").hidden = choirStep !== 3;
  if (choirStep <= 2) {
    prompt.textContent = choirStep === 0 ? "Ask an audience volunteer to stand & follow." : "Ask another audience volunteer to stand & follow.";
    actions.innerHTML = `<button type="button" class="primary step-action" data-choir-run>▶ Voice ${choirStep + 1} · twice</button>`;
  } else if (choirStep === 3) {
    prompt.textContent = "Ready? Sing together!";
    actions.innerHTML = `<button type="button" class="primary step-action" data-choir-run>▶ Sing together</button>`;
  } else {
    prompt.textContent = "The answer";
    actions.innerHTML = `<button type="button" data-choir-replay>▶ The answer</button>`;
  }
  $("#harmonyReveal").hidden = !revealed;
  $("#harmonyReveal").innerHTML = revealed ? PROGRESSIONS[0].chords.map((name, index) => `<button type="button" data-harmony-chord="${index}"><small>${PROGRESSIONS[0].romans[index]}</small><b>${name}</b></button>`).join("<i>→</i>") : "";
  $('[data-choir-run]', actions)?.addEventListener("click", (event) => { if (claimInput()) runChoirStep(event.currentTarget); });
  $('[data-choir-replay]', actions)?.addEventListener("click", (event) => {
    if (claimInput()) guardedRun("choir-answer", () => audio.playClip("parts-answer", event.currentTarget, choirCue, { statusLabel: "Playing: the answer" }));
  });
  $$('[data-harmony-chord]', $("#harmonyReveal")).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    cancelAudioOnly();
    const name = PROGRESSIONS[0].chords[Number(button.dataset.harmonyChord)];
    audio.chord(CHORD_SHAPES[name].midis, button, 900, name);
  }));
}
function runChoirStep(button) {
  if (choirStep <= 2) {
    const voice = choirStep + 1;
    guardedRun(`choir-practice-${voice}`, () => audio.playClip(`part-${voice}-practice`, button, choirCue), () => { choirStep += 1; });
  } else if (choirStep === 3) {
    guardedRun("choir-together", () => audio.playClip("parts-together", button, choirCue, { statusLabel: "Audience: sing together" }), () => { choirStep = 4; });
  }
}

// Process: exactly one new progression appears after a complete playback.
function progressionButton(flow, index) {
  return `<button type="button" class="progression ${index === processReveal.completed ? "step-action" : ""} ${flow.chords.length >= 7 ? "is-long" : ""}" data-flow="${index}"><span>▶</span>${flow.chords.map((name, step) => `<span data-flow-step="${step}"><b>${name}</b><small>${flow.romans[step]}</small></span>`).join("<i>→</i>")}</button>`;
}
function renderFilm(flowIndex = selectedFlow, active = -1) {
  const flow = PROGRESSIONS[flowIndex];
  const strip = $("#filmstrip");
  strip.style.gridTemplateColumns = flow.chords.map((_, step) => step < flow.chords.length - 1 ? "1fr auto" : "1fr").join(" ");
  strip.innerHTML = flow.chords.map((name, step) => `<button type="button" class="film-cell ${step === active ? "is-current" : ""}" data-film-step="${step}"><b>${name}</b>${diagramSVG(CHORD_SHAPES[name], { width: 260, height: 220, margin: 1 })}</button>${step < flow.chords.length - 1 ? '<span class="film-arrow">→</span>' : ""}`).join("");
  $$(".film-cell", strip).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    cancelAudioOnly();
    const name = flow.chords[Number(button.dataset.filmStep)];
    audio.chord(CHORD_SHAPES[name].midis, button, 850, name);
  }));
}
function renderProcess() {
  renderFilm(selectedFlow);
  $("#progressionList").innerHTML = PROGRESSIONS.slice(0, processReveal.unlocked).map(progressionButton).join("");
  $$("[data-flow]", $("#progressionList")).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    playProgression(Number(button.dataset.flow), button);
  }));
}
function playProgression(flowIndex, button) {
  selectedFlow = flowIndex;
  const flow = PROGRESSIONS[flowIndex];
  guardedRun(`process-${processReveal.completed}-${flowIndex}`, () => audio.sequence(flow.chords.map((name) => CHORD_SHAPES[name].midis), button, (step) => {
    $$('[data-flow-step]', button).forEach((cell) => cell.classList.toggle("is-current", Number(cell.dataset.flowStep) === step));
    renderFilm(flowIndex, step);
  }, 760, `Process ${flowIndex + 1}`), () => {
    if (processReveal.complete(flowIndex)) selectedFlow = Math.min(processReveal.completed, PROGRESSIONS.length - 1);
  });
}

// Tonnetz: chromatic identities → fifth order → one exact 12-note cell → translations → tuning comparison.
const midiFrequency = (midi) => 440 * 2 ** ((midi - 69) / 12);
function renderTonnetz() {
  const prompt = $("#tonnetzPrompt"), scene = $("#tonnetzScene"), action = $("#tonnetzAction");
  if (tonnetzStep === 0) {
    prompt.textContent = "12 notes";
    scene.innerHTML = ringSVG();
    action.textContent = "▶ Chromatic";
  } else if (tonnetzStep === 1) {
    prompt.textContent = "Fifths";
    scene.innerHTML = ringSVG({ fifths: true });
    action.textContent = "▶ Fifths";
  } else if (tonnetzStep === 2) {
    prompt.textContent = "One cell";
    scene.innerHTML = `<div class="map-pair"><div>${ringSVG().replace("0 0 1140 520", "180 0 780 520")}<b>12 notes</b></div><i>→</i><div>${tonnetzCellSVG(false, { compact: true, axes: false })}<b>One cell</b></div></div>`;
    action.textContent = "▶ Map 12 notes";
  } else if (tonnetzStep === 3) {
    prompt.textContent = "Repeat";
    scene.innerHTML = tonnetzCellSVG(true);
    action.textContent = "▶ Pure / 12-TET";
  } else {
    prompt.textContent = "12-TET: 12 equal steps / octave";
    scene.innerHTML = `${tonnetzCellSVG(true)}<div class="tuning-compare"><span data-compare="pure">Pure fifth</span><b data-compare="pure" data-tex="3:2"></b><span data-compare="equal">12-TET</span><b data-compare="equal" data-tex="2^{7/12}"></b></div>`;
    renderMath(scene);
    action.hidden = true;
    return;
  }
  action.hidden = false;
  action.onclick = () => { if (claimInput()) runTonnetzStep(action); };
}
function markPc(pc) { $$(".tone-node,.cell-note", $("#tonnetzScene")).forEach((node) => node.classList.toggle("is-cue", Number(node.dataset.pc) === pc)); }
function markCompare(step) {
  const kind = step < 0 ? "" : step < 2 ? "pure" : "equal";
  $$('[data-compare]', $("#tonnetzScene")).forEach((node) => node.classList.toggle("is-cue", node.dataset.compare === kind));
}
function runTonnetzStep(button) {
  if (tonnetzStep === 0) {
    guardedRun("tonnetz-chromatic", () => audio.frequencySteps(Array.from({ length: 12 }, (_, i) => midiFrequency(60 + i)), button, (step) => markPc(step), 250, 210, "12 notes"), () => { tonnetzStep = 1; });
  } else if (tonnetzStep === 1) {
    guardedRun("tonnetz-fifths", () => audio.frequencySteps([...FIFTH_PCS, 0].map((pc) => midiFrequency(60 + pc)), button, (step) => {
      markPc([...FIFTH_PCS, 0][step]);
      $$(".fifth-link").forEach((edge) => {
        edge.classList.toggle("is-revealed", Number(edge.dataset.fifthStep) < step);
        edge.classList.toggle("is-cue", Number(edge.dataset.fifthStep) === step - 1);
      });
    }, 420, 350, "Fifths"), () => { tonnetzStep = 2; });
  } else if (tonnetzStep === 2) {
    guardedRun("tonnetz-cell", () => audio.frequencySteps(TONNETZ_CELL.map(({ pc }) => midiFrequency(60 + pc)), button, (step) => markPc(TONNETZ_CELL[step]?.pc), 230, 195, "One cell"), () => { tonnetzStep = 3; });
  } else if (tonnetzStep === 3) {
    $("#tonnetzPrompt").textContent = "12-TET: 12 equal steps / octave";
    $("#tonnetzScene").insertAdjacentHTML("beforeend", '<div class="tuning-compare"><span data-compare="pure">Pure fifth</span><b data-compare="pure" data-tex="3:2"></b><span data-compare="equal">12-TET</span><b data-compare="equal" data-tex="2^{7/12}"></b></div>');
    renderMath($("#tonnetzScene"));
    const base = 261.625565;
    guardedRun("tonnetz-tuning", () => audio.frequencySteps([base, base * PURE_FIFTH_RATIO, base, base * EQUAL_FIFTH_RATIO], button, markCompare, 620, 540, "Pure / 12-TET"), () => { tonnetzStep = 4; });
  }
}

// Shape of chords: each full chord playback unlocks exactly one new shape.
function renderShapes() {
  selectedShape = Math.min(selectedShape, shapeReveal.unlocked - 1);
  const chord = CHORD_DEMOS[selectedShape];
  const learningEdges = shapeEdgesHeard < 3;
  $("#shapeLegend").innerHTML = edgeLegendSVG();
  const legends = $$("[data-interval]", $("#shapeLegend"));
  legends.forEach((node, index) => {
    node.classList.toggle("is-cue", learningEdges && index === shapeEdgesHeard);
    node.setAttribute("aria-disabled", String(index > shapeEdgesHeard));
    node.tabIndex = index > shapeEdgesHeard ? -1 : 0;
    const play = () => { if (claimInput()) playEdge(index); };
    node.onclick = play;
    node.onkeydown = (event) => { if (["Enter", " "].includes(event.key)) { event.preventDefault(); play(); } };
  });
  $("#chordMain").innerHTML = `${learningEdges ? "" : `<span class="chord-name">${esc(chord.id)}</span>`}${fixedChordSVG(learningEdges ? { coords: [] } : chord)}`;
  $("#shapeIntroAction").hidden = !learningEdges;
  $("#shapeIntroAction").textContent = ["▶ Fifth", "▶ Major 3rd", "▶ Minor 3rd"][shapeEdgesHeard] || "";
  $("#shapeIntroAction").onclick = () => { if (claimInput()) playEdge(shapeEdgesHeard); };
  $("#chordPicker").hidden = learningEdges;
  $("#chordMain").setAttribute("aria-label", learningEdges ? "Hear the next edge" : `Play ${chord.id}`);
  $("#chordPicker").innerHTML = CHORD_DEMOS.slice(0, shapeReveal.unlocked).map((item, index) => `<button type="button" data-shape="${index}" class="${index === selectedShape ? "is-active" : ""}">${esc(item.id)}</button>`).join("");
  $("#chordMain").onclick = () => { if (claimInput()) shapeEdgesHeard < 3 ? playEdge(shapeEdgesHeard) : playShape(selectedShape, $("#chordMain")); };
  $$('[data-shape]', $("#chordPicker")).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    selectedShape = Number(button.dataset.shape);
    renderShapes();
    playShape(selectedShape, $("#chordMain"));
  }));
}
function playEdge(index) {
  if (index > shapeEdgesHeard || index < 0 || index > 2) return;
  const node = $$("[data-interval]", $("#shapeLegend"))[index];
  const coords = [[1, 0], [0, 1], [1, -1]][index];
  $("#chordMain").innerHTML = fixedChordSVG({ coords: [[0, 0], coords], quality: "major" });
  $$("[data-interval]", $("#shapeLegend")).forEach((edge) => edge.classList.toggle("is-cue", edge === node));
  guardedRun(`shape-edge-${index}`, () => audio.sequence([[60], [Number(node.dataset.toMidi)], [60, Number(node.dataset.toMidi)]], node, null, 520, node.getAttribute("aria-label")), () => {
    if (index === shapeEdgesHeard) shapeEdgesHeard += 1;
  });
}
function playShape(index, button) {
  const chord = CHORD_DEMOS[index];
  guardedRun(`shape-${shapeReveal.completed}-${index}`, () => audio.chord(audio.midiForPcs(chord.pcs), button, 1050, chord.id), () => {
    if (shapeReveal.complete(index)) selectedShape = Math.min(shapeReveal.completed, CHORD_DEMOS.length - 1);
  });
}

// Isomorphic keyboard: geometric offsets choose one concrete adjacent Tonnetz shape.
const columnStart = (col) => Math.floor((2 * col + 4) / 7);
function harmonicKeysFor(card, chordName) {
  const shape = CHORD_SHAPES[chordName];
  const [baseI, baseJ] = shape.coords[0];
  const offsets = shape.coords.map(([i, j]) => [i - baseI, j - baseJ]);
  const keys = $$(".snapshot-key", card).map((node) => ({
    node, col: Number(node.dataset.col), row: Number(node.dataset.row), pc: Number(node.dataset.pc), midi: Number(node.dataset.midi)
  })).map((key) => ({ ...key, latticeRow: columnStart(key.col) + key.row }));
  const roots = keys.filter((key) => key.pc === pitchClass(shape.coords[0]));
  const candidates = roots.map((root) => offsets.map(([di, dj]) => keys.find((key) => key.col === root.col + dj && key.latticeRow === root.latticeRow - di))).filter((set) => set.every(Boolean));
  const score = (keys) => Math.abs(keys[0].midi - shape.midis[0]) * 100 + Math.abs(keys[0].col - 4) + Math.abs(keys[0].row - 2.5);
  candidates.sort((a, b) => score(a) - score(b));
  return candidates[0] || [];
}
function markKeys(card, keys) {
  $$(".snapshot-key", card).forEach((key) => key.classList.remove("is-highlight"));
  keys.forEach((key) => key.node.classList.add("is-highlight"));
}
function classicKeysFor(card, chordName) {
  const midis = CLASSIC_VOICINGS[chordName];
  const keys = $$(".snapshot-key", card).map((node) => ({
    node, midi: Number(node.dataset.midi), col: Number(node.dataset.col),
    row: Number(node.dataset.row), latticeRow: columnStart(Number(node.dataset.col)) + Number(node.dataset.row)
  }));
  // Ascending piano-register intervals use one translated shape, including odd semitones.
  const candidates = keys.filter((key) => key.midi === midis[0]).map((root) => midis.map((midi) => {
    const interval = midi - midis[0];
    return keys.find((key) => key.col === root.col + Math.floor(interval / 2)
      && key.latticeRow === root.latticeRow - (interval % 2) && key.midi === midi);
  })).filter((group) => group.every(Boolean));
  const distance = (group) => Math.abs(group.reduce((sum, key) => sum + key.col, 0) / group.length - 6)
    + Math.abs(group.reduce((sum, key) => sum + key.row, 0) / group.length - 3);
  return candidates.sort((a, b) => distance(a) - distance(b))[0] || [];
}

function installPlayableKeys(card) {
  $$(".snapshot-key", card).forEach((key) => {
    key.tabIndex = 0;
    key.setAttribute("role", "button");
    key.setAttribute("aria-label", `Play ${key.querySelector("text")?.textContent || "key"}`);
  });
  card.onclick = (event) => {
    const key = event.target.closest(".snapshot-key");
    if (!key || !claimInput()) return;
    cancelAudioOnly();
    audio.chord([Number(key.dataset.midi)], key, 650, key.querySelector("text")?.textContent || "Key");
  };
  card.onkeydown = (event) => {
    const key = event.target.closest?.(".snapshot-key");
    if (!key || !["Enter", " "].includes(event.key)) return;
    event.preventDefault();
    if (!claimInput()) return;
    cancelAudioOnly();
    audio.chord([Number(key.dataset.midi)], key, 650, key.querySelector("text")?.textContent || "Key");
  };
}
function renderKeyboardActions(container, names, reveal, mode) {
  container.innerHTML = names.slice(0, reveal.unlocked).map((name, index) => `<button type="button" data-keyboard-chord="${index}" class="${index === reveal.completed ? "step-action" : ""}">${esc(name)}</button>`).join("");
  $$('[data-keyboard-chord]', container).forEach((button) => button.addEventListener("click", (event) => {
    event.stopPropagation();
    if (!claimInput()) return;
    playKeyboardChord(mode, Number(button.dataset.keyboardChord), button);
  }));
}
function renderKeyboard() {
  const harmonicCard = $("#harmonicCard"), classicCard = $("#classicCard");
  if (!$("#harmonicKeyboard svg")) {
    $("#harmonicKeyboard").innerHTML = appLayoutSnapshot({ layout: "harmonic", columns: 9, rows: 6, width: 1160, height: 430 });
    installPlayableKeys(harmonicCard);
  }
  renderKeyboardActions($("#harmonicActions"), HARMONIC_CHORDS, harmonicReveal, "harmonic");
  if (!harmonicReveal.done) keyboardMode = "harmonic";
  harmonicCard.hidden = keyboardMode !== "harmonic";
  classicCard.hidden = !harmonicReveal.done || keyboardMode !== "classic";
  $("#keyboardStage").classList.remove("has-classic");
  if (harmonicReveal.done && !$("#classicKeyboard svg")) {
    $("#classicKeyboard").innerHTML = appLayoutSnapshot({ layout: "classic", columns: 13, rows: 7, width: 1160, height: 430 });
    installPlayableKeys(classicCard);
  }
  if (harmonicReveal.done) renderKeyboardActions($("#classicActions"), CLASSIC_CHORDS, classicReveal, "classic");
  $("#keyboardModes").innerHTML = harmonicReveal.done ? `<button type="button" data-keyboard-mode="harmonic" class="${keyboardMode === "harmonic" ? "is-active" : ""}">Harmonic</button><button type="button" data-keyboard-mode="classic" class="${keyboardMode === "classic" ? "is-active" : ""}">Classic</button>` : "";
  $$('[data-keyboard-mode]', $("#keyboardModes")).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    keyboardMode = button.dataset.keyboardMode;
    renderKeyboard();
  }));
  const currentMode = keyboardMode;
  const reveal = currentMode === "harmonic" ? harmonicReveal : classicReveal;
  const names = currentMode === "harmonic" ? HARMONIC_CHORDS : CLASSIC_CHORDS;
  const card = currentMode === "harmonic" ? harmonicCard : classicCard;
  if (!reveal.done) {
    const keys = currentMode === "harmonic" ? harmonicKeysFor(card, names[reveal.completed]) : classicKeysFor(card, names[reveal.completed]);
    markKeys(card, keys);
  }
}
function playKeyboardChord(mode, index, button) {
  const reveal = mode === "harmonic" ? harmonicReveal : classicReveal;
  const names = mode === "harmonic" ? HARMONIC_CHORDS : CLASSIC_CHORDS;
  const card = mode === "harmonic" ? $("#harmonicCard") : $("#classicCard");
  const name = names[index];
  const keys = mode === "harmonic" ? harmonicKeysFor(card, name) : classicKeysFor(card, name);
  markKeys(card, keys);
  const expected = mode === "harmonic" ? CHORD_SHAPES[name].coords.length : CLASSIC_VOICINGS[name].length;
  if (keys.length !== expected) {
    $("#soundStatus").textContent = "Chord is outside this view";
    return;
  }
  guardedRun(`${mode}-${reveal.completed}-${index}`, () => audio.chord(keys.map((key) => key.midi), button, 1000, name), () => {
    const advanced = reveal.complete(index);
    if (mode === "harmonic" && advanced && harmonicReveal.done) keyboardMode = "classic";
  });
}

function renderSummary() {
  if (!harmonyExplorer) {
    harmonyExplorer = createHarmonyExplorer({
      container: $("#harmonySummary"), audio, claimInput, guardedRun, renderMath,
      onComplete: () => { summaryPlayed = true; renderNavigation(); }
    });
  }
  harmonyExplorer.render();
}
function runSummaryPath() {
  renderSummary();
  return harmonyExplorer.advance();
}

function renderClosing() {
  $("#cadenceStrip").innerHTML = FINAL_CADENCE.chords.map((name, step) => `<button type="button" class="cadence-cell" data-cadence-step="${step}"><span><small>${FINAL_CADENCE.romans[step]}</small><b>${name}</b></span>${diagramSVG(CHORD_SHAPES[name], { width: 360, height: 260, margin: 1 })}</button>${step < 2 ? '<i>→</i>' : ""}`).join("");
  $$('[data-cadence-step]', $("#cadenceStrip")).forEach((button) => button.addEventListener("click", () => {
    if (!claimInput()) return;
    cancelAudioOnly();
    const step = Number(button.dataset.cadenceStep);
    audio.chord(FINAL_CADENCE.midis[step], button, 1200, FINAL_CADENCE.chords[step]);
  }));
  $("#cadenceButton").onclick = () => {
    if (!claimInput()) return;
    runCadence();
  };
}
function runCadence() {
  guardedRun("cadence", () => audio.sequence(FINAL_CADENCE.midis, $("#cadenceButton"), (step) => {
    $$('[data-cadence-step]', $("#cadenceStrip")).forEach((cell) => cell.classList.toggle("is-current", Number(cell.dataset.cadenceStep) === step));
  }, 1300, "IV → V7 → I"), () => { cadencePlayed = true; });
}

function renderNavigation() {
  pageCount.textContent = `${pageIndex + 1} / ${slides.length}`;
  progressBar.style.width = `${(pageIndex + 1) / slides.length * 100}%`;
  prevButton.disabled = pageIndex === 0 || runGate.busy;
  nextButton.disabled = runGate.busy || (pageIndex === slides.length - 1 && cadencePlayed);
  nextButton.classList.toggle("is-ready", pageComplete());
  nextButton.setAttribute("aria-label", pageComplete() ? "Next page" : "Do next step");
}
function renderPageState() {
  if (pageIndex === 1) renderChoir();
  else if (pageIndex === 2) renderTonnetz();
  else if (pageIndex === 3) renderShapes();
  else if (pageIndex === 4) renderProcess();
  else if (pageIndex === 5) renderKeyboard();
  else if (pageIndex === 6) renderSummary();
  else if (pageIndex === 7) renderClosing();
  renderNavigation();
}

function performCurrentStep() {
  if (pageComplete()) return pageIndex < slides.length - 1 ? moveForward() : false;
  if (pageIndex === 1) {
    runChoirStep($("[data-choir-run]"));
  } else if (pageIndex === 2) runTonnetzStep($("#tonnetzAction"));
  else if (pageIndex === 3) {
    if (shapeEdgesHeard < 3) { playEdge(shapeEdgesHeard); return true; }
    selectedShape = shapeReveal.completed;
    renderShapes();
    playShape(shapeReveal.completed, $("#chordMain"));
  } else if (pageIndex === 4) {
    const button = $(`[data-flow="${processReveal.completed}"]`);
    if (button) playProgression(processReveal.completed, button);
  }
  else if (pageIndex === 5) {
    const mode = harmonicReveal.done ? "classic" : "harmonic";
    const reveal = mode === "harmonic" ? harmonicReveal : classicReveal;
    keyboardMode = mode;
    renderKeyboard();
    const button = $(`#${mode}Actions [data-keyboard-chord="${reveal.completed}"]`);
    if (button) playKeyboardChord(mode, reveal.completed, button);
  } else if (pageIndex === 6) runSummaryPath();
  else if (pageIndex === 7) runCadence();
  return true;
}
function requestAdvance() {
  if (!claimInput()) return;
  performCurrentStep();
}

prevButton.addEventListener("click", () => { if (claimInput() && pageIndex > 0) navigate(pageIndex - 1); });
nextButton.addEventListener("click", requestAdvance);
$("#fullscreenButton").addEventListener("click", () => document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.());
$("#soundStopButton").addEventListener("click", () => { lastInputAt = performance.now(); cancelSound(); });
document.addEventListener("keydown", (event) => {
  if (event.defaultPrevented || event.target.closest?.("input,select,textarea")) return;
  const interactive = event.target.closest?.("button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[data-no-advance]");
  if (interactive && [" ", "Enter"].includes(event.key)) return;
  if (["ArrowRight", "PageDown", " "].includes(event.key)) { event.preventDefault(); requestAdvance(); }
  else if (["ArrowLeft", "PageUp"].includes(event.key)) { event.preventDefault(); if (claimInput() && pageIndex > 0) navigate(pageIndex - 1); }
  else if (event.key === "Home" && claimInput()) navigate(0);
  else if (event.key.toLowerCase() === "f") $("#fullscreenButton").click();
});

let pointerStart = null;
stage.addEventListener("pointerdown", (event) => { pointerStart = { x: event.clientX, y: event.clientY, button: event.button }; });
stage.addEventListener("click", (event) => {
  const interactive = event.target.closest?.("button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[data-no-advance]");
  if (interactive || event.button !== 0 || !pointerStart || pointerStart.button !== 0 || Math.hypot(event.clientX - pointerStart.x, event.clientY - pointerStart.y) > 6 || window.getSelection()?.toString().trim()) return;
  requestAdvance();
});
stage.addEventListener("contextmenu", (event) => {
  if (event.target.closest?.("button,a,input,select,textarea,label,summary,[role='button'],[role='tab'],[data-no-advance]")) return;
  event.preventDefault();
  if (claimInput() && pageIndex > 0) navigate(pageIndex - 1);
});
window.addEventListener("hashchange", () => {
  const target = slides.findIndex((slide) => slide.id === location.hash.slice(1));
  if (target >= 0 && target <= maxUnlockedPage) navigate(target, { hash: false });
  else setHash();
});
window.addEventListener("blur", cancelSound);
window.addEventListener("pagehide", cancelSound);
document.addEventListener("visibilitychange", () => { if (document.hidden) cancelSound(); });

renderClosing();
navigate(0);
window.KaraokeDeck = Object.freeze({
  stop: cancelSound,
  pageCount: slides.length,
  currentPage: () => slides[pageIndex].id,
  currentStep: () => ({ choirStep, process: processReveal.completed, tonnetzStep, shape: shapeReveal.completed, harmonic: harmonicReveal.completed, classic: classicReveal.completed })
});
