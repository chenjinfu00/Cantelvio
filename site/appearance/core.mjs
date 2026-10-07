export const DEFAULTS = Object.freeze({version: 1, mode: 'system', accent: '#2f6b4f', background: '#f6f5ef'});
export const MODES = ['system', 'light', 'dark', 'custom'];
export const PRESETS = [
  {color: '#2f6b4f', zh: '松绿', en: 'Forest'},
  {color: '#2865bc', zh: '湖蓝', en: 'Lake'},
  {color: '#7651b5', zh: '紫藤', en: 'Violet'},
  {color: '#a64b21', zh: '暖橙', en: 'Amber'},
];
const isColor = value => typeof value === 'string' && /^#[\da-f]{6}$/i.test(value);
export function normalize(value) {
  if (!value || typeof value !== 'object') value = {};
  return {
    version: 1,
    mode: MODES.includes(value.mode) ? value.mode : DEFAULTS.mode,
    accent: isColor(value.accent) ? value.accent.toLowerCase() : DEFAULTS.accent,
    background: isColor(value.background) ? value.background.toLowerCase() : DEFAULTS.background,
  };
}
export function storageKey(scope) {
  return `cantelvio:appearance:v1:${new URL(scope).pathname}`;
}
export function readPreferences(storage, key) {
  try { return normalize(JSON.parse(storage.getItem(key))); } catch { return {...DEFAULTS}; }
}
export function writePreferences(storage, key, preferences) {
  try { storage.setItem(key, JSON.stringify(normalize(preferences))); return true; } catch { return false; }
}
const rgb = hex => [1, 3, 5].map(start => parseInt(hex.slice(start, start + 2), 16));
export function mix(a, b, amount) {
  const other = rgb(b);
  return '#' + rgb(a).map((channel, i) => Math.round(channel + (other[i] - channel) * amount).toString(16).padStart(2, '0')).join('');
}
export function luminance(hex) {
  return rgb(hex).reduce((sum, channel, i) => {
    const c = channel / 255;
    return sum + (c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4) * [.2126, .7152, .0722][i];
  }, 0);
}
export function contrast(a, b) {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y);
  return (high + .05) / (low + .05);
}
export function readable(color, background, ratio = 4.5) {
  if (contrast(color, background) >= ratio) return color;
  const target = contrast('#000000', background) > contrast('#ffffff', background) ? '#000000' : '#ffffff';
  for (let step = 1; step <= 100; step++) {
    const adjusted = mix(color, target, step / 100);
    if (contrast(adjusted, background) >= ratio) return adjusted;
  }
  return target;
}
function readableOn(color, backgrounds, ratio = 4.5) {
  const score = candidate => Math.min(...backgrounds.map(bg => contrast(candidate, bg)));
  if (score(color) >= ratio) return color;
  const target = score('#000000') > score('#ffffff') ? '#000000' : '#ffffff';
  for (let step = 1; step <= 100; step++) {
    const candidate = mix(color, target, step / 100);
    if (score(candidate) >= ratio) return candidate;
  }
  return target;
}
export function palette(value, systemDark = false) {
  const settings = normalize(value);
  const bg = settings.mode === 'custom' ? settings.background : (settings.mode === 'dark' || (settings.mode === 'system' && systemDark) ? '#141b18' : '#f6f5ef');
  const dark = contrast('#ffffff', bg) > contrast('#000000', bg);
  // Mid-tone custom backgrounds need surfaces that increase text contrast.
  const lift = dark && luminance(bg) < .06;
  const surface = mix(bg, dark && !lift ? '#000000' : '#ffffff', dark ? (lift ? .045 : .12) : .72);
  const raised = mix(bg, dark && !lift ? '#000000' : '#ffffff', dark ? (lift ? .085 : .22) : .38);
  const bases = [bg, surface, raised];
  const accentSoft = color => mix(surface, color, dark ? (lift ? .17 : .04) : .10);
  const target = dark ? '#ffffff' : '#000000';
  let accent = settings.accent;
  for (let step = 0; step <= 100; step++) {
    accent = mix(settings.accent, target, step / 100);
    if (bases.concat(accentSoft(accent)).every(base => contrast(accent, base) >= 4.5)) break;
  }
  const backgrounds = [...bases, accentSoft(accent), mix(surface, '#c89637', .12), mix(surface, '#b13b3b', .10)];
  const text = readableOn(dark ? '#f2f6f2' : '#142019', backgrounds);
  const onAccent = contrast('#ffffff', accent) > contrast('#000000', accent) ? '#ffffff' : '#000000';
  const semantic = color => readableOn(color, backgrounds);
  return {
    theme: dark ? 'dark' : 'light',
    colors: {
      bg, surface, raised, text,
      muted: readableOn(mix(text, bg, .34), backgrounds),
      border: mix(bg, text, dark ? .23 : .18),
      accent, 'accent-hover': mix(accent, onAccent === '#ffffff' ? '#000000' : '#ffffff', .12),
      'on-accent': onAccent, 'accent-soft': accentSoft(accent),
      good: semantic('#237349'), warning: semantic('#95611b'), danger: semantic('#b13b3b'),
      'warning-soft': mix(surface, '#c89637', .12), 'danger-soft': mix(surface, '#b13b3b', .10),
    },
    shadow: dark ? '0 8px 32px rgb(0 0 0 / .32)' : '0 6px 24px rgb(20 32 25 / .10)',
  };
}
