#!/usr/bin/env node
/**
 * Generate packages/engraving/src/smufl/bravura.generated.ts from the Bravura font.
 *
 * Inputs : @vexflow-fonts/bravura (bravura.otf + metadata.json, SIL OFL 1.1)
 * Output : glyph outlines as SVG path data in staff spaces (y down, origin = glyph origin),
 *          bounding boxes and anchors from the SMuFL metadata, and the engraving defaults.
 *
 * Codepoints follow the SMuFL specification (checked against w3c/smufl glyphnames.json).
 * The script verifies every codepoint by comparing the outline's bounding box with the
 * metadata bounding box of the glyph name, so a wrong codepoint fails loudly.
 *
 * Run: npm run gen:smufl
 */
import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const opentype = require('opentype.js');

const here = dirname(fileURLToPath(import.meta.url));
const fontDir = dirname(require.resolve('@vexflow-fonts/bravura/package.json'));
const metadata = JSON.parse(readFileSync(join(fontDir, 'metadata.json'), 'utf8'));
const font = opentype.loadSync(join(fontDir, 'bravura.otf'));

/** SMuFL glyph name -> codepoint. Add glyphs here, then rerun the script. */
const GLYPHS = {
  brace: 0xe000,
  bracket: 0xe002,
  bracketTop: 0xe003,
  bracketBottom: 0xe004,
  repeatDot: 0xe044,
  segno: 0xe047,
  coda: 0xe048,
  gClef: 0xe050,
  gClef8vb: 0xe052,
  gClef8va: 0xe053,
  cClef: 0xe05c,
  fClef: 0xe062,
  fClef8vb: 0xe064,
  unpitchedPercussionClef1: 0xe069,
  timeSig0: 0xe080,
  timeSig1: 0xe081,
  timeSig2: 0xe082,
  timeSig3: 0xe083,
  timeSig4: 0xe084,
  timeSig5: 0xe085,
  timeSig6: 0xe086,
  timeSig7: 0xe087,
  timeSig8: 0xe088,
  timeSig9: 0xe089,
  timeSigCommon: 0xe08a,
  timeSigCutCommon: 0xe08b,
  noteheadDoubleWhole: 0xe0a0,
  noteheadWhole: 0xe0a2,
  noteheadHalf: 0xe0a3,
  noteheadBlack: 0xe0a4,
  noteheadXBlack: 0xe0a9,
  augmentationDot: 0xe1e7,
  flag8thUp: 0xe240,
  flag8thDown: 0xe241,
  flag16thUp: 0xe242,
  flag16thDown: 0xe243,
  flag32ndUp: 0xe244,
  flag32ndDown: 0xe245,
  flag64thUp: 0xe246,
  flag64thDown: 0xe247,
  flag128thUp: 0xe248,
  flag128thDown: 0xe249,
  accidentalFlat: 0xe260,
  accidentalNatural: 0xe261,
  accidentalSharp: 0xe262,
  accidentalDoubleSharp: 0xe263,
  accidentalDoubleFlat: 0xe264,
  accidentalParensLeft: 0xe26a,
  accidentalParensRight: 0xe26b,
  articAccentAbove: 0xe4a0,
  articAccentBelow: 0xe4a1,
  articStaccatoAbove: 0xe4a2,
  articStaccatoBelow: 0xe4a3,
  articTenutoAbove: 0xe4a4,
  articTenutoBelow: 0xe4a5,
  articStaccatissimoAbove: 0xe4a6,
  articStaccatissimoBelow: 0xe4a7,
  articMarcatoAbove: 0xe4ac,
  articMarcatoBelow: 0xe4ad,
  fermataAbove: 0xe4c0,
  fermataBelow: 0xe4c1,
  restDoubleWhole: 0xe4e2,
  restWhole: 0xe4e3,
  restHalf: 0xe4e4,
  restQuarter: 0xe4e5,
  rest8th: 0xe4e6,
  rest16th: 0xe4e7,
  rest32nd: 0xe4e8,
  rest64th: 0xe4e9,
  rest128th: 0xe4ea,
  restHBarLeft: 0xe4ef,
  restHBarMiddle: 0xe4f0,
  restHBarRight: 0xe4f1,
  dynamicPiano: 0xe520,
  dynamicMezzo: 0xe521,
  dynamicForte: 0xe522,
  dynamicRinforzando: 0xe523,
  dynamicSforzando: 0xe524,
  dynamicZ: 0xe525,
  dynamicNiente: 0xe526,
  tuplet0: 0xe880,
  tuplet1: 0xe881,
  tuplet2: 0xe882,
  tuplet3: 0xe883,
  tuplet4: 0xe884,
  tuplet5: 0xe885,
  tuplet6: 0xe886,
  tuplet7: 0xe887,
  tuplet8: 0xe888,
  tuplet9: 0xe889,
  tupletColon: 0xe88a,
  metNoteDoubleWhole: 0xeca0,
  metNoteWhole: 0xeca2,
  metNoteHalfUp: 0xeca3,
  metNoteQuarterUp: 0xeca5,
  metNote8thUp: 0xeca7,
  metNote16thUp: 0xeca9,
  metNote32ndUp: 0xecab,
  metNote64thUp: 0xecad,
  metAugmentationDot: 0xecb7,
  keyboardPedalPed: 0xe650,
  keyboardPedalUp: 0xe655,
};

