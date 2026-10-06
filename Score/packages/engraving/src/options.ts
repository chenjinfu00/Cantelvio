import type { ScoreDoc } from '@ailegro-score/core';

/** Measures text width in staff spaces for a font size in staff spaces. */
export type TextMeasurer = (
  text: string,
  size: number,
  family: 'serif' | 'sans',
  weight?: 'normal' | 'bold',
  italic?: boolean,
) => number;

/** Rough metrics good enough for layout when no real font metrics are available (Node, tests). */
export const approximateTextWidth: TextMeasurer = (text, size, _family, weight) => {
  let w = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x2e80)
      w += 1.0; // CJK
    else if ("il.,:;|!'`".includes(ch)) w += 0.28;
    else if ('mwMW'.includes(ch)) w += 0.85;
    else if (ch === ' ') w += 0.27;
    else if (ch >= 'A' && ch <= 'Z') w += 0.68;
    else w += 0.5;
  }
  return w * size * (weight === 'bold' ? 1.06 : 1);
};

export interface LayoutOptions {
  /** 'page': print pages; 'continuous': one horizontal system; 'seamless': wrapped vertical flow. */
  readonly mode: 'page' | 'continuous' | 'seamless';
  /** Show concert pitch instead of written pitch for transposing instruments. */
  readonly concertPitch: boolean;
  readonly measureText: TextMeasurer;
  /** Override page geometry (mm); default from the document settings. */
  readonly pageWidthMm?: number;
  readonly pageHeightMm?: number;
  readonly staffSpaceMm?: number;
  /** Horizontal spacing multiplier (1 = default). */
  readonly spacing: number;
  /** Show measure numbers at system starts. */
  readonly measureNumbers: boolean;
  /** Ids of events to draw as AI suggestions (ghost style). */
  readonly ghostEvents?: ReadonlySet<string>;
}

export function defaultOptions(
  doc: ScoreDoc,
  overrides: Partial<LayoutOptions> = {},
): LayoutOptions {
  return {
    mode: 'page',
    concertPitch: doc.settings.concertPitch,
    measureText: approximateTextWidth,
    spacing: 1,
    measureNumbers: true,
    ...overrides,
  };
}

/** Engraving style constants (staff spaces unless noted). */
export const STYLE = {
  staffHeight: 4,
  staffLineWidth: 0.13,
  ledgerLineWidth: 0.16,
  ledgerExtension: 0.4,
  stemWidth: 0.12,
  stemLength: 3.5,
  beamThickness: 0.5,
  beamSpacing: 0.25,
  thinBarline: 0.16,
  thickBarline: 0.5,
  barlineSeparation: 0.4,
  /** Gap between staves of one instrument (grand staff). */
  staffGapInPart: 5.5,
  /** Gap between staves of different instruments. */
  staffGapBetweenParts: 6.5,
  systemGap: 9,
  minPadding: 0.6,
  noteSpacingQuarter: 3.4,
  spacingExponent: 0.62,
  measureStartPad: 1.3,
  measureEndPad: 1.0,
  clefPadLeft: 0.6,
  keySigPad: 0.6,
  timeSigPad: 0.9,
  dotGap: 0.35,
  dotSpacing: 0.5,
  accidentalGap: 0.2,
  instrumentNameSize: 1.9,
  measureNumberSize: 1.3,
  titleSize: 5.2,
  subtitleSize: 2.8,
  composerSize: 2.2,
  tempoSize: 2.0,
  chordSymbolSize: 2.0,
  tieThickness: 0.2,
} as const;
