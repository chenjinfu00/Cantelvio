import type { ID } from './types';

/**
 * Id generation. Ids are created by the CALLER of a command and passed inside the command
 * payload, so that applying the same command twice (undo/redo, replay, collaboration rebase)
 * always yields the same document.
 *
 * Format: `<prefix>_<12 base36 chars>`; prefixes make ids self-describing in diffs and logs:
 *   sc score, pt part, st staff, gr group, m measure, e event, n note, tu tuplet,
 *   cl clef change, dy dynamic, tm tempo, ch chord symbol, gc grace note (chord), sp spanner,
 *   ai Cantelvio request / run.
 */
// prettier-ignore
export type IdPrefix =
  | 'sc' | 'pt' | 'st' | 'gr' | 'm' | 'e' | 'n' | 'tu' | 'cl' | 'dy' | 'tm' | 'ch' | 'gc' | 'sp'
  | 'ai';

export interface IdGenerator {
  next(prefix: IdPrefix): ID;
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz';

type RandomSource = (bytes: Uint8Array) => Uint8Array;

function defaultRandom(): RandomSource {
  const c = (globalThis as { crypto?: { getRandomValues?: (a: Uint8Array) => Uint8Array } }).crypto;
  if (c?.getRandomValues) return (bytes) => c.getRandomValues!(bytes);
  // Fallback for exotic runtimes; ids only need to be unique, not secret.
  return (bytes) => {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    return bytes;
  };
}

/** Random ids (default for the editor). */
export function randomIds(random: RandomSource = defaultRandom()): IdGenerator {
  return {
    next(prefix) {
      const bytes = random(new Uint8Array(12));
      let out = '';
      for (const b of bytes) out += ALPHABET[b % 36];
      return `${prefix}_${out}`;
    },
  };
}

/** Deterministic, readable ids for tests and fixtures: `e_1`, `e_2`, `n_1`, ... */
export function sequentialIds(start = 1): IdGenerator {
  const counters = new Map<string, number>();
  return {
    next(prefix) {
      const n = counters.get(prefix) ?? start;
      counters.set(prefix, n + 1);
      return `${prefix}_${n}`;
    },
  };
}