const SP_PER_EM = 4; // SMuFL: one em = four staff spaces
const round = (x, k = 3) => Math.round(x * 10 ** k) / 10 ** k;

const out = {};
const problems = [];
for (const [name, cp] of Object.entries(GLYPHS)) {
  const glyph = font.charToGlyph(String.fromCodePoint(cp));
  if (!glyph || glyph.index === 0) {
    problems.push(`${name}: codepoint U+${cp.toString(16)} not in font`);
    continue;
  }
  const meta = metadata.glyphBBoxes[name];
  if (!meta) {
    problems.push(`${name}: no bounding box in metadata`);
    continue;
  }
  const bb = glyph.getBoundingBox();
  const scale = SP_PER_EM / font.unitsPerEm;
  const fromFont = [bb.x1 * scale, bb.y1 * scale, bb.x2 * scale, bb.y2 * scale];
  const fromMeta = [meta.bBoxSW[0], meta.bBoxSW[1], meta.bBoxNE[0], meta.bBoxNE[1]];
  if (fromFont.some((v, i) => Math.abs(v - fromMeta[i]) > 0.02)) {
    problems.push(
      `${name}: outline bbox ${fromFont.map((v) => round(v, 2))} != metadata ${fromMeta}`,
    );
  }
  const path = glyph.getPath(0, 0, SP_PER_EM).toPathData(3);
  const anchors = metadata.glyphsWithAnchors[name];
  const advance = metadata.glyphAdvanceWidths?.[name];
  out[name] = {
    cp,
    // [x0, y0, x1, y1] in staff spaces, SMuFL orientation (y up)
    bbox: fromMeta.map((v) => round(v)),
    ...(anchors
      ? {
          anchors: Object.fromEntries(
            Object.entries(anchors).map(([k, v]) => [k, v.map((x) => round(x))]),
          ),
        }
      : {}),
    ...(advance !== undefined ? { advance: round(advance) } : {}),
    path,
  };
}
if (problems.length) {
  console.error('SMuFL generation failed:\n  ' + problems.join('\n  '));
  process.exit(1);
}

const defaults = metadata.engravingDefaults;
const body = `/* eslint-disable */
// GENERATED by packages/engraving/scripts/gen-smufl.mjs — do not edit by hand.
// Source: Bravura ${metadata.fontVersion} (SIL Open Font License 1.1, © Steinberg Media Technologies GmbH).
// Units: staff spaces. Paths are y-down with the glyph origin at (0, 0); bbox/anchors are SMuFL (y-up).

export const FONT_NAME = ${JSON.stringify(metadata.fontName)};
export const FONT_VERSION = ${JSON.stringify(metadata.fontVersion)};

export const ENGRAVING_DEFAULTS = ${JSON.stringify(defaults, null, 2)} as const;

export const GLYPH_DATA = {
${Object.entries(out)
  .map(([name, g]) => `  ${name}: ${JSON.stringify(g)},`)
  .join('\n')}
} as const;
`;
const target = join(here, '..', 'src', 'smufl', 'bravura.generated.ts');
writeFileSync(target, body);
console.log(`wrote ${Object.keys(out).length} glyphs to ${target}`);
