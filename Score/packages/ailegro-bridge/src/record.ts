/** Export a ScoreDoc as a Cantelvio exact-notation score record (ailegro.score-record/1). */
import {
  type DynamicValue,
  type Interval,
  type NoteEvent,
  type Provenance,
  type Rational,
  type ScoreDoc,
  add,
  allStaves,
  cmp,
  eq,
  findInstrument,
  getInstrument,
  isUnison,
  keyTonicPitchClass,
  le,
  lt,
  measureInfos,
  midiOf,
  mulInt,
  stepSemitone,
  sub,
  toString as ratString,
  spannerTimes,
  tempoMap,
  transpose,
  invertInterval,
} from '@cantelvio-score/core';
import {
  RECORD_SCHEMA,
  type RecordChord,
  type RecordMeasure,
  type RecordNote,
  type RecordPart,
  type ScoreRecord,
} from './schemas';

/** MusicXML <instrument-sound> ids for the instrument catalog. */
export const MUSICXML_SOUNDS: Readonly<Record<string, string>> = {
  piccolo: 'wind.flutes.flute.piccolo',
  flute: 'wind.flutes.flute',
  'alto-flute': 'wind.flutes.flute.alto',
  recorder: 'wind.flutes.recorder.soprano',
  oboe: 'wind.reed.oboe',
  'english-horn': 'wind.reed.english-horn',
  'clarinet-eb': 'wind.reed.clarinet.eflat',
  'clarinet-bb': 'wind.reed.clarinet.bflat',
  'clarinet-a': 'wind.reed.clarinet.a',
  'bass-clarinet': 'wind.reed.clarinet.bass',
  'soprano-sax': 'wind.reed.saxophone.soprano',
  'alto-sax': 'wind.reed.saxophone.alto',
  'tenor-sax': 'wind.reed.saxophone.tenor',
  'baritone-sax': 'wind.reed.saxophone.baritone',
  bassoon: 'wind.reed.bassoon',
  contrabassoon: 'wind.reed.contrabassoon',
  'horn-f': 'brass.french-horn',
  'trumpet-bb': 'brass.trumpet.bflat',
  'trumpet-c': 'brass.trumpet.c',
  'cornet-bb': 'brass.cornet',
  flugelhorn: 'brass.flugelhorn',
  trombone: 'brass.trombone',
  'bass-trombone': 'brass.trombone.bass',
  euphonium: 'brass.euphonium',
  tuba: 'brass.tuba',
  timpani: 'drum.timpani',
  xylophone: 'pitched-percussion.xylophone',
  glockenspiel: 'pitched-percussion.glockenspiel',
  vibraphone: 'pitched-percussion.vibraphone',
  marimba: 'pitched-percussion.marimba',
  'snare-drum': 'drum.snare-drum',
  'bass-drum': 'drum.bass-drum',
  cymbals: 'metal.cymbal.crash',
  triangle: 'metal.triangle',
  'drum-set': 'drum.group.set',
  harp: 'pluck.harp',
  celesta: 'keyboard.celesta',
  piano: 'keyboard.piano',
  harpsichord: 'keyboard.harpsichord',
  organ: 'keyboard.organ.pipe',
  guitar: 'pluck.guitar.nylon-string',
  soprano: 'voice.soprano',
  'mezzo-soprano': 'voice.mezzo-soprano',
  alto: 'voice.alto',
  tenor: 'voice.tenor',
  baritone: 'voice.baritone',
  'bass-voice': 'voice.bass',
  violin: 'strings.violin',
  viola: 'strings.viola',
  cello: 'strings.cello',
  'double-bass': 'strings.contrabass',
};

export interface RecordOptions {
  /** Which origins to include. Default: user, import and accepted AI material. */
  readonly include?: (p: Provenance | undefined) => boolean;
  /** Restrict to measure indices [from, to). */
  readonly bars?: { readonly from: number; readonly to: number };
  /** Restrict to these parts. */
  readonly parts?: readonly string[];
  /** Per-part musical role labels if the user assigned them. */
  readonly roles?: Readonly<Record<string, string>>;
  readonly exportedAt?: string;
  readonly license?: string;
}

export const defaultInclude = (p: Provenance | undefined): boolean =>
  !p || p.kind !== 'ai' || !!p.accepted;

const q = (r: Rational): string => ratString(mulInt(r, 4));

const STEP_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

function writtenInterval(transposition: Interval | undefined): Interval | null {
  if (!transposition || isUnison(transposition)) return null;
  return invertInterval(transposition);
}

