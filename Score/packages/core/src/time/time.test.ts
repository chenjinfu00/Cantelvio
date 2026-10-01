import { describe, expect, it } from 'vitest';
import { decomposeGreedy, writtenFromLength, writtenLength } from './duration';
import {
  barLength,
  beamBoundaries,
  beatGroups,
  isMetricSpan,
  metricLevels,
  strongestBoundaryInside,
} from './meter';
import { add, cmp, div, eq, parseRational, rat, sub, toString } from './rational';

const r = parseRational;
const strs = (xs: { n: number; d: number }[]) => xs.map(toString);

describe('rational', () => {
  it('normalizes and compares', () => {
    expect(rat(2, 4)).toEqual({ n: 1, d: 2 });
    expect(rat(3, -6)).toEqual({ n: -1, d: 2 });
    expect(rat(0, 5)).toEqual({ n: 0, d: 1 });
    expect(eq(add(rat(1, 3), rat(1, 6)), rat(1, 2))).toBe(true);
    expect(toString(sub(rat(1, 4), rat(1, 3)))).toBe('-1/12');
    expect(cmp(rat(1, 3), rat(1, 4))).toBeGreaterThan(0);
    expect(toString(div(rat(3, 8), rat(1, 8)))).toBe('3');
    expect(toString(r(' 6/8 '))).toBe('3/4');
  });
  it('rejects bad input', () => {
    expect(() => rat(1, 0)).toThrow();
    expect(() => rat(0.5, 1)).toThrow();
    expect(() => r('a/b')).toThrow();
  });
});

describe('durations', () => {
  it('maps lengths to written values', () => {
    expect(writtenFromLength(r('3/8'))).toEqual({ value: 'quarter', dots: 1 });
    expect(writtenFromLength(r('7/16'))).toEqual({ value: 'quarter', dots: 2 });
    expect(writtenFromLength(r('5/8'))).toBeNull();
    expect(writtenFromLength(r('1/12'))).toBeNull();
    expect(toString(writtenLength({ value: 'half', dots: 1 }))).toBe('3/4');
  });
  it('decomposes greedily', () => {
    expect(decomposeGreedy(r('5/8'))).toEqual([
      { value: 'half', dots: 0 },
      { value: 'eighth', dots: 0 },
    ]);
  });
});

describe('meter', () => {
  it('groups beats', () => {
    expect(strs(beatGroups({ beats: 4, beatType: 4 }))).toEqual(['1/4', '1/4', '1/4', '1/4']);
    expect(strs(beatGroups({ beats: 6, beatType: 8 }))).toEqual(['3/8', '3/8']);
    expect(strs(beatGroups({ beats: 7, beatType: 8 }))).toEqual(['1/4', '1/4', '3/8']);
    expect(strs(beatGroups({ beats: 7, beatType: 8, groups: [3, 2, 2] }))).toEqual([
      '3/8',
      '1/4',
      '1/4',
    ]);
    expect(toString(barLength({ beats: 3, beatType: 4 }))).toBe('3/4');
  });

  it('builds metric levels for 4/4 with a half-bar level', () => {
    const levels = metricLevels({ beats: 4, beatType: 4 });
    expect(strs(levels[0]!)).toEqual(['0', '1']);
    expect(strs(levels[1]!)).toEqual(['0', '1/2', '1']);
    expect(strs(levels[2]!)).toEqual(['0', '1/4', '1/2', '3/4', '1']);
    expect(strs(levels[3]!).length).toBe(9);
    expect(toString(strongestBoundaryInside(levels, r('3/8'), r('7/8'))!)).toBe('1/2');
    expect(isMetricSpan(levels, r('1/2'), r('1'))).toBe(true);
    expect(isMetricSpan(levels, r('1/4'), r('3/4'))).toBe(false);
  });

  it('builds compound pulses for 6/8', () => {
    const levels = metricLevels({ beats: 6, beatType: 8 });
    expect(strs(levels[1]!)).toEqual(['0', '3/8', '3/4']);
    expect(strs(levels[2]!)).toEqual(['0', '1/8', '1/4', '3/8', '1/2', '5/8', '3/4']);
  });

  it('aligns pickup bars to the following barline', () => {
    const levels = metricLevels({ beats: 4, beatType: 4 }, r('1/4'));
    expect(strs(levels[0]!)).toEqual(['0', '1/4']);
    // the eighth level of the last beat
    expect(levels.some((l) => strs(l).join() === '0,1/8,1/4')).toBe(true);
  });

  it('chooses conventional beam groups', () => {
    expect(strs(beamBoundaries({ beats: 4, beatType: 4 }, 1))).toEqual(['0', '1/2', '1']);
    expect(strs(beamBoundaries({ beats: 4, beatType: 4 }, 2))).toEqual([
      '0',
      '1/4',
      '1/2',
      '3/4',
      '1',
    ]);
    expect(strs(beamBoundaries({ beats: 3, beatType: 4 }, 1))).toEqual(['0', '1/4', '1/2', '3/4']);
    expect(strs(beamBoundaries({ beats: 6, beatType: 8 }, 1))).toEqual(['0', '3/8', '3/4']);
  });
});
