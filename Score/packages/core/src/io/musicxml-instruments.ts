/**
 * Map a MusicXML part to an instrument of the catalog, from (in this order) its instrument sound
 * (`<instrument-sound>`, e.g. "wind.reed.clarinet.b-flat"), its names (part name, abbreviation,
 * instrument names; English, German, Italian and French spellings) and its General MIDI program.
 * Names that depend on context are settled with it: "Bass" is a singer next to soprano, alto and
 * tenor parts (or with lyrics) and a double bass otherwise; "Alto" with an alto clef is a viola.
 */
import type { ClefType } from '../model/clef';

export interface PartIdentity {
  /** Part name, abbreviation and instrument names, most specific first. */
  readonly names: readonly string[];
  readonly sounds: readonly string[];
  /** General MIDI program, 0-based (MusicXML writes 1-based programs). */
  readonly program: number | null;
  /** MIDI channel 10, a percussion clef or unpitched notes. */
  readonly percussion: boolean;
  readonly staves: number;
  /** Clef of each staff at the start. */
  readonly clefs: readonly ClefType[];
  readonly hasLyrics: boolean;
}

export interface InstrumentGuess {
  readonly instrument: string;
  readonly by: 'sound' | 'name' | 'program' | 'fallback';
}

/** Lower case, no diacritics, flat signs as "b", punctuation as spaces. */
export function normalizeName(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/♭/g, 'b')
    .replace(/♯/g, '#')
    .toLowerCase()
    .replace(/[^a-z0-9#]+/g, ' ')
    .trim();
}

/** Names that carry no information ("Instrument 1", "Part 2", "MusicXML Part", "P1", "Staff"). */
export function isGenericName(name: string): boolean {
  const n = normalizeName(name);
  return (
    n === '' ||
    /^(instrument|part|staff|track|stave|unnamed|untitled|musicxml part|p)( ?[0-9]+)?$/.test(n)
  );
}

// [prefix of the normalized sound id (hyphens removed), instrument]; the first match wins.
const SOUNDS: readonly (readonly [string, string])[] = [
  ['wind.flutes.flute.piccolo', 'piccolo'],
  ['wind.flutes.piccolo', 'piccolo'],
  ['wind.flutes.flute.alto', 'alto-flute'],
  ['wind.flutes.recorder', 'recorder'],
  ['wind.flutes', 'flute'],
  ['wind.reed.oboe', 'oboe'],
  ['wind.reed.englishhorn', 'english-horn'],
  ['wind.reed.clarinet.bass', 'bass-clarinet'],
  ['wind.reed.clarinet.eflat', 'clarinet-eb'],
  ['wind.reed.clarinet.a', 'clarinet-a'],
  ['wind.reed.clarinet', 'clarinet-bb'],
  ['wind.reed.saxophone.soprano', 'soprano-sax'],
  ['wind.reed.saxophone.tenor', 'tenor-sax'],
  ['wind.reed.saxophone.baritone', 'baritone-sax'],
  ['wind.reed.saxophone', 'alto-sax'],
  ['wind.reed.contrabassoon', 'contrabassoon'],
  ['wind.reed.bassoon', 'bassoon'],
  ['brass.frenchhorn', 'horn-f'],
  ['brass.horn', 'horn-f'],
  ['brass.trumpet.c', 'trumpet-c'],
  ['brass.trumpet', 'trumpet-bb'],
  ['brass.cornet', 'cornet-bb'],
  ['brass.flugelhorn', 'flugelhorn'],
  ['brass.trombone.bass', 'bass-trombone'],
  ['brass.trombone', 'trombone'],
  ['brass.euphonium', 'euphonium'],
  ['brass.baritone', 'euphonium'],
  ['brass.tuba', 'tuba'],
  ['drum.timpani', 'timpani'],
  ['pitchedpercussion.xylophone', 'xylophone'],
  ['pitchedpercussion.glockenspiel', 'glockenspiel'],
  ['pitchedpercussion.vibraphone', 'vibraphone'],
  ['pitchedpercussion.marimba', 'marimba'],
  ['pitchedpercussion.celesta', 'celesta'],
  ['drum.snaredrum', 'snare-drum'],
  ['drum.bassdrum', 'bass-drum'],
  ['metal.cymbal', 'cymbals'],
  ['metal.triangle', 'triangle'],
  ['drum', 'drum-set'],
  ['pluck.harp', 'harp'],
  ['pluck.bass', 'double-bass'],
  ['pluck.guitar', 'guitar'],
  ['keyboard.celesta', 'celesta'],
  ['keyboard.harpsichord', 'harpsichord'],
  ['keyboard.organ', 'organ'],
  ['keyboard', 'piano'],
  ['voice.soprano', 'soprano'],
  ['voice.mezzosoprano', 'mezzo-soprano'],
  ['voice.alto', 'alto'],
  ['voice.tenor', 'tenor'],
  ['voice.baritone', 'baritone'],
  ['voice.bass', 'bass-voice'],
  ['strings.violin', 'violin'],
  ['strings.viola', 'viola'],
  ['strings.cello', 'cello'],
  ['strings.contrabass', 'double-bass'],
];

type Rule = readonly [RegExp, string | ((name: string, id: PartIdentity) => string | null)];

const clarinetKey = (n: string): string => {
  if (/\bbass\b/.test(n)) return 'bass-clarinet';
  if (/\b(e ?b|e ?flat|es|mib)\b/.test(n)) return 'clarinet-eb';
  if (/\b(in a|in la|a clarinets?|cl a)\b|\ba$/.test(n) && !/\b(bb|b flat|in b|sib)\b/.test(n))
    return 'clarinet-a';
  return 'clarinet-bb';
};

const saxophone = (n: string): string =>
  /\bsoprano\b/.test(n)
    ? 'soprano-sax'
    : /\btenor\b/.test(n)
      ? 'tenor-sax'
      : /\b(baritone|bari)\b/.test(n)
        ? 'baritone-sax'
        : 'alto-sax';

const voiceByClef = (_n: string, id: PartIdentity): string => {
  const clef = id.clefs[0];
  if (clef === 'bass' || clef === 'bass8vb') return 'bass-voice';
  if (clef === 'treble8vb' || clef === 'tenor') return 'tenor';
  if (clef === 'alto') return 'alto';
  return 'soprano';
};

// Matched against each normalized name in turn; specific names come before the words they contain.
const NAME_RULES: readonly Rule[] = [
  [
    /\b(trumpets?|tromb[ae]|trompeten?|trompettes?|tpts?|trp)\b/,
    (n) => (/\b(in c|c trumpets?)\b|\bc$/.test(n) ? 'trumpet-c' : 'trumpet-bb'),
  ],
  [/\b(cornets?|cornet a pistons)\b/, 'cornet-bb'],
  [/\bflugel/, 'flugelhorn'],
  [/\b(english horns?|cor anglais|corno inglese|englischhorn|engl hn|e hn|eh)\b/, 'english-horn'],
  [
    /\b(bass clarinet|bassklarinette|clarinetto basso|clarinette basse|clarone|b cl|bcl)\b/,
    'bass-clarinet',
  ],
  [/\b(clarinets?|klarinetten?|clarinett[oi]|clarinettes?|cl|clar|kl|klar)\b/, clarinetKey],
  [/\b(sax|saxes|saxophones?|saxophon|saxofono)\b/, saxophone],
  [/\b(soprano|alto|tenor|baritone|bari) sax/, saxophone],
  [
    /\b(contrabassoon|contra bassoon|contrafagott[oi]|kontrafagott|contrebasson|cbsn|cfg|kfg)\b/,
    'contrabassoon',
  ],
  [/\b(bassoons?|fagott[oei]?|bassons?|bsn|fg)\b/, 'bassoon'],
  [/\b(horns?|corn[oi]|cors?|hns?|hrn|waldhorn|horner)\b/, 'horn-f'],
  [/\b(bass trombone|bassposaune|trombone basso|b tbn)\b/, 'bass-trombone'],
  [/\b(trombones?|posaunen?|tromboni|tbn|trb|pos)\b/, 'trombone'],
  [/\b(euphonium|baritone horn|tenor tuba|euph)\b/, 'euphonium'],
  [/\b(tubas?|tba)\b/, 'tuba'],
  [/\b(alto flute|flauto contralto|altflote|altfloete)\b/, 'alto-flute'],
  [/\b(recorders?|blockflote|blockfloete|flauto dolce|flute a bec|blfl)\b/, 'recorder'],
  [/\b(piccolo|ottavino|kleine flote|petite flute|picc)\b/, 'piccolo'],
  [/\b(flutes?|flauto|flauti|flote|floten|floete|traverso|fl)\b/, 'flute'],
  [/\b(oboes?|hautbois|oboi|hoboe|ob)\b/, 'oboe'],
  [/\b(timpani|timpano|pauken?|timbales|timp)\b/, 'timpani'],
  [/\b(xylophone?|xylo|xyl)\b/, 'xylophone'],
  [/\b(glockenspiel|glock|glk|campanelli|jeu de timbres|orchestra bells)\b/, 'glockenspiel'],
  [/\b(vibraphone?|vibes|vib)\b/, 'vibraphone'],
  [/\bmarimba\b/, 'marimba'],
  [/\b(snare|caisse claire|tamburo|kleine trommel|side drum)\b/, 'snare-drum'],
  [/\b(bass drum|gran cassa|grosse caisse|grosse trommel)\b/, 'bass-drum'],
  [/\b(cymbals?|piatti|becken|cymbales)\b/, 'cymbals'],
  [/\b(triangle|triangolo|triangel)\b/, 'triangle'],
  [/\b(drum set|drumset|drum kit|drums|batterie|schlagzeug|percussion)\b/, 'drum-set'],
  [/\b(harps?|arpa|harfe|harpe|hp)\b/, 'harp'],
  [/\b(celesta|celeste|cel)\b/, 'celesta'],
  [/\b(harpsichord|cembalo|clavecin|clavicembalo|hpsd)\b/, 'harpsichord'],
  [/\b(organ|orgel|organo|orgue|org)\b/, 'organ'],
  [/\b(pianos?|pianoforte|fortepiano|klavier|pno|pf|keyboard)\b/, 'piano'],
  [/\b(bass guitar|electric bass|e bass|bass gtr)\b/, 'double-bass'],
  [/\b(guitars?|gitarren?|chitarra|guitare|gtr|guit)\b/, 'guitar'],
  [
    /\b(contrabass(es)?|double bass(es)?|kontrabass|kontrabasse|contrabbass[oi]|contrebasses?|string bass|upright bass|violone|cb|db|kb)\b/,
    'double-bass',
  ],
  [/\b(violoncell[oie]s?|violoncelli|cellos?|celli|vc|vlc|vcl)\b/, 'cello'],
  [/\b(violas?|viole|bratschen?|vla|va)\b/, 'viola'],
  [/\b(violins?|violin[oie]|violini|violons?|violinen|geigen?|vln|vl|vn|vni|fiddle)\b/, 'violin'],
  [/\b(continuo|basso continuo|bc|b c)\b/, 'harpsichord'],
  [/\bmezzo/, 'mezzo-soprano'],
  [/\b(countertenor|contratenor|contratenore|counter tenor|altus)\b/, 'alto'],
  [/\b(superius|discantus|cantus)\b/, 'soprano'],
  [/\b(quintus|quinto|quinta|sextus|sexto|sesto|septimus|vagans)\b/, voiceByClef],
  [/\b(sopranos?|sopran|soprani|sopr|cantus|canto|discant|s)\b/, 'soprano'],
  [
    /\b(contralto|alto|altus|alt|a)\b/,
    (_n, id) => (id.clefs[0] === 'alto' || id.program === 41 ? 'viola' : 'alto'),
  ],
  [/\b(tenors?|tenore|tenori|t)\b/, 'tenor'],
  [/\b(baritone|bariton|baritono|bar)\b/, 'baritone'],
  [/\b(bass|basses|basso|bassi|bassus|b)\b/, 'bass?'],
  [
    /\b(voice|vocals?|voce|stimme|singstimme|chant|vox|choir|chorus|chor|coro|choeur)\b/,
    voiceByClef,
  ],
];

/** GM programs (0-based) of the catalog instruments, for parts that have nothing else. */
function byProgram(program: number, id: PartIdentity): string | null {
  if (program <= 5 || program === 7) return 'piano';
  if (program === 6) return 'harpsichord';
  if (program === 8) return 'celesta';
  if (program === 9) return 'glockenspiel';
  if (program === 10 || program === 14) return 'glockenspiel';
  if (program === 11) return 'vibraphone';
  if (program === 12) return 'marimba';
  if (program === 13) return 'xylophone';
  if (program >= 16 && program <= 23) return 'organ';
  if (program >= 24 && program <= 31) return 'guitar';
  if (program >= 32 && program <= 39) return 'double-bass';
  if (program === 40) return 'violin';
  if (program === 41) return 'viola';
  if (program === 42) return 'cello';
  if (program === 43) return 'double-bass';
  if (program === 44 || program === 45 || (program >= 48 && program <= 51)) return 'violin';
  if (program === 46) return 'harp';
  if (program === 47) return 'timpani';
  if (program >= 52 && program <= 54) return voiceByClef('', id);
  if (program === 56 || program === 59 || program === 61) return 'trumpet-bb';
  if (program === 57) return 'trombone';
  if (program === 58) return 'tuba';
  if (program === 60) return 'horn-f';
  if (program === 64) return 'soprano-sax';
  if (program === 65) return 'alto-sax';
  if (program === 66) return 'tenor-sax';
  if (program === 67) return 'baritone-sax';
  if (program === 68) return 'oboe';
  if (program === 69) return 'english-horn';
  if (program === 70) return 'bassoon';
  if (program === 71) return 'clarinet-bb';
  if (program === 72) return 'piccolo';
  if (program === 73 || program === 75 || program === 77) return 'flute';
  if (program === 74 || program === 76 || program === 78 || program === 79) return 'recorder';
  return null;
}

const VOICE_IDS = new Set(['soprano', 'mezzo-soprano', 'alto', 'tenor', 'baritone', 'bass-voice']);

function bySound(sounds: readonly string[]): string | null {
  for (const raw of sounds) {
    const s = raw.toLowerCase().replace(/[-_\s]/g, '');
    for (const [prefix, instrument] of SOUNDS) if (s.startsWith(prefix)) return instrument;
  }
  return null;
}

function byName(id: PartIdentity): string | null {
  for (const raw of id.names) {
    if (isGenericName(raw)) continue;
    const n = normalizeName(raw);
    for (const [re, target] of NAME_RULES) {
      if (!re.test(n)) continue;
      const instrument = typeof target === 'string' ? target : target(n, id);
      if (instrument) return instrument;
    }
  }
  return null;
}

/**
 * Catalog instruments for all parts of a score. `bass?` names are resolved last: a singer when
 * other parts are singers or the part has lyrics, otherwise a double bass (also for GM basses).
 */
export function guessInstruments(parts: readonly PartIdentity[]): InstrumentGuess[] {
  const first = parts.map((id): InstrumentGuess | { instrument: 'bass?'; by: 'name' } => {
    const sound = bySound(id.sounds);
    if (sound) return { instrument: sound, by: 'sound' };
    const name = byName(id);
    if (name) return { instrument: name, by: 'name' } as InstrumentGuess;
    if (id.percussion) return { instrument: 'drum-set', by: 'fallback' };
    // an unknown part with lyrics is a singer
    if (id.hasLyrics) return { instrument: voiceByClef('', id), by: 'name' };
    const program = id.program !== null ? byProgram(id.program, id) : null;
    if (program) return { instrument: program, by: 'program' };
    return { instrument: 'piano', by: 'fallback' };
  });
  const singers = first.some((g) => VOICE_IDS.has(g.instrument));
  return first.map((g, i) => {
    if (g.instrument !== 'bass?') return g as InstrumentGuess;
    const id = parts[i]!;
    const gmBass =
      id.program !== null && ((id.program >= 32 && id.program <= 39) || id.program === 43);
    const singer = !gmBass && (singers || id.hasLyrics);
    return { instrument: singer ? 'bass-voice' : 'double-bass', by: 'name' };
  });
}
