import assert from 'node:assert/strict';
import {describe, test} from 'node:test';
import {
  DEFAULTS, MODES, PRESETS, normalize, storageKey, readPreferences,
  writePreferences, mix, luminance, contrast, readable, palette,
} from '../appearance/core.mjs';

// An independent WCAG calculation keeps palette tests from merely agreeing
// with a bug in the implementation's own contrast helper.
function contrastRatio(a, b) {
  const relativeLuminance = hex => {
    const channels = hex.slice(1).match(/.{2}/g).map(channel => Number.parseInt(channel, 16) / 255);
    const linear = channels.map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    return linear[0] * 0.2126 + linear[1] * 0.7152 + linear[2] * 0.0722;
  };
  const first = relativeLuminance(a), second = relativeLuminance(b);
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05);
}

function memoryStorage() {
  const values = new Map();
  return {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, String(value)),
  };
}

describe('appearance preferences', () => {
  test('normalizes missing and malformed values to fresh defaults', () => {
    for (const value of [undefined, null, false, true, 12, 'dark', [], {}]) {
      const normalized = normalize(value);
      assert.deepEqual(normalized, DEFAULTS);
      assert.notEqual(normalized, DEFAULTS);
    }
    assert.ok(Object.isFrozen(DEFAULTS));
  });

  test('accepts all modes, lowercases six-digit colors and strips extra fields', () => {
    for (const mode of MODES) {
      assert.deepEqual(normalize({mode, accent: '#ABCDEF', background: '#FEDCBA', version: 50, extra: 'ignored'}), {
        version: 1, mode, accent: '#abcdef', background: '#fedcba',
      });
    }
  });

  test('rejects malformed colors and unknown modes without discarding valid fields', () => {
    for (const color of ['#fff', '#12345678', '123456', '#gg0000', 'red', 'rgb(1,2,3)', '', null, 123456]) {
      assert.deepEqual(normalize({mode: 'custom', accent: color, background: color}), {...DEFAULTS, mode: 'custom'});
    }
    assert.deepEqual(normalize({mode: 'DARK', accent: '#112233', background: '#445566'}), {
      version: 1, mode: 'system', accent: '#112233', background: '#445566',
    });
  });

  test('does not mutate input preferences', () => {
    const original = Object.freeze({mode: 'custom', accent: '#ABCDEF', background: '#123456', version: 99});
    normalize(original);
    palette(original, true);
    assert.equal(original.accent, '#ABCDEF');
    assert.equal(original.version, 99);
  });
});

