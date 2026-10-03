import { describe, expect, it } from 'vitest';
import {
  XmlError,
  decodeUtf8,
  decodeXmlBytes,
  encodeUtf8,
  parseXml,
  xmlChild,
  xmlChildText,
  xmlChildren,
  xmlText,
} from './xml';
import { ZipError, crc32, readZipEntries, readZipEntry, writeZip } from './zip';

const bytes = (text: string) => new Uint8Array([...text].map((c) => c.charCodeAt(0)));

describe('xml parser', () => {
  it('reads elements, attributes, text and self-closing tags', () => {
    const root = parseXml(
      `<score a="1" b='two'><part id="P1"><note><step>C</step><dot/></note></part></score>`,
    );
    expect(root.name).toBe('score');
    expect(root.attributes).toEqual({ a: '1', b: 'two' });
    const note = xmlChild(xmlChild(root, 'part'), 'note');
    expect(xmlChildText(note, 'step')).toBe('C');
    expect(xmlChildren(note).map((c) => c.name)).toEqual(['step', 'dot']);
    expect(xmlChild(note, 'dot')?.children).toEqual([]);
    expect(xmlChildText(note, 'missing')).toBeUndefined();
  });

  it('skips the declaration, the doctype (with an internal subset), comments and PIs', () => {
    const root = parseXml(`\uFEFF<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE score-partwise PUBLIC "-//Recordare//DTD MusicXML 4.0 Partwise//EN"
  "http://www.musicxml.org/dtds/partwise.dtd" [ <!ENTITY x "y"> <!-- a > b --> ]>
<!-- comment with <tags> -->
<score-partwise><?finale ignore me?><work/><!-- inside --></score-partwise>
<!-- after -->`);
    expect(root.name).toBe('score-partwise');
    expect(xmlChildren(root).map((c) => c.name)).toEqual(['work']);
  });

  it('decodes entities and character references; CDATA stays literal', () => {
    const root = parseXml(
      `<t a="&lt;&amp;&quot;&#65;&#x42;">x &lt; y &amp; &apos;z&apos; &#x266D; &unknown; <![CDATA[<b>&amp;</b>]]></t>`,
    );
    expect(root.attributes.a).toBe('<&"AB');
    expect(xmlText(root)).toBe(`x < y & 'z' ♭ &unknown; <b>&amp;</b>`);
  });

  it('drops whitespace-only text unless asked to keep it', () => {
    const xml = '<a>\n  <b> x </b>\n</a>';
    expect(parseXml(xml).children.length).toBe(1);
    expect(xmlText(parseXml(xml))).toBe(' x ');
    expect(parseXml(xml, { keepWhitespace: true }).children.length).toBe(3);
  });

  it('reports malformed documents with line and column', () => {
    const fail = (xml: string) => {
      try {
        parseXml(xml);
      } catch (e) {
        expect(e).toBeInstanceOf(XmlError);
        return e as XmlError;
      }
      throw new Error('no error');
    };
    expect(fail('<a>\n  <b></c></a>').line).toBe(2);
    expect(fail('<a><b></b>').message).toMatch(/unclosed element <a>/);
    expect(fail('<a/><b/>').message).toMatch(/more than one root/);
    expect(fail('just text').message).toMatch(/outside the root/);
    expect(fail('<a x=1/>').message).toMatch(/malformed attribute/);
    expect(fail('').message).toMatch(/no root element/);
    expect(fail('<a><!-- open</a>').message).toMatch(/unterminated comment/);
  });

  it('decodes bytes as UTF-8, UTF-16 or Latin-1', () => {
    const text = '<a>Ré ♭ 𝄞</a>';
    const utf8 = encodeUtf8(text);
    expect(decodeUtf8(utf8)).toBe(text);
    expect(decodeXmlBytes(new Uint8Array([0xef, 0xbb, 0xbf, ...utf8]))).toBe(text);
    const le = new Uint8Array(2 + text.length * 2);
    const be = new Uint8Array(2 + text.length * 2);
    le.set([0xff, 0xfe]);
    be.set([0xfe, 0xff]);
    for (let i = 0; i < text.length; i++) {
      const c = text.charCodeAt(i);
      le.set([c & 0xff, c >> 8], 2 + i * 2);
      be.set([c >> 8, c & 0xff], 2 + i * 2);
    }
    expect(decodeXmlBytes(le)).toBe(text);
    expect(decodeXmlBytes(be)).toBe(text);
    expect(decodeXmlBytes(le.subarray(2))).toBe(text); // no BOM: recognised from "<\0"
    const latin1 = bytes('<?xml version="1.0" encoding="ISO-8859-1"?><a>R\xe9</a>');
    expect(xmlText(parseXml(decodeXmlBytes(latin1)))).toBe('Ré');
    expect(decodeUtf8(new Uint8Array([0x41, 0xc3]))).toBe('A�');
  });
});

describe('zip', () => {
  it('computes CRC-32', () => {
    expect(crc32(bytes('123456789'))).toBe(0xcbf43926);
  });

  it('writes and reads stored archives', async () => {
    const files = [
      { name: 'META-INF/container.xml', data: bytes('<container/>') },
      { name: 'score.musicxml', data: bytes('<score-partwise/>') },
      { name: 'dir/ü.txt', data: new Uint8Array([1, 2, 3]) },
    ];
    const zip = writeZip(files);
    const entries = readZipEntries(zip);
    expect(entries.map((e) => [e.name, e.method, e.size])).toEqual([
      ['META-INF/container.xml', 0, 12],
      ['score.musicxml', 0, 17],
      ['dir/ü.txt', 0, 3],
    ]);
    const inflate = () => {
      throw new Error('stored entries need no inflate');
    };
    for (const [i, e] of entries.entries())
      expect(await readZipEntry(zip, e, inflate)).toEqual(files[i]!.data);
  });

  it('hands deflated entries to the platform inflate and checks them', async () => {
    // a reversible stand-in for DEFLATE: the plumbing (method 8, sizes, CRC) is what is tested
    const reverse = (d: Uint8Array) => new Uint8Array([...d].reverse());
    const zip = writeZip([{ name: 'a.xml', data: bytes('<a>abc</a>') }], reverse);
    const [entry] = readZipEntries(zip);
    expect(entry!.method).toBe(8);
    expect(await readZipEntry(zip, entry!, reverse)).toEqual(bytes('<a>abc</a>'));
    await expect(readZipEntry(zip, entry!, (d) => d)).rejects.toThrow(ZipError);
  });

  it('refuses damaged archives', () => {
    expect(() => readZipEntries(bytes('PK\x03\x04 not really'))).toThrow(ZipError);
    const zip = writeZip([{ name: 'a', data: bytes('x') }]);
    expect(() => readZipEntries(zip.subarray(0, zip.length - 30))).toThrow(ZipError);
  });
});
