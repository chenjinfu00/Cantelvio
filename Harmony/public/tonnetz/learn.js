const mod = (value, modulus = 12) => ((value % modulus) + modulus) % modulus;

export const NOTE_NAMES = Object.freeze([
  "C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"
]);

export const FIFTH_ORDER = Object.freeze(Array.from({ length: 12 }, (_, index) => mod(index * 7)));
export const PERIOD_VECTORS = Object.freeze([Object.freeze([0, 3]), Object.freeze([4, -1])]);
export const EDGE_DIRECTIONS = Object.freeze({
  fifth: Object.freeze([1, 0]),
  majorThird: Object.freeze([0, 1]),
  minorThird: Object.freeze([1, -1])
});

export function pitchClass([i, j]) {
  return mod(7 * i + 4 * j);
}

export const PERIOD_CELL = Object.freeze(
  Array.from({ length: 3 }, (_, j) =>
    Array.from({ length: 4 }, (_, i) => Object.freeze({ i, j, pc: pitchClass([i, j]) }))
  ).flat()
);

export function translatedCell(a = 0, b = 0) {
  const [u, v] = PERIOD_VECTORS;
  return PERIOD_CELL.map(({ i, j, pc }) => ({
    i: i + a * u[0] + b * v[0],
    j: j + a * u[1] + b * v[1],
    pc,
    copyA: a,
    copyB: b
  }));
}

const shape = (id, quality, coords, midis, notes) => Object.freeze({
  id,
  quality,
  coords: Object.freeze(coords.map((coord) => Object.freeze(coord))),
  midis: Object.freeze(midis),
  notes
});

// The first eight entries are the complete original Tonnetz demo set. The
// remaining shapes add the common triads requested by the workbench lesson.
export const CHORD_SHAPES = Object.freeze([
  shape("C", "major", [[0, 0], [0, 1], [1, 0]], [60, 64, 67], "C E G"),
  shape("Cmaj7", "major", [[0, 0], [0, 1], [1, 0], [1, 1]], [60, 64, 67, 71], "C E G B"),
  shape("Cmaj9", "major", [[0, 0], [0, 1], [1, 0], [1, 1], [2, 0]], [60, 64, 67, 71, 74], "C E G B D"),
  shape("C7", "dominant", [[0, 0], [0, 1], [1, 0], [2, -1]], [60, 64, 67, 70], "C E G B♭"),
  shape("Cm", "minor", [[0, 0], [1, -1], [1, 0]], [60, 63, 67], "C E♭ G"),
  shape("Cm7", "minor", [[0, 0], [1, -1], [1, 0], [2, -1]], [60, 63, 67, 70], "C E♭ G B♭"),
  shape("Cm9", "minor", [[0, 0], [1, -1], [1, 0], [2, -1], [2, 0]], [60, 63, 67, 70, 74], "C E♭ G B♭ D"),
  shape("Cdim7", "diminished", [[0, 0], [1, -1], [2, -2], [3, -3]], [60, 63, 66, 69], "C E♭ F♯ A"),
  shape("Caug", "augmented", [[0, 0], [0, 1], [0, 2]], [60, 64, 68], "C E G♯"),
  shape("Cdim", "diminished", [[0, 0], [1, -1], [2, -2]], [60, 63, 66], "C E♭ F♯"),
  shape("Csus2", "suspended", [[0, 0], [1, 0], [2, 0]], [60, 62, 67], "C D G"),
  shape("Csus4", "suspended", [[0, 0], [-1, 0], [1, 0]], [60, 65, 67], "C F G")
]);

export const PURE_FIFTH_RATIO = 3 / 2;
export const EQUAL_FIFTH_RATIO = 2 ** (7 / 12);
export const PURE_FIFTH_MIDI = 60 + 12 * Math.log2(PURE_FIFTH_RATIO);
export const FIFTH_DIFFERENCE_CENTS = 1200 * Math.log2(PURE_FIFTH_RATIO / EQUAL_FIFTH_RATIO);

export function frequencyForMidi(midi, a4 = 440) {
  return a4 * 2 ** ((midi - 69) / 12);
}

export function transposeFifthsMidis(midis, steps) {
  let result = midis.map((midi) => midi + steps * 7);
  while (result[0] < 48) result = result.map((midi) => midi + 12);
  while (result[0] > 71) result = result.map((midi) => midi - 12);
  return result;
}

