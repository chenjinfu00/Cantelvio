(() => {
  "use strict";

  const i18n = window.TonnetzI18n;
  const t = (key, values) => i18n?.t(key, values) || key;
  i18n?.applyDOM(document);

  const DEFAULT_ROWS = 8;
  const DEFAULT_COLUMNS = 13;
  const MIN_ROWS = 4;
  const MAX_ROWS = 10;
  const MIN_COLUMNS = 7;
  const MAX_COLUMNS = 55;
  const MIN_KEY_SCALE = 0.7;
  const MAX_KEY_SCALE = 1.4;
  const KEY_SCALE_STEP = 0.1;
  const DEFAULT_OVERVIEW_HEIGHT = 72;
  const MIN_OVERVIEW_HEIGHT = 28;
  const MAX_OVERVIEW_HEIGHT = 120;
  const OVERVIEW_HEIGHT_STEP = 4;
  const DEFAULT_OVERVIEW_WIDTH_SCALE = 1;
  const MIN_OVERVIEW_WIDTH_SCALE = 0.7;
  const MAX_OVERVIEW_WIDTH_SCALE = 1.4;
  const OVERVIEW_WIDTH_STEP = 0.1;
  const GRID_U = { x: 0.9606, y: -0.2781 };
  const GRID_V = { x: -0.2398, y: 0.9708 };
  const KEY_HEIGHT_UNITS = 1.1547;
  // Rotated hexagons extend beyond their unrotated box; this keeps their tips visible.
  const BOARD_PADDING_UNITS = 0.52;
  const MAX_VOICES = 16;
  const MAX_AUXILIARY_VOICES = 48;
  const MIN_OCTAVE = -3;
  const MAX_OCTAVE = 3;
  const MAX_SAMPLE_BANKS = 10;
  const NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const SCALE_CLASSES = new Set([0, 2, 4, 5, 7, 9, 11]);
  const ACTIVE_COLORS = [
    "#ffc65a", "#b18cff", "#62e5df", "#79d6ff", "#8ae6b3", "#79d6ff",
    "#c994ff", "#62e5df", "#ff91b4", "#8ae6b3", "#ff9c7b", "#79d6ff"
  ];
  const KEY_SKINS = new Set(["tonnetz", "piano", "wood"]);

  const LAYOUTS = {
    classic: {
      nameKey: "layout.classic",
      hintKey: "layout.classicHint",
      centerMidi: 60,
      columnStep: 2,
      rowStep: 1
    },
    melodic: {
      nameKey: "layout.melodic",
      hintKey: "layout.melodicHint",
      centerMidi: 60,
      columnStep: 2,
      rowStep: 7
    },
    harmonic: {
      nameKey: "layout.harmonic",
      hintKey: "layout.harmonicHint",
      centerMidi: 60,
      columnStep: 4,
      rowStep: 7
    }
  };

  const PRESETS = {
    piano: { release: 0.72, wet: 0.22 },
    "synth-lead": { release: .14, wet: .12 },
    "reed-lead": { release: .10, wet: .09 },
    "electric-guitar": { release: 0.095, wet: 0.065 },
    "electric-bass": { release: 0.13, wet: 0.025 },
    "synth-bass": { release: 0.16, wet: 0.035 },
    concert: { release: 0.65, wet: 0.26 },
    epiano: { release: 1.15, wet: 0.3 },
    bell: { release: 1.9, wet: 0.48 },
    organ: { release: 0.32, wet: 0.18 },
    pluck: { release: 0.5, wet: 0.34 },
    pad: { release: 2.8, wet: 0.42 },
    "sample-piano": { release: 0.7, wet: 0.22 },
    strings: { release: 1.25, wet: 0.34 },
    winds: { release: 0.72, wet: 0.3 },
    violin: { release: 0.8, wet: 0.3 },
    viola: { release: 0.86, wet: 0.31 },
    cello: { release: 0.9, wet: 0.32 },
    contrabass: { release: 0.86, wet: 0.27 },
    harp: { release: 1.25, wet: 0.38 },
    flute: { release: 0.6, wet: 0.3 },
    oboe: { release: 0.55, wet: 0.28 },
    clarinet: { release: 0.58, wet: 0.27 },
    bassoon: { release: 0.62, wet: 0.26 },
    horn: { release: 0.72, wet: 0.34 },
    trumpet: { release: 0.52, wet: 0.27 },
    trombone: { release: 0.58, wet: 0.29 },
    tuba: { release: 0.68, wet: 0.25 },
    timpani: { release: 1.3, wet: 0.42 },
    sine: { release: 0.08, wet: 0 }
  };

  const LOCAL_PIANO_SAMPLES = Array.from({ length: 17 }, (_, index) => {
    const midi = 36 + index * 3;
    const name = ["C", "Ds", "Fs", "A"][(midi % 12) / 3];
    return { midi, file: `${name}${Math.floor(midi / 12) - 1}.mp3` };
  });

  const LOCAL_BASS_SAMPLES = [[28,"E1"],[31,"G1"],[34,"As1"],[37,"Cs2"],[40,"E2"],[43,"G2"],[46,"As2"],[49,"Cs3"],[52,"E3"]].map(([midi,name]) => ({midi,file:`${name}.mp3`}));

  const LOCAL_GUITAR_SAMPLES = [[54,"Fs3"],[57,"A3"],[60,"C4"],[63,"Ds4"],[66,"Fs4"],[69,"A4"],[72,"C5"],[75,"Ds5"],[78,"Fs5"]].map(([midi,name]) => ({midi,file:`${name}.mp3`}));

  const SAMPLE_INSTRUMENTS = {
    "sample-piano": "acoustic_grand_piano",
    violin: "violin",
    viola: "viola",
    cello: "cello",
    contrabass: "contrabass",
    harp: "orchestral_harp",
    piccolo: "piccolo",
    flute: "flute",
    oboe: "oboe",
    clarinet: "clarinet",
    bassoon: "bassoon",
    horn: "french_horn",
    trumpet: "trumpet",
    trombone: "trombone",
    tuba: "tuba",
    timpani: "timpani"
  };
  const SAMPLE_BASE_URL = "https://gleitz.github.io/midi-js-soundfonts/MusyngKite";

  const INSTRUMENT_STYLES = {
    violin: { nameKey: "voice.violin", short: "Vln", min: 55, max: 108, keyA: "#63353f", keyB: "#2d1c27", color: "#ff8797" },
    viola: { nameKey: "voice.viola", short: "Vla", min: 48, max: 91, keyA: "#543762", keyB: "#281d35", color: "#cf90f1" },
    cello: { nameKey: "voice.cello", short: "Vc", min: 36, max: 79, keyA: "#654427", keyB: "#302218", color: "#efa85c" },
    contrabass: { nameKey: "voice.contrabass", short: "Cb", min: 28, max: 67, keyA: "#55502a", keyB: "#282817", color: "#ddca62" },
    piccolo: { nameKey: "voice.piccolo", short: "Picc", min: 74, max: 108, keyA: "#265361", keyB: "#152c35", color: "#7ee9ff" },
    flute: { nameKey: "voice.flute", short: "Fl", min: 60, max: 96, keyA: "#28594f", keyB: "#153029", color: "#77e2ca" },
    oboe: { nameKey: "voice.oboe", short: "Ob", min: 58, max: 91, keyA: "#3d5c2e", keyB: "#202f1b", color: "#9ddd72" },
    clarinet: { nameKey: "voice.clarinet", short: "Cl", min: 50, max: 94, keyA: "#294d70", keyB: "#172a3d", color: "#72b8ff" },
    bassoon: { nameKey: "voice.bassoon", short: "Bsn", min: 34, max: 75, keyA: "#5a4032", keyB: "#2e241f", color: "#c99574" },
    horn: { nameKey: "voice.horn", short: "Hn", min: 41, max: 86, keyA: "#65502a", keyB: "#322918", color: "#f4cf67" },
    trumpet: { nameKey: "voice.trumpet", short: "Tpt", min: 54, max: 86, keyA: "#693f27", keyB: "#342318", color: "#ffa45f" },
    trombone: { nameKey: "voice.trombone", short: "Tbn", min: 40, max: 74, keyA: "#653329", keyB: "#331e1a", color: "#ed7658" },
    tuba: { nameKey: "voice.tuba", short: "Tba", min: 28, max: 60, keyA: "#45385d", keyB: "#261f35", color: "#ad8cdf" }
  };

  const SAMPLE_SECTIONS = {
    strings: ["contrabass", "cello", "viola", "violin"],
    winds: ["tuba", "trombone", "bassoon", "horn", "clarinet", "trumpet", "oboe", "flute", "piccolo"]
  };
  const STRING_INSTRUMENTS = new Set(SAMPLE_SECTIONS.strings);

  const keyboard = document.querySelector("#keyboard");
  const keyboardViewport = document.querySelector("#keyboardViewport");
  const playSurface = document.querySelector(".play-surface");
  const instrument = document.querySelector("#instrument");
  const noteReadout = document.querySelector("#noteReadout");
  const octaveValue = document.querySelector("#octaveValue");
  const octaveDown = document.querySelector("#octaveDown");
  const octaveUp = document.querySelector("#octaveUp");
  const mainSustainButton = document.querySelector("#mainSustainButton");
  const glissandoButton = document.querySelector("#glissandoButton");
  const performanceToggles = document.querySelector("#performanceToggles");
  const labelsButton = document.querySelector("#labelsButton");
  const startOverlay = document.querySelector("#startOverlay");
  const startButton = document.querySelector("#startButton");
  const voiceSelect = document.querySelector("#voiceSelect");
  const intervalHint = document.querySelector("#intervalHint");
  const volumeSlider = document.querySelector("#volumeSlider");
  const settingsHandle = document.querySelector("#settingsHandle");
  const settingsSheet = document.querySelector("#settingsSheet");
  const settingsBackdrop = document.querySelector("#settingsBackdrop");
  const closeSettings = document.querySelector("#closeSettings");
  const sheetGrabber = document.querySelector("#sheetGrabber");
  const columnsDown = document.querySelector("#columnsDown");
  const columnsUp = document.querySelector("#columnsUp");
  const columnsMin = document.querySelector("#columnsMin");
  const columnsMax = document.querySelector("#columnsMax");
  const columnsValue = document.querySelector("#columnsValue");
  const rowsDown = document.querySelector("#rowsDown");
  const rowsUp = document.querySelector("#rowsUp");
  const rowsValue = document.querySelector("#rowsValue");
  const keyboardOverview = document.querySelector("#keyboardOverview");
  const overviewCanvas = document.querySelector("#overviewCanvas");
  const overviewWindow = document.querySelector("#overviewWindow");
  const keyScaleDown = document.querySelector("#keyScaleDown");
  const keyScaleUp = document.querySelector("#keyScaleUp");
  const keyScaleValue = document.querySelector("#keyScaleValue");
  const overviewHeightDown = document.querySelector("#overviewHeightDown");
  const overviewHeightUp = document.querySelector("#overviewHeightUp");
  const overviewHeightValue = document.querySelector("#overviewHeightValue");
  const overviewWidthDown = document.querySelector("#overviewWidthDown");
  const overviewWidthUp = document.querySelector("#overviewWidthUp");
  const overviewWidthValue = document.querySelector("#overviewWidthValue");
  const layoutSelect = document.querySelector("#layoutSelect");
  const layoutName = document.querySelector("#layoutName");
  const skinSelect = document.querySelector("#skinSelect");
  const ensembleLegend = document.querySelector("#ensembleLegend");
  const languageSelect = document.querySelector("#languageSelect");

  let audioContext = null;
  let masterGain = null;
  let dryBus = null;
  let reverbBus = null;
  let noiseBuffer = null;
  let octaveShift = 0;
  let sustain = false;
  let glissando = readPreference("glissando", "false") === "true";
  let audioStarted = false;
  let audioGeneration = 0;
  let voiceCounter = 0;
  let settingsOpen = false;
  let edgeSwipe = null;
  let sheetSwipe = null;
  let columnCount = DEFAULT_COLUMNS;
  let rowCount = DEFAULT_ROWS;
  let panX = 0;
  let maxPanX = 0;
  let overviewDragging = false;
  let keyPositions = [];
  let boardWidthUnits = 12;
  let boardHeightUnits = 9;
  let keyScale = 1;
  let overviewHeight = DEFAULT_OVERVIEW_HEIGHT;
  let overviewWidthScale = DEFAULT_OVERVIEW_WIDTH_SCALE;
  let layoutId = "classic";
  let layout = LAYOUTS.classic;
  let keySkin = "tonnetz";
  let overviewMetrics = null;
  let overviewPanFrame = 0;
  let pendingOverviewClientX = 0;
  let overviewGrabOffset = 0;
  let overviewDragMetrics = null;
  let sampleWarmGeneration = 0;
  let hitTestMetrics = null;
  let noteMoveFrame = 0;
  let readoutFrame = 0;
  let pendingReadout = null;
  let readoutModel = { kind: "ready" };
  let overviewWindowWidth = "";

  const voices = new Map();
  const groupVoiceIds = new Map();
  const groupBuses = new Map();
  const groupVolumes = new Map([
    ["melody", 1],
    ["accompaniment", 0.62],
    ["learn", 0.7],
    ["preview", 0.7]
  ]);
  const pointerNotes = new Map();
  const sustainedVoiceIds = new Set();
  const activeKeyCounts = new Map();
  const keyElements = new Map();
  const surfacePointers = new Map();
  const sampleBanks = new Map();
  const sampleBankPromises = new Map();
  const sampleBuffers = new Map();
  const sampleBufferPromises = new Map();
  const sampleBankOrder = [];
  const localBassBuffers = new Map();
  const localBassPromises = new Map();
  let bassWarmContext = null;
  let bassSampleStarts = 0;
  let bassFallbackStarts = 0;
  const localGuitarBuffers = new Map();
  const localGuitarPromises = new Map();
  let guitarWarmContext = null;
  let guitarSampleStarts = 0;
  let guitarFallbackStarts = 0;
  const guitarDriveCurve = Float32Array.from({length:512}, (_,i) => Math.tanh((i/511*2-1)*1.6)/Math.tanh(1.6));
  const localPianoBuffers = new Map();
  const localPianoPromises = new Map();
  const keyHitBuckets = new Map();
  const pendingNoteMoves = new Map();

  const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
  const frequencyForMidi = (midi) => 440 * Math.pow(2, (midi - 69) / 12);
  const pitchClass = (midi) => ((midi % 12) + 12) % 12;
  const noteLabel = (midi) => `${NOTE_NAMES[pitchClass(midi)]}${Math.floor(midi / 12) - 1}`;

  function readPreference(key, fallback) {
    try {
      return window.localStorage.getItem(`guangge-${key}`) || fallback;
    } catch (_) {
      return fallback;
    }
  }

  function savePreference(key, value) {
    try {
      window.localStorage.setItem(`guangge-${key}`, String(value));
    } catch (_) {
      // Private browsing can disable storage; the instrument still works.
    }
  }

  const layoutLabel = (target = layout) => t(target.nameKey);
  const layoutHintLabel = (target = layout) => t(target.hintKey);
  const instrumentLabel = (type) => {
    const style = INSTRUMENT_STYLES[type];
    return style ? t(style.nameKey) : "";
  };
  const keyboardAriaLabel = () => t("aria.keyboardGrid", {
    layout: layoutLabel(),
    columns: columnCount,
    rows: rowCount
  });

  function readoutHTML() {
    if (readoutModel.kind === "poly") {
      return `<span class="note-name">${readoutModel.names}</span><span class="note-detail">${t("readout.polyphony", { count: readoutModel.count })}</span>`;
    }
    if (readoutModel.kind === "note") {
      const detail = readoutModel.voiceType
        ? `${instrumentLabel(readoutModel.voiceType)} · ${readoutModel.frequency} Hz`
        : `${readoutModel.frequency} Hz`;
      return `<span class="note-name">${readoutModel.note}</span><span class="note-detail">${detail}</span>`;
    }
    if (readoutModel.kind === "status") {
      const values = { ...readoutModel.values };
      if (values.voiceType) values.voice = t(`voice.${values.voiceType}`);
      return `<span class="note-name">${t(readoutModel.messageKey, values)}</span><span class="note-detail">${t("readout.continue")}</span>`;
    }
    return `<span class="note-name">${t("readout.touch")}</span><span class="note-detail">${t("readout.multi")}</span>`;
  }

  function renderReadout() {
    pendingReadout = null;
    noteReadout.innerHTML = readoutHTML();
  }

  function columnStartFor(col) {
    return Math.floor((2 * col + 4) / 7);
  }

  function rowRangeFor(col) {
    let firstRow = 0;
    let lastRow = rowCount - 1;
    if (col === 0) lastRow = Math.max(1, rowCount - 4);
    else if (col === 1) lastRow = Math.max(2, rowCount - 2);
    else if (col === columnCount - 2) firstRow = Math.min(1, rowCount - 2);
    else if (col === columnCount - 1) firstRow = Math.min(3, rowCount - 2);
    return [firstRow, lastRow];
  }

  function midiForPosition(row, col) {
    const latticeRow = columnStartFor(col) + row;
    const centerCol = (columnCount - 1) / 2;
    const lowCenterCol = Math.floor(centerCol);
    const highCenterCol = Math.ceil(centerCol);
    const centerStart = columnStartFor(lowCenterCol) + (columnStartFor(highCenterCol) - columnStartFor(lowCenterCol)) * (centerCol - lowCenterCol);
    const centerLatticeRow = centerStart + (rowCount - 1) / 2;
    const midi = layout.centerMidi
      + (col - centerCol) * layout.columnStep
      - (latticeRow - centerLatticeRow) * layout.rowStep
      + octaveShift * 12;
    return clamp(Math.round(midi), 0, 127);
  }

  function sampleKeyToMidi(key) {
    const match = /^([A-G])([#b]?)(-?\d+)$/.exec(key);
    if (!match) return null;
    const natural = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[match[1]];
    const accidental = match[2] === "#" ? 1 : match[2] === "b" ? -1 : 0;
    return (Number(match[3]) + 1) * 12 + natural + accidental;
  }

  function decodeDataUri(dataUri) {
    const comma = dataUri.indexOf(",");
    const binary = window.atob(dataUri.slice(comma + 1));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes.buffer;
  }

  function retainSampleBank(type) {
    const previousIndex = sampleBankOrder.indexOf(type);
    if (previousIndex >= 0) sampleBankOrder.splice(previousIndex, 1);
    sampleBankOrder.push(type);
    while (sampleBankOrder.length > MAX_SAMPLE_BANKS) {
      const expiredType = sampleBankOrder.shift();
      sampleBanks.delete(expiredType);
      [...sampleBuffers.keys()].forEach((key) => {
        if (key.startsWith(`${expiredType}:`)) sampleBuffers.delete(key);
      });
    }
  }

  async function loadSampleBank(type) {
    if (!SAMPLE_INSTRUMENTS[type]) return null;
    if (sampleBanks.has(type)) {
      retainSampleBank(type);
      return sampleBanks.get(type);
    }
    if (sampleBankPromises.has(type)) return sampleBankPromises.get(type);
    const instrumentName = SAMPLE_INSTRUMENTS[type];
    const promise = fetch(`${SAMPLE_BASE_URL}/${instrumentName}-mp3.js`, { mode: "cors", cache: "force-cache" })
      .then((response) => {
        if (!response.ok) throw new Error(`SoundFont ${response.status}`);
        return response.text();
      })
      .then((source) => {
        const assignment = source.indexOf(`MIDI.Soundfont.${instrumentName}`);
        const start = source.indexOf("{", assignment);
        const end = source.lastIndexOf("}");
        if (assignment < 0 || start < 0 || end <= start) throw new Error("Invalid SoundFont");
        const objectSource = source.slice(start, end + 1).replace(/,\s*}$/, "}");
        const raw = JSON.parse(objectSource);
        const entries = Object.entries(raw)
          .map(([key, dataUri]) => ({ key, midi: sampleKeyToMidi(key), dataUri }))
          .filter((entry) => Number.isFinite(entry.midi))
          .sort((a, b) => a.midi - b.midi);
        sampleBanks.set(type, entries);
        retainSampleBank(type);
        sampleBankPromises.delete(type);
        return entries;
      })
      .catch(() => {
        sampleBankPromises.delete(type);
        return null;
      });
    sampleBankPromises.set(type, promise);
    return promise;
  }

  function nearestSample(entries, midi) {
    if (!entries?.length) return null;
    let closest = entries[0];
    for (const entry of entries) {
      if (Math.abs(entry.midi - midi) < Math.abs(closest.midi - midi)) closest = entry;
      if (entry.midi > midi && Math.abs(entry.midi - midi) > Math.abs(closest.midi - midi)) break;
    }
    return closest;
  }

  function nearestLocalPianoSample(midi) {
    return LOCAL_PIANO_SAMPLES.reduce((best, sample) => (
      Math.abs(sample.midi - midi) < Math.abs(best.midi - midi) ? sample : best
    ));
  }

  async function prepareLocalPiano(midi) {
    if (!audioContext) return null;
    const sample = nearestLocalPianoSample(midi);
    if (localPianoBuffers.has(sample.midi)) {
      return { buffer: localPianoBuffers.get(sample.midi), sourceMidi: sample.midi };
    }
    if (localPianoPromises.has(sample.midi)) return localPianoPromises.get(sample.midi);
    const context = audioContext;
    const generation = audioGeneration;
    const abortController = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutId = 0;
    const timeout = new Promise((resolve) => {
      timeoutId = window.setTimeout(() => {
        try { abortController?.abort(); } catch (_) { /* Request may already be complete. */ }
        resolve(null);
      }, 2000);
    });
    const load = fetch(`./media/piano/${sample.file}`, {
      cache: "force-cache",
      ...(abortController ? { signal: abortController.signal } : {})
    })
      .then((response) => {
        if (!response.ok) throw new Error(`Piano sample ${response.status}`);
        return response.arrayBuffer();
      })
      .then((encoded) => context.decodeAudioData(encoded.slice(0)));
    let promise;
    promise = Promise.race([load, timeout])
      .then((buffer) => {
        if (!buffer || generation !== audioGeneration) return null;
        localPianoBuffers.set(sample.midi, buffer);
        return { buffer, sourceMidi: sample.midi };
      })
      .catch(() => {
        return null;
      })
      .finally(() => {
        if (timeoutId) window.clearTimeout(timeoutId);
        if (localPianoPromises.get(sample.midi) === promise) localPianoPromises.delete(sample.midi);
      });
    localPianoPromises.set(sample.midi, promise);
    return promise;
  }

  function getPreparedLocalPiano(midi) {
    let prepared = null;
    localPianoBuffers.forEach((buffer, sourceMidi) => {
      if (!prepared || Math.abs(sourceMidi - midi) < Math.abs(prepared.sourceMidi - midi)) {
        prepared = { buffer, sourceMidi };
      }
    });
    return prepared;
  }

  function warmLocalPiano() {
    [60, 48, 72, 36, 84].forEach((midi, index) => {
      window.setTimeout(() => prepareLocalPiano(midi), index * 100);
    });
  }

  async function prepareLocalBass(midi) {
    if (!audioContext) return null;
    const sample = nearestSample(LOCAL_BASS_SAMPLES, midi);
    if (localBassBuffers.has(sample.midi)) return {buffer:localBassBuffers.get(sample.midi),sourceMidi:sample.midi};
    if (localBassPromises.has(sample.midi)) return localBassPromises.get(sample.midi);
    const context = audioContext, generation = audioGeneration;
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutId;
    const timeout = new Promise(resolve => { timeoutId = window.setTimeout(() => { abort?.abort(); resolve(null); }, 2000); });
    const load = fetch(`./media/bass/${sample.file}`, {cache:"force-cache", ...(abort ? {signal:abort.signal} : {})})
      .then(response => { if (!response.ok) throw new Error("Bass sample unavailable"); return response.arrayBuffer(); })
      .then(data => context.decodeAudioData(data.slice(0)));
    let pending;
    pending = Promise.race([load, timeout]).then(buffer => {
      if (!buffer || generation !== audioGeneration) return null;
      localBassBuffers.set(sample.midi, buffer); return {buffer,sourceMidi:sample.midi};
    }).catch(() => null).finally(() => {
      window.clearTimeout(timeoutId);
      if (localBassPromises.get(sample.midi) === pending) localBassPromises.delete(sample.midi);
    });
    localBassPromises.set(sample.midi,pending); return pending;
  }

  function getPreparedLocalBass(midi) {
    let prepared = null;
    localBassBuffers.forEach((buffer, sourceMidi) => {
      if (Math.abs(sourceMidi-midi)<=5 && (!prepared || Math.abs(sourceMidi-midi)<Math.abs(prepared.sourceMidi-midi))) prepared={buffer,sourceMidi};
    });
    return prepared;
  }

  function warmLocalBass() {
    if (bassWarmContext === audioContext) return;
    bassWarmContext = audioContext;
    LOCAL_BASS_SAMPLES.forEach((sample,index) => window.setTimeout(() => prepareLocalBass(sample.midi),index*45));
  }

  async function prepareLocalGuitar(midi) {
    if (!audioContext) return null;
    const sample = nearestSample(LOCAL_GUITAR_SAMPLES, midi);
    if (localGuitarBuffers.has(sample.midi)) return {buffer:localGuitarBuffers.get(sample.midi),sourceMidi:sample.midi};
    if (localGuitarPromises.has(sample.midi)) return localGuitarPromises.get(sample.midi);
    const context = audioContext, generation = audioGeneration;
    const abort = typeof AbortController === "function" ? new AbortController() : null;
    let timeoutId;
    const timeout = new Promise(resolve => { timeoutId = window.setTimeout(() => { abort?.abort(); resolve(null); }, 2000); });
    const load = fetch(`./media/guitar/${sample.file}`, {cache:"force-cache", ...(abort ? {signal:abort.signal} : {})})
      .then(response => { if (!response.ok) throw new Error("Guitar sample unavailable"); return response.arrayBuffer(); })
      .then(data => context.decodeAudioData(data.slice(0)));
    let pending;
    pending = Promise.race([load, timeout]).then(buffer => {
      if (!buffer || generation !== audioGeneration) return null;
      localGuitarBuffers.set(sample.midi, buffer); return {buffer,sourceMidi:sample.midi};
    }).catch(() => null).finally(() => {
      window.clearTimeout(timeoutId);
      if (localGuitarPromises.get(sample.midi) === pending) localGuitarPromises.delete(sample.midi);
    });
    localGuitarPromises.set(sample.midi,pending); return pending;
  }

  function getPreparedLocalGuitar(midi) {
    let prepared = null;
    localGuitarBuffers.forEach((buffer, sourceMidi) => {
      if (Math.abs(sourceMidi-midi)<=5 && (!prepared || Math.abs(sourceMidi-midi)<Math.abs(prepared.sourceMidi-midi))) prepared={buffer,sourceMidi};
    });
    return prepared;
  }

  function warmLocalGuitar() {
    if (guitarWarmContext === audioContext) return;
    guitarWarmContext = audioContext;
    LOCAL_GUITAR_SAMPLES.forEach((sample,index) => window.setTimeout(() => prepareLocalGuitar(sample.midi),index*45));
  }

  async function prepareSample(type, midi) {
    if (!audioContext || !SAMPLE_INSTRUMENTS[type]) return null;
    const entries = await loadSampleBank(type);
    const entry = nearestSample(entries, midi);
    if (!entry) return null;
    const cacheKey = `${type}:${entry.key}`;
    if (sampleBuffers.has(cacheKey)) return { buffer: sampleBuffers.get(cacheKey), sourceMidi: entry.midi };
    if (sampleBufferPromises.has(cacheKey)) return sampleBufferPromises.get(cacheKey);
    const context = audioContext;
    const generation = audioGeneration;
    let promise;
    promise = context.decodeAudioData(decodeDataUri(entry.dataUri).slice(0))
      .then((buffer) => {
        if (generation !== audioGeneration) return null;
        sampleBuffers.set(cacheKey, buffer);
        return { buffer, sourceMidi: entry.midi };
      })
      .catch(() => null)
      .finally(() => {
        if (sampleBufferPromises.get(cacheKey) === promise) sampleBufferPromises.delete(cacheKey);
      });
    sampleBufferPromises.set(cacheKey, promise);
    return promise;
  }

  async function warmSampleInstrument(type) {
    if (!SAMPLE_INSTRUMENTS[type]) return;
    const entries = await loadSampleBank(type);
    if (!entries || !audioContext) return;
    [36, 48, 60, 72, 84].forEach((midi) => prepareSample(type, midi));
  }

  function warmVoiceSelection(type) {
    sampleWarmGeneration += 1;
    const generation = sampleWarmGeneration;
    if (SAMPLE_INSTRUMENTS[type]) {
      warmSampleInstrument(type);
      return;
    }
    const section = SAMPLE_SECTIONS[type];
    if (!section) return;
    section.forEach((instrumentType, index) => {
      window.setTimeout(async () => {
        if (generation !== sampleWarmGeneration || voiceSelect.value !== type) return;
        const style = INSTRUMENT_STYLES[instrumentType];
        await loadSampleBank(instrumentType);
        if (!audioContext || !style) return;
        const inset = Math.min(7, Math.max(2, Math.round((style.max - style.min) * 0.12)));
        const warmPoints = [
          style.min + inset,
          Math.round((style.min + style.max) / 2),
          style.max - inset
        ];
        warmPoints.forEach((midi) => prepareSample(instrumentType, midi));
      }, index * 260);
    });
  }

  function buildNoiseBuffer(context) {
    const length = Math.floor(context.sampleRate * 0.09);
    const buffer = context.createBuffer(1, length, context.sampleRate);
    const data = buffer.getChannelData(0);
    let last = 0;
    for (let index = 0; index < length; index += 1) {
      const white = Math.random() * 2 - 1;
      last = last * 0.72 + white * 0.28;
      data[index] = last;
    }
    return buffer;
  }

  function buildReverbImpulse(context) {
    const duration = 1.15;
    const length = Math.floor(context.sampleRate * duration);
    const impulse = context.createBuffer(2, length, context.sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const data = impulse.getChannelData(channel);
      for (let index = 0; index < length; index += 1) {
        const time = index / context.sampleRate;
        const decay = Math.pow(1 - time / duration, 2.6);
        const early = time < 0.075 ? Math.sin(time * 760 + channel * 0.9) * 0.16 : 0;
        data[index] = ((Math.random() * 2 - 1) * 0.72 + early) * decay;
      }
    }
    return impulse;
  }

  function normalizedGroup(group) {
    return typeof group === "string" && group.trim() ? group.trim() : "accompaniment";
  }

  function groupVoiceSet(group) {
    const id = normalizedGroup(group);
    if (!groupVoiceIds.has(id)) groupVoiceIds.set(id, new Set());
    return groupVoiceIds.get(id);
  }

  function getGroupBus(group) {
    const id = normalizedGroup(group);
    if (groupBuses.has(id)) return groupBuses.get(id);
    const dry = audioContext.createGain();
    const wet = audioContext.createGain();
    const value = clamp(groupVolumes.get(id) ?? 1, 0, 1);
    dry.gain.value = value;
    wet.gain.value = value;
    dry.connect(dryBus);
    wet.connect(reverbBus);
    const bus = { dry, wet };
    groupBuses.set(id, bus);
    return bus;
  }

  function dispatchAudioEvent(type, detail = {}) {
    try {
      window.dispatchEvent(new CustomEvent(type, { detail }));
    } catch (_) {
      // Older WebKit may not construct CustomEvent in all embedded contexts.
    }
  }

  function discardClosedAudioGraph() {
    voices.forEach((voice) => {
      if (voice.durationTimer) window.clearTimeout(voice.durationTimer);
      voice.sources.forEach((source) => {
        try { source.stop(); } catch (_) { /* Closed contexts may reject stop. */ }
      });
      voice.nodes.forEach((node) => {
        try { node.disconnect(); } catch (_) { /* Closed graph is already inert. */ }
      });
    });
    pointerNotes.forEach((active) => setKeyActive(active.keyId, false));
    pointerNotes.clear();
    voices.clear();
    groupVoiceIds.clear();
    sustainedVoiceIds.clear();
    groupBuses.forEach(({ dry, wet }) => {
      try { dry.disconnect(); } catch (_) { /* Closed graph. */ }
      try { wet.disconnect(); } catch (_) { /* Closed graph. */ }
    });
    groupBuses.clear();
    localPianoPromises.clear();
    localBassPromises.clear();
    bassWarmContext = null;
    localGuitarPromises.clear();
    guitarWarmContext = null;
    sampleBufferPromises.clear();
    audioContext = null;
    masterGain = null;
    dryBus = null;
    reverbBus = null;
    noiseBuffer = null;
  }

  function initAudio() {
    const rebuildingClosedContext = audioContext?.state === "closed";
    if (rebuildingClosedContext) discardClosedAudioGraph();
    const firstStart = !audioStarted || rebuildingClosedContext;
    if (!audioContext) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      try {
        audioContext = new AudioContextClass({ latencyHint: "interactive" });
      } catch (_) {
        audioContext = new AudioContextClass();
      }
      audioGeneration += 1;

      masterGain = audioContext.createGain();
      dryBus = audioContext.createGain();
      reverbBus = audioContext.createGain();
      const convolver = audioContext.createConvolver();
      const reverbReturn = audioContext.createGain();
      const compressor = audioContext.createDynamicsCompressor();

      noiseBuffer = buildNoiseBuffer(audioContext);
      convolver.buffer = buildReverbImpulse(audioContext);
      dryBus.gain.value = 0.92;
      reverbBus.gain.value = 0.78;
      reverbReturn.gain.value = 0.32;
      masterGain.gain.value = Math.pow(Number(volumeSlider.value) / 100, 1.7) * 0.52;

      compressor.threshold.value = -16;
      compressor.knee.value = 20;
      compressor.ratio.value = 5.5;
      compressor.attack.value = 0.004;
      compressor.release.value = 0.2;

      dryBus.connect(masterGain);
      reverbBus.connect(convolver);
      convolver.connect(reverbReturn);
      reverbReturn.connect(masterGain);
      masterGain.connect(compressor);
      compressor.connect(audioContext.destination);

      audioContext.addEventListener?.("statechange", () => {
        dispatchAudioEvent("tonnetz:audio-state", { state: audioContext.state });
        if (audioContext.state !== "running") panic();
      });
    }

    audioStarted = true;
    startOverlay.classList.add("is-hidden");
    if (firstStart) warmVoiceSelection(voiceSelect.value);
    return audioContext;
  }

  async function ensureAudioReady() {
    let context;
    try {
      try {
        if (navigator.audioSession && navigator.audioSession.type !== "playback") {
          navigator.audioSession.type = "playback";
        }
      } catch (_) { /* Some WebKit builds expose a read-only audioSession. */ }
      context = initAudio();
      if (context.state !== "running") await context.resume();
      warmLocalPiano();
      warmLocalBass();
      return context.state === "running";
    } catch (_) {
      return false;
    }
  }

  function makeVoice(midi, type, group, when) {
    const now = Number.isFinite(when) ? Math.max(audioContext.currentTime, when) : audioContext.currentTime;
    const preset = PRESETS[type] || PRESETS.concert;
    const output = audioContext.createGain();
    const wet = audioContext.createGain();
    const groupBus = getGroupBus(group);
    const id = ++voiceCounter;

    output.gain.setValueAtTime(1, now);
    wet.gain.value = preset.wet;
    output.connect(groupBus.dry);
    output.connect(wet);
    wet.connect(groupBus.wet);

    return {
      id,
      midi,
      type,
      group,
      output,
      wet,
      release: preset.release,
      startedAt: now,
      sources: [],
      nodes: [output, wet],
      durationTimer: 0
    };
  }

  function addOscillator(voice, target, frequency, options = {}) {
    const now = voice.startedAt;
    const oscillator = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const attack = options.attack ?? 0.004;
    const peak = Math.max(0.0002, options.level ?? 0.2);
    const decay = options.decay ?? 1;
    const sustainLevel = options.sustain;
    let stopAt = null;

    oscillator.type = options.type || "sine";
    oscillator.frequency.setValueAtTime(frequency, now);
    oscillator.detune.value = options.detune || 0;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(peak, now + attack);

    if (sustainLevel === undefined) {
      gain.gain.exponentialRampToValueAtTime(0.0001, now + attack + decay);
      stopAt = now + attack + decay + 0.12;
    } else {
      gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak * sustainLevel), now + attack + decay);
    }

    oscillator.connect(gain);
    gain.connect(target);
    oscillator.start(now);
    if (stopAt !== null) oscillator.stop(stopAt);
    voice.sources.push(oscillator);
    voice.nodes.push(oscillator, gain);
    return oscillator;
  }

  function addNoiseStrike(voice, target, frequency, level, duration = 0.055) {
    const now = voice.startedAt;
    const source = audioContext.createBufferSource();
    const filter = audioContext.createBiquadFilter();
    const gain = audioContext.createGain();

    source.buffer = noiseBuffer;
    filter.type = "bandpass";
    filter.frequency.value = clamp(frequency, 650, 6200);
    filter.Q.value = 0.85;
    gain.gain.setValueAtTime(Math.max(0.0002, level), now);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + duration);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(target);
    source.start(now);
    source.stop(now + Math.min(duration + 0.04, noiseBuffer.duration));
    voice.sources.push(source);
    voice.nodes.push(source, filter, gain);
  }

  function addFmPair(voice, target, frequency, velocity, detune = 0) {
    const now = voice.startedAt;
    const carrier = audioContext.createOscillator();
    const modulator = audioContext.createOscillator();
    const modulation = audioContext.createGain();
    const amp = audioContext.createGain();
    const brightness = clamp(frequency * (1.45 + velocity * 2.2), 90, 1650);

    carrier.type = "sine";
    carrier.frequency.value = frequency;
    carrier.detune.value = detune;
    modulator.type = "sine";
    modulator.frequency.value = frequency * 2.002;
    modulation.gain.setValueAtTime(brightness, now);
    modulation.gain.exponentialRampToValueAtTime(Math.max(8, brightness * 0.08), now + 1.5);
    amp.gain.setValueAtTime(0.0001, now);
    amp.gain.exponentialRampToValueAtTime(0.42 * velocity, now + 0.006);
    amp.gain.exponentialRampToValueAtTime(0.11 * velocity, now + 1.45);
    amp.gain.exponentialRampToValueAtTime(0.0001, now + 7.2);

    modulator.connect(modulation);
    modulation.connect(carrier.frequency);
    carrier.connect(amp);
    amp.connect(target);
    carrier.start(now);
    modulator.start(now);
    carrier.stop(now + 7.35);
    modulator.stop(now + 7.35);
    voice.sources.push(carrier, modulator);
    voice.nodes.push(carrier, modulator, modulation, amp);
  }

  function buildConcertPiano(voice, midi, velocity) {
    const now = voice.startedAt;
    const frequency = frequencyForMidi(midi);
    const filter = audioContext.createBiquadFilter();
    const decayScale = clamp(1.32 - (midi - 36) / 115, 0.58, 1.36);
    const brightness = clamp(3100 + velocity * 6100 - Math.max(0, midi - 72) * 42, 2500, 9800);
    const partials = [
      [1, 0.47, 5.8, "triangle"],
      [2.002, 0.21, 3.15, "sine"],
      [3.008, 0.11, 2.05, "sine"]
    ];

    filter.type = "lowpass";
    filter.Q.value = 0.42;
    filter.frequency.setValueAtTime(brightness, now);
    filter.frequency.exponentialRampToValueAtTime(Math.max(1700, brightness * 0.38), now + 2.4);
    filter.connect(voice.output);
    voice.nodes.push(filter);

    partials.forEach(([ratio, level, decay, type], index) => {
      addOscillator(voice, filter, frequency * ratio, {
        type,
        level: level * Math.pow(velocity, 0.82),
        attack: 0.0025 + index * 0.00035,
        decay: decay * decayScale,
        detune: index === 0 ? -0.7 : index * 0.18
      });
    });

  }

  function buildElectricPiano(voice, midi, velocity) {
    const now = voice.startedAt;
    const frequency = frequencyForMidi(midi);
    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(clamp(3400 + velocity * 4800, 3000, 8200), now);
    filter.Q.value = 0.55;
    filter.connect(voice.output);
    voice.nodes.push(filter);

    addFmPair(voice, filter, frequency, velocity, -1.6);
    addOscillator(voice, filter, frequency * 2.006, {
      type: "sine",
      level: 0.105 * velocity,
      attack: 0.003,
      decay: 1.35,
      detune: 2.2
    });
    addOscillator(voice, filter, frequency * 0.5, {
      type: "sine",
      level: 0.065 * velocity,
      attack: 0.012,
      decay: 4.8
    });
    addNoiseStrike(voice, filter, frequency * 7, 0.026 * velocity, 0.026);
  }

  function buildBell(voice, midi, velocity) {
    const frequency = frequencyForMidi(midi);
    const partials = [
      [1, 0.45, 5.8],
      [2.012, 0.24, 4.25],
      [2.997, 0.1, 3.15],
      [4.163, 0.075, 2.5]
    ];
    partials.forEach(([ratio, level, decay], index) => {
      addOscillator(voice, voice.output, frequency * ratio, {
        type: "sine",
        level: level * velocity,
        attack: 0.0015 + index * 0.0003,
        decay,
        detune: index % 2 ? 1.2 : -0.7
      });
    });
    addNoiseStrike(voice, voice.output, frequency * 8, 0.025 * velocity, 0.021);
  }

  function buildPluck(voice, midi, velocity) {
    const frequency = frequencyForMidi(midi);
    addOscillator(voice, voice.output, frequency, {
      type: "triangle", level: 0.38 * velocity, attack: 0.002, decay: 1.45
    });
    addOscillator(voice, voice.output, frequency * 2.003, {
      type: "sine", level: 0.14 * velocity, attack: 0.0015, decay: 0.72
    });
    addOscillator(voice, voice.output, frequency * 3.008, {
      type: "sine", level: 0.055 * velocity, attack: 0.001, decay: 0.34
    });
    addNoiseStrike(voice, voice.output, frequency * 6, 0.018 * velocity, 0.018);
  }

  function buildOrgan(voice, midi, velocity) {
    const frequency = frequencyForMidi(midi);
    const drawbars = [
      [0.5, 0.11], [1, 0.36], [2, 0.19], [3, 0.105],
      [4, 0.075]
    ];
    const vibrato = audioContext.createOscillator();
    const vibratoDepth = audioContext.createGain();
    vibrato.type = "sine";
    vibrato.frequency.value = 5.35;
    vibratoDepth.gain.value = 4.2;
    vibrato.connect(vibratoDepth);

    drawbars.forEach(([ratio, level]) => {
      const oscillator = addOscillator(voice, voice.output, frequency * ratio, {
        type: "sine",
        level: level * (0.72 + velocity * 0.28),
        attack: 0.026,
        decay: 0.16,
        sustain: 0.88
      });
      vibratoDepth.connect(oscillator.detune);
    });
    vibrato.start(audioContext.currentTime);
    voice.sources.push(vibrato);
    voice.nodes.push(vibrato, vibratoDepth);
  }

  function buildPad(voice, midi, velocity) {
    const now = voice.startedAt;
    const frequency = frequencyForMidi(midi);
    const filter = audioContext.createBiquadFilter();
    const filterLfo = audioContext.createOscillator();
    const filterDepth = audioContext.createGain();

    filter.type = "lowpass";
    filter.frequency.value = clamp(1250 + velocity * 1350, 1250, 2800);
    filter.Q.value = 0.72;
    filter.connect(voice.output);
    filterLfo.type = "sine";
    filterLfo.frequency.value = 0.17;
    filterDepth.gain.value = 430;
    filterLfo.connect(filterDepth);
    filterDepth.connect(filter.frequency);

    addOscillator(voice, filter, frequency, {
      type: "sawtooth", level: 0.12 * velocity, attack: 0.42, decay: 0.9, sustain: 0.82, detune: -9
    });
    addOscillator(voice, filter, frequency, {
      type: "sawtooth", level: 0.12 * velocity, attack: 0.46, decay: 0.9, sustain: 0.82, detune: 9
    });
    addOscillator(voice, filter, frequency, {
      type: "triangle", level: 0.22 * velocity, attack: 0.34, decay: 0.8, sustain: 0.88
    });
    filterLfo.start(now);
    voice.sources.push(filterLfo);
    voice.nodes.push(filter, filterLfo, filterDepth);
  }

  function buildSine(voice, midi, velocity) {
    addOscillator(voice, voice.output, frequencyForMidi(midi), {
      type: "sine",
      level: 0.28 * velocity,
      attack: 0.008,
      decay: 0.08,
      sustain: 0.92
    });
  }

  function getPreparedSample(type, midi) {
    const entries = sampleBanks.get(type);
    if (!entries?.length) return null;
    let prepared = null;
    entries.forEach((entry) => {
      const buffer = sampleBuffers.get(`${type}:${entry.key}`);
      if (!buffer) return;
      if (!prepared || Math.abs(entry.midi - midi) < Math.abs(prepared.sourceMidi - midi)) {
        prepared = { buffer, sourceMidi: entry.midi };
      }
    });
    return prepared;
  }

  function buildSampleVoice(voice, midi, velocity, prepared) {
    const now = voice.startedAt;
    const source = audioContext.createBufferSource();
    const gain = audioContext.createGain();
    const filter = audioContext.createBiquadFilter();
    source.buffer = prepared.buffer;
    source.playbackRate.value = Math.pow(2, (midi - prepared.sourceMidi) / 12);
    filter.type = "lowpass";
    filter.frequency.value = clamp(5400 + velocity * 6200, 6200, 11800);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.66 * Math.pow(velocity, 0.82), now + 0.006);
    source.connect(filter);
    filter.connect(gain);
    gain.connect(voice.output);
    source.start(now);
    voice.sources.push(source);
    voice.nodes.push(source, filter, gain);
  }

  function buildBassVoice(voice, midi, velocity, prepared) {
    const now = voice.startedAt;
    const filter = audioContext.createBiquadFilter();
    filter.type = "lowpass"; filter.frequency.value = 900+velocity*2500; filter.Q.value=.55;
    filter.connect(voice.output); voice.nodes.push(filter);
    if (prepared) {
      const source=audioContext.createBufferSource(),amp=audioContext.createGain();
      source.buffer=prepared.buffer; source.playbackRate.value=Math.pow(2,(midi-prepared.sourceMidi)/12);
      amp.gain.setValueAtTime(.0001,now);amp.gain.exponentialRampToValueAtTime(.72*Math.pow(velocity,.9),now+.006);
      source.connect(amp);amp.connect(filter);source.start(now);
      voice.sources.push(source);voice.nodes.push(source,amp);bassSampleStarts+=1;
    } else {
      const frequency=frequencyForMidi(midi);
      addOscillator(voice,filter,frequency,{type:"triangle",level:.29*velocity,attack:.006,decay:.22,sustain:.48});
      addOscillator(voice,filter,frequency,{type:"sine",level:.36*velocity,attack:.005,decay:.34,sustain:.46});
      addOscillator(voice,filter,frequency*2,{type:"sine",level:.085*velocity,attack:.003,decay:.16});
      bassFallbackStarts+=1;
    }
  }

  function buildLeadVoice(voice, midi, velocity, reed = false) {
    const filter=audioContext.createBiquadFilter();
    filter.type="lowpass"; filter.frequency.value=(reed?1700:2400)+velocity*1600; filter.Q.value=.65;
    filter.connect(voice.output);voice.nodes.push(filter);
    const frequency=frequencyForMidi(midi);
    addOscillator(voice,filter,frequency,{type:"triangle",level:.25*velocity,attack:.018,decay:.18,sustain:.72});
    addOscillator(voice,filter,frequency*(reed?3:2),{type:"sine",level:(reed?.09:.065)*velocity,attack:.025,decay:.2,sustain:.55});
    addOscillator(voice,filter,frequency*.999,{type:"sine",level:.13*velocity,attack:.02,decay:.22,sustain:.65});
  }

  function buildGuitarVoice(voice, midi, velocity, prepared) {
    if (!prepared) { buildPluck(voice,midi,velocity*.75); guitarFallbackStarts+=1; return; }
    const now=voice.startedAt, source=audioContext.createBufferSource(), gain=audioContext.createGain();
    const drive=audioContext.createWaveShaper(), filter=audioContext.createBiquadFilter();
    source.buffer=prepared.buffer;
    source.playbackRate.value=Math.pow(2,(midi-prepared.sourceMidi)/12);
    drive.curve=guitarDriveCurve; drive.oversample="2x";
    filter.type="lowpass"; filter.frequency.value=2800+velocity*3500; filter.Q.value=.65;
    gain.gain.setValueAtTime(.0001,now);
    gain.gain.exponentialRampToValueAtTime(.46*Math.pow(velocity,.85),now+.004);
    source.connect(drive);drive.connect(filter);filter.connect(gain);gain.connect(voice.output);
    source.start(now);voice.sources.push(source);voice.nodes.push(source,drive,filter,gain);guitarSampleStarts+=1;
  }

  function buildSampleFallback(voice, midi, velocity, type) {
    if (type === "sample-piano" || type === "harp" || type === "timpani") {
      buildConcertPiano(voice, midi, velocity * 0.88);
    } else if (type === "strings" || STRING_INSTRUMENTS.has(type)) {
      buildPad(voice, midi, velocity * 0.86);
    } else {
      const frequency = frequencyForMidi(midi);
      const filter = audioContext.createBiquadFilter();
      filter.type = "lowpass";
      filter.frequency.value = type === "trumpet" || type === "trombone" ? 3600 : 2700;
      filter.Q.value = 0.7;
      filter.connect(voice.output);
      voice.nodes.push(filter);
      addOscillator(voice, filter, frequency, {
        type: "triangle", level: 0.28 * velocity, attack: 0.035, decay: 0.18, sustain: 0.78
      });
      addOscillator(voice, filter, frequency * 2.001, {
        type: "sine", level: 0.075 * velocity, attack: 0.04, decay: 0.22, sustain: 0.58
      });
    }
  }

  function startVoice(midi, velocity = 0.82, requestedType = null, requestedGroup = "melody", duration = null, when = null) {
    const group = normalizedGroup(requestedGroup);
    initAudio();
    if (group === "melody" && audioContext.state !== "running") {
      audioContext.resume().catch(() => {});
    }
    const groupVoices = groupVoiceSet(group);
    const limit = group === "melody" ? MAX_VOICES : MAX_AUXILIARY_VOICES;
    while (groupVoices.size >= limit) {
      const oldestVoiceId = groupVoices.values().next().value;
      stopVoice(oldestVoiceId, true);
    }

    const type = requestedType || voiceSelect.value;
    const voice = makeVoice(midi, type, group, when);
    voices.set(voice.id, voice);
    groupVoices.add(voice.id);

    if (Number.isFinite(duration) && duration > 0) {
      voice.durationTimer = window.setTimeout(() => stopVoice(voice.id), (duration + Math.max(0,voice.startedAt-audioContext.currentTime)) * 1000);
    }

    if (type === "synth-lead" || type === "reed-lead") { buildLeadVoice(voice,midi,velocity,type === "reed-lead"); return voice.id; }

    if (type === "electric-guitar") {
      buildGuitarVoice(voice,midi,velocity,getPreparedLocalGuitar(midi));
      warmLocalGuitar(); void prepareLocalGuitar(midi);
      return voice.id;
    }

    if (type === "electric-bass" || type === "synth-bass") {
      const prepared = type === "electric-bass" ? getPreparedLocalBass(midi) : null;
      buildBassVoice(voice,midi,velocity,prepared);
      if (type === "electric-bass") void prepareLocalBass(midi);
      return voice.id;
    }

    if (type === "piano") {
      const prepared = getPreparedLocalPiano(midi);
      if (prepared) buildSampleVoice(voice, midi, velocity, prepared);
      else {
        buildConcertPiano(voice, midi, velocity);
      }
      prepareLocalPiano(midi);
      return voice.id;
    }

    if (SAMPLE_INSTRUMENTS[type]) {
      const prepared = getPreparedSample(type, midi);
      if (prepared) buildSampleVoice(voice, midi, velocity, prepared);
      else { buildSampleFallback(voice, midi, velocity, type); void prepareSample(type,midi).catch(()=>null); }
      return voice.id;
    }

    switch (type) {
      case "epiano": buildElectricPiano(voice, midi, velocity); break;
      case "bell": buildBell(voice, midi, velocity); break;
      case "organ": buildOrgan(voice, midi, velocity); break;
      case "pluck": buildPluck(voice, midi, velocity); break;
      case "pad": buildPad(voice, midi, velocity); break;
      case "sine": buildSine(voice, midi, velocity); break;
      default: buildConcertPiano(voice, midi, velocity); break;
    }
    return voice.id;
  }

  function stopVoice(id, immediate = false) {
    const voice = voices.get(id);
    if (!voice || !audioContext) return;
    voices.delete(id);
    groupVoiceIds.get(voice.group)?.delete(id);
    sustainedVoiceIds.delete(id);
    if (voice.durationTimer) window.clearTimeout(voice.durationTimer);

    const now = audioContext.currentTime;
    if (voice.startedAt > now) {
      voice.output.gain.cancelScheduledValues(now);
      voice.output.gain.setValueAtTime(0, now);
      voice.sources.forEach(source => { try { source.stop(now); } catch (_) {} });
      voice.nodes.forEach(node => { try { node.disconnect(); } catch (_) {} });
      return;
    }
    const release = immediate ? 0.035 : voice.release;
    voice.output.gain.cancelScheduledValues(now);
    voice.output.gain.setTargetAtTime(0.0001, now, Math.max(0.008, release / 5));

    window.setTimeout(() => {
      voice.sources.forEach((source) => {
        try { source.stop(); } catch (_) { /* The source may have ended naturally. */ }
      });
      voice.nodes.forEach((node) => {
        try { node.disconnect(); } catch (_) { /* Already disconnected. */ }
      });
    }, (release + 0.22) * 1000);
  }

  function releaseOrSustainVoice(id) {
    if (sustain && voices.has(id)) sustainedVoiceIds.add(id);
    else stopVoice(id);
  }

  function releaseSustainedVoices() {
    [...sustainedVoiceIds].forEach((id) => stopVoice(id));
    sustainedVoiceIds.clear();
  }

  function setKeyActive(keyId, active) {
    const key = keyElements.get(keyId);
    if (!key) return;
    const current = activeKeyCounts.get(keyId) || 0;
    const next = active ? current + 1 : Math.max(0, current - 1);
    activeKeyCounts.set(keyId, next);
    key.classList.toggle("is-active", next > 0);
  }

  function showReadout(midi, voiceType = null) {
    if (!settingsOpen) return;
    const activeNotes = [...pointerNotes.values()].map((item) => item.midi).concat(midi);
    const uniqueNotes = [...new Set(activeNotes)].sort((a, b) => a - b);
    if (uniqueNotes.length > 1) {
      const names = uniqueNotes.map(noteLabel).join(" · ");
      readoutModel = { kind: "poly", names, count: uniqueNotes.length };
    } else {
      readoutModel = { kind: "note", note: noteLabel(midi), voiceType, frequency: frequencyForMidi(midi).toFixed(1) };
    }
    pendingReadout = readoutHTML();
    if (readoutFrame) return;
    readoutFrame = requestAnimationFrame(() => {
      readoutFrame = 0;
      if (pendingReadout) noteReadout.innerHTML = pendingReadout;
      pendingReadout = null;
    });
  }

  function keyFromPoint(x, y) {
    if (!hitTestMetrics) return null;
    const boardLeft = hitTestMetrics.viewportLeft + hitTestMetrics.viewportWidth / 2 - hitTestMetrics.boardWidth / 2 + panX;
    const boardTop = hitTestMetrics.viewportTop + hitTestMetrics.viewportHeight / 2 - hitTestMetrics.boardHeight / 2;
    const unitX = (x - boardLeft) / hitTestMetrics.keySize;
    const unitY = (y - boardTop) / hitTestMetrics.keySize;
    const bucketX = Math.floor(unitX);
    const bucketY = Math.floor(unitY);
    let closest = null;
    let closestDistance = Infinity;
    for (let offsetX = -1; offsetX <= 1; offsetX += 1) {
      for (let offsetY = -1; offsetY <= 1; offsetY += 1) {
        const candidates = keyHitBuckets.get(`${bucketX + offsetX}:${bucketY + offsetY}`) || [];
        candidates.forEach((candidate) => {
          const deltaX = unitX - candidate.centerX;
          const deltaY = unitY - candidate.centerY;
          const distance = deltaX * deltaX + deltaY * deltaY;
          if (distance < closestDistance) {
            closest = candidate;
            closestDistance = distance;
          }
        });
      }
    }
    return closest && closestDistance <= 0.62 ? keyElements.get(closest.keyId) : null;
  }

  function buildKeyHitIndex() {
    keyHitBuckets.clear();
    keyPositions.forEach((position) => {
      const candidate = {
        keyId: `${position.row}-${position.col}`,
        centerX: position.x + 0.5,
        centerY: position.y + KEY_HEIGHT_UNITS / 2
      };
      const bucketKey = `${Math.floor(candidate.centerX)}:${Math.floor(candidate.centerY)}`;
      const bucket = keyHitBuckets.get(bucketKey) || [];
      bucket.push(candidate);
      keyHitBuckets.set(bucketKey, bucket);
    });
  }

  function scheduleNoteMove(pointerId, x, y, pressure) {
    pendingNoteMoves.set(pointerId, { x, y, pressure });
    if (noteMoveFrame) return;
    noteMoveFrame = requestAnimationFrame(() => {
      noteMoveFrame = 0;
      const moves = [...pendingNoteMoves];
      pendingNoteMoves.clear();
      moves.forEach(([activePointerId, move]) => {
        if (!surfacePointers.has(activePointerId)) return;
        const key = keyFromPoint(move.x, move.y);
        if (key) pressKey(activePointerId, key, move.pressure);
      });
    });
  }

  function pressKey(pointerId, key, pressure = 0.5) {
    if (!key) return;
    const existing = pointerNotes.get(pointerId);
    if (existing && existing.keyId === key.dataset.keyId) return;
    if (existing) releasePointer(pointerId);

    const midi = Number(key.dataset.midi);
    const voiceType = key.dataset.voice || null;
    const velocity = clamp(0.58 + pressure * 0.38, 0.58, 0.98);
    const voiceId = startVoice(midi, velocity, voiceType);
    const keyId = key.dataset.keyId;
    showReadout(midi, voiceType);
    pointerNotes.set(pointerId, { keyId, voiceId, midi, voiceType });
    setKeyActive(keyId, true);
  }

  function releasePointer(pointerId) {
    const active = pointerNotes.get(pointerId);
    if (!active) return;
    releaseOrSustainVoice(active.voiceId);
    setKeyActive(active.keyId, false);
    pointerNotes.delete(pointerId);
  }

  function cancelPointer(pointerId) {
    const active = pointerNotes.get(pointerId);
    if (!active) return;
    stopVoice(active.voiceId, true);
    setKeyActive(active.keyId, false);
    pointerNotes.delete(pointerId);
  }

  function stopKeyboardSounds(messageKey = "status.soundStopped", values = {}) {
    if (readoutFrame) cancelAnimationFrame(readoutFrame);
    readoutFrame = 0;
    pendingReadout = null;
    pendingNoteMoves.clear();
    pointerNotes.forEach((active) => setKeyActive(active.keyId, false));
    pointerNotes.clear();
    [...(groupVoiceIds.get("melody") || [])].forEach((id) => stopVoice(id, true));
    sustainedVoiceIds.clear();
    readoutModel = { kind: "status", messageKey, values };
    renderReadout();
  }

  function stopGroup(group) {
    [...(groupVoiceIds.get(normalizedGroup(group)) || [])].forEach((id) => stopVoice(id, true));
  }

  function panic(messageKey = "status.soundStopped", values = {}) {
    stopKeyboardSounds(messageKey, values);
    [...groupVoiceIds.keys()].filter((group) => group !== "melody").forEach(stopGroup);
    dispatchAudioEvent("tonnetz:panic");
  }

  function setGroupVolume(group, value) {
    const id = normalizedGroup(group);
    const normalized = clamp(Number(value) || 0, 0, 1);
    groupVolumes.set(id, normalized);
    const bus = groupBuses.get(id);
    if (!bus || !audioContext) return;
    bus.dry.gain.setTargetAtTime(normalized, audioContext.currentTime, 0.025);
    bus.wet.gain.setTargetAtTime(normalized, audioContext.currentTime, 0.025);
  }

  function highlightChord(pitchClasses = []) {
    const selected = new Set((Array.isArray(pitchClasses) ? pitchClasses : [])
      .filter(Number.isFinite)
      .map((pc) => pitchClass(pc)));
    keyElements.forEach((key) => {
      const active = selected.has(Number(key.dataset.pitchClass));
      key.classList.toggle("is-chord-tone", active);
      if (active) key.dataset.chordTone = "true";
      else delete key.dataset.chordTone;
    });
  }

  function getDiagnostics() {
    return {
      contextState: audioContext?.state || "uninitialized",
      totalNoteStarts: voiceCounter,
      activeVoices: voices.size,
      bassSamplesReady: localBassBuffers.size, bassSampleStarts, bassFallbackStarts,
      guitarSamplesReady: localGuitarBuffers.size, guitarSampleStarts, guitarFallbackStarts,
      groups: Object.fromEntries([...groupVoiceIds].map(([group, ids]) => [group, ids.size]))
    };
  }

  window.TonnetzAudio = Object.freeze({
    ensureReady: ensureAudioReady,
    playNote(midi, options = {}) {
      const rawNote = Number(midi);
      const note = options.instrument === "sine" ? rawNote : Math.round(rawNote);
      if (!Number.isFinite(note) || note < 0 || note > 127) return null;
      const group = normalizedGroup(options.group || "accompaniment");
      if (group !== "melody" && (!audioContext || audioContext.state !== "running")) return null;
      const velocity = clamp(Number(options.velocity) || 0.82, 0.01, 1);
      const instrumentType = PRESETS[options.instrument] ? options.instrument : "concert";
      return startVoice(note, velocity, instrumentType, group, options.duration, options.when);
    },
    stopGroup,
    setGroupVolume,
    getContext: () => audioContext,
    getDiagnostics,
    panic,
    highlightChord
  });

  function comfortableInstrument(instruments, midi) {
    return instruments.reduce((best, instrumentType) => {
      const style = INSTRUMENT_STYLES[instrumentType];
      const distance = Math.abs(midi - (style.min + style.max) / 2);
      return !best || distance < best.distance ? { instrumentType, distance } : best;
    }, null)?.instrumentType || instruments[0];
  }

  function assignSectionVoices() {
    const section = SAMPLE_SECTIONS[voiceSelect.value];
    keyPositions.forEach((position) => { position.voiceType = null; });
    if (!section) return;

    const totals = new Map();
    const seen = new Map();
    keyPositions.forEach((position) => totals.set(position.midi, (totals.get(position.midi) || 0) + 1));

    keyPositions.forEach((position) => {
      let candidates = section.filter((instrumentType) => {
        const style = INSTRUMENT_STYLES[instrumentType];
        return position.midi >= style.min && position.midi <= style.max;
      });
      if (!candidates.length) {
        const distances = section.map((instrumentType) => {
          const style = INSTRUMENT_STYLES[instrumentType];
          const distance = position.midi < style.min ? style.min - position.midi : position.midi - style.max;
          return { instrumentType, distance };
        });
        const nearestDistance = Math.min(...distances.map((item) => item.distance));
        candidates = distances.filter((item) => item.distance === nearestDistance).map((item) => item.instrumentType);
      }
      const ordinal = seen.get(position.midi) || 0;
      const total = totals.get(position.midi) || 1;
      position.voiceType = total > 1
        ? candidates[ordinal % candidates.length]
        : comfortableInstrument(candidates, position.midi);
      seen.set(position.midi, ordinal + 1);
    });
  }

  function updateEnsembleLegend() {
    const section = SAMPLE_SECTIONS[voiceSelect.value];
    if (!section) {
      ensembleLegend.hidden = true;
      ensembleLegend.innerHTML = "";
      return;
    }
    const visibleSection = voiceSelect.value === "strings" ? SAMPLE_SECTIONS.strings : section;
    ensembleLegend.hidden = false;
    ensembleLegend.innerHTML = `<strong>${t(voiceSelect.value === "strings" ? "ensemble.strings" : "ensemble.winds")}</strong>${visibleSection.map((type) => {
      const style = INSTRUMENT_STYLES[type];
      return `<span><i style="--legend-color:${style.color}"></i>${t(style.nameKey)}</span>`;
    }).join("")}<small>${t("ensemble.detail")}</small>`;
  }

  function setKeySkin(nextSkin, shouldSave = true) {
    keySkin = KEY_SKINS.has(nextSkin) ? nextSkin : "tonnetz";
    keyboard.dataset.skin = keySkin;
    skinSelect.value = keySkin;
    if (shouldSave) savePreference("skin", keySkin);
    requestAnimationFrame(drawOverview);
  }

  function styleKey(key, midi, voiceType = null) {
    const pc = pitchClass(midi);
    const octave = Math.floor(midi / 12) - 1;
    const instrumentStyle = INSTRUMENT_STYLES[voiceType];
    key.dataset.midi = String(midi);
    if (voiceType) key.dataset.voice = voiceType;
    else delete key.dataset.voice;
    key.setAttribute("aria-label", instrumentStyle ? `${noteLabel(midi)} · ${t(instrumentStyle.nameKey)}` : noteLabel(midi));
    key.dataset.pitchClass = String(pc);
    key.classList.toggle("instrument-key", Boolean(instrumentStyle));
    key.classList.toggle("sharp-key", !SCALE_CLASSES.has(pc));
    key.classList.toggle("natural-key", SCALE_CLASSES.has(pc));
    key.classList.toggle("scale-key", !instrumentStyle && SCALE_CLASSES.has(pc));
    key.classList.toggle("tonic-key", !instrumentStyle && pc === 0);
    key.style.setProperty("--active-color", instrumentStyle?.color || ACTIVE_COLORS[pc]);
    if (instrumentStyle) {
      key.style.setProperty("--key-a", instrumentStyle.keyA);
      key.style.setProperty("--key-b", instrumentStyle.keyB);
      key.style.setProperty("--key-edge", instrumentStyle.color);
      key.style.setProperty("--instrument-color", instrumentStyle.color);
    } else {
      key.style.removeProperty("--key-a");
      key.style.removeProperty("--key-b");
      key.style.removeProperty("--key-edge");
      key.style.removeProperty("--instrument-color");
    }
    const voiceBadge = instrumentStyle ? `<i>${instrumentStyle.short}</i>` : "";
    key.innerHTML = `<span class="key-label"><strong>${NOTE_NAMES[pc]}</strong><small>${octave}</small>${voiceBadge}</span>`;
  }

  function refreshVoiceMapping() {
    assignSectionVoices();
    keyPositions.forEach((position) => {
      const key = keyElements.get(`${position.row}-${position.col}`);
      if (key) styleKey(key, position.midi, position.voiceType);
    });
    requestAnimationFrame(drawOverview);
  }

  function createKeyboard() {
    keyboard.innerHTML = "";
    keyElements.clear();
    const positions = [];
    for (let col = 0; col < columnCount; col += 1) {
      const [firstRow, lastRow] = rowRangeFor(col);
      for (let row = firstRow; row <= lastRow; row += 1) {
        const latticeRow = columnStartFor(col) + row;
        positions.push({
          row,
          col,
          x: col * GRID_U.x + latticeRow * GRID_V.x,
          y: col * GRID_U.y + latticeRow * GRID_V.y
        });
      }
    }

    const minX = Math.min(...positions.map((position) => position.x));
    const maxX = Math.max(...positions.map((position) => position.x));
    const minY = Math.min(...positions.map((position) => position.y));
    const maxY = Math.max(...positions.map((position) => position.y));
    boardWidthUnits = maxX - minX + 1 + BOARD_PADDING_UNITS * 2;
    boardHeightUnits = maxY - minY + KEY_HEIGHT_UNITS + BOARD_PADDING_UNITS * 2;
    keyboard.dataset.widthUnits = String(boardWidthUnits);
    keyboard.dataset.heightUnits = String(boardHeightUnits);
    keyboard.style.setProperty("--board-width-units", boardWidthUnits);
    keyboard.style.setProperty("--board-height-units", boardHeightUnits);

    keyPositions = positions.map(({ row, col, x, y }) => ({
      row,
      col,
      x: x - minX + BOARD_PADDING_UNITS,
      y: y - minY + BOARD_PADDING_UNITS,
      midi: midiForPosition(row, col)
    }));

    assignSectionVoices();
    buildKeyHitIndex();

    keyPositions.forEach(({ row, col, x, y, midi, voiceType }) => {
        const keyId = `${row}-${col}`;
        const key = document.createElement("button");
        key.type = "button";
        key.className = "hex-key";
        key.style.setProperty("--x", x);
        key.style.setProperty("--y", y);
        key.dataset.keyId = keyId;
        key.dataset.row = String(row);
        key.dataset.col = String(col);
        styleKey(key, midi, voiceType);
        keyboard.appendChild(key);
        keyElements.set(keyId, key);
    });
  }

  function currentMaxPan() {
    return maxPanX;
  }

  function setKeyboardTransform() {
    keyboard.style.transform = `translate3d(-50%, -50%, 0) translate3d(${panX}px, 0, 0)`;
  }

  function applyPan(nextPan) {
    panX = clamp(nextPan, -currentMaxPan(), currentMaxPan());
    setKeyboardTransform();
    updateOverviewWindow();
  }

  function fitKeyboard() {
    const width = playSurface.clientWidth - 12;
    const fullHeight = playSurface.clientHeight - 12;
    const heightUnits = Number(keyboard.dataset.heightUnits) || 9;
    const fullHeightKeySize = clamp((fullHeight / heightUnits) * keyScale, 52, 160);
    const needsOverview = boardWidthUnits * fullHeightKeySize > playSurface.clientWidth + 4;
    keyboardOverview.classList.toggle("is-visible", needsOverview);
    playSurface.classList.toggle("has-overview", needsOverview);
    keyboardOverview.setAttribute("aria-hidden", String(!needsOverview));

    const height = keyboardViewport.clientHeight - 12;
    if (width <= 0 || height <= 0) return;
    const byHeight = height / heightUnits;
    const keySize = clamp(byHeight * keyScale, 52, 160);
    document.documentElement.style.setProperty("--key-size", `${keySize}px`);
    maxPanX = Math.max(0, (boardWidthUnits * keySize - keyboardViewport.clientWidth) / 2);
    panX = clamp(panX, -maxPanX, maxPanX);
    setKeyboardTransform();
    const viewportRect = keyboardViewport.getBoundingClientRect();
    hitTestMetrics = {
      viewportLeft: viewportRect.left,
      viewportTop: viewportRect.top,
      viewportWidth: viewportRect.width,
      viewportHeight: viewportRect.height,
      keySize,
      boardWidth: boardWidthUnits * keySize,
      boardHeight: boardHeightUnits * keySize
    };
    requestAnimationFrame(drawOverview);
  }

  function positionPerformanceToggles() {
    const groupWidth = performanceToggles.offsetWidth;
    const safeEdge = 12;
    const overviewRect = keyboardOverview.getBoundingClientRect();
    const surfaceRect = playSurface.getBoundingClientRect();
    const overviewTopInSurface = overviewRect.top - surfaceRect.top;
    const nextLeft = Math.max(safeEdge, surfaceRect.width - groupWidth - safeEdge);
    if (!keyboardOverview.classList.contains("is-visible")) {
      performanceToggles.style.left = `${nextLeft}px`;
      performanceToggles.style.top = `${overviewTopInSurface}px`;
      return;
    }
    const groupHeight = performanceToggles.offsetHeight;
    const nextTop = overviewTopInSurface + Math.max(0, (overviewRect.height - groupHeight) / 2);
    performanceToggles.style.left = `${nextLeft}px`;
    performanceToggles.style.top = `${nextTop}px`;
  }

  function drawHex(context, x, y, radius, fill) {
    context.beginPath();
    for (let side = 0; side < 6; side += 1) {
      const angle = -Math.PI / 2 - 0.282 + side * Math.PI / 3;
      const px = x + Math.cos(angle) * radius;
      const py = y + Math.sin(angle) * radius;
      if (side === 0) context.moveTo(px, py);
      else context.lineTo(px, py);
    }
    context.closePath();
    context.fillStyle = fill;
    context.fill();
  }

  function drawOverview() {
    const keySize = parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--key-size")) || 84;
    const boardWidth = boardWidthUnits * keySize;
    const viewportWidth = keyboardViewport.clientWidth;
    if (!keyboardOverview.classList.contains("is-visible")) {
      panX = 0;
      maxPanX = 0;
      setKeyboardTransform();
      positionPerformanceToggles();
      return;
    }

    const viewportRect = keyboardViewport.getBoundingClientRect();
    const keyTops = Array.from(keyElements.values(), (key) => key.getBoundingClientRect().top);
    const firstKeyTop = keyTops.length ? Math.min(...keyTops) : viewportRect.top + overviewHeight;
    const overviewTop = Math.max(4, parseFloat(getComputedStyle(keyboardOverview).top) || 4);
    const availableBlankHeight = Math.max(0, Math.floor(firstKeyTop - playSurface.getBoundingClientRect().top - overviewTop - 6));
    const renderedOverviewHeight = Math.min(overviewHeight, availableBlankHeight);
    keyboardOverview.style.height = `${renderedOverviewHeight}px`;
    const visibleFraction = clamp(viewportWidth / boardWidth, 0, 1);
    const automaticWidthRatio = 0.29 + (1 - visibleFraction) * 0.32;
    const controlsWidth = performanceToggles.offsetWidth;
    const overviewAreaWidth = Math.max(220, viewportWidth - controlsWidth - 46);
    const renderedOverviewWidth = clamp(
      viewportWidth * automaticWidthRatio * overviewWidthScale,
      Math.min(260, overviewAreaWidth),
      Math.min(overviewAreaWidth, 520)
    );
    keyboardOverview.style.width = `${renderedOverviewWidth}px`;
    keyboardOverview.style.left = `${12 + overviewAreaWidth / 2}px`;

    const rect = keyboardOverview.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    overviewCanvas.width = Math.round(rect.width * ratio);
    overviewCanvas.height = Math.round(rect.height * ratio);
    const context = overviewCanvas.getContext("2d");
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    context.clearRect(0, 0, rect.width, rect.height);

    const pad = 4;
    const drawWidth = rect.width - pad * 2;
    const drawHeight = rect.height - pad * 2;
    const scale = Math.min(drawWidth / boardWidthUnits, drawHeight / boardHeightUnits);
    const originX = (rect.width - boardWidthUnits * scale) / 2;
    const originY = (rect.height - boardHeightUnits * scale) / 2;
    const radius = Math.max(1.5, scale * 0.48);

    keyPositions.forEach((position) => {
      const pc = pitchClass(position.midi);
      const instrumentColor = INSTRUMENT_STYLES[position.voiceType]?.color;
      drawHex(
        context,
        originX + (position.x + 0.5) * scale,
        originY + (position.y + KEY_HEIGHT_UNITS / 2) * scale,
        radius,
        instrumentColor || (pc === 0 ? "rgba(255,198,90,.72)" : SCALE_CLASSES.has(pc) ? "rgba(79,175,181,.7)" : "rgba(80,105,113,.62)")
      );
    });

    overviewMetrics = { boardWidth, viewportWidth, keySize, originX, scale };
    updateOverviewWindow();
    positionPerformanceToggles();
  }

  function updateOverviewWindow() {
    if (!overviewMetrics) return;
    const { boardWidth, viewportWidth, keySize, originX, scale } = overviewMetrics;
    const visibleLeft = clamp((boardWidth - viewportWidth) / 2 - panX, 0, boardWidth - viewportWidth);
    const viewportX = originX + (visibleLeft / keySize) * scale;
    const viewportW = (viewportWidth / keySize) * scale;
    const widthValue = `${viewportW}px`;
    if (widthValue !== overviewWindowWidth) {
      overviewWindowWidth = widthValue;
      overviewWindow.style.width = widthValue;
    }
    overviewWindow.style.transform = `translate3d(${viewportX}px, 0, 0)`;
  }

  function panFromOverview(clientX) {
    const metrics = overviewDragMetrics || (() => {
      const rect = keyboardOverview.getBoundingClientRect();
      return {
        rectLeft: rect.left,
        boardWidth: overviewMetrics?.boardWidth || boardWidthUnits * 84,
        contentLeft: overviewMetrics?.originX || 0,
        contentWidth: overviewMetrics ? boardWidthUnits * overviewMetrics.scale : rect.width
      };
    })();
    const fraction = clamp((clientX - metrics.rectLeft - metrics.contentLeft) / metrics.contentWidth, 0, 1);
    applyPan((0.5 - fraction) * metrics.boardWidth);
  }

  function scheduleOverviewPan(clientX) {
    pendingOverviewClientX = clientX;
    if (overviewPanFrame) return;
    overviewPanFrame = requestAnimationFrame(() => {
      overviewPanFrame = 0;
      panFromOverview(pendingOverviewClientX - overviewGrabOffset);
    });
  }

  function updateGridSize(nextColumns, nextRows) {
    const changedColumns = clamp(nextColumns, MIN_COLUMNS, MAX_COLUMNS);
    const changedRows = clamp(nextRows, MIN_ROWS, MAX_ROWS);
    if (changedColumns === columnCount && changedRows === rowCount) return;
    stopKeyboardSounds("status.keyboardResized");
    columnCount = changedColumns;
    rowCount = changedRows;
    panX = 0;
    columnsValue.textContent = String(columnCount);
    rowsValue.textContent = String(rowCount);
    columnsDown.disabled = columnCount <= MIN_COLUMNS;
    columnsUp.disabled = columnCount >= MAX_COLUMNS;
    columnsMin.disabled = columnCount <= MIN_COLUMNS;
    columnsMax.disabled = columnCount >= MAX_COLUMNS;
    rowsDown.disabled = rowCount <= MIN_ROWS;
    rowsUp.disabled = rowCount >= MAX_ROWS;
    savePreference("columns", columnCount);
    savePreference("rows", rowCount);
    createKeyboard();
    keyboard.setAttribute("aria-label", keyboardAriaLabel());
    requestAnimationFrame(fitKeyboard);
  }

  function updateKeyScale(nextScale) {
    const rounded = Math.round(clamp(nextScale, MIN_KEY_SCALE, MAX_KEY_SCALE) * 10) / 10;
    if (rounded === keyScale) return;
    keyScale = rounded;
    keyScaleValue.textContent = `${Math.round(keyScale * 100)}%`;
    keyScaleDown.disabled = keyScale <= MIN_KEY_SCALE;
    keyScaleUp.disabled = keyScale >= MAX_KEY_SCALE;
    savePreference("key-scale", keyScale);
    panX = 0;
    fitKeyboard();
  }

  function updateOverviewSize(nextHeight, nextWidthScale, shouldSave = true) {
    overviewHeight = Math.round(clamp(nextHeight, MIN_OVERVIEW_HEIGHT, MAX_OVERVIEW_HEIGHT) / OVERVIEW_HEIGHT_STEP) * OVERVIEW_HEIGHT_STEP;
    overviewWidthScale = Math.round(clamp(nextWidthScale, MIN_OVERVIEW_WIDTH_SCALE, MAX_OVERVIEW_WIDTH_SCALE) * 10) / 10;
    overviewHeightValue.textContent = `${overviewHeight}px`;
    overviewWidthValue.textContent = `${Math.round(overviewWidthScale * 100)}%`;
    overviewHeightDown.disabled = overviewHeight <= MIN_OVERVIEW_HEIGHT;
    overviewHeightUp.disabled = overviewHeight >= MAX_OVERVIEW_HEIGHT;
    overviewWidthDown.disabled = overviewWidthScale <= MIN_OVERVIEW_WIDTH_SCALE;
    overviewWidthUp.disabled = overviewWidthScale >= MAX_OVERVIEW_WIDTH_SCALE;
    document.documentElement.style.setProperty("--overview-height", `${overviewHeight}px`);
    if (shouldSave) {
      savePreference("overview-height", overviewHeight);
      savePreference("overview-width-scale", overviewWidthScale);
    }
    requestAnimationFrame(fitKeyboard);
  }

  function setLayout(nextLayoutId, shouldSave = true) {
    if (!LAYOUTS[nextLayoutId]) return;
    stopKeyboardSounds("status.layoutChanged");
    layoutId = nextLayoutId;
    layout = LAYOUTS[layoutId];
    layoutSelect.value = layoutId;
    layoutName.textContent = layoutLabel();
    intervalHint.textContent = layoutHintLabel();
    if (shouldSave) savePreference("layout", layoutId);
    panX = 0;
    createKeyboard();
    keyboard.setAttribute("aria-label", keyboardAriaLabel());
    requestAnimationFrame(fitKeyboard);
  }

  function setSettingsOpen(open) {
    settingsOpen = open;
    instrument.classList.toggle("settings-open", open);
    settingsSheet.setAttribute("aria-hidden", String(!open));
    settingsBackdrop.setAttribute("aria-hidden", String(!open));
    settingsHandle.setAttribute("aria-expanded", String(open));
    window.dispatchEvent(new CustomEvent("tonnetz:settings", { detail: { open } }));
  }

  function updateOctaveControls() {
    octaveShift = clamp(octaveShift, MIN_OCTAVE, MAX_OCTAVE);
    octaveValue.textContent = octaveShift > 0 ? `+${octaveShift}` : String(octaveShift);
    octaveDown.disabled = octaveShift <= MIN_OCTAVE;
    octaveUp.disabled = octaveShift >= MAX_OCTAVE;
  }

  function updateKeyboardPitches(messageKey = "status.layoutChanged", values = {}) {
    stopKeyboardSounds(messageKey, values);
    keyPositions.forEach((position) => {
      position.midi = midiForPosition(position.row, position.col);
    });
    refreshVoiceMapping();
    updateOctaveControls();
  }

  keyboard.addEventListener("pointerdown", (event) => {
    const key = event.target.closest(".hex-key") || keyFromPoint(event.clientX, event.clientY);
    if (!key) return;
    event.preventDefault();
    keyboard.setPointerCapture?.(event.pointerId);
    surfacePointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    pressKey(event.pointerId, key, event.pressure || 0.5);
  });

  keyboard.addEventListener("pointermove", (event) => {
    if (!surfacePointers.has(event.pointerId)) return;
    event.preventDefault();
    const coalescedEvents = event.getCoalescedEvents?.();
    const latestEvent = coalescedEvents?.length ? coalescedEvents[coalescedEvents.length - 1] : event;
    surfacePointers.set(event.pointerId, { x: latestEvent.clientX, y: latestEvent.clientY });
    if (!pointerNotes.has(event.pointerId)) return;
    if (!glissando) return;
    scheduleNoteMove(
      event.pointerId,
      latestEvent.clientX,
      latestEvent.clientY,
      latestEvent.pressure || 0.5
    );
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    keyboard.addEventListener(type, (event) => {
      pendingNoteMoves.delete(event.pointerId);
      releasePointer(event.pointerId);
      surfacePointers.delete(event.pointerId);
    });
  });

  startButton.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    ensureAudioReady();
  });

  settingsHandle.addEventListener("click", () => setSettingsOpen(true));
  closeSettings.addEventListener("click", () => setSettingsOpen(false));
  sheetGrabber.addEventListener("click", () => setSettingsOpen(false));
  settingsBackdrop.addEventListener("click", () => setSettingsOpen(false));

  columnsDown.addEventListener("click", () => updateGridSize(columnCount - 1, rowCount));
  columnsUp.addEventListener("click", () => updateGridSize(columnCount + 1, rowCount));
  columnsMin.addEventListener("click", () => updateGridSize(MIN_COLUMNS, rowCount));
  columnsMax.addEventListener("click", () => updateGridSize(MAX_COLUMNS, rowCount));
  rowsDown.addEventListener("click", () => updateGridSize(columnCount, rowCount - 1));
  rowsUp.addEventListener("click", () => updateGridSize(columnCount, rowCount + 1));
  keyScaleDown.addEventListener("click", () => updateKeyScale(keyScale - KEY_SCALE_STEP));
  keyScaleUp.addEventListener("click", () => updateKeyScale(keyScale + KEY_SCALE_STEP));
  overviewHeightDown.addEventListener("click", () => updateOverviewSize(overviewHeight - OVERVIEW_HEIGHT_STEP, overviewWidthScale));
  overviewHeightUp.addEventListener("click", () => updateOverviewSize(overviewHeight + OVERVIEW_HEIGHT_STEP, overviewWidthScale));
  overviewWidthDown.addEventListener("click", () => updateOverviewSize(overviewHeight, overviewWidthScale - OVERVIEW_WIDTH_STEP));
  overviewWidthUp.addEventListener("click", () => updateOverviewSize(overviewHeight, overviewWidthScale + OVERVIEW_WIDTH_STEP));
  layoutSelect.addEventListener("change", () => setLayout(layoutSelect.value));
  skinSelect.addEventListener("change", () => setKeySkin(skinSelect.value));

  keyboardOverview.addEventListener("pointerdown", (event) => {
    event.preventDefault();
    overviewDragging = true;
    keyboardOverview.setPointerCapture?.(event.pointerId);
    const overviewRect = keyboardOverview.getBoundingClientRect();
    overviewDragMetrics = {
      rectLeft: overviewRect.left,
      boardWidth: overviewMetrics?.boardWidth || boardWidthUnits * 84,
      contentLeft: overviewMetrics?.originX || 0,
      contentWidth: overviewMetrics ? boardWidthUnits * overviewMetrics.scale : overviewRect.width
    };
    const windowRect = overviewWindow.getBoundingClientRect();
    const grabbedWindow = event.clientX >= windowRect.left && event.clientX <= windowRect.right
      && event.clientY >= windowRect.top && event.clientY <= windowRect.bottom;
    overviewGrabOffset = grabbedWindow
      ? event.clientX - (windowRect.left + windowRect.width / 2)
      : 0;
    scheduleOverviewPan(event.clientX);
  });

  keyboardOverview.addEventListener("pointermove", (event) => {
    if (!overviewDragging) return;
    event.preventDefault();
    scheduleOverviewPan(event.clientX);
  });

  ["pointerup", "pointercancel", "lostpointercapture"].forEach((type) => {
    keyboardOverview.addEventListener(type, () => {
      overviewDragging = false;
      overviewGrabOffset = 0;
      overviewDragMetrics = null;
    });
  });

  instrument.addEventListener("pointerdown", (event) => {
    if (settingsOpen || event.clientY < window.innerHeight - 96 || event.target.closest(".hex-key, #harmonyWorkbench")) return;
    edgeSwipe = { id: event.pointerId, startY: event.clientY };
  });

  instrument.addEventListener("pointerup", (event) => {
    if (!edgeSwipe || edgeSwipe.id !== event.pointerId) return;
    if (edgeSwipe.startY - event.clientY > 42) setSettingsOpen(true);
    edgeSwipe = null;
  });

  settingsSheet.addEventListener("pointerdown", (event) => {
    if (!event.target.closest(".sheet-grabber, .sheet-header")) return;
    if (event.target.closest("button, select, input") && !event.target.closest(".sheet-grabber")) return;
    sheetSwipe = { id: event.pointerId, startY: event.clientY };
  });

  window.addEventListener("pointerup", (event) => {
    if (!sheetSwipe || sheetSwipe.id !== event.pointerId) return;
    if (event.clientY - sheetSwipe.startY > 42) setSettingsOpen(false);
    sheetSwipe = null;
  });

  window.addEventListener("pointercancel", () => {
    edgeSwipe = null;
    sheetSwipe = null;
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && settingsOpen) setSettingsOpen(false);
  });

  octaveDown.addEventListener("click", () => {
    octaveShift = clamp(octaveShift - 1, MIN_OCTAVE, MAX_OCTAVE);
    updateKeyboardPitches("status.octave", { octave: octaveShift > 0 ? `+${octaveShift}` : octaveShift });
  });

  octaveUp.addEventListener("click", () => {
    octaveShift = clamp(octaveShift + 1, MIN_OCTAVE, MAX_OCTAVE);
    updateKeyboardPitches("status.octave", { octave: octaveShift > 0 ? `+${octaveShift}` : octaveShift });
  });

  function setSustain(nextState) {
    sustain = nextState;
    mainSustainButton.setAttribute("aria-pressed", String(sustain));
    mainSustainButton.setAttribute("aria-label", t(sustain ? "aria.sustainOff" : "aria.sustainOn"));
    if (!sustain) releaseSustainedVoices();
  }

  mainSustainButton.addEventListener("click", () => setSustain(!sustain));

  function setGlissando(nextState, shouldSave = true) {
    glissando = nextState;
    glissandoButton.setAttribute("aria-pressed", String(glissando));
    glissandoButton.setAttribute("aria-label", t(glissando ? "aria.glissandoOff" : "aria.glissandoOn"));
    pendingNoteMoves.clear();
    if (shouldSave) savePreference("glissando", glissando);
  }

  glissandoButton.addEventListener("click", () => setGlissando(!glissando));

  labelsButton.addEventListener("click", () => {
    const isVisible = labelsButton.getAttribute("aria-pressed") === "true";
    labelsButton.setAttribute("aria-pressed", String(!isVisible));
    labelsButton.textContent = t(isVisible ? "action.showLabels" : "action.hideLabels");
    keyboard.classList.toggle("hide-labels", isVisible);
  });

  volumeSlider.addEventListener("input", () => {
    savePreference("volume", volumeSlider.value);
    if (!masterGain || !audioContext) return;
    const value = Math.pow(Number(volumeSlider.value) / 100, 1.7) * 0.52;
    masterGain.gain.setTargetAtTime(value, audioContext.currentTime, 0.025);
  });

  voiceSelect.addEventListener("change", () => {
    savePreference("voice", voiceSelect.value);
    if (audioStarted) stopKeyboardSounds("status.voiceSelected", { voiceType: voiceSelect.value });
    refreshVoiceMapping();
    updateEnsembleLegend();
    warmVoiceSelection(voiceSelect.value);
  });

  function refreshLocalizedUI() {
    i18n?.applyDOM(document);
    languageSelect.value = i18n?.getLanguage() || "en";
    layoutName.textContent = layoutLabel();
    intervalHint.textContent = layoutHintLabel();
    keyboard.setAttribute("aria-label", keyboardAriaLabel());
    mainSustainButton.setAttribute("aria-label", t(sustain ? "aria.sustainOff" : "aria.sustainOn"));
    glissandoButton.setAttribute("aria-label", t(glissando ? "aria.glissandoOff" : "aria.glissandoOn"));
    const labelsVisible = labelsButton.getAttribute("aria-pressed") === "true";
    labelsButton.textContent = t(labelsVisible ? "action.hideLabels" : "action.showLabels");
    if (keyPositions.length) refreshVoiceMapping();
    updateEnsembleLegend();
    renderReadout();
  }

  languageSelect.addEventListener("change", () => i18n?.setLanguage(languageSelect.value));
  window.addEventListener("tonnetzlanguagechange", refreshLocalizedUI);
  document.addEventListener("DOMContentLoaded", refreshLocalizedUI, { once: true });

  document.querySelector("#panicButton").addEventListener("click", () => panic());
  window.addEventListener("blur", () => panic());
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) panic();
  });
  window.addEventListener("pagehide", () => panic());

  window.addEventListener("resize", fitKeyboard, { passive: true });
  window.addEventListener("orientationchange", () => window.setTimeout(fitKeyboard, 160), { passive: true });
  document.addEventListener("gesturestart", (event) => event.preventDefault(), { passive: false });
  document.addEventListener("contextmenu", (event) => {
    if (event.target.closest(".keyboard")) event.preventDefault();
  });

  const preferredVoice = readPreference("voice", "concert");
  const preferredVolume = Number(readPreference("volume", "72"));
  const preferredColumns = Number(readPreference("columns", String(DEFAULT_COLUMNS)));
  const preferredRows = Number(readPreference("rows", String(DEFAULT_ROWS)));
  const preferredKeyScale = Number(readPreference("key-scale", "1"));
  const preferredOverviewHeight = Number(readPreference("overview-height", String(DEFAULT_OVERVIEW_HEIGHT)));
  const preferredOverviewWidthScale = Number(readPreference("overview-width-scale", String(DEFAULT_OVERVIEW_WIDTH_SCALE)));
  const preferredLayout = readPreference("layout", "classic");
  const preferredSkin = readPreference("skin", "tonnetz");
  columnCount = clamp(Number.isFinite(preferredColumns) ? preferredColumns : DEFAULT_COLUMNS, MIN_COLUMNS, MAX_COLUMNS);
  rowCount = clamp(Number.isFinite(preferredRows) ? preferredRows : DEFAULT_ROWS, MIN_ROWS, MAX_ROWS);
  keyScale = Math.round(clamp(Number.isFinite(preferredKeyScale) ? preferredKeyScale : 1, MIN_KEY_SCALE, MAX_KEY_SCALE) * 10) / 10;
  overviewHeight = Number.isFinite(preferredOverviewHeight) ? preferredOverviewHeight : DEFAULT_OVERVIEW_HEIGHT;
  overviewWidthScale = Number.isFinite(preferredOverviewWidthScale) ? preferredOverviewWidthScale : DEFAULT_OVERVIEW_WIDTH_SCALE;
  layoutId = LAYOUTS[preferredLayout] ? preferredLayout : "classic";
  layout = LAYOUTS[layoutId];
  keySkin = KEY_SKINS.has(preferredSkin) ? preferredSkin : "tonnetz";
  if (PRESETS[preferredVoice]) voiceSelect.value = preferredVoice;
  volumeSlider.value = String(clamp(Number.isFinite(preferredVolume) ? preferredVolume : 72, 0, 100));
  columnsValue.textContent = String(columnCount);
  rowsValue.textContent = String(rowCount);
  keyScaleValue.textContent = `${Math.round(keyScale * 100)}%`;
  columnsDown.disabled = columnCount <= MIN_COLUMNS;
  columnsUp.disabled = columnCount >= MAX_COLUMNS;
  columnsMin.disabled = columnCount <= MIN_COLUMNS;
  columnsMax.disabled = columnCount >= MAX_COLUMNS;
  rowsDown.disabled = rowCount <= MIN_ROWS;
  rowsUp.disabled = rowCount >= MAX_ROWS;
  keyScaleDown.disabled = keyScale <= MIN_KEY_SCALE;
  keyScaleUp.disabled = keyScale >= MAX_KEY_SCALE;
  setGlissando(glissando, false);
  updateOverviewSize(overviewHeight, overviewWidthScale, false);
  layoutSelect.value = layoutId;
  setKeySkin(keySkin, false);
  languageSelect.value = i18n?.getLanguage() || "en";
  layoutName.textContent = layoutLabel();
  intervalHint.textContent = layoutHintLabel();
  keyboard.setAttribute("aria-label", keyboardAriaLabel());
  createKeyboard();
  updateEnsembleLegend();
  updateOctaveControls();
  requestAnimationFrame(fitKeyboard);
  warmVoiceSelection(voiceSelect.value);

  if ("serviceWorker" in navigator && location.protocol !== "file:") {
    window.addEventListener("load", () => navigator.serviceWorker.register("./sw.js").catch(() => {}));
  }
})();