describe('project-scoped persistence', () => {
  const key = storageKey('https://chenjinfu00.github.io/Cantelvio/');

  test('uses the project root consistently from every module and ignores URL query/hash', () => {
    const entries = [
      ['https://chenjinfu00.github.io/Cantelvio/', './'],
      ['https://chenjinfu00.github.io/Cantelvio/score/?demo=continue', '../'],
      ['https://chenjinfu00.github.io/Cantelvio/harmony/', '../'],
      ['https://chenjinfu00.github.io/Cantelvio/stage/', '../'],
      ['https://chenjinfu00.github.io/Cantelvio/results/', '../'],
      ['https://chenjinfu00.github.io/Cantelvio/compose/orchestra/joint.html', '../../'],
    ];
    for (const [location, root] of entries) assert.equal(storageKey(new URL(root, location)), key);
    assert.equal(storageKey('https://chenjinfu00.github.io/Cantelvio/?lang=en#settings'), key);
  });

  test('keeps other GitHub Pages projects and the origin root isolated', () => {
    const otherKey = storageKey('https://chenjinfu00.github.io/OtherProject/');
    assert.notEqual(otherKey, key);
    assert.notEqual(storageKey('https://chenjinfu00.github.io/'), key);
    const storage = memoryStorage();
    writePreferences(storage, key, {mode: 'dark', accent: '#2865bc'});
    assert.equal(readPreferences(storage, key).mode, 'dark');
    assert.deepEqual(readPreferences(storage, otherKey), DEFAULTS);
  });

  test('round-trips normalized preferences, including custom background', () => {
    const storage = memoryStorage();
    const value = {mode: 'custom', accent: '#ABCDEF', background: '#765432', unexpected: true};
    assert.equal(writePreferences(storage, key, value), true);
    assert.deepEqual(readPreferences(storage, key), normalize(value));
    assert.deepEqual(JSON.parse(storage.getItem(key)), normalize(value));
  });

  test('returns fresh defaults for absent, corrupted or unsupported stored values', () => {
    for (const serialized of [null, '', '{broken', 'null', '12', '"dark"', '[]']) {
      const storage = {getItem: () => serialized};
      const first = readPreferences(storage, key);
      first.mode = 'custom';
      assert.deepEqual(readPreferences(storage, key), DEFAULTS);
      assert.equal(DEFAULTS.mode, 'system');
    }
  });

  test('survives unavailable storage and storage access failures', () => {
    const blocked = {
      getItem() {throw new Error('Storage access denied');},
      setItem() {throw new Error('Quota exceeded');},
    };
    for (const storage of [undefined, null, blocked, {}]) {
      assert.deepEqual(readPreferences(storage, key), DEFAULTS);
      assert.equal(writePreferences(storage, key, {mode: 'dark'}), false);
    }
  });

  test('preserves the prior saved value when a write fails', () => {
    const original = normalize({mode: 'light', accent: '#7651b5'});
    const storage = {
      getItem: () => JSON.stringify(original),
      setItem() {throw new Error('Quota exceeded');},
    };
    assert.equal(writePreferences(storage, key, {mode: 'dark'}), false);
    assert.deepEqual(readPreferences(storage, key), original);
  });
});