export async function previewFifth(audio, tuning = "equal", isCurrent = () => true) {
  if (!audio?.ensureReady || !audio?.playNote) return false;
  const ready = await audio.ensureReady();
  if (!ready || !isCurrent()) return false;
  audio.stopGroup?.("learn");
  const upperMidi = tuning === "pure" ? PURE_FIFTH_MIDI : 67;
  [60, upperMidi].forEach((midi) => audio.playNote(midi, {
    instrument: "sine",
    velocity: 0.66,
    duration: 1.7,
    group: "learn"
  }));
  return true;
}

const GRID_COORDS = Object.freeze(
  Array.from({ length: 8 }, (_, jIndex) =>
    Array.from({ length: 10 }, (_, iIndex) => Object.freeze([iIndex - 4, jIndex - 4]))
  ).flat()
);

const I18N = {
  en: {
    eyebrow: "Explore the Tonnetz",
    title: "How a circle becomes a harmony map",
    intro: "Tap any note or chord to hear it. The same 12 pitch classes appear in every view.",
    stages: ["12-note circle", "Fifths path", "Period cell", "2D plane"],
    stageTitles: ["One chromatic octave", "Walk by perfect fifths", "The smallest repeating cell", "Repeat the cell in two directions"],
    stageCopy: [
      "Adjacent points are one semitone apart. After 12 steps, the octave repeats.",
      "Keep every note in the same place and connect +7 semitone steps: C–G–D–A… The path visits all 12 notes before returning.",
      "Put +7 semitones on one axis and +4 on the other. These 12 positions contain every pitch class exactly once.",
      "Shifting by either period vector changes coordinates but preserves each note. The outlined 12-note cells repeat edge-to-edge across the plane."
    ],
    axes: "Coordinates: fifth +7 · major third +4",
    intervalTitle: "Pure fifth and equal-tempered fifth",
    intervalCopy: "A pure fifth has the simple frequency ratio 3:2. A piano divides the octave into 12 equal steps, so its fifth is slightly narrower—about 1.955 cents. The difference is subtle; compare the two sonorities.",
    pure: "Play pure 3:2",
    equal: "Play 12-TET fifth",
    playPath: "Play the 12-step path",
    stopPreview: "Stop preview",
    edgeTitle: "Read the three edge directions",
    edgeCopy: "Every neighboring line names an interval. These three directions turn chord tones into compact shapes.",
    fifth: "Perfect fifth · 7",
    majorThird: "Major third · 4",
    minorThird: "Minor third · 3",
    chordTitle: "Chord shapes on one fixed grid",
    chordCopy: "Choose a shape, then move it by fifths. Its geometry stays the same while every note is transposed.",
    moveBack: "Move down a fifth",
    moveNext: "Move up a fifth",
    reset: "Return to C",
    playChord: "Play chord",
    actualNotes: "Sounding notes",
    scrollHint: "Scroll the diagram sideways to inspect every label.",
    diagramLabels: ["Chromatic circle", "Circle of fifths path on the chromatic circle", "Twelve-note Tonnetz period cell", "Repeated Tonnetz period cells"],
    gridLabel: "Tonnetz chord grid"
  },
  "zh-CN": {
    eyebrow: "探索 Tonnetz",
    title: "一个音圈如何变成和声地图",
    intro: "点击任意音或和弦即可试听。每幅图都使用同一组 12 个音级。",
    stages: ["十二音圈", "五度路径", "最小周期单元", "二维铺展"],
    stageTitles: ["一个半音阶八度", "沿纯五度前进", "最小重复单元", "沿两个方向重复单元"],
    stageCopy: [
      "相邻两点相差一个半音。走完 12 步后，音高在高八度重复。",
      "所有音的位置保持不变，再连接每次上行 7 个半音的路径：C–G–D–A……返回 C 前会经过全部 12 个音。",
      "一条轴每步 +7 个半音，另一条轴每步 +4 个半音。这 12 个位置恰好各含一个音级。",
      "沿任一周期向量平移，坐标会改变，音名却保持不变。图中的十二音单元首尾相接，连续铺满二维平面。"
    ],
    axes: "坐标方向：纯五度 +7 · 大三度 +4",
    intervalTitle: "纯律五度与十二平均律五度",
    intervalCopy: "纯五度的频率比是简单的 3:2。钢琴把八度平均分成 12 份，因此五度略窄，约相差 1.955 音分。差别很细微，可以来回试听。",
    pure: "播放纯律 3:2",
    equal: "播放十二平均律五度",
    playPath: "播放十二步路径",
    stopPreview: "停止试听",
    edgeTitle: "读懂三种边",
    edgeCopy: "每个相邻方向代表一种音程。这三种方向让和弦音在网格上组成紧凑图形。",
    fifth: "纯五度 · 7",
    majorThird: "大三度 · 4",
    minorThird: "小三度 · 3",
    chordTitle: "同一张网格上的和弦形状",
    chordCopy: "选择一个形状，再沿五度方向移动。几何形状不变，所有音都会移调。",
    moveBack: "下移一个五度",
    moveNext: "上移一个五度",
    reset: "回到 C",
    playChord: "播放和弦",
    actualNotes: "实际发声音",
    scrollHint: "左右滚动图形可查看所有音名。",
    diagramLabels: ["半音阶十二音圈", "同一十二音圈上的五度路径", "十二音 Tonnetz 周期单元", "重复的 Tonnetz 周期单元"],
    gridLabel: "Tonnetz 和弦网格"
  }
};

