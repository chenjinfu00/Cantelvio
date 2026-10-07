import { describe, expect, it } from 'vitest';
import { sequentialIds } from '../model/ids';
import { allStaves } from '../model/query';
import type { NoteEvent, ScoreDoc, StaffMeasure } from '../model/types';
import { validateScore } from '../model/validate';
import { pitchName } from '../pitch/pitch';
import { toString } from '../time/rational';
import { parseScore, serializeScore } from './json';
import { MusicXmlError, importMusicXml, musicXmlFromBytes } from './musicxml';
import { encodeUtf8 } from './xml';
import { writeZip } from './zip';

// ------------------------------------------------------------------------------- fixture helpers

const NOW = '2026-10-03T12:00:00.000Z';

function partwise(parts: string, partList: string, header = ''): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd">
<score-partwise version="4.0">${header}<part-list>${partList}</part-list>${parts}</score-partwise>`;
}

const scorePart = (id: string, name: string, extra = '') =>
  `<score-part id="${id}"><part-name>${name}</part-name>${extra}</score-part>`;

function attributes(
  o: {
    divisions?: number;
    fifths?: number;
    time?: [number, number];
    clefs?: string[];
    staves?: number;
    extra?: string;
  } = {},
): string {
  const clefs = (o.clefs ?? ['G2']).map(
    (c, i) =>
      `<clef${o.clefs && o.clefs.length > 1 ? ` number="${i + 1}"` : ''}><sign>${c[0]}</sign><line>${c[1]}</line></clef>`,
  );
  return (
    `<attributes><divisions>${o.divisions ?? 1}</divisions>` +
    (o.fifths !== undefined ? `<key><fifths>${o.fifths}</fifths></key>` : '') +
    (o.time ? `<time><beats>${o.time[0]}</beats><beat-type>${o.time[1]}</beat-type></time>` : '') +
    (o.staves ? `<staves>${o.staves}</staves>` : '') +
    clefs.join('') +
    (o.extra ?? '') +
    `</attributes>`
  );
}

/** A note: "C4", "F#5", "Bb3"; duration in divisions; extra elements go inside <note>. */
function note(name: string, duration: number, type: string, extra = '', before = ''): string {
  const m = /^([A-G])(#|b)?(-?\d)$/.exec(name)!;
  const alter = m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0;
  return (
    `<note>${before}<pitch><step>${m[1]}</step>${alter ? `<alter>${alter}</alter>` : ''}` +
    `<octave>${m[3]}</octave></pitch><duration>${duration}</duration>${extra}<type>${type}</type></note>`
  );
}

const rest = (duration: number, type: string, extra = '') =>
  `<note><rest/><duration>${duration}</duration>${extra}<type>${type}</type></note>`;

function load(xml: string, fileName = 'test.musicxml'): { doc: ScoreDoc; warnings: string[] } {
  const result = importMusicXml(xml, { ids: sequentialIds(), now: NOW, fileName });
  expect(validateScore(result.doc)).toEqual([]);
  const text = serializeScore(result.doc);
  expect(parseScore(text)).toEqual(result.doc);
  return result;
}

function staffMeasure(doc: ScoreDoc, staff: number, bar: number): StaffMeasure | undefined {
  return doc.content[allStaves(doc)[staff]!.staff.id]?.[doc.measures[bar]!.id];
}

function events(doc: ScoreDoc, staff = 0, bar = 0, voice = 0): readonly NoteEvent[] {
  return staffMeasure(doc, staff, bar)?.voices[voice] ?? [];
}

/** "C4+E4@1/4:1/4" per event: pitches @ offset : duration (whole notes). */
const show = (list: readonly NoteEvent[]) =>
  list.map(
    (e) =>
      `${e.notes.map((n) => pitchName(n.pitch) + (n.tieForward ? '~' : '')).join('+')}` +
      `@${toString(e.offset)}:${toString(e.duration)}`,
  );

// ------------------------------------------------------------------------------- tests

describe('MusicXML import', () => {
  it('imports a simple melody with title, composer, key, time and instrument', () => {
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 1, time: [4, 4] })}` +
        `${note('G4', 1, 'quarter')}${note('A4', 1, 'quarter')}${note('B4', 1, 'quarter')}${note('C5', 1, 'quarter')}` +
        `</measure><measure number="2">${note('D5', 4, 'whole')}</measure></part>`,
      scorePart('P1', 'Flute'),
      `<work><work-title>Little Tune</work-title></work>` +
        `<identification><creator type="composer">A. Composer</creator><rights>public domain</rights></identification>`,
    );
    const { doc, warnings } = load(xml);
    expect(warnings).toEqual([]);
    expect(doc.meta).toMatchObject({
      title: 'Little Tune',
      composer: 'A. Composer',
      copyright: 'public domain',
      createdAt: NOW,
    });
    expect(doc.parts.map((p) => [p.instrument, p.name])).toEqual([['flute', 'Flute']]);
    expect(doc.measures[0]).toMatchObject({
      timeSig: { beats: 4, beatType: 4 },
      keySig: { fifths: 1 },
    });
    expect(doc.measures[1]!.timeSig).toBeUndefined();
    expect(show(events(doc, 0, 0))).toEqual(['G4@0:1/4', 'A4@1/4:1/4', 'B4@1/2:1/4', 'C5@3/4:1/4']);
    expect(show(events(doc, 0, 1))).toEqual(['D5@0:1']);
    expect(events(doc)[0]!.source).toEqual({
      kind: 'import',
      format: 'musicxml',
      file: 'test.musicxml',
    });
  });

  it('reads a grand staff with two voices per staff through <backup>', () => {
    const measure =
      attributes({ divisions: 2, fifths: 0, time: [2, 4], staves: 2, clefs: ['G2', 'F4'] }) +
      note('E5', 4, 'half', '<voice>1</voice><staff>1</staff>') +
      `<backup><duration>4</duration></backup>` +
      note('C5', 2, 'quarter', '<voice>2</voice><staff>1</staff>') +
      note('B4', 2, 'quarter', '<voice>2</voice><staff>1</staff>') +
      `<backup><duration>4</duration></backup>` +
      note('C3', 4, 'half', '<voice>5</voice><staff>2</staff>');
    const { doc } = load(
      partwise(
        `<part id="P1"><measure number="1">${measure}</measure></part>`,
        scorePart('P1', 'Piano'),
      ),
    );
    const part = doc.parts[0]!;
    expect(part.instrument).toBe('piano');
    expect(part.staves.map((s) => s.clef)).toEqual(['treble', 'bass']);
    expect(doc.groups).toMatchObject([{ kind: 'brace', barlineThrough: true }]);
    expect(show(events(doc, 0, 0, 0))).toEqual(['E5@0:1/2']);
    expect(show(events(doc, 0, 0, 1))).toEqual(['C5@0:1/4', 'B4@1/4:1/4']);
    expect(show(events(doc, 1, 0, 0))).toEqual(['C3@0:1/2']);
  });

  it('builds chords from <chord/> and sorts their notes', () => {
    const chord =
      note('G4', 2, 'half') +
      note('C4', 2, 'half', '', '<chord/>') +
      note('E4', 2, 'half', '', '<chord/>');
    const { doc } = load(
      partwise(
        `<part id="P1"><measure number="1">${attributes({ time: [2, 2], fifths: 0 })}${chord}${rest(2, 'half')}</measure></part>`,
        scorePart('P1', 'Piano'),
      ),
    );
    expect(show(events(doc))).toEqual(['C4+E4+G4@0:1/2']);
  });

  it('merges tied chords into one event across the barline and keeps partial ties', () => {
    const tie = (t: string) => `<tie type="${t}"/>`;
    const tied = (t: string) => `<notations><tied type="${t}"/></notations>`;
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ time: [4, 4], fifths: 0 })}` +
        note('C4', 2, 'half') +
        // C4+E4 tied to C4+E4 in the next bar: one event of 3 quarters
        note('C4', 2, 'half', tie('start'), '') +
        note('E4', 2, 'half', tie('start'), '<chord/>') +
        `</measure><measure number="2">` +
        note('C4', 1, 'quarter', tie('stop')) +
        note('E4', 1, 'quarter', tie('stop'), '<chord/>') +
        // only the lower note of this chord is tied on
        note('D4', 1, 'quarter', `${tie('start')}${tied('start')}`) +
        note('F4', 1, 'quarter', '', '<chord/>') +
        note('D4', 2, 'half', tie('stop')) +
        note('A4', 2, 'half', '', '<chord/>') +
        `</measure></part>`,
      scorePart('P1', 'Piano'),
    );
    const { doc } = load(xml);
    expect(show(events(doc, 0, 0))).toEqual(['C4@0:1/2', 'C4+E4@1/2:3/4']);
    expect(show(events(doc, 0, 1))).toEqual(['D4~+F4@1/4:1/4', 'D4+A4@1/2:1/2']);
  });

  it('reads triplets as a tuplet span of exact thirds', () => {
    const tm =
      '<time-modification><actual-notes>3</actual-notes><normal-notes>2</normal-notes></time-modification>';
    const t = (type: string) => `<notations><tuplet type="${type}"/></notations>`;
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ divisions: 3, time: [2, 4], fifths: 0 })}` +
        note('C5', 1, 'eighth', `${tm}${t('start')}`) +
        note('D5', 1, 'eighth', tm) +
        note('E5', 1, 'eighth', `${tm}${t('stop')}`) +
        note('F5', 3, 'quarter') +
        `</measure></part>`,
      scorePart('P1', 'Violin'),
    );
    const { doc } = load(xml);
    expect(doc.parts[0]!.instrument).toBe('violin');
    expect(show(events(doc))).toEqual(['C5@0:1/12', 'D5@1/12:1/12', 'E5@1/6:1/12', 'F5@1/4:1/4']);
    expect(staffMeasure(doc, 0, 0)!.tuplets).toMatchObject([
      { voice: 0, actual: 3, normal: 2, offset: { n: 0, d: 1 }, length: { n: 1, d: 4 } },
    ]);
  });

  it('keeps a pickup bar short', () => {
    const xml = partwise(
      `<part id="P1"><measure number="0" implicit="yes">${attributes({ time: [3, 4], fifths: 0 })}` +
        `${note('D4', 1, 'quarter')}</measure>` +
        `<measure number="1">${note('G4', 3, 'half', '<dot/>')}</measure></part>`,
      scorePart('P1', 'Oboe'),
    );
    const { doc } = load(xml);
    expect(doc.measures[0]!.actualLength).toEqual({ n: 1, d: 4 });
    expect(doc.measures[1]!.actualLength).toBeUndefined();
    expect(show(events(doc, 0, 1))).toEqual(['G4@0:3/4']);
  });

  it('converts a B-flat clarinet to concert pitch and takes the key from untransposed parts', () => {
    const clarinet =
      attributes({
        fifths: 0,
        time: [4, 4],
        extra: '<transpose><diatonic>-1</diatonic><chromatic>-2</chromatic></transpose>',
      }) + note('D5', 4, 'whole');
    const piano = attributes({ fifths: -2, time: [4, 4] }) + note('C5', 4, 'whole');
    const xml = partwise(
      `<part id="P1"><measure number="1">${clarinet}</measure></part>` +
        `<part id="P2"><measure number="1">${piano}</measure></part>`,
      scorePart('P1', 'Clarinet in B♭') + scorePart('P2', 'Piano'),
    );
    const { doc, warnings } = load(xml);
    expect(warnings).toEqual([]);
    expect(doc.parts.map((p) => p.instrument)).toEqual(['clarinet-bb', 'piano']);
    expect(doc.parts[0]!.transposition).toBeUndefined(); // the catalog clarinet transposes already
    expect(doc.measures[0]!.keySig).toEqual({ fifths: -2 });
    expect(show(events(doc, 0, 0))).toEqual(['C5@0:1']);
    // alone, the clarinet's written key is transposed to concert pitch
    const alone = load(
      partwise(
        `<part id="P1"><measure number="1">${clarinet}</measure></part>`,
        scorePart('P1', 'Clarinet'),
      ),
    );
    expect(alone.doc.measures[0]!.keySig).toEqual({ fifths: -2 });
  });

  it('reads unmarked transposing parts as written pitch when asked (optical music recognition)', () => {
    const clarinet = attributes({ fifths: -1, time: [4, 4] }) + note('G4', 4, 'whole');
    const piano = attributes({ fifths: -3, time: [4, 4] }) + note('F4', 4, 'whole');
    const xml = partwise(
      `<part id="P1"><measure number="1">${clarinet}</measure></part>` +
        `<part id="P2"><measure number="1">${piano}</measure></part>`,
      scorePart('P1', 'Voice') + scorePart('P2', 'Piano'),
    );
    const plain = load(xml);
    expect(plain.doc.parts[0]!.instrument).toBe('soprano');
    expect(show(events(plain.doc, 0, 0))).toEqual(['G4@0:1']);
    const omr = importMusicXml(xml, {
      ids: sequentialIds(),
      now: NOW,
      instruments: ['clarinet-bb', null],
      writtenPitch: true,
    });
    expect(validateScore(omr.doc)).toEqual([]);
    expect(omr.doc.parts.map((p) => p.instrument)).toEqual(['clarinet-bb', 'piano']);
    expect(show(events(omr.doc, 0, 0))).toEqual(['F4@0:1']); // written G4 sounds F4
    expect(omr.doc.measures[0]!.keySig).toEqual({ fifths: -3 }); // concert E-flat, no disagreement
    expect(omr.warnings).toEqual([
      'Part 1 (Clarinet in B♭) was read as written pitch and transposed',
    ]);
    const unknown = importMusicXml(xml, { ids: sequentialIds(), now: NOW, instruments: ['kazoo'] });
    expect(unknown.warnings.join(' ')).toMatch(/Unknown instrument "kazoo"/);
  });

  it('keeps the time signature when one part runs past it and another fills the bar', () => {
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [2, 4] })}` +
        `${note('C5', 1, 'quarter')}${note('D5', 1, 'quarter')}${note('E5', 1, 'quarter')}</measure>` +
        `<measure number="2">${note('F5', 2, 'half')}</measure></part>` +
        `<part id="P2"><measure number="1">${attributes({ fifths: 0, time: [2, 4], clefs: ['F4'] })}` +
        `${note('C3', 2, 'half')}</measure><measure number="2">${note('G2', 2, 'half')}</measure></part>`,
      scorePart('P1', 'Violin') + scorePart('P2', 'Cello'),
    );
    const { doc, warnings } = load(xml);
    expect(doc.measures[0]!.actualLength).toBeUndefined();
    expect(show(events(doc, 0, 0))).toEqual(['C5@0:1/4', 'D5@1/4:1/4']);
    expect(show(events(doc, 0, 1))).toEqual(['F5@0:1/2']);
    expect(warnings).toEqual([
      'Bars where a part runs past the time signature keep its length (the extra notes were cut) (bar 1)',
    ]);
  });

  it('can trust the time signature for short interior bars', () => {
    const bars = [
      note('G4', 1, 'quarter'),
      note('C5', 2, 'half'),
      note('D5', 1, 'quarter'), // a missed rest: one beat short
      note('E5', 2, 'half'),
      note('C5', 1, 'quarter'),
    ];
    const xml = partwise(
      `<part id="P1">${bars
        .map(
          (b, i) =>
            `<measure number="${i}">${i === 0 ? attributes({ fifths: 0, time: [2, 4] }) : ''}${b}</measure>`,
        )
        .join('')}</part>`,
      scorePart('P1', 'Flute'),
    );
    const lengths = (doc: ScoreDoc) =>
      doc.measures.map((m) => (m.actualLength ? toString(m.actualLength) : '-'));
    expect(lengths(load(xml).doc)).toEqual(['1/4', '-', '1/4', '-', '1/4']);
    const trusted = importMusicXml(xml, {
      ids: sequentialIds(),
      now: NOW,
      trustTimeSignatures: true,
    });
    expect(validateScore(trusted.doc)).toEqual([]);
    expect(lengths(trusted.doc)).toEqual(['1/4', '-', '-', '-', '1/4']); // pickup and last bar stay short
    expect(trusted.warnings).toEqual([
      'Bars shorter than their time signature were filled up to it (bar 3)',
    ]);
  });

  it('reads key, time and clef changes', () => {
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [4, 4], clefs: ['F4'] })}${note('C3', 4, 'whole')}</measure>` +
        `<measure number="2"><attributes><key><fifths>-1</fifths><mode>minor</mode></key><time><beats>3</beats><beat-type>4</beat-type></time></attributes>` +
        `${note('D3', 2, 'half')}<attributes><clef><sign>C</sign><line>4</line></clef></attributes>${note('A3', 1, 'quarter')}</measure></part>`,
      scorePart('P1', 'Cello'),
    );
    const { doc } = load(xml);
    expect(doc.parts[0]!.instrument).toBe('cello');
    expect(doc.measures[1]).toMatchObject({
      timeSig: { beats: 3, beatType: 4 },
      keySig: { fifths: -1, mode: 'minor' },
    });
    expect(staffMeasure(doc, 0, 1)!.clefChanges).toMatchObject([
      { offset: { n: 1, d: 2 }, clef: 'tenor' },
    ]);
  });

  it('reads dynamics, hairpins, slurs and articulations', () => {
    const slur = (t: string) => `<notations><slur type="${t}" number="1"/></notations>`;
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [4, 4] })}` +
        `<direction placement="below"><direction-type><dynamics><p/></dynamics></direction-type></direction>` +
        `<direction><direction-type><wedge type="crescendo"/></direction-type></direction>` +
        note('C5', 1, 'quarter', slur('start')) +
        note('D5', 1, 'quarter') +
        note('E5', 1, 'quarter', slur('stop')) +
        `<direction><direction-type><wedge type="stop"/></direction-type></direction>` +
        note(
          'F5',
          1,
          'quarter',
          '<notations><articulations><staccato/><accent/></articulations><fermata/></notations>',
        ) +
        `</measure></part>`,
      scorePart('P1', 'Violin'),
    );
    const { doc, warnings } = load(xml);
    expect(warnings).toEqual([]);
    expect(staffMeasure(doc, 0, 0)!.dynamics).toMatchObject([
      { offset: { n: 0, d: 1 }, value: 'p' },
    ]);
    const list = events(doc);
    const slurs = doc.spanners.filter((s) => s.kind === 'slur');
    expect(slurs).toMatchObject([{ from: list[0]!.id, to: list[2]!.id }]);
    const hairpins = doc.spanners.filter((s) => s.kind === 'hairpin');
    expect(hairpins).toMatchObject([
      {
        direction: 'crescendo',
        start: { measureId: doc.measures[0]!.id, offset: { n: 0, d: 1 } },
        end: { measureId: doc.measures[0]!.id, offset: { n: 3, d: 4 } },
      },
    ]);
    expect(list[3]!.articulations).toEqual(
      expect.arrayContaining(['staccato', 'accent', 'fermata']),
    );
  });

  it('attaches grace notes to the following note', () => {
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [2, 4] })}` +
        `<note><grace slash="yes"/><pitch><step>D</step><octave>5</octave></pitch><type>eighth</type></note>` +
        note('C5', 1, 'quarter') +
        note('B4', 1, 'quarter') +
        `</measure></part>`,
      scorePart('P1', 'Flute'),
    );
    const { doc } = load(xml);
    const [first, second] = events(doc);
    expect(first!.graces).toMatchObject([
      { slash: true, value: 'eighth', notes: [{ pitch: { step: 'D', octave: 5 } }] },
    ]);
    expect(second!.graces).toBeUndefined();
  });

  it('maps chord-symbol kinds, degrees and bass notes to Cantelvio qualities', () => {
    const harmony = (root: string, kind: string, extra = '') =>
      `<harmony><root><root-step>${root[0]}</root-step>${root[1] === 'b' ? '<root-alter>-1</root-alter>' : ''}</root>` +
      `<kind>${kind}</kind>${extra}</harmony>`;
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [4, 4] })}` +
        harmony('D', 'minor-seventh') +
        note('C5', 1, 'quarter') +
        harmony(
          'G',
          'dominant',
          '<degree><degree-value>9</degree-value><degree-alter>0</degree-alter><degree-type>add</degree-type></degree>',
        ) +
        note('B4', 1, 'quarter') +
        harmony('C', 'major', '<bass><bass-step>E</bass-step></bass>') +
        note('C5', 1, 'quarter') +
        harmony('Bb', 'none') +
        note('C5', 1, 'quarter') +
        `</measure></part>`,
      scorePart('P1', 'Guitar'),
    );
    const { doc, warnings } = load(xml);
    expect(
      doc.harmony.map((h) => [
        toString(h.offset),
        `${h.root.step}${h.root.alter}`,
        h.quality,
        h.bass?.step ?? null,
      ]),
    ).toEqual([
      ['0', 'D0', 'min7', null],
      ['1/4', 'G0', 'dom9', null],
      ['1/2', 'C0', 'maj', 'E'],
    ]);
    expect(warnings.join('\n')).toMatch(/No chord/);
  });

  it('reports what it skips, counted once per kind', () => {
    const lyric = (text: string) =>
      `<lyric><syllabic>single</syllabic><text>${text}</text></lyric>`;
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [2, 4] })}` +
        note('C5', 1, 'quarter', lyric('la')) +
        note('D5', 1, 'quarter', lyric('la')) +
        `<barline location="right"><ending number="1" type="start"/></barline></measure></part>`,
      scorePart('P1', 'Soprano'),
    );
    const { doc, warnings } = load(xml);
    expect(doc.parts[0]!.instrument).toBe('soprano');
    expect(warnings).toEqual([
      'Lyrics are not supported yet (syllables skipped): 2×, first in bar 1',
      'Volta brackets (1st/2nd endings) are not supported yet (bar 1)',
    ]);
  });

  it('converts score-timewise and reads compressed .mxl archives', async () => {
    const timewise = `<?xml version="1.0"?><score-timewise version="4.0"><part-list>${scorePart('P1', 'Flute')}</part-list>
      <measure number="1"><part id="P1">${attributes({ fifths: 0, time: [1, 4] })}${note('A4', 1, 'quarter')}</part></measure>
      <measure number="2"><part id="P1">${note('B4', 1, 'quarter')}</part></measure></score-timewise>`;
    const { doc } = load(timewise);
    expect(show(events(doc, 0, 1))).toEqual(['B4@0:1/4']);

    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 0, time: [1, 4] })}${note('E4', 1, 'quarter')}</measure></part>`,
      scorePart('P1', 'Flute'),
    );
    const container =
      '<?xml version="1.0"?><container><rootfiles><rootfile full-path="score/main.musicxml" ' +
      'media-type="application/vnd.recordare.musicxml+xml"/></rootfiles></container>';
    const archive = writeZip(
      [
        { name: 'mimetype', data: encodeUtf8('application/vnd.recordare.musicxml') },
        { name: 'META-INF/container.xml', data: encodeUtf8(container) },
        { name: 'score/main.musicxml', data: encodeUtf8(xml) },
      ],
      (data) => data, // "deflate" that stores: the platform inflate below hands the bytes back
    );
    let inflated = 0;
    const read = await musicXmlFromBytes(archive, (data) => {
      inflated++;
      return data;
    });
    expect(read.path).toBe('score/main.musicxml');
    expect(inflated).toBe(2);
    expect(show(events(load(read.xml).doc))).toEqual(['E4@0:1/4']);
    // plain text files are decoded as they are
    expect((await musicXmlFromBytes(encodeUtf8(xml), () => new Uint8Array())).xml).toBe(xml);
  });

  it('refuses files that are not MusicXML scores', () => {
    const opts = { ids: sequentialIds(), now: NOW };
    expect(() => importMusicXml('<score-partwise><part', opts)).toThrow(MusicXmlError);
    expect(() => importMusicXml('<html><body/></html>', opts)).toThrow(/not a MusicXML score/);
    expect(() => importMusicXml('<opus/>', opts)).toThrow(/opus/);
    expect(() => importMusicXml('<score-partwise><part-list/></score-partwise>', opts)).toThrow(
      /no parts/,
    );
  });

  it('is deterministic for the same ids', () => {
    const xml = partwise(
      `<part id="P1"><measure number="1">${attributes({ fifths: 2, time: [3, 4] })}${note('F#4', 3, 'half', '<dot/>')}</measure></part>`,
      scorePart('P1', 'Viola'),
    );
    const a = importMusicXml(xml, { ids: sequentialIds(), now: NOW });
    const b = importMusicXml(xml, { ids: sequentialIds(), now: NOW });
    expect(serializeScore(a.doc)).toBe(serializeScore(b.doc));
    expect(a.doc.meta.title).toBe('Untitled Score');
    expect(show(events(a.doc))).toEqual(['F#4@0:3/4']);
  });
});
