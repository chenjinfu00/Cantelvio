import { describe, expect, it } from 'vitest';
import {
  DEFAULT_IMPORT_OPTIONS,
  type ImportJob,
  fromBase64,
  importKindOf,
  importSummary,
  loadImportOptions,
  resultXml,
  uploadQuery,
} from './service-import';

const job = (patch: Partial<ImportJob>): ImportJob => ({
  id: 'j1',
  kind: 'audio',
  name: 'take.wav',
  state: 'done',
  stage: 'done',
  progress: null,
  elapsed: 12,
  ...patch,
});

describe('service imports', () => {
  it('sends PDFs, scans and recordings to the service, scores stay local', () => {
    for (const name of ['a.pdf', 'Scan.PNG', 'p.jpeg', 'x.tif', 'y.tiff'])
      expect(importKindOf(name)).toBe('pdf');
    for (const name of ['a.wav', 'b.MP3', 'c.flac', 'd.m4a', 'e.aiff', 'f.aif', 'g.ogg'])
      expect(importKindOf(name)).toBe('audio');
    for (const name of ['s.cantelvio.json', 's.musicxml', 's.mxl', 's.xml', 's.mid', 'pdf'])
      expect(importKindOf(name)).toBeNull();
  });

  it('puts only the options of the file kind in the upload query', () => {
    const o = {
      ...DEFAULT_IMPORT_OPTIONS,
      sheets: ' 1 3-4 ',
      instruments: ['acoustic_piano', 'voice'],
      piano: true,
      metre: '6/8',
    };
    expect(Object.fromEntries(new URLSearchParams(uploadQuery('pdf', 'Mein Lied.pdf', o)))).toEqual(
      {
        name: 'Mein Lied.pdf',
        sheets: '1 3-4',
      },
    );
    expect(Object.fromEntries(new URLSearchParams(uploadQuery('audio', 'take 1.wav', o)))).toEqual({
      name: 'take 1.wav',
      instruments: 'acoustic_piano,voice',
      piano: '1',
      metre: '6/8',
    });
    expect(uploadQuery('audio', 'x.wav', DEFAULT_IMPORT_OPTIONS)).toBe('name=x.wav');
  });

  it('falls back to the default options without browser storage', () => {
    expect(loadImportOptions()).toEqual(DEFAULT_IMPORT_OPTIONS);
  });

  it('decodes MusicXML results', async () => {
    const xml =
      '<score-partwise version="4.0"><work><work-title>Lied – ä</work-title></work></score-partwise>';
    const data = Buffer.from(xml, 'utf8').toString('base64');
    expect(new TextDecoder().decode(fromBase64(data))).toBe(xml);
    expect(await resultXml({ name: 'x.musicxml', format: 'musicxml', data })).toBe(xml);
  });

  it('summarises what a job made', () => {
    const audio = job({
      result: {
        files: [],
        warnings: [],
        report: { notes: 317, kept: 300, metre: '2/4', qpm: 97.1, bars: 24 },
      },
    });
    expect(importSummary('zh', audio)).toBe(
      '扒谱完成：take.wav，保留 300/317 个音，2/4，♩ = 97，24 小节（保存时另存为 .cantelvio.json）',
    );
    const pdf = job({
      kind: 'pdf',
      name: 'quartet.pdf',
      result: {
        files: [
          { name: 'q.mvt1.mxl', format: 'mxl', data: '' },
          { name: 'q.mvt2.mxl', format: 'mxl', data: '' },
        ],
        warnings: [],
        report: { sheets: 6 },
      },
    });
    expect(importSummary('en', pdf)).toBe(
      'Read quartet.pdf: 6 page(s) (saving writes a .cantelvio.json). Audiveris found 2 movements; the first one is open',
    );
  });
});
