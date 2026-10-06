import { rat } from '@ailegro-score/core';
import { describe, expect, it } from 'vitest';
import { type MeasureGeometry, offsetToX, xToOffset } from './geometry';

const measure = (offsets: readonly number[]): MeasureGeometry => ({
  measureId: 'm_test',
  index: 0,
  x: 10,
  width: 110,
  contentX: 30,
  length: rat(1),
  segments: offsets.map((t) => ({ offset: rat(Math.round(t * 8), 8), x: 30 + t * 80 })),
});

describe('playhead time-to-position mapping', () => {
  it('keeps moving during the last beat, right up to the barline', () => {
    const m = measure([0, 0.25, 0.5, 0.75]);
    expect(offsetToX(m, 0.75)).toBe(90);
    expect(offsetToX(m, 0.875)).toBe(105);
    expect(offsetToX(m, 1 - 1e-6)).toBeCloseTo(120, 3);
    expect(offsetToX(m, 1)).toBe(m.x + m.width);
  });

  it.each([
    ['held half note', [0, 0.5]],
    ['whole note or whole-measure rest', [0]],
    ['eighth notes', [0, 0.125, 0.25, 0.375, 0.5, 0.625, 0.75, 0.875]],
  ] as const)('advances throughout a bar containing %s', (_name, offsets) => {
    const m = measure(offsets);
    let previous = offsetToX(m, 0);
    for (let step = 1; step <= 100; step++) {
      const time = step / 100;
      const x = offsetToX(m, time);
      expect(x).toBeGreaterThan(previous);
      expect(xToOffset(m, x)).toBeCloseTo(time, 10);
      previous = x;
    }
    expect(previous).toBe(m.x + m.width);
  });

  it('aligns audio-clock floats with exact rational notation positions', () => {
    const m: MeasureGeometry = {
      ...measure([]),
      length: rat(3, 4),
      segments: [
        { offset: rat(0), x: 30 },
        { offset: rat(1, 12), x: 40 },
        { offset: rat(1, 6), x: 50 },
        { offset: rat(1, 4), x: 65 },
        { offset: rat(3, 8), x: 80 },
      ],
    };
    for (const t of [rat(1, 24), rat(1, 8), rat(1, 3), rat(1, 2), rat(3, 4)])
      expect(offsetToX(m, t.n / t.d)).toBeCloseTo(offsetToX(m, t), 10);
    expect(offsetToX(m, 0.75)).toBe(m.x + m.width);
  });
});