const escapeHTML = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

const rounded = (value) => Number(value).toFixed(2);

function latticePoint([i, j], scale = 1, origin = { x: 0, y: 0 }) {
  return {
    x: origin.x + scale * (i * 0.2398 + j * 0.9606),
    y: origin.y + scale * (i * -0.9708 + j * -0.2781)
  };
}

export function planeViewportNotes(width = 860, height = 540, scale = 56, padding = 23) {
  const origin = { x: width / 2, y: height / 2 };
  const notes = [];
  for (let i = -20; i <= 20; i += 1) {
    for (let j = -20; j <= 20; j += 1) {
      const point = latticePoint([i, j], scale, origin);
      if (point.x < padding || point.x > width - padding || point.y < padding || point.y > height - padding) continue;
      notes.push({ i, j, pc: pitchClass([i, j]), ...periodAddress(i, j), ...point });
    }
  }
  return notes;
}

function fitCoordinates(coords, width, height, padding) {
  const raw = coords.map((coord) => ({ coord, ...latticePoint(coord) }));
  const minX = Math.min(...raw.map(({ x }) => x));
  const maxX = Math.max(...raw.map(({ x }) => x));
  const minY = Math.min(...raw.map(({ y }) => y));
  const maxY = Math.max(...raw.map(({ y }) => y));
  const scale = Math.min(
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxY - minY)
  );
  return {
    scale,
    points: raw.map((entry) => ({
      ...entry,
      x: width / 2 + (entry.x - (minX + maxX) / 2) * scale,
      y: height / 2 + (entry.y - (minY + maxY) / 2) * scale
    }))
  };
}

function hexPath(x, y, radius) {
  return Array.from({ length: 6 }, (_, side) => {
    const angle = -Math.PI / 2 - 0.282 + side * Math.PI / 3;
    const command = side ? "L" : "M";
    return `${command}${rounded(x + Math.cos(angle) * radius)},${rounded(y + Math.sin(angle) * radius)}`;
  }).join(" ") + " Z";
}

export function circlePositions(width = 640, height = 400) {
  const cx = width / 2;
  const cy = height / 2;
  const radius = Math.min(width * 0.36, height * 0.39);
  return Array.from({ length: 12 }, (_, pc) => {
    const angle = -Math.PI / 2 + pc * Math.PI * 2 / 12;
    return { pc, x: cx + Math.cos(angle) * radius, y: cy + Math.sin(angle) * radius };
  });
}

