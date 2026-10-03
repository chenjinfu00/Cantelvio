/**
 * A small, pure, non-validating XML parser for MusicXML (and the `.mxl` container file).
 *
 * It reads elements, attributes, text and CDATA sections into a plain tree. Comments, processing
 * instructions and the DOCTYPE (including an internal subset) are skipped; the five predefined
 * entities and numeric character references are decoded, other entity references are kept as
 * written (no DTD is read). Namespaces are not interpreted: a prefixed name stays `prefix:name`.
 * Malformed input (mismatched or unclosed tags, a missing root) throws `XmlError` with the line
 * and column.
 */

export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Child elements and text, in document order. Adjacent text and CDATA are joined. */
  readonly children: readonly XmlNode[];
}

/** An element or a text node (a plain string). */
export type XmlNode = XmlElement | string;

export class XmlError extends Error {
  override name = 'XmlError';
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(`${message} (line ${line}, column ${column})`);
  }
}

export interface XmlParseOptions {
  /** Keep text nodes that contain only whitespace (default false: indentation is dropped). */
  readonly keepWhitespace?: boolean;
}

const NAME = /[^\s/>]+/y;
const ATTRIBUTE = /\s*([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/y;
const SPACE = /\s*/y;
const ENTITY = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[A-Za-z_][\w.-]*);/g;
const PREDEFINED: Readonly<Record<string, string>> = {
  lt: '<',
  gt: '>',
  amp: '&',
  quot: '"',
  apos: "'",
};

/** Decode the predefined entities and numeric character references. */
export function decodeXmlEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, ref: string) => {
    if (ref[0] !== '#') return PREDEFINED[ref] ?? whole;
    const code =
      ref[1] === 'x' || ref[1] === 'X' ? parseInt(ref.slice(2), 16) : Number(ref.slice(1));
    if (
      !Number.isInteger(code) ||
      code < 1 ||
      code > 0x10ffff ||
      (code >= 0xd800 && code <= 0xdfff)
    )
      return whole;
    return String.fromCodePoint(code);
  });
}

interface OpenElement {
  readonly name: string;
  readonly attributes: Record<string, string>;
  readonly children: XmlNode[];
  readonly at: number;
}

const isBlank = (s: string) => /^\s*$/.test(s);

