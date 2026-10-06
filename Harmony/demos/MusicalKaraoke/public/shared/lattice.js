import { NOTE_NAMES, pitchClass } from "./music-data.js";

export const BASIS = {
  e5: { x: 0.2398, y: -0.9708 },
  e3: { x: 0.9606, y: -0.2781 },
  appU: { x: 0.9606, y: -0.2781 },
  appV: { x: -0.2398, y: 0.9708 }
};

export const point = ([i, j], scale = 58, origin = { x: 0, y: 0 }) => ({
  x: origin.x + scale * (i * BASIS.e5.x + j * BASIS.e3.x),
  y: origin.y + scale * (i * BASIS.e5.y + j * BASIS.e3.y)
});

const esc = (value) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));

export function hexPath(x, y, radius) {
  return Array.from({ length: 6 }, (_, side) => {
    const angle = -Math.PI / 2 - 0.282 + side * Math.PI / 3;
    return `${side ? "L" : "M"}${(x + Math.cos(angle) * radius).toFixed(2)},${(y + Math.sin(angle) * radius).toFixed(2)}`;
  }).join(" ") + " Z";
}

export function keyboardSVG({ coords = [], highlight = [], width = 420, height = 235, scale = 48, labels = true, quality = "major", className = "", origin = null } = {}) {
  const highlightSet = new Set(highlight.map(([i, j]) => `${i},${j}`));
  const keys = coords.length ? coords : (() => {
    const values = [];
    for (let i = -2; i <= 3; i += 1) for (let j = -3; j <= 3; j += 1) values.push([i, j]);
    return values;
  })();
  const pts = keys.map((coord) => ({ coord, ...point(coord, scale, origin || { x: width / 2, y: height / 2 }) }));
  const body = pts.map(({ coord, x, y }) => {
    const selected = highlightSet.has(`${coord[0]},${coord[1]}`);
    return `<g class="lattice-key ${selected ? `is-highlight ${esc(quality)}` : ""}" data-i="${coord[0]}" data-j="${coord[1]}" data-pc="${pitchClass(coord)}"><path d="${hexPath(x, y, scale * .55)}"/><text x="${x}" y="${y + 5}">${labels ? esc(NOTE_NAMES[pitchClass(coord)]) : ""}</text></g>`;
  }).join("");
  return `<svg class="keyboard-svg ${esc(className)}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Tonnetz keyboard diagram">${body}</svg>`;
}

export function chordSVG(chord, options = {}) {
  const width = options.width || 420, height = options.height || 235, scale = options.scale || 48;
  const raw = chord.coords.map((coord) => point(coord, scale));
  const center = { x: (Math.min(...raw.map((p) => p.x)) + Math.max(...raw.map((p) => p.x))) / 2, y: (Math.min(...raw.map((p) => p.y)) + Math.max(...raw.map((p) => p.y))) / 2 };
  const all = [];
  for (let i = -3; i <= 5; i += 1) for (let j = -5; j <= 5; j += 1) all.push([i, j]);
  return keyboardSVG({ ...options, width, height, scale, origin: { x: width / 2 - center.x, y: height / 2 - center.y }, coords: all, highlight: chord.coords, quality: chord.quality, labels: false });
}