function circleSVG(showFifths, label) {
  const width = 400;
  const height = 400;
  const points = circlePositions(width, height);
  const perimeter = points.map((from, pc) => {
    const to = points[(pc + 1) % 12];
    return `<line class="learn-chromatic-edge" x1="${rounded(from.x)}" y1="${rounded(from.y)}" x2="${rounded(to.x)}" y2="${rounded(to.y)}"/>`;
  }).join("");
  const fifths = showFifths ? FIFTH_ORDER.map((fromPc, index) => {
    const toPc = FIFTH_ORDER[(index + 1) % FIFTH_ORDER.length];
    const from = points[fromPc];
    const to = points[toPc];
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy) || 1;
    const inset = 25;
    return `<line class="learn-fifth-edge" data-step="${index}" x1="${rounded(from.x + dx / length * inset)}" y1="${rounded(from.y + dy / length * inset)}" x2="${rounded(to.x - dx / length * inset)}" y2="${rounded(to.y - dy / length * inset)}" marker-end="url(#learn-arrow)"/>`;
  }).join("") : "";
  const nodes = points.map(({ pc, x, y }) => `<g class="learn-note" role="button" tabindex="0" data-midi="${60 + pc}" aria-label="Play ${NOTE_NAMES[pc]}" transform="translate(${rounded(x)} ${rounded(y)})"><circle r="22"/><text y="5">${NOTE_NAMES[pc]}</text></g>`).join("");
  return `<svg class="learn-ring" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><defs><marker id="learn-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs><g>${perimeter}</g><g>${fifths}</g><g>${nodes}</g></svg>`;
}

function latticeEdges(pointsByCoordinate) {
  const directions = [[1, 0, "fifth"], [0, 1, "major-third"], [1, -1, "minor-third"]];
  const edges = [];
  for (const point of pointsByCoordinate.values()) {
    directions.forEach(([di, dj, interval]) => {
      const next = pointsByCoordinate.get(`${point.i + di},${point.j + dj}`);
      if (next) edges.push(`<line class="learn-grid-edge ${interval}" x1="${rounded(point.x)}" y1="${rounded(point.y)}" x2="${rounded(next.x)}" y2="${rounded(next.y)}"/>`);
    });
  }
  return edges.join("");
}

function cellSVG(label) {
  const width = 680;
  const height = 430;
  const source = translatedCell(0, 0);
  const { points, scale } = fitCoordinates(source.map(({ i, j }) => [i, j]), width, height, 66);
  const positioned = source.map((note, index) => ({ ...note, ...points[index] }));
  const byCoordinate = new Map(positioned.map((note) => [`${note.i},${note.j}`, note]));
  const radius = Math.min(31, scale * 0.34);
  const nodes = positioned.map((note) => {
    const origin = note.copyA === 0 && note.copyB === 0;
    return `<g class="learn-cell-note ${origin ? "is-origin" : "is-copy"}" role="button" tabindex="0" data-midi="${60 + note.pc}" data-i="${note.i}" data-j="${note.j}" aria-label="Play ${NOTE_NAMES[note.pc]}"><path d="${hexPath(note.x, note.y, radius)}"/><text x="${rounded(note.x)}" y="${rounded(note.y + 4.5)}">${NOTE_NAMES[note.pc]}</text></g>`;
  }).join("");
  return `<svg class="learn-cell is-period" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><g>${latticeEdges(byCoordinate)}</g><g>${nodes}</g></svg>`;
}

export function periodAddress(i, j) {
  const b = Math.floor(i / 4);
  const localI = mod(i, 4);
  const localJ = mod(j + b, 3);
  const a = (j + b - localJ) / 3;
  return { a, b, localI, localJ };
}