/** Parse an XML document and return its root element. */
export function parseXml(text: string, options: XmlParseOptions = {}): XmlElement {
  const keepWhitespace = options.keepWhitespace ?? false;
  const n = text.length;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;
  const stack: OpenElement[] = [];
  const result: { root: XmlElement | null } = { root: null };

  const fail = (message: string, at: number): never => {
    let line = 1;
    let lineStart = 0;
    for (let k = 0; k < at && k < n; k++) {
      if (text.charCodeAt(k) === 10) {
        line++;
        lineStart = k + 1;
      }
    }
    throw new XmlError(message, line, at - lineStart + 1);
  };

  const addText = (value: string, at: number) => {
    const parent = stack[stack.length - 1];
    if (!parent) {
      if (!isBlank(value)) fail('text outside the root element', at);
      return;
    }
    if (!keepWhitespace && isBlank(value)) return;
    const last = parent.children.length - 1;
    if (last >= 0 && typeof parent.children[last] === 'string')
      parent.children[last] = (parent.children[last] as string) + value;
    else parent.children.push(value);
  };

  const close = (el: XmlElement, at: number) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(el);
    else if (result.root) fail('more than one root element', at);
    else result.root = el;
  };

  /** Skip `<!DOCTYPE …>` or another declaration, including a [ … ] internal subset. */
  const skipDeclaration = (start: number): number => {
    let k = start + 2;
    let depth = 0;
    while (k < n) {
      const c = text[k]!;
      if (c === '"' || c === "'") {
        const e = text.indexOf(c, k + 1);
        if (e < 0) break;
        k = e + 1;
        continue;
      }
      if (c === '[') depth++;
      else if (c === ']') depth--;
      else if (c === '>' && depth <= 0) return k + 1;
      else if (c === '<' && text.startsWith('<!--', k)) {
        const e = text.indexOf('-->', k + 4);
        if (e < 0) break;
        k = e + 3;
        continue;
      }
      k++;
    }
    return fail('unterminated declaration', start);
  };

  while (i < n) {
    const lt = text.indexOf('<', i);
    const textEnd = lt < 0 ? n : lt;
    if (textEnd > i) addText(decodeXmlEntities(text.slice(i, textEnd)), i);
    if (lt < 0) break;
    i = lt;
    const next = text[i + 1];
    if (next === '!') {
      if (text.startsWith('<!--', i)) {
        const e = text.indexOf('-->', i + 4);
        if (e < 0) fail('unterminated comment', i);
        i = e + 3;
      } else if (text.startsWith('<![CDATA[', i)) {
        const e = text.indexOf(']]>', i + 9);
        if (e < 0) fail('unterminated CDATA section', i);
        if (!stack.length) fail('CDATA outside the root element', i);
        addText(text.slice(i + 9, e), i);
        i = e + 3;
      } else {
        i = skipDeclaration(i);
      }
      continue;
    }
    if (next === '?') {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) fail('unterminated processing instruction', i);
      i = e + 2;
      continue;
    }
    if (next === '/') {
      NAME.lastIndex = i + 2;
      const m = NAME.exec(text);
      const name = m?.[0] ?? '';
      const gt = text.indexOf('>', i);
      if (!name || gt < 0 || !isBlank(text.slice(i + 2 + name.length, gt)))
        fail('malformed end tag', i);
      const open = stack.pop();
      if (!open) fail(`unexpected end tag </${name}>`, i);
      if (open!.name !== name) fail(`end tag </${name}> does not match <${open!.name}>`, i);
      close({ name, attributes: open!.attributes, children: open!.children }, i);
      i = gt + 1;
      continue;
    }
    // start tag
    NAME.lastIndex = i + 1;
    const m = NAME.exec(text);
    if (!m) fail('malformed tag', i);
    const name = m![0];
    const attributes: Record<string, string> = {};
    let k = i + 1 + name.length;
    let selfClosing = false;
    while (true) {
      ATTRIBUTE.lastIndex = k;
      const a = ATTRIBUTE.exec(text);
      if (a) {
        attributes[a[1]!] = decodeXmlEntities(a[2] ?? a[3] ?? '');
        k = ATTRIBUTE.lastIndex;
        continue;
      }
      SPACE.lastIndex = k;
      SPACE.exec(text);
      k = SPACE.lastIndex;
      if (text[k] === '>') {
        k++;
        break;
      }
      if (text[k] === '/' && text[k + 1] === '>') {
        selfClosing = true;
        k += 2;
        break;
      }
      fail(k >= n ? `unterminated tag <${name}>` : `malformed attribute in <${name}>`, k);
    }
    if (selfClosing) close({ name, attributes, children: [] }, i);
    else stack.push({ name, attributes, children: [], at: i });
    i = k;
  }
  const unclosed = stack[stack.length - 1];
  if (unclosed) fail(`unclosed element <${unclosed.name}>`, unclosed.at);
  return result.root ?? fail('no root element', n);
}

// ------------------------------------------------------------------------------- tree helpers

export const isXmlElement = (node: XmlNode): node is XmlElement => typeof node !== 'string';

/** Child elements, optionally only those with the given name. */
export function xmlChildren(el: XmlElement | undefined, name?: string): XmlElement[] {
  const out: XmlElement[] = [];
  if (!el) return out;
  for (const c of el.children) if (typeof c !== 'string' && (!name || c.name === name)) out.push(c);
  return out;
}

/** The first child element with the given name. */
export function xmlChild(el: XmlElement | undefined, name: string): XmlElement | undefined {
  if (!el) return undefined;
  for (const c of el.children) if (typeof c !== 'string' && c.name === name) return c;
  return undefined;
}

/** All text inside an element (descendants included), untrimmed. */
export function xmlText(el: XmlElement | undefined): string {
  if (!el) return '';
  let out = '';
  for (const c of el.children) out += typeof c === 'string' ? c : xmlText(c);
  return out;
}

/** Trimmed text of the first child with the given name, or undefined when there is none. */
export function xmlChildText(el: XmlElement | undefined, name: string): string | undefined {
  const c = xmlChild(el, name);
  return c ? xmlText(c).trim() : undefined;
}

// ------------------------------------------------------------------------------- bytes -> text

function fromCodeUnits(units: Uint16Array, length: number): string {
  let out = '';
  const CHUNK = 0x2000;
  for (let k = 0; k < length; k += CHUNK)
    out += String.fromCharCode(...units.subarray(k, Math.min(length, k + CHUNK)));
  return out;
}