export function latticeSceneSVG({ mode = "kitaev", dualStep = 0 } = {}) {
  const width = 1080, height = 590, scale = 74, origin = { x: 520, y: 300 };
  const coords = [];
  for (let i = -4; i <= 4; i += 1) for (let j = -5; j <= 5; j += 1) coords.push([i, j]);
  const sites = coords.map((coord) => ({ coord, ...point(coord, scale, origin) })).filter((p) => p.x > 20 && p.x < width - 20 && p.y > 20 && p.y < height - 20);
  const by = new Map(sites.map((p) => [p.coord.join(","), p]));
  const edges = [];
  const dirs = [[1, 0, "fifth"], [0, 1, "major-third"], [1, -1, "minor-third"]];
  sites.forEach((p) => dirs.forEach(([di, dj, cls]) => {
    const q = by.get(`${p.coord[0] + di},${p.coord[1] + dj}`);
    if (q) edges.push(`<line class="dual-edge ${cls}" x1="${p.x}" y1="${p.y}" x2="${q.x}" y2="${q.y}"/>`);
  }));
  const radius = scale / Math.sqrt(3);
  const vertexMap = new Map();
  const bonds = [];
  sites.forEach((p) => {
    const vertices = Array.from({ length: 6 }, (_, side) => {
      const angle = -Math.PI / 2 - 0.282 + side * Math.PI / 3;
      return { x: p.x + Math.cos(angle) * radius, y: p.y + Math.sin(angle) * radius };
    });
    vertices.forEach((v, side) => {
      const key = `${Math.round(v.x)},${Math.round(v.y)}`;
      if (!vertexMap.has(key)) vertexMap.set(key, { ...v, sub: side % 2 });
      const q = vertices[(side + 1) % 6];
      if (side < 3) bonds.push(`<line class="honey-bond bond-${["x", "z", "y"][side]}" x1="${v.x}" y1="${v.y}" x2="${q.x}" y2="${q.y}"/>`);
    });
  });
  const keys = bonds.join("") + [...vertexMap.values()].map((v) => `<circle class="spin-site sub-${v.sub}" cx="${v.x}" cy="${v.y}" r="5.5"/>`).join("");
  const dualEdges = edges.join("");
  const nodes = sites.map((p) => `<g class="dual-site" data-pc="${pitchClass(p.coord)}" data-i="${p.coord[0]}" data-j="${p.coord[1]}"><circle cx="${p.x}" cy="${p.y}" r="18"/><text x="${p.x}" y="${p.y + 6}">${mode === "pivot" ? esc(NOTE_NAMES[pitchClass(p.coord)]) : ""}</text></g>`).join("");
  const focus = point([0, 0], scale, origin);
  const major = [[0, 0], [0, 1], [1, 0]].map((c) => point(c, scale, origin));
  const triangle = `<path class="major-triangle" d="M${major.map((p) => `${p.x},${p.y}`).join(" L")} Z"/>`;
  return `<svg class="lattice-scene mode-${mode} dual-step-${dualStep}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${mode === "kitaev" ? "Kitaev honeycomb lattice" : mode === "dual" ? "Honeycomb and triangular dual lattice" : "Tonnetz note lattice"}"><g class="honey-layer">${keys}</g><g class="bond-labels"><text x="${focus.x - 18}" y="${focus.y - 48}">x</text><text x="${focus.x + 47}" y="${focus.y - 4}">y</text><text x="${focus.x - 54}" y="${focus.y + 14}">z</text></g><g class="dual-layer">${dualEdges}${mode === "pivot" ? triangle : ""}${nodes}</g><circle class="focus-plaquette" cx="${focus.x}" cy="${focus.y}" r="${radius * .98}"/><text class="plaquette-label" x="${focus.x + 55}" y="${focus.y + 72}">plaquette</text></svg>`;
}