/** A cropped viewport of the infinite lattice, partitioned into exact 12-note cells. */
function planeSVG(label) {
  const width = 860;
  const height = 480;
  const scale = 56;
  const origin = { x: width / 2, y: height / 2 };
  const positioned = planeViewportNotes(width, height, scale, 23);
  const byCoordinate = new Map(positioned.map((note) => [`${note.i},${note.j}`, note]));
  const cells = [];
  for (let a = -10; a <= 10; a += 1) {
    for (let b = -10; b <= 10; b += 1) {
      const base = [4 * b, 3 * a - b];
      const corners = [[-0.5, -0.5], [3.5, -0.5], [3.5, 2.5], [-0.5, 2.5]]
        .map(([di, dj]) => latticePoint([base[0] + di, base[1] + dj], scale, origin));
      const minX = Math.min(...corners.map(({ x }) => x));
      const maxX = Math.max(...corners.map(({ x }) => x));
      const minY = Math.min(...corners.map(({ y }) => y));
      const maxY = Math.max(...corners.map(({ y }) => y));
      if (maxX < 0 || minX > width || maxY < 0 || minY > height) continue;
      cells.push(`<polygon class="learn-period-boundary tone-${mod(a + 2 * b, 4)}" points="${corners.map(({ x, y }) => `${rounded(x)},${rounded(y)}`).join(" ")}"/>`);
    }
  }
  const nodes = positioned.map((note) => `<g class="learn-cell-note is-plane tone-${mod(note.a + 2 * note.b, 4)}" role="button" tabindex="0" data-midi="${60 + note.pc}" data-i="${note.i}" data-j="${note.j}" data-copy-a="${note.a}" data-copy-b="${note.b}" aria-label="Play ${NOTE_NAMES[note.pc]}"><path d="${hexPath(note.x, note.y, 19)}"/><text x="${rounded(note.x)}" y="${rounded(note.y + 5)}">${NOTE_NAMES[note.pc]}</text></g>`).join("");
  return `<svg class="learn-cell is-expanded" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><g class="learn-period-cells">${cells.join("")}</g><g>${latticeEdges(byCoordinate)}</g><g>${nodes}</g></svg>`;
}

function edgeLegendSVG(copy) {
  const entries = [
    { id: "fifth", label: copy.fifth, semitones: 7, coord: EDGE_DIRECTIONS.fifth, x: 78, y: 82 },
    { id: "major-third", label: copy.majorThird, semitones: 4, coord: EDGE_DIRECTIONS.majorThird, x: 266, y: 70 },
    { id: "minor-third", label: copy.minorThird, semitones: 3, coord: EDGE_DIRECTIONS.minorThird, x: 540, y: 82 }
  ];
  return `<svg class="learn-edge-legend" viewBox="0 0 680 128" role="group">${entries.map((entry) => {
    const delta = latticePoint(entry.coord, 62);
    const endX = entry.x + delta.x;
    const endY = entry.y + delta.y;
    return `<g class="learn-edge-sample ${entry.id}" role="button" tabindex="0" data-interval="${entry.semitones}" data-di="${entry.coord[0]}" data-dj="${entry.coord[1]}" aria-label="${escapeHTML(entry.label)}"><line x1="${rounded(entry.x)}" y1="${rounded(entry.y)}" x2="${rounded(endX)}" y2="${rounded(endY)}"/><circle cx="${rounded(entry.x)}" cy="${rounded(entry.y)}" r="7"/><circle cx="${rounded(endX)}" cy="${rounded(endY)}" r="7"/><text x="${entry.x - 42}" y="116">${escapeHTML(entry.label)}</text></g>`;
  }).join("")}</svg>`;
}

const noteWithOctave = (midi) => `${NOTE_NAMES[mod(Math.round(midi))]}${Math.floor(Math.round(midi) / 12) - 1}`;

function chordGridSVG(selectedShape, fifthShift, label) {
  const width = 720;
  const height = 500;
  const { points, scale } = fitCoordinates(GRID_COORDS, width, height, 35);
  const positioned = points.map(({ coord: [i, j], x, y }) => ({ i, j, x, y }));
  const byCoordinate = new Map(positioned.map((note) => [`${note.i},${note.j}`, note]));
  const shiftedCoordinates = selectedShape.coords.map(([i, j]) => [i + fifthShift, j]);
  const selected = new Set(shiftedCoordinates.map(([i, j]) => `${i},${j}`));
  const trianglePoints = shiftedCoordinates.slice(0, 3).map(([i, j]) => byCoordinate.get(`${i},${j}`)).filter(Boolean);
  const triangle = trianglePoints.length === 3
    ? `<path class="learn-chord-polygon ${escapeHTML(selectedShape.quality)}" d="M${trianglePoints.map(({ x, y }) => `${rounded(x)},${rounded(y)}`).join(" L")} Z"/>`
    : "";
  const radius = Math.min(23, scale * 0.38);
  const nodes = positioned.map(({ i, j, x, y }) => {
    const active = selected.has(`${i},${j}`);
    const pc = pitchClass([i, j]);
    return `<g class="learn-grid-note ${active ? `is-active ${escapeHTML(selectedShape.quality)}` : ""}" role="button" tabindex="0" data-midi="${60 + pc}" data-i="${i}" data-j="${j}" aria-label="Play ${NOTE_NAMES[pc]}"><path d="${hexPath(x, y, radius)}"/><text x="${rounded(x)}" y="${rounded(y + 4.5)}">${NOTE_NAMES[pc]}</text></g>`;
  }).join("");
  return `<svg class="learn-chord-grid" viewBox="0 0 ${width} ${height}" role="img" aria-label="${escapeHTML(label)}"><g>${latticeEdges(byCoordinate)}</g>${triangle}<g>${nodes}</g></svg>`;
}

