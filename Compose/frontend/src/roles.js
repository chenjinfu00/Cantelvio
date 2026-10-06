/** Instrument-group roles for the console status bars.
 *
 * Describes the texture of one bar from the notes each group actually plays:
 * Melody 1 (the most prominent line), Melody 2, 3 … (further independent
 * lines), Bass, Harmony and Rhythm. A group may hold several roles at once.
 *
 * Evidence: pitch height (who sounds the top or the bottom, and for how long),
 * melodic movement, simultaneous notes, steady repetition and, when the
 * generator reports it, the line each note was sampled for (v2 console lanes:
 * melody / harmony / bass). This is a deterministic description of notes that
 * were already generated. It runs no model, never changes a note and is not a
 * trained role classifier.
 *
 * Times are quarter notes relative to the analysed bar. Notes from the previous
 * bar (negative start) give melodic context and carried-over sound.
 */
export const ROLE_ORDER = Object.freeze(['melody', 'bass', 'harmony', 'rhythm']);
export const ROLE_COPY = Object.freeze({
  melody: {en: 'Melody', zh: '旋律'}, bass: {en: 'Bass', zh: '低音'},
  harmony: {en: 'Harmony', zh: '和声'}, rhythm: {en: 'Rhythm', zh: '节奏'},
});
/** v2 performance payload `role`: the console line a note was sampled for. */
export const V2_LANES = Object.freeze(['harmony', 'bass', 'melody']);
const EPS = 1e-6;
const KEY = t => Math.round(t * 1e6);
const clamp01 = x => Math.max(0, Math.min(1, x));
const median = values => {
  if (!values.length) return NaN;
  const s = [...values].sort((a, b) => a - b), m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const sounding = (notes, beats) => notes.filter(n => n.end > EPS && n.start < beats - EPS);

/** One entry per onset: highest and lowest pitch starting there, chord size. */
function onsets(notes) {
  const map = new Map();
  for (const n of notes) {
    const k = KEY(n.start), item = map.get(k);
    if (!item) map.set(k, {time: n.start, top: n.pitch, low: n.pitch, size: 1});
    else { item.top = Math.max(item.top, n.pitch); item.low = Math.min(item.low, n.pitch); item.size++; }
  }
  return [...map.values()].sort((a, b) => a.time - b.time);
}

/** Shape of a top line over the previous and current bar. */
function shape(notes, beats) {
  const all = onsets(notes), cur = all.filter(o => o.time > -EPS && o.time < beats - EPS);
  const leaps = [];
  for (let i = 1; i < all.length; i++) { const d = Math.abs(all[i].top - all[i - 1].top); if (d) leaps.push(d); }
  const gaps = [];
  for (let i = 1; i < cur.length; i++) gaps.push(cur[i].time - cur[i - 1].time);
  const mean = gaps.reduce((a, b) => a + b, 0) / (gaps.length || 1);
  const spread = Math.sqrt(gaps.reduce((a, b) => a + (b - mean) ** 2, 0) / (gaps.length || 1));
  let repeats = 0;
  for (let i = 1; i < cur.length; i++)
    if (cur[i].top === cur[i - 1].top && cur[i].low === cur[i - 1].low && cur[i].size === cur[i - 1].size) repeats++;
  return {
    all: all.length, current: cur.length, distinct: new Set(all.map(o => o.top)).size,
    conjunct: leaps.length ? leaps.filter(d => d <= 4).length / leaps.length : 0,
    wide: leaps.length ? leaps.filter(d => d >= 8).length / leaps.length : 0,
    single: all.length ? all.filter(o => o.size === 1).length / all.length : 1,
    register: median((cur.length ? cur : all).map(o => o.top)),
    steady: gaps.length >= 3 && mean > 0 && spread / mean <= .35,
    repeats: cur.length > 1 ? repeats / (cur.length - 1) : 0,
  };
}

/** Share of the bar's sounding time in which each unit holds the global top or
 * bottom pitch, and the share of its own sounding time with 2+ notes. */
function measure(units, beats) {
  const cuts = new Set([0, KEY(beats)]);
  for (const u of units) for (const n of u.current) { cuts.add(KEY(Math.max(0, n.start))); cuts.add(KEY(Math.min(beats, n.end))); }
  const times = [...cuts].sort((a, b) => a - b).map(k => k / 1e6);
  let total = 0;
  for (const u of units) Object.assign(u, {top: 0, bottom: 0, time: 0, chordal: 0});
  for (let i = 0; i + 1 < times.length; i++) {
    const dt = times[i + 1] - times[i], mid = times[i] + dt / 2;
    if (dt <= EPS) continue;
    let hi = -Infinity, lo = Infinity;
    const here = [];
    for (const u of units) {
      let uh = -Infinity, ul = Infinity, count = 0;
      for (const n of u.current) if (n.start <= mid && mid < n.end) { uh = Math.max(uh, n.pitch); ul = Math.min(ul, n.pitch); count++; }
      if (count) { here.push([u, uh, ul, count]); hi = Math.max(hi, uh); lo = Math.min(lo, ul); }
    }
    if (!here.length) continue;
    total += dt;
    for (const [u, uh, ul, count] of here) {
      u.time += dt;
      if (count > 1) u.chordal += dt;
      if (uh === hi) u.top += dt;
      if (ul === lo) u.bottom += dt;
    }
  }
  for (const u of units) {
    u.chordal = u.time ? u.chordal / u.time : 0;
    u.top = total ? u.top / total : 0;
    u.bottom = total ? u.bottom / total : 0;
  }
}

/** True when `unit` repeats `lead`'s line in unison or octaves during this bar. */
function doubles(unit, lead, field = 'top') {
  const a = onsets(unit.current).filter(o => o.time > -EPS), b = new Map(onsets(lead.current).map(o => [KEY(o.time), o]));
  if (a.length < 2) return false;
  let same = 0;
  for (const o of a) { const m = b.get(KEY(o.time)); if (m && m[field] % 12 === o[field] % 12) same++; }
  return same / a.length >= .7;
}

const laneShare = (notes, lane) => notes.length ? notes.filter(n => n.lane === lane).length / notes.length : 0;

/** Further independent lines inside one group, from the model's voice identity. */
function extraLines(unit, beats) {
  const voices = new Map();
  for (const n of unit.notes) if (n.voice != null) {
    if (!voices.has(n.voice)) voices.set(n.voice, []);
    voices.get(n.voice).push(n);
  }
  if (voices.size < 2) return [];
  const lines = [...voices.values()].map(notes => {
    const current = sounding(notes, beats), s = shape(notes, beats);
    const clear = s.current >= 3 && s.single >= .75 && s.conjunct >= .5 && s.wide <= .25;
    const sampled = laneShare(current, 'melody') >= .5 && s.current >= 2 && s.distinct >= 2;
    return {notes, current, register: s.register, line: clear || sampled};
  }).filter(l => l.current.length).sort((a, b) => b.register - a.register);
  const out = [];
  for (const [i, l] of lines.entries()) {
    if (i === 0 || !l.line) continue;
    if (lines.slice(0, i).some(prev => doubles(l, prev))) continue;
    out.push(l);
  }
  return out;
}

/**
 * @param {object} input
 * @param {Array<{group:string,voice?:string,lane?:string,pitch:number,start:number,end:number,velocity?:number}>} input.notes
 *   audible pitched notes; quarter-note times relative to this bar
 * @param {number} input.beats  bar length in quarter notes
 * @param {string[]} input.groups  group ids to report
 * @param {object|null} [input.previous]  previous bar's result (steadier Melody 1 on near ties)
 * @returns {{groups:Object<string,{sounding:boolean,roles:Array<{role:string,rank?:number}>}>,leadGroup:string|null,detail:Array}}
 */
export function analyzeGroupRoles({notes, beats, groups, previous = null}) {
  const units = [];
  for (const id of groups) {
    const own = (notes || []).filter(n => n && n.group === id && Number.isFinite(n.pitch) &&
      Number.isFinite(n.start) && Number.isFinite(n.end) && n.end > n.start + EPS);
    const current = sounding(own, beats);
    if (current.length) units.push({id, notes: own, current, roles: new Set(), ranks: []});
  }
  const pitched = units.filter(u => u.id !== 'percussion');
  measure(pitched, beats);
  const loudest = Math.max(0, ...pitched.flatMap(u => u.current.map(n => n.velocity ?? .6)));
  for (const u of pitched) {
    u.shape = shape(u.notes, beats);
    u.loudness = loudest > 0 ? clamp01(Math.max(...u.current.map(n => n.velocity ?? .6)) / loudest) : 1;
    u.floor = median(u.current.map(n => n.pitch));
    u.lane = Object.fromEntries(V2_LANES.map(lane => [lane, laneShare(u.current, lane)]));
  }

  // Bass: the group that most often sounds the lowest pitch, provided it lies
  // low; groups sharing that bottom (unison or octave doubling) are bass too.
  const bass = new Set();
  const lowest = [...pitched].sort((a, b) => (b.bottom + .3 * b.lane.bass) - (a.bottom + .3 * a.lane.bass) || a.floor - b.floor)[0];
  if (pitched.length > 1 && lowest.floor <= 64 && (lowest.bottom >= .3 || lowest.lane.bass >= .5)) {
    bass.add(lowest);
    for (const u of pitched) if (u !== lowest && u.floor <= 67 && (u.bottom >= .3 || doubles(u, lowest, 'low'))) bass.add(u);
  }

  // Melody: the most prominent moving line is Melody 1; further groups need an
  // independent line of their own. Doubling groups share the same number.
  const lead = previous?.leadGroup;
  const candidates = [];
  for (const u of pitched) {
    const s = u.shape, solo = pitched.length === 1;
    const moving = s.current >= 1 && s.all >= 3 && s.distinct >= 2;
    if (!solo && (bass.has(u) || !moving)) continue;
    const activity = clamp01(s.current / Math.max(1, beats)), register = clamp01((s.register - 48) / 36);
    u.salience = .35 * u.top + .2 * activity + .2 * (1 - s.wide) + .1 * register + .1 * u.loudness +
      .25 * u.lane.melody - .1 * u.lane.harmony + (u.id === lead ? .05 : 0);
    candidates.push(u);
  }
  candidates.sort((a, b) => b.salience - a.salience || b.shape.register - a.shape.register || groups.indexOf(a.id) - groups.indexOf(b.id));
  const leaders = [];
  for (const u of candidates) {
    const s = u.shape, twin = leaders.find(l => doubles(u, l));
    if (twin) { u.ranks.push(twin.ranks[0]); continue; }
    const first = !leaders.length && u.salience >= .3;
    // Notes sampled as harmony (chord tones only) count as a further melody only
    // when they move mostly by step; notes sampled as melody need less evidence.
    const melodic = u.lane.harmony >= .5 ? s.current >= 3 && s.single >= .6 && s.conjunct >= .5 :
      (s.current >= 3 && s.single >= .6 && (s.conjunct >= .4 || s.wide <= .3)) || (u.lane.melody >= .5 && s.current >= 2);
    if (!first && !(leaders.length && melodic && u.salience >= .35)) continue;
    u.ranks.push(leaders.length + 1);
    leaders.push(u);
  }
  let next = leaders.length + 1;
  for (const u of leaders.slice()) for (const _ of extraLines(u, beats)) u.ranks.push(next++);

  for (const u of units) {
    if (u.id === 'percussion') { u.roles.add('rhythm'); continue; }
    const s = u.shape;
    if (bass.has(u)) u.roles.add('bass');
    // Chords inside a melody or bass group add Harmony, unless they are already
    // explained as that group's further melody lines.
    if (!u.ranks.length && !bass.has(u)) u.roles.add('harmony');
    else if (u.chordal >= .4 && u.ranks.length <= 1) u.roles.add('harmony');
    if (!u.ranks.includes(1) && s.current >= Math.max(4, beats) && s.steady && s.repeats >= .5) u.roles.add('rhythm');
  }

  const result = {};
  for (const id of groups) {
    const u = units.find(x => x.id === id);
    if (!u) { result[id] = {sounding: false, roles: []}; continue; }
    const roles = [...new Set(u.ranks)].sort((a, b) => a - b).map(rank => ({role: 'melody', rank}));
    for (const role of ROLE_ORDER.slice(1)) if (u.roles.has(role)) roles.push({role});
    result[id] = {sounding: true, roles};
  }
  const round = v => typeof v === 'number' ? Math.round(v * 1000) / 1000 : v;
  return {groups: result, leadGroup: units.find(u => u.ranks[0] === 1)?.id ?? null,
    detail: pitched.map(u => ({group: u.id, top: round(u.top), bottom: round(u.bottom), chordal: round(u.chordal),
      salience: round(u.salience ?? null), lane: u.lane, ...Object.fromEntries(Object.entries(u.shape).map(([k, v]) => [k, round(v)]))}))};
}

/** Display label, e.g. "Melody 1" / "旋律 1". */
export function roleLabel(item, language = 'en') {
  const copy = ROLE_COPY[item.role];
  const name = language === 'en' ? copy.en : copy.zh;
  return item.role === 'melody' ? `${name} ${item.rank}` : name;
}
