import { hexPath, point } from "../shared/lattice.js";
import { pitchClass } from "../shared/music-data.js";

export const GEOMETRY_NOTE_NAMES = Object.freeze(["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]);
export const FIFTH_ORDER = Object.freeze(Array.from({ length: 12 }, (_, index) => (7 * index) % 12));
export const PERIOD_VECTORS = Object.freeze([[0, 3], [4, -1]]);
export const CELL_REPRESENTATIVES = Object.freeze(
  Array.from({ length: 3 }, (_, j) => Array.from({ length: 4 }, (_, i) => Object.freeze({ i, j, pc: pitchClass([i, j]) }))).flat()
);
export const FIXED_CHORD_GRID = Object.freeze(
  Array.from({ length: 11 }, (_, iIndex) => Array.from({ length: 14 }, (_, jIndex) => Object.freeze([iIndex - 3, jIndex - 7]))).flat()
);

const esc = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[character]));

const rounded = (value) => Number(value).toFixed(2);

function fitLattice(coords, width, height, padding) {
  const raw = coords.map(([i, j]) => ({ i, j, ...point([i, j], 1) }));
  const minX = Math.min(...raw.map(({ x }) => x));
  const maxX = Math.max(...raw.map(({ x }) => x));
  const minY = Math.min(...raw.map(({ y }) => y));
  const maxY = Math.max(...raw.map(({ y }) => y));
  const scale = Math.min(
    (width - padding * 2) / Math.max(1, maxX - minX),
    (height - padding * 2) / Math.max(1, maxY - minY)
  );
  return raw.map((entry) => ({
    ...entry,
    x: width / 2 + (entry.x - (minX + maxX) / 2) * scale,
    y: height / 2 + (entry.y - (minY + maxY) / 2) * scale
  })).concat([{ __fit: true, scale }]);
}

function shortenedLine(from, to, inset = 45) {
  const dx = to.x - from.x, dy = to.y - from.y;
  const length = Math.hypot(dx, dy) || 1;
  return {
    x1: from.x + dx / length * inset,
    y1: from.y + dy / length * inset,
    x2: to.x - dx / length * inset,
    y2: to.y - dy / length * inset
  };
}

/**
 * Twelve pitch classes stay on one chromatic circle. `fifths` only adds the
 * +7 directed path; it never computes a second set of node positions.
 */