function formulaMarkup() {
  return `<div class="learn-formulas" aria-label="Fifth frequency formulas">
    <span class="learn-formula" data-tex="\\frac{f_2}{f_1}=\\frac{3}{2}"><math><mfrac><msub><mi>f</mi><mn>2</mn></msub><msub><mi>f</mi><mn>1</mn></msub></mfrac><mo>=</mo><mfrac><mn>3</mn><mn>2</mn></mfrac></math></span>
    <span class="learn-formula" data-tex="2^{7/12}\\approx1.498307"><math><msup><mn>2</mn><mrow><mn>7</mn><mo>/</mo><mn>12</mn></mrow></msup><mo>≈</mo><mn>1.498307</mn></math></span>
    <span class="learn-formula" data-tex="1200\\log_2\\!\\left(\\frac{3/2}{2^{7/12}}\\right)\\approx1.955\\,\\text{cents}"><math><mn>1200</mn><msub><mi>log</mi><mn>2</mn></msub><mfenced><mfrac><mrow><mn>3</mn><mo>/</mo><mn>2</mn></mrow><msup><mn>2</mn><mrow><mn>7</mn><mo>/</mo><mn>12</mn></mrow></msup></mfrac></mfenced><mo>≈</mo><mn>1.955</mn><mtext> cents</mtext></math></span>
  </div>`;
}

function renderKaTeX(container) {
  const renderer = globalThis.katex?.render;
  if (typeof renderer !== "function") return;
  container.querySelectorAll(".learn-formula[data-tex]").forEach((element) => {
    try {
      renderer(element.dataset.tex, element, { throwOnError: false, displayMode: false, strict: false });
    } catch (_) {
      // The embedded MathML remains readable if an optional KaTeX build fails.
    }
  });
}

function normalizeLanguage(language) {
  return language === "zh-CN" || String(language || "").toLowerCase().startsWith("zh") ? "zh-CN" : "en";
}