describe('mode and palette behavior', () => {
  test('system mode follows the system preference', () => {
    assert.equal(palette({mode: 'system'}, false).theme, 'light');
    assert.equal(palette({mode: 'system'}, true).theme, 'dark');
    assert.notEqual(palette({mode: 'system'}, false).colors.bg, palette({mode: 'system'}, true).colors.bg);
  });

  test('explicit light and dark modes ignore system changes and custom background', () => {
    for (const mode of ['light', 'dark']) {
      const settings = {mode, background: '#ff0000'};
      assert.deepEqual(palette(settings, false), palette(settings, true));
      assert.equal(palette(settings).theme, mode);
      assert.notEqual(palette(settings).colors.bg, settings.background);
    }
  });

  test('custom backgrounds remain exact and determine their own resolved theme', () => {
    for (const [background, theme] of [['#ffffff', 'light'], ['#000000', 'dark'], ['#e8d9c1', 'light'], ['#243b52', 'dark']]) {
      const settings = {mode: 'custom', background};
      assert.equal(palette(settings).colors.bg, background);
      assert.equal(palette(settings).theme, theme);
      assert.deepEqual(palette(settings, false), palette(settings, true));
    }
  });

  test('invalid preferences yield the same palette as defaults', () => {
    assert.deepEqual(palette({mode: 'unknown', background: 'red', accent: '#fff'}), palette(DEFAULTS));
    assert.deepEqual(palette(null, true), palette(DEFAULTS, true));
  });

  test('returns fresh palettes and valid CSS colors for each setting', () => {
    const first = palette(DEFAULTS);
    first.colors.bg = '#000000';
    assert.notEqual(palette(DEFAULTS).colors.bg, first.colors.bg);
    for (const mode of MODES) {
      const result = palette({mode, background: '#808080'});
      assert.ok(['light', 'dark'].includes(result.theme));
      for (const [name, color] of Object.entries(result.colors)) assert.match(color, /^#[0-9a-f]{6}$/i, name);
      assert.equal(typeof result.shadow, 'string');
    }
  });

  test('color helpers agree with reference contrast values', () => {
    assert.equal(luminance('#000000'), 0);
    assert.equal(luminance('#ffffff'), 1);
    assert.equal(contrast('#000000', '#ffffff'), 21);
    assert.equal(contrast('#123456', '#123456'), 1);
    assert.equal(mix('#000000', '#ffffff', 0), '#000000');
    assert.equal(mix('#000000', '#ffffff', 1), '#ffffff');
    assert.equal(mix('#000000', '#ffffff', 0.5), '#808080');
    for (const background of ['#000000', '#ffffff', '#777777', '#0000ff']) {
      assert.ok(Math.abs(contrast('#7651b5', background) - contrastRatio('#7651b5', background)) < 1e-12);
      assert.ok(contrastRatio(readable('#7651b5', background), background) >= 4.5);
    }
  });
});

// Text and accent links appear on each of these surfaces throughout the
// workspaces, including selected rows and the shared settings controls.
const surfaces = ['bg', 'surface', 'raised', 'accent-soft'];
const backgrounds = [
  '#000000', '#ffffff', '#030303', '#fdfdfd',
  '#141b18', '#243b52', '#e8d9c1', '#f6f5ef',
  '#444444', '#666666', '#707070', '#757575', '#767676', '#777777', '#787878', '#808080', '#999999', '#bbbbbb',
  '#ff0000', '#00ff00', '#0000ff', '#ffff00', '#00ffff', '#ff00ff',
];

function assertReadablePalette(settings, context) {
  const {colors} = palette(settings);
  const failures = [];
  for (const ink of ['text', 'muted', 'accent']) {
    for (const surface of surfaces) {
      const ratio = contrastRatio(colors[ink], colors[surface]);
      if (ratio < 4.5) failures.push(`${ink} ${colors[ink]} on ${surface} ${colors[surface]} = ${ratio.toFixed(3)}:1`);
    }
  }
  for (const fill of ['accent', 'accent-hover']) {
    const ratio = contrastRatio(colors['on-accent'], colors[fill]);
    if (ratio < 4.5) failures.push(`on-accent ${colors['on-accent']} on ${fill} ${colors[fill]} = ${ratio.toFixed(3)}:1`);
  }
  assert.deepEqual(failures, [], `${context}: all normal text requires at least 4.5:1 contrast\n${failures.join('\n')}`);
}

describe('readable shared colors', () => {
  for (const preset of PRESETS) {
    for (const mode of ['light', 'dark']) {
      test(`${preset.en} preset in ${mode} mode`, () => assertReadablePalette({mode, accent: preset.color}, `${preset.en}, ${mode}`));
    }
    for (const background of backgrounds) {
      test(`${preset.en} preset on custom ${background}`, () => assertReadablePalette({mode: 'custom', accent: preset.color, background}, `${preset.en}, custom ${background}`));
    }
  }
  for (const accent of ['#000000', '#ffffff', '#777777']) {
    for (const background of ['#000000', '#ffffff', '#777777']) {
      test(`custom accent ${accent} on ${background}`, () => assertReadablePalette({mode: 'custom', accent, background}, `custom ${accent} on ${background}`));
    }
  }

  test('all presets remain readable across every eight-bit gray background', () => {
    for (let channel = 0; channel <= 255; channel++) {
      const background = '#' + channel.toString(16).padStart(2, '0').repeat(3);
      for (const preset of PRESETS) {
        assertReadablePalette({mode: 'custom', accent: preset.color, background}, `${preset.en}, gray ${background}`);
      }
    }
  });

  test('all presets remain readable across a coarse RGB background grid', () => {
    for (const red of [0, 51, 102, 153, 204, 255]) {
      for (const green of [0, 51, 102, 153, 204, 255]) {
        for (const blue of [0, 51, 102, 153, 204, 255]) {
          const background = '#' + [red, green, blue].map(channel => channel.toString(16).padStart(2, '0')).join('');
          for (const preset of PRESETS) {
            assertReadablePalette({mode: 'custom', accent: preset.color, background}, `${preset.en}, RGB ${background}`);
          }
        }
      }
    }
  });
});