export function ringSVG({ fifths = false } = {}) {
  const width = 1140, height = 520, cx = 570, cy = 260, rx = 315, ry = 205;
  const positions = Array.from({ length: 12 }, (_, pc) => {
    const angle = -Math.PI / 2 + pc * Math.PI * 2 / 12;
    return { pc, x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });
  const perimeter = positions.map((from, pc) => {
    const to = positions[(pc + 1) % 12];
    return `<line class="chromatic-link" data-from-pc="${pc}" data-to-pc="${(pc + 1) % 12}" x1="${rounded(from.x)}" y1="${rounded(from.y)}" x2="${rounded(to.x)}" y2="${rounded(to.y)}"/>`;
  }).join("");
  const fifthLinks = fifths ? FIFTH_ORDER.map((fromPc, step) => {
    const toPc = FIFTH_ORDER[(step + 1) % FIFTH_ORDER.length];
    const line = shortenedLine(positions[fromPc], positions[toPc], 48);
    return `<line class="fifth-link" data-fifth-step="${step}" data-from-pc="${fromPc}" data-to-pc="${toPc}" x1="${rounded(line.x1)}" y1="${rounded(line.y1)}" x2="${rounded(line.x2)}" y2="${rounded(line.y2)}" marker-end="url(#karaoke-fifth-arrow)"/>`;
  }).join("") : "";
  const nodes = positions.map(({ pc, x, y }) => `<g class="tone-node" data-pc="${pc}" transform="translate(${rounded(x)} ${rounded(y)})"><circle r="39"/><text y="9">${esc(GEOMETRY_NOTE_NAMES[pc])}</text></g>`).join("");
  return `<svg class="karaoke-ring ${fifths ? "shows-fifths" : "shows-chromatic"}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Twelve chromatic notes${fifths ? " with the circle of fifths" : ""}"><defs><marker id="karaoke-fifth-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 Z"/></marker></defs><g class="chromatic-links">${perimeter}</g><g class="fifth-links">${fifthLinks}</g><g class="ring-notes">${nodes}</g></svg>`;
}

export function translatedCell(a = 0, b = 0) {
  const [u, v] = PERIOD_VECTORS;
  return CELL_REPRESENTATIVES.map(({ i, j, pc }) => ({
    i: i + a * u[0] + b * v[0],
    j: j + a * u[1] + b * v[1],
    pc,
    copyA: a,
    copyB: b,
    origin: a === 0 && b === 0
  }));
}

function expandedRepresentatives() {
  const notes = [];
  for (let b = -3; b <= 3; b += 1) {
    for (let a = -5; a <= 5; a += 1) notes.push(...translatedCell(a, b));
  }
  return notes;
}

function cellEdges(positionByCoord) {
  const directions = [[1, 0, "fifth"], [0, 1, "major-third"], [1, -1, "minor-third"]];
  const edges = [];
  for (const note of positionByCoord.values()) {
    for (const [di, dj, interval] of directions) {
      const next = positionByCoord.get(`${note.i + di},${note.j + dj}`);
      if (!next) continue;
      edges.push(`<line class="cell-edge ${interval}" data-interval="${interval}" x1="${rounded(note.x)}" y1="${rounded(note.y)}" x2="${rounded(next.x)}" y2="${rounded(next.y)}"/>`);
    }
  }
  return edges.join("");
}

/** One exact 12-note period or a rectangular two-dimensional period tiling. */
export function tonnetzCellSVG(expanded = false, { compact = false, axes = true } = {}) {
  const width = compact ? 760 : 1140;
  const height = compact ? 440 : 520;
  const source = expanded ? expandedRepresentatives() : translatedCell(0, 0);
  const coords = source.map(({ i, j }) => [i, j]);
  const fitted = expanded
    ? coords.map(([i, j]) => ({ i, j, ...point([i - 1.5, j - 1], 75, { x: width / 2, y: height / 2 }) })).concat([{ __fit: true, scale: 75 }])
    : fitLattice(coords, width, height, compact ? 42 : 30);
  const fit = fitted.pop();
  const radius = Math.min(expanded ? 29 : compact ? 31 : 38, fit.scale * .36);
  const positioned = source.map((note, index) => ({ ...note, x: fitted[index].x, y: fitted[index].y }));
  const byCoord = new Map(positioned.map((note) => [`${note.i},${note.j}`, note]));
  const nodes = positioned.map((note) => `<g class="cell-note ${note.origin ? "origin-cell" : "copy-cell"}" data-pc="${note.pc}" data-i="${note.i}" data-j="${note.j}" data-copy-a="${note.copyA}" data-copy-b="${note.copyB}" data-x="${rounded(note.x)}" data-y="${rounded(note.y)}" data-radius="${rounded(radius)}"><path d="${hexPath(note.x, note.y, radius)}"/><text x="${rounded(note.x)}" y="${rounded(note.y + Math.max(5, radius * .25))}">${esc(GEOMETRY_NOTE_NAMES[note.pc])}</text></g>`).join("");
  const origin = positioned.find(({ i, j, origin: isOrigin }) => isOrigin && i === 0 && j === 0) || positioned.find(({ origin: isOrigin }) => isOrigin);
  let axisMarkup = "";
  if (!expanded && axes && origin) {
    const fifth = byCoord.get(`${origin.i + 1},${origin.j}`);
    const third = byCoord.get(`${origin.i},${origin.j + 1}`);
    axisMarkup = `<g class="cell-axes" aria-hidden="true">${fifth ? `<line class="axis fifth" x1="${rounded(origin.x)}" y1="${rounded(origin.y)}" x2="${rounded(fifth.x)}" y2="${rounded(fifth.y)}"/><text x="${rounded((origin.x + fifth.x) / 2 - 66)}" y="${rounded((origin.y + fifth.y) / 2 - 12)}">Fifths +7</text>` : ""}${third ? `<line class="axis major-third" x1="${rounded(origin.x)}" y1="${rounded(origin.y)}" x2="${rounded(third.x)}" y2="${rounded(third.y)}"/><text x="${rounded((origin.x + third.x) / 2 + 18)}" y="${rounded((origin.y + third.y) / 2 - 12)}">Major 3rds +4</text>` : ""}</g>`;
  }
  return `<svg class="tonnetz-cell ${expanded ? "is-expanded" : "is-one-cell"} ${compact ? "is-compact" : ""}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${expanded ? "Repeated two-dimensional Tonnetz cells" : "One twelve-note Tonnetz cell"}"><g class="cell-edges">${cellEdges(byCoord)}</g>${nodes}${axisMarkup}</svg>`;
}

function fixedChordFit() {
  const width = 1100, height = 560;
  const scale = 108;
  const positions = FIXED_CHORD_GRID.map(([i, j]) => ({ i, j, ...point([i, j], scale, { x: 620, y: 390 }) }));
  return { width, height, scale, positions };
}

/** Every chord is drawn on the same coordinates and the same viewBox. */
export function fixedChordSVG(shape) {
  if (!shape?.coords) throw new TypeError("shape.coords is required");
  const { width, height, scale, positions } = fixedChordFit();
  const selected = new Set(shape.coords.map(([i, j]) => `${i},${j}`));
  const radius = scale * .43;
  const nodes = positions.map(({ i, j, x, y }) => {
    const highlighted = selected.has(`${i},${j}`);
    const pc = pitchClass([i, j]);
    return `<g class="fixed-key ${highlighted ? `is-highlight ${esc(shape.quality || "major")}` : ""}" data-i="${i}" data-j="${j}" data-pc="${pc}"><path d="${hexPath(x, y, radius)}"/><text x="${rounded(x)}" y="${rounded(y + Math.max(6, radius * .24))}">${esc(GEOMETRY_NOTE_NAMES[pc])}</text></g>`;
  }).join("");
  return `<svg class="fixed-chord" viewBox="0 0 ${width} ${height}" role="img" aria-label="Chord on a fixed Tonnetz grid"><g class="fixed-edges">${cellEdges(new Map(positions.map((note) => [`${note.i},${note.j}`, note])))}</g>${nodes}</svg>`;
}

/** Compact playable legend; the parent binds click/keyboard handlers to each group. */
export function edgeLegendSVG() {
  const entries = [
    { id: "fifth", label: "Fifth", semitones: 7, coord: [1, 0], color: "orange" },
    { id: "major-third", label: "Major 3rd", semitones: 4, coord: [0, 1], color: "teal" },
    { id: "minor-third", label: "Minor 3rd", semitones: 3, coord: [1, -1], color: "violet" }
  ];
  const groups = entries.map((entry, index) => {
    const origin = { x: 70 + index * 350, y: 83 };
    const delta = point(entry.coord, 64);
    const end = { x: origin.x + delta.x, y: origin.y + delta.y };
    return `<g class="edge-legend-item ${entry.color}" role="button" tabindex="0" aria-label="Play ${entry.label}" data-interval="${entry.id}" data-semitones="${entry.semitones}" data-from-midi="60" data-to-midi="${60 + entry.semitones}"><line x1="${rounded(origin.x)}" y1="${rounded(origin.y)}" x2="${rounded(end.x)}" y2="${rounded(end.y)}"/><circle cx="${rounded(origin.x)}" cy="${rounded(origin.y)}" r="9"/><circle cx="${rounded(end.x)}" cy="${rounded(end.y)}" r="9"/><text x="${55 + index * 350}" y="142">${entry.label} · ${entry.semitones} semitones</text></g>`;
  }).join("");
  return `<svg class="edge-legend" viewBox="0 0 1100 170" role="group" aria-label="Tonnetz intervals">${groups}</svg>`;
}