export function createLearnPanel({ container, audio, getLanguage = () => "en" } = {}) {
  if (!container || typeof container.addEventListener !== "function") {
    throw new TypeError("createLearnPanel requires a container element");
  }

  const state = { stage: 0, chordId: "C", fifthShift: 0 };
  let destroyed = false;
  let audioRequest = 0;
  const pathTimers = new Set();

  const selectedShape = () => CHORD_SHAPES.find(({ id }) => id === state.chordId) || CHORD_SHAPES[0];
  const soundingMidis = () => transposeFifthsMidis(selectedShape().midis, state.fifthShift);

  function setPathHighlight(pc = null) {
    container.querySelectorAll?.(".is-path-active").forEach((element) => element.classList.remove("is-path-active"));
    if (pc === null) return;
    container.querySelectorAll?.(`[data-midi="${60 + pc}"]`).forEach((element) => element.classList.add("is-path-active"));
  }

  function cancel() {
    audioRequest += 1;
    pathTimers.forEach((timer) => clearTimeout(timer));
    pathTimers.clear();
    setPathHighlight();
    audio?.stopGroup?.("learn");
  }

  function beginPreview() {
    cancel();
    return audioRequest;
  }

  async function playMidis(midis, duration = 1.35) {
    if (!audio?.ensureReady || !audio?.playNote) return false;
    const request = beginPreview();
    const ready = await audio.ensureReady();
    if (!ready || destroyed || request !== audioRequest) return false;
    audio.stopGroup?.("learn");
    midis.forEach((midi) => audio.playNote(midi, {
      instrument: "epiano",
      velocity: midis.length > 1 ? 0.62 : 0.72,
      duration,
      group: "learn"
    }));
    return true;
  }

  function playTuningFifth(tuning) {
    const request = beginPreview();
    return previewFifth(audio, tuning, () => !destroyed && request === audioRequest);
  }

  async function playStagePath() {
    if (!audio?.ensureReady || !audio?.playNote) return false;
    const request = beginPreview();
    const ready = await audio.ensureReady();
    if (!ready || destroyed || request !== audioRequest) return false;
    const order = state.stage === 1 ? FIFTH_ORDER : Array.from({ length: 12 }, (_, pc) => pc);
    order.forEach((pc, index) => {
      const timer = setTimeout(() => {
        pathTimers.delete(timer);
        if (destroyed || request !== audioRequest) return;
        setPathHighlight(pc);
        audio.playNote(60 + pc, {
          instrument: "epiano",
          velocity: 0.68,
          duration: 0.31,
          group: "learn"
        });
      }, index * 350);
      pathTimers.add(timer);
    });
    const finishTimer = setTimeout(() => {
      pathTimers.delete(finishTimer);
      if (request === audioRequest) setPathHighlight();
    }, order.length * 350);
    pathTimers.add(finishTimer);
    return true;
  }

  function stageDiagram(copy) {
    if (state.stage === 0) return circleSVG(false, copy.diagramLabels[0]);
    if (state.stage === 1) return circleSVG(true, copy.diagramLabels[1]);
    if (state.stage === 2) return cellSVG(copy.diagramLabels[2]);
    return planeSVG(copy.diagramLabels[3]);
  }

  function render() {
    if (destroyed) return;
    const language = normalizeLanguage(getLanguage());
    const copy = I18N[language];
    const chord = selectedShape();
    const midis = soundingMidis();
    const chordName = `${NOTE_NAMES[mod(midis[0])]}${chord.id.slice(1)}`;
    container.innerHTML = `<section class="tonnetz-learn" lang="${language}">
      <header class="learn-header">
        <p class="learn-eyebrow">${copy.eyebrow}</p>
        <h2>${copy.title}</h2>
        <p>${copy.intro}</p>
      </header>

      <div class="learn-stage-tabs" role="tablist" aria-label="${escapeHTML(copy.title)}">
        ${copy.stages.map((label, index) => `<button type="button" role="tab" aria-selected="${state.stage === index}" class="learn-stage-tab ${state.stage === index ? "is-active" : ""}" data-stage="${index}"><span>${index + 1}</span>${label}</button>`).join("")}
      </div>
      <article class="learn-card learn-stage-card">
        <h3>${copy.stageTitles[state.stage]}</h3>
        <p>${copy.stageCopy[state.stage]}</p>
        ${state.stage >= 2 ? `<p class="learn-axis-copy">${copy.axes}</p>` : ""}
        <div class="learn-diagram-scroll" tabindex="0">${stageDiagram(copy)}<span class="learn-scroll-hint">${copy.scrollHint}</span></div>
        ${state.stage <= 1 ? `<div class="learn-button-row learn-path-controls"><button type="button" class="learn-action-button is-pure" data-action="play-stage-path">▶ ${copy.playPath}</button><button type="button" class="learn-action-button" data-action="stop-preview">■ ${copy.stopPreview}</button></div>` : ""}
      </article>

      <article class="learn-card learn-interval-card">
        <h3>${copy.intervalTitle}</h3>
        <p>${copy.intervalCopy}</p>
        ${formulaMarkup()}
        <div class="learn-button-row">
          <button type="button" class="learn-action-button is-pure" data-action="pure-fifth">${copy.pure}</button>
          <button type="button" class="learn-action-button" data-action="equal-fifth">${copy.equal}</button>
        </div>
      </article>

      <article class="learn-card learn-edge-card">
        <h3>${copy.edgeTitle}</h3>
        <p>${copy.edgeCopy}</p>
        <div class="learn-diagram-scroll" tabindex="0">${edgeLegendSVG(copy)}</div>
      </article>

      <article class="learn-card learn-chord-card">
        <h3>${copy.chordTitle}</h3>
        <p>${copy.chordCopy}</p>
        <div class="learn-chord-picker" role="listbox" aria-label="${escapeHTML(copy.chordTitle)}">
          ${CHORD_SHAPES.map((item) => `<button type="button" role="option" aria-selected="${item.id === chord.id}" class="learn-chord-choice ${item.id === chord.id ? "is-active" : ""}" data-chord="${item.id}">${item.id}</button>`).join("")}
        </div>
        <div class="learn-move-row">
          <button type="button" class="learn-icon-button" data-action="move-back" aria-label="${escapeHTML(copy.moveBack)}" ${state.fifthShift <= -2 ? "disabled" : ""}>−5th</button>
          <button type="button" class="learn-reset-button" data-action="reset-shape">${copy.reset}</button>
          <button type="button" class="learn-icon-button" data-action="move-next" aria-label="${escapeHTML(copy.moveNext)}" ${state.fifthShift >= 2 ? "disabled" : ""}>+5th</button>
        </div>
        <div class="learn-current-chord" aria-live="polite"><strong>${escapeHTML(chordName)}</strong><span>${copy.actualNotes}: ${midis.map(noteWithOctave).join(" · ")}</span><button type="button" class="learn-play-chord" data-action="play-chord">▶ ${copy.playChord}</button></div>
        <div class="learn-diagram-scroll" tabindex="0">${chordGridSVG(chord, state.fifthShift, copy.gridLabel)}<span class="learn-scroll-hint">${copy.scrollHint}</span></div>
      </article>
    </section>`;
    renderKaTeX(container);
  }

  function activate(target) {
    const stage = target.closest?.("[data-stage]");
    if (stage) {
      cancel();
      state.stage = Number(stage.dataset.stage);
      render();
      return;
    }
    const chord = target.closest?.("[data-chord]");
    if (chord) {
      state.chordId = chord.dataset.chord;
      state.fifthShift = 0;
      render();
      void playMidis(soundingMidis());
      return;
    }
    const interval = target.closest?.("[data-interval]");
    if (interval) {
      void playMidis([60, 60 + Number(interval.dataset.interval)], 1.25);
      return;
    }
    const note = target.closest?.("[data-midi]");
    if (note) {
      void playMidis([Number(note.dataset.midi)], 0.8);
      return;
    }
    const action = target.closest?.("[data-action]")?.dataset.action;
    if (action === "pure-fifth") void playTuningFifth("pure");
    if (action === "equal-fifth") void playTuningFifth("equal");
    if (action === "play-stage-path") void playStagePath();
    if (action === "stop-preview") cancel();
    if (action === "play-chord") void playMidis(soundingMidis());
    if (action === "move-back" && state.fifthShift > -2) {
      state.fifthShift -= 1;
      render();
      void playMidis(soundingMidis());
    }
    if (action === "move-next" && state.fifthShift < 2) {
      state.fifthShift += 1;
      render();
      void playMidis(soundingMidis());
    }
    if (action === "reset-shape") {
      state.fifthShift = 0;
      render();
      void playMidis(soundingMidis());
    }
  }

  function onClick(event) {
    activate(event.target);
  }

  function onKeyDown(event) {
    if ((event.key === "Enter" || event.key === " ") && event.target.matches?.("[role='button']")) {
      event.preventDefault();
      activate(event.target);
    }
  }

  const browserWindow = typeof window === "undefined" ? null : window;
  const browserDocument = typeof document === "undefined" ? null : document;
  const onVisibilityChange = () => {
    if (browserDocument?.hidden) cancel();
  };
  const onPageHide = () => cancel();
  const onPanic = () => cancel();

  container.addEventListener("click", onClick);
  container.addEventListener("keydown", onKeyDown);
  browserWindow?.addEventListener("pagehide", onPageHide);
  browserWindow?.addEventListener("tonnetz:panic", onPanic);
  browserDocument?.addEventListener("visibilitychange", onVisibilityChange);
  render();

  return {
    render,
    cancel,
    destroy() {
      if (destroyed) return;
      cancel();
      destroyed = true;
      container.removeEventListener("click", onClick);
      container.removeEventListener("keydown", onKeyDown);
      browserWindow?.removeEventListener("pagehide", onPageHide);
      browserWindow?.removeEventListener("tonnetz:panic", onPanic);
      browserDocument?.removeEventListener("visibilitychange", onVisibilityChange);
      container.innerHTML = "";
    }
  };
}
