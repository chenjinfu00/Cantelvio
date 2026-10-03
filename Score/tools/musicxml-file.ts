/**
 * Node side of MusicXML import: read a `.musicxml` / `.xml` / `.mxl` file (inflating `.mxl`
 * archives with node:zlib) and import it with @ailegro-score/core.
 */
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import {
  type IdGenerator,
  type MusicXmlImportResult,
  importMusicXml,
  musicXmlFromBytes,
} from '@ailegro-score/core';

export const inflateRaw = (data: Uint8Array): Uint8Array => new Uint8Array(inflateRawSync(data));

/** The MusicXML text of a file (the root file of an `.mxl` archive). */
export async function readMusicXmlText(path: string): Promise<string> {
  return (await musicXmlFromBytes(new Uint8Array(readFileSync(path)), inflateRaw)).xml;
}

/** Read and import a MusicXML file. */
export async function importMusicXmlFile(
  path: string,
  options: { ids: IdGenerator; now?: string },
): Promise<MusicXmlImportResult> {
  return importMusicXml(await readMusicXmlText(path), {
    ids: options.ids,
    now: options.now ?? new Date().toISOString(),
    fileName: basename(path),
  });
}