export function appLayoutSnapshot({ layout = "harmonic", columns = 13, rows = 8, width = 700, height = 360, highlightPcs = [0, 4, 7] } = {}) {
  const U = BASIS.appU, V = BASIS.appV;
  const columnStep = layout === "harmonic" ? 4 : layout === "melodic" ? 2 : 2;
  const rowStep = layout === "harmonic" || layout === "melodic" ? 7 : 1;
  const columnStart = (col) => Math.floor((2 * col + 4) / 7);
  const rowRange = (col) => {
    let first = 0, last = rows - 1;
    if (col === 0) last = Math.max(1, rows - 4);
    else if (col === 1) last = Math.max(2, rows - 2);
    else if (col === columns - 2) first = Math.min(1, rows - 2);
    else if (col === columns - 1) first = Math.min(3, rows - 2);
    return [first, last];
  };
  const positions = [];
  for (let col = 0; col < columns; col += 1) {
    const [first, last] = rowRange(col);
    for (let row = first; row <= last; row += 1) {
      const latticeRow = columnStart(col) + row;
      const centerCol = (columns - 1) / 2;
      const lowCenterCol = Math.floor(centerCol), highCenterCol = Math.ceil(centerCol);
      const centerStart = columnStart(lowCenterCol) + (columnStart(highCenterCol) - columnStart(lowCenterCol)) * (centerCol - lowCenterCol);
      const centerLatticeRow = centerStart + (rows - 1) / 2;
      const midi = Math.round(60 + (col - centerCol) * columnStep - (latticeRow - centerLatticeRow) * rowStep);
      positions.push({ col, row, midi, pc: ((midi % 12) + 12) % 12, x: col * U.x + latticeRow * V.x, y: col * U.y + latticeRow * V.y });
    }
  }
  const minX = Math.min(...positions.map((p) => p.x)), maxX = Math.max(...positions.map((p) => p.x));
  const minY = Math.min(...positions.map((p) => p.y)), maxY = Math.max(...positions.map((p) => p.y));
  const scale = Math.min((width - 80) / (maxX - minX + 1.2), (height - 44) / (maxY - minY + 1.3));
  const center = { x: width / 2 - (minX + maxX) * scale / 2, y: height / 2 - (minY + maxY) * scale / 2 };
  const chosen = new Set();
  if (layout === "harmonic") {
    const origins = positions.filter((p) => p.pc === 0).sort((a, b) => Math.hypot(a.x - (minX + maxX) / 2, a.y - (minY + maxY) / 2) - Math.hypot(b.x - (minX + maxX) / 2, b.y - (minY + maxY) / 2));
    const origin = origins.find((root) => {
      const rootLR = columnStart(root.col) + root.row;
      return [[0, 0], [0, 1], [1, 0]].every(([i, j]) => positions.some((p) => p.col === root.col + j && columnStart(p.col) + p.row === rootLR - i));
    });
    if (origin) {
      const rootLR = columnStart(origin.col) + origin.row;
      [[0, 0], [0, 1], [1, 0]].forEach(([i, j]) => {
        const key = positions.find((p) => p.col === origin.col + j && columnStart(p.col) + p.row === rootLR - i);
        if (key) chosen.add(`${key.row}-${key.col}`);
      });
    }
  } else if (layout === "classic") {
    [60, 64, 67].forEach((midi) => {
      const candidate = positions.filter((p) => p.midi === midi).sort((a, b) => Math.hypot(a.x - (minX + maxX) / 2, a.y - (minY + maxY) / 2) - Math.hypot(b.x - (minX + maxX) / 2, b.y - (minY + maxY) / 2))[0];
      if (candidate) chosen.add(`${candidate.row}-${candidate.col}`);
    });
  } else {
    highlightPcs.forEach((pc) => {
      const candidate = positions.filter((p) => p.pc === pc).sort((a, b) => Math.hypot(a.x - (minX + maxX) / 2, a.y - (minY + maxY) / 2) - Math.hypot(b.x - (minX + maxX) / 2, b.y - (minY + maxY) / 2))[0];
      if (candidate) chosen.add(`${candidate.row}-${candidate.col}`);
    });
  }
  const APP_NOTE_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
  const keys = positions.map((p) => {
    const x = center.x + p.x * scale, y = center.y + p.y * scale;
    const selected = chosen.has(`${p.row}-${p.col}`);
    const sharp = ![0, 2, 4, 5, 7, 9, 11].includes(p.pc);
    return `<g class="snapshot-key ${selected ? "is-highlight" : ""} ${layout === "classic" && sharp ? "sharp" : "natural"}" data-midi="${p.midi}" data-pc="${p.pc}" data-row="${p.row}" data-col="${p.col}"><path d="${hexPath(x, y, scale / Math.sqrt(3))}"/><text x="${x}" y="${y + 5}">${esc(APP_NOTE_NAMES[p.pc])}</text></g>`;
  }).join("");
  return `<svg class="app-layout-snapshot ${layout}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Actual ${layout} layout exported from the local instrument geometry">${keys}</svg>`;
}
