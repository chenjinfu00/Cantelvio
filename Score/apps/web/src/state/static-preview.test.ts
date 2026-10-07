import { SAMPLES, serializeScore } from '@ailegro-score/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

async function host(hostname: string, flag = 'false') {
  vi.resetModules();
  vi.stubEnv('VITE_STATIC_PREVIEW', flag);
  vi.stubGlobal('window', {
    location: new URL(`https://${hostname}/Cantelvio/score/`),
    innerWidth: 1280,
    innerHeight: 800,
  });
  return import('../host');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('static public editor', () => {
  it('recognizes GitHub Pages and explicitly configured custom domains, preserving local mode', async () => {
    expect((await host('chenjinfu00.github.io')).LOCAL_SERVICE_UNAVAILABLE).toBe(true);
    expect((await host('music.example', 'true')).IN_STATIC_PREVIEW).toBe(true);
    expect((await host('127.0.0.1')).LOCAL_SERVICE_UNAVAILABLE).toBe(false);
    expect((await host('localhost')).LOCAL_SERVICE_UNAVAILABLE).toBe(false);
    expect((await host('github.io.example')).IN_STATIC_PREVIEW).toBe(false);
  });

  it('blocks health checks, generation, analysis and PDF/audio uploads before any network call', async () => {
    await host('music.example', 'true');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { initStore, getStore } = await import('./store');
    const { pingService, generateWithService, analyzeWithService, defaultSpec } =
      await import('./ailegro');
    const { generateCandidates, useComposeCandidates } = await import('./compose-candidates');
    const { importViaService } = await import('./service-import');
    initStore(SAMPLES[0]!.build('zh'));
    const doc = getStore().getState().doc;
    const spec = defaultSpec(doc, { kind: 'none' });
    const base = 'http://127.0.0.1:8765';

    await expect(pingService(base)).rejects.toThrow('不托管 AI 模型');
    await expect(generateWithService(base, spec)).rejects.toThrow('不托管 AI 模型');
    await expect(generateCandidates(base, spec, 3)).rejects.toThrow('不托管 AI 模型');
    await expect(analyzeWithService(base, 'bar')).rejects.toThrow('不托管 AI 模型');
    expect(await importViaService(new File(['private music'], 'score.pdf'), 'pdf')).toBe(false);
    expect(await importViaService(new File(['private recording'], 'take.wav'), 'audio')).toBe(
      false,
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(getStore().getState().doc).toBe(doc);
    expect(useComposeCandidates.getState()).toMatchObject({ busy: false, candidates: [] });
    expect(getStore().getState().toast?.text).toContain('网页不会上传这些文件');
  });

  it('still opens native scores and imports MusicXML entirely in the browser', async () => {
    await host('chenjinfu00.github.io');
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { initStore, getStore } = await import('./store');
    const { openFile } = await import('./files');
    const sample = SAMPLES[0]!.build('en');
    initStore(sample);
    expect(await openFile(new File([serializeScore(sample)], 'piano.ailegro.json'))).toBe(true);
    expect(serializeScore(getStore().getState().doc)).toBe(serializeScore(sample));

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
      <score-partwise version="4.0">
        <work><work-title>Browser import</work-title></work>
        <part-list><score-part id="P1"><part-name>Piano</part-name></score-part></part-list>
        <part id="P1"><measure number="1">
          <attributes><divisions>1</divisions><key><fifths>0</fifths></key>
            <time><beats>4</beats><beat-type>4</beat-type></time>
            <clef><sign>G</sign><line>2</line></clef></attributes>
          <note><pitch><step>C</step><octave>4</octave></pitch><duration>4</duration><type>whole</type></note>
        </measure></part>
      </score-partwise>`;
    expect(await openFile(new File([xml], 'piano.musicxml'))).toBe(true);
    expect(getStore().getState().doc.meta.title).toBe('Browser import');
    expect(
      Object.values(getStore().getState().doc.content).flatMap((staff) =>
        Object.values(staff).flatMap((measure) => measure.voices.flat()),
      ),
    ).toHaveLength(1);
    expect(fetch).not.toHaveBeenCalled();
  });
});
