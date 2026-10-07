/**
 * Node side of MusicXML import: read a `.musicxml` / `.xml` / `.mxl` file (inflating `.mxl`
 * archives with node:zlib) and import it with @cantelvio-score/core.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  type IdGenerator,
  type MusicXmlImportOptions,
  type MusicXmlImportResult,
  importMusicXml,
  musicXmlFromBytes,
} from '@cantelvio-score/core';

export const inflateRaw = (data: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(data));

/** The MusicXML text of a file (the root file of an `.mxl` archive). */
export async function readMusicXmlText(path: string): Promise<string> {
  return (await musicXmlFromBytes(new Uint8Array(readFileSync(path)), inflateRaw)).xml;
}

/** Read and import a MusicXML file (`fileName` defaults to the file's name). */
export async function importMusicXmlFile(
  path: string,
  options: { ids: IdGenerator; now?: string } & Partial<Omit<MusicXmlImportOptions, 'ids' | 'now'>>,
): Promise<MusicXmlImportResult> {
  return importMusicXml(await readMusicXmlText(path), {
    fileName: basename(path),
    ...options,
    now: options.now ?? new Date().toISOString(),
  });
}