export function buildScoreRecord(doc: ScoreDoc, options: RecordOptions = {}): ScoreRecord {
  const include = options.include ?? defaultInclude;
  const infos = measureInfos(doc);
  const fromBar = options.bars?.from ?? 0;
  const toBar = Math.min(options.bars?.to ?? infos.length, infos.length);
  const keepPart = (id: string) => !options.parts || options.parts.includes(id);
  const windowStart = infos[fromBar]?.start ?? { n: 0, d: 1 };
  const windowEnd =
    toBar < infos.length
      ? infos[toBar]!.start
      : add(infos[infos.length - 1]!.start, infos[infos.length - 1]!.length);

  const parts: RecordPart[] = doc.parts
    .filter((p) => keepPart(p.id))
    .map((p) => {
      const def = getInstrument(p.instrument);
      return {
        id: p.id,
        name: p.name,
        sound: MUSICXML_SOUNDS[p.instrument] ?? '',
        group: def.ailegroGroup,
        program: (p.midiProgram ?? def.gmProgram) + 1,
        mapping: def.family === 'voices' ? 'vocal' : 'catalog',
        instrument: p.instrument,
        staves: p.staves.length,
      };
    });

  const measures: RecordMeasure[] = infos.slice(fromBar, toBar).map((m) => ({
    number: m.index + 1,
    on: q(m.start),
    dur: q(m.length),
    meter: [m.timeSig.beats, m.timeSig.beatType],
    key: { fifths: m.keySig.fifths, mode: m.keySig.mode ?? null },
    irregular: cmp(m.length, { n: m.timeSig.beats, d: m.timeSig.beatType }) > 0,
  }));

  const notes: RecordNote[] = [];
  for (const s of allStaves(doc)) {
    if (!keepPart(s.part.id)) continue;
    const def = findInstrument(s.part.instrument);
    const toWritten = writtenInterval(s.part.transposition ?? def?.transposition);
    const unpitched = !!def?.unpitched;
    // dynamics in force on this staff
    const marks: { at: Rational; value: DynamicValue }[] = [];
    for (const info of infos) {
      for (const d of doc.content[s.staff.id]?.[info.measure.id]?.dynamics ?? [])
        marks.push({ at: add(info.start, d.offset), value: d.value });
    }
    marks.sort((a, b) => cmp(a.at, b.at));
    const dynamicAt = (t: Rational): string | null => {
      let v: string | null = null;
      for (const m of marks) if (le(m.at, t)) v = m.value;
      return v;
    };
    // hairpins of this staff: a note starting inside one carries its direction
    const wedges: { start: Rational; end: Rational; wedge: string }[] = [];
    for (const sp of doc.spanners) {
      if (sp.kind !== 'hairpin' || sp.staffId !== s.staff.id) continue;
      const t = spannerTimes(doc, sp);
      if (t) wedges.push({ ...t, wedge: sp.direction });
    }
    const wedgeAt = (t: Rational): string | null =>
      wedges.find((w) => le(w.start, t) && lt(t, w.end))?.wedge ?? null;
    for (let voice = 0; voice < 4; voice++) {
      // gather the voice timeline, merging explicit ties into single sounding notes
      type Pending = RecordNote & { startT: Rational; endT: Rational };
      const open = new Map<number, Pending>();
      const emit: Pending[] = [];
      for (const info of infos) {
        const sm = doc.content[s.staff.id]?.[info.measure.id];
        const events: readonly NoteEvent[] = sm?.voices[voice] ?? [];
        for (const e of events) {
          if (!include(e.source)) continue;
          const start = add(info.start, e.offset);
          const end = add(start, e.duration);
          const tuplet = (sm?.tuplets ?? []).find(
            (t) =>
              t.voice === voice && le(t.offset, e.offset) && lt(e.offset, add(t.offset, t.length)),
          );
          const arts = new Set(e.articulations ?? []);
          const accent = arts.has('marcato') ? 2 : arts.has('accent') ? 1 : 0;
          const nextOpen = new Map<number, Pending>();
          // grace notes: zero duration at the principal's onset (as Cantelvio reads MusicXML)
          for (const g of e.graces ?? []) {
            for (const n of g.notes) {
              const midi = midiOf(n.pitch);
              emit.push({
                part: s.part.id,
                staff: String(s.staffIndex + 1),
                voice: String(voice + 1),
                bar: info.index,
                on: q(start),
                dur: '0',
                pitch: unpitched ? null : midi,
                writtenPitch: unpitched
                  ? null
                  : toWritten
                    ? midiOf(transpose(n.pitch, toWritten))
                    : midi,
                group: def?.ailegroGroup ?? null,
                role: options.roles?.[s.part.id] ?? null,
                tuplet: null,
                dynamic: dynamicAt(start),
                wedge: wedgeAt(start),
                accent: 0,
                grace: true,
                unpitched,
                ...(unpitched ? { drum: def?.range[0] ?? null } : {}),
                id: n.id,
                ...(e.source
                  ? { source: e.source.kind === 'ai' ? `ai:${e.source.runId}` : e.source.kind }
                  : {}),
                startT: start,
                endT: start,
              });
            }
          }
          for (const n of e.notes) {
            const midi = midiOf(n.pitch);
            const prev = open.get(midi);
            if (prev && eq(prev.endT, start)) {
              // continue a tie chain: extend the earlier note
              const merged: Pending = { ...prev, dur: q(sub(end, prev.startT)), endT: end };
              emit[emit.indexOf(prev)] = merged;
              if (n.tieForward) nextOpen.set(midi, merged);
              continue;
            }
            const written = toWritten ? midiOf(transpose(n.pitch, toWritten)) : midi;
            const note: Pending = {
              part: s.part.id,
              staff: String(s.staffIndex + 1),
              voice: String(voice + 1),
              bar: info.index,
              on: q(start),
              dur: q(e.duration),
              pitch: unpitched ? null : midi,
              writtenPitch: unpitched ? null : written,
              group: def?.ailegroGroup ?? null,
              role: options.roles?.[s.part.id] ?? null,
              tuplet: tuplet ? `${tuplet.actual}:${tuplet.normal}` : null,
              dynamic: dynamicAt(start),
              wedge: wedgeAt(start),
              accent,
              grace: false,
              unpitched,
              ...(unpitched ? { drum: def?.range[0] ?? null } : {}),
              ...(n.velocity ? { velocity: n.velocity } : {}),
              id: n.id,
              ...(e.source
                ? { source: e.source.kind === 'ai' ? `ai:${e.source.runId}` : e.source.kind }
                : {}),
              startT: start,
              endT: end,
            };
            emit.push(note);
            if (n.tieForward) nextOpen.set(midi, note);
          }
          open.clear();
          for (const [k, v] of nextOpen) open.set(k, v);
        }
      }
      for (const n of emit) {
        const on = parseQ(n.on);
        if (lt(on, mulInt(windowStart, 4)) || !lt(on, mulInt(windowEnd, 4))) continue;
        const { startT: _s, endT: _e, ...rest } = n;
        notes.push(rest);
      }
    }
  }
  const partOrder = new Map(doc.parts.map((p, i) => [p.id, i]));
  notes.sort(
    (a, b) =>
      cmp(parseQ(a.on), parseQ(b.on)) ||
      partOrder.get(a.part)! - partOrder.get(b.part)! ||
      a.staff.localeCompare(b.staff) ||
      a.voice.localeCompare(b.voice) ||
      (a.pitch ?? -1) - (b.pitch ?? -1),
  );

  const harmony: RecordChord[] = [];
  for (const c of doc.harmony) {
    if (!include(c.source)) continue;
    const info = infos.find((m) => m.measure.id === c.measureId);
    if (!info || info.index < fromBar || info.index >= toBar) continue;
    const root = (((stepSemitone(c.root.step) + c.root.alter) % 12) + 12) % 12;
    harmony.push({
      bar: info.index,
      on: q(add(info.start, c.offset)),
      root,
      rootName: `${c.root.step}${c.root.alter > 0 ? '#'.repeat(c.root.alter) : 'b'.repeat(-c.root.alter)}`,
      quality: c.quality,
      bass: c.bass ? (((stepSemitone(c.bass.step) + c.bass.alter) % 12) + 12) % 12 : null,
      id: c.id,
    });
  }

  const tempo = tempoMap(doc).map((t) => ({ on: q(t.at), qpm: t.qpm, text: null }));

  const first = infos[0];
  return {
    schema: RECORD_SCHEMA,
    scoreId: doc.id,
    source: 'ailegro-score',
    composer: doc.meta.composer ?? null,
    work: doc.meta.title || null,
    movement: doc.meta.subtitle ?? null,
    compositionKey: first ? keyName(first.keySig.fifths, first.keySig.mode) : null,
    scoreSha256: null,
    parts,
    measures,
    notes,
    harmony,
    tempo,
    provenance: {
      app: 'Cantelvio Score',
      exportedAt: options.exportedAt ?? null,
      license: options.license ?? null,
    },
  };
}

function parseQ(text: string): Rational {
  const [n, d] = text.split('/');
  return { n: Number(n), d: d ? Number(d) : 1 };
}

function keyName(fifths: number, mode: 'major' | 'minor' | undefined): string {
  const pc = keyTonicPitchClass({ fifths, ...(mode ? { mode } : {}) });
  return `${STEP_NAMES[pc]} ${mode ?? 'major'}`;
}