function decodeUtf16(bytes: Uint8Array, start: number, littleEndian: boolean): string {
  const count = (bytes.length - start) >> 1;
  const units = new Uint16Array(count);
  for (let k = 0, p = start; k < count; k++, p += 2)
    units[k] = littleEndian ? bytes[p]! | (bytes[p + 1]! << 8) : (bytes[p]! << 8) | bytes[p + 1]!;
  return fromCodeUnits(units, count);
}

function decodeLatin1(bytes: Uint8Array, start: number): string {
  const units = new Uint16Array(bytes.length - start);
  for (let k = start; k < bytes.length; k++) units[k - start] = bytes[k]!;
  return fromCodeUnits(units, units.length);
}

/** A string as UTF-8 bytes. */
export function encodeUtf8(text: string): Uint8Array {
  const out: number[] = [];
  for (const ch of text) {
    const c = ch.codePointAt(0)!;
    if (c < 0x80) out.push(c);
    else if (c < 0x800) out.push(0xc0 | (c >> 6), 0x80 | (c & 0x3f));
    else if (c < 0x10000) out.push(0xe0 | (c >> 12), 0x80 | ((c >> 6) & 0x3f), 0x80 | (c & 0x3f));
    else
      out.push(
        0xf0 | (c >> 18),
        0x80 | ((c >> 12) & 0x3f),
        0x80 | ((c >> 6) & 0x3f),
        0x80 | (c & 0x3f),
      );
  }
  return new Uint8Array(out);
}

/** UTF-8 to a string; invalid sequences become U+FFFD. */
export function decodeUtf8(bytes: Uint8Array, start = 0): string {
  const units = new Uint16Array(bytes.length - start + 1);
  let u = 0;
  let k = start;
  const n = bytes.length;
  const cont = (p: number) => p < n && (bytes[p]! & 0xc0) === 0x80;
  while (k < n) {
    const b = bytes[k]!;
    let cp = 0xfffd;
    let len = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && cont(k + 1)) {
      cp = ((b & 0x1f) << 6) | (bytes[k + 1]! & 0x3f);
      len = 2;
    } else if (b >= 0xe0 && b < 0xf0 && cont(k + 1) && cont(k + 2)) {
      cp = ((b & 0x0f) << 12) | ((bytes[k + 1]! & 0x3f) << 6) | (bytes[k + 2]! & 0x3f);
      len = 3;
      if (cp < 0x800 || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    } else if (b >= 0xf0 && b < 0xf5 && cont(k + 1) && cont(k + 2) && cont(k + 3)) {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[k + 1]! & 0x3f) << 12) |
        ((bytes[k + 2]! & 0x3f) << 6) |
        (bytes[k + 3]! & 0x3f);
      len = 4;
      if (cp < 0x10000 || cp > 0x10ffff) cp = 0xfffd;
    }
    k += len;
    if (cp >= 0x10000) {
      cp -= 0x10000;
      units[u++] = 0xd800 + (cp >> 10);
      units[u++] = 0xdc00 + (cp & 0x3ff);
    } else {
      units[u++] = cp;
    }
  }
  return fromCodeUnits(units, u);
}

/**
 * Decode the bytes of an XML file: a byte order mark selects UTF-8 or UTF-16 (LE/BE); without one,
 * UTF-16 is recognised from the first `<`, and the XML declaration's `encoding` chooses between
 * UTF-8 (default) and ISO-8859-1 / windows-1252 (decoded as Latin-1).
 */
export function decodeXmlBytes(bytes: Uint8Array): string {
  const b0 = bytes[0];
  const b1 = bytes[1];
  if (b0 === 0xef && b1 === 0xbb && bytes[2] === 0xbf) return decodeUtf8(bytes, 3);
  if (b0 === 0xff && b1 === 0xfe) return decodeUtf16(bytes, 2, true);
  if (b0 === 0xfe && b1 === 0xff) return decodeUtf16(bytes, 2, false);
  if (b0 === 0x3c && b1 === 0x00) return decodeUtf16(bytes, 0, true);
  if (b0 === 0x00 && b1 === 0x3c) return decodeUtf16(bytes, 0, false);
  const head = decodeLatin1(bytes.subarray(0, Math.min(bytes.length, 200)), 0);
  const declared = /^\s*<\?xml[^>]*encoding\s*=\s*["']([^"']+)["']/i.exec(head)?.[1]?.toLowerCase();
  if (declared && /^(iso-?8859-1|latin-?1|windows-1252|cp1252|us-ascii|ascii)$/.test(declared))
    return decodeLatin1(bytes, 0);
  return decodeUtf8(bytes, 0);
}
