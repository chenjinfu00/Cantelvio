import {quarterToSeconds, renderAudio} from './audio.js';
import {createLiveController} from './live.js';

const $ = id => document.getElementById(id);
const GROUPS = [
  ['woodwinds', 'Woodwinds', '木管', '#9cc9b4'],
  ['brass', 'Brass', '铜管', '#e8b26d'],
  ['percussion', 'Percussion', '打击乐', '#d78f7f'],
  ['keys', 'Harp / keys', '竖琴／键盘', '#c8b2d9'],
  ['high_strings', 'High strings', '高音弦乐', '#94b9dd'],
  ['low_strings', 'Low strings', '低音弦乐', '#b5c58d'],
];
const NAMES = {
  'abl-absolute': ['Absolute pitch', '绝对音高', 'Direct MIDI-pitch targets · no transposition', '直接预测 MIDI 音高 · 无移调增强'],
  'abl-absolute-aug': ['Absolute + augmentation', '绝对音高＋增强', 'Direct pitch targets · transposition in training', '直接预测音高 · 训练时移调'],
  'abl-rotary': ['Rotary pitch', '旋转音高', 'Relative intervals + pitch rotation · no augmentation', '相对音程＋音高旋转 · 无增强'],
  'abl-rotary-aug': ['Rotary + augmentation', '旋转音高＋增强', 'Relative intervals + rotation · transposition in training', '相对音程＋旋转 · 训练时移调'],
  'abl-rotary-exact-aug': ['Exact rotary + augmentation', '精确旋转＋增强', 'No register-position channel · transposition in training', '无音区位置通道 · 训练时移调'],
};

let language = 'en';
let modelData = [];
let selected = 'abl-rotary-aug';
let current = null;
let busy = false;
let live;
let viewToken = 0;
const groupState = Object.fromEntries(GROUPS.map(([id]) => [id, id.endsWith('strings') ? 'on' : 'auto']));
const generated = new Map();
const audioCache = new Map();
const audioUrls = new Set();
const noteHits = [];
const chart = {margin: 104, header: 33, lane: 45, scale: 19, width: 0};
const t = (en, zh) => language === 'en' ? en : zh;
const stateText = state => ({auto: t('Auto', '自动'), on: t('On', '开启'), off: t('Off', '关闭')})[state];

function setStatus(en, zh, state = '') {
  $('status').textContent = t(en, zh);
  $('status').dataset.state = state;
}

function translate() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.title = t('Cantelvio Compose · Orchestral Listening Room', 'Cantelvio Compose · 管弦乐试听室');
  document.querySelectorAll('[data-en][data-zh]').forEach(el => {
    el.textContent = el.dataset[language];
  });
  $('language').textContent = language === 'en' ? '中文' : 'EN';
  $('bars').querySelectorAll('option').forEach(option => { option.textContent = t(`${option.value} bars`, `${option.value} 小节`); });
  $('soundMode').options[0].textContent = t('Orchestral sketch', '管弦乐简化音色');
  $('soundMode').options[1].textContent = t('Piano reduction', '钢琴简化音色');
  renderModels();
  renderGroups();
  $('stageTitle').textContent = NAMES[selected]?.[language === 'en' ? 0 : 1] ?? selected;
  live?.updateLanguage();
  if (current) drawScore(current.sample);
}

function renderModels() {
  $('modelList').replaceChildren(...modelData.map((model, index) => {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'model-card'; button.dataset.model = model.id;
    button.setAttribute('aria-pressed', String(model.id === selected));
    button.disabled = busy;
    const info = NAMES[model.id];
    button.innerHTML = `<span class="index">${String(index + 1).padStart(2, '0')}</span><span><strong>${info[language === 'en' ? 0 : 1]}</strong><small class="desc">${info[language === 'en' ? 2 : 3]}</small><span class="value">VAL NLL ${model.validation.toFixed(3)}</span></span>`;
    return button;
  }));
}

function renderGroups() {
  $('groupControls').replaceChildren(...GROUPS.map(([id, en, zh]) => {
    const button = document.createElement('button');
    button.className = 'group-control'; button.type = 'button'; button.dataset.group = id;
    button.dataset.state = groupState[id]; button.disabled = busy;
    button.setAttribute('aria-label', `${t(en, zh)}: ${stateText(groupState[id])}`);
    const name = document.createElement('span'); name.textContent = t(en, zh);
    const state = document.createElement('strong'); state.textContent = stateText(groupState[id]);
    button.append(name, state);
    return button;
  }));
}

function lock(value) {
  busy = value;
  for (const id of ['bars', 'seed', 'randomSeed', 'tempo', 'temperature', 'topP', 'generate', 'generateAll']) $(id).disabled = value;
  $('groupPresets').querySelectorAll('button').forEach(button => { button.disabled = value; });
  renderModels(); renderGroups();
}

function controls(model) {
  const seed = Number($('seed').value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999999) throw new Error(t('Seed must be an integer from 0 to 999999999.', '随机种子须为 0 到 999999999 的整数。'));
  return {model, bars: Number($('bars').value), seed, tempo: Number($('tempo').value),
    temperature: Number($('temperature').value), topP: Number($('topP').value), groups: {...groupState}};
}

function clearPlayback() {
  $('player').pause(); $('player').removeAttribute('src'); $('player').load();
  for (const id of ['midiDownload', 'wavDownload']) {
    $(id).removeAttribute('href'); $(id).classList.add('disabled'); $(id).setAttribute('aria-disabled', 'true');
  }
  current = null; $('playhead').style.display = 'none';
  $('metrics').querySelectorAll('strong').forEach(el => { el.textContent = '—'; });
  const canvas = $('roll');
  canvas.getContext('2d').clearRect(0, 0, canvas.width, canvas.height);
  noteHits.length = 0;
}

async function fetchSample(options) {
  const key = JSON.stringify(options);
  if (generated.has(key)) return {key, data: generated.get(key)};
  const response = await fetch('/api/orchestra/generate', {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(options),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  generated.set(key, data);
  return {key, data};
}

async function showSample(key, data, token) {
  if (token !== viewToken) return;
  const mode = $('soundMode').value;
  const audioKey = `${key}|${mode}`;
  let rendered = audioCache.get(audioKey);
  if (!rendered) {
    setStatus(t('Rendering sound…', '正在合成声音…'), t('Rendering sound…', '正在合成声音…'), 'busy');
    const result = await renderAudio(data.sample, mode);
    rendered = {url: URL.createObjectURL(result.blob), duration: result.duration};
    audioUrls.add(rendered.url); audioCache.set(audioKey, rendered);
  }
  if (token !== viewToken) return;
  current = data;
  $('player').src = rendered.url;
  $('player').load();
  $('midiDownload').href = data.midiUrl; $('midiDownload').download = `${data.model}-${data.options.seed}.mid`;
  $('wavDownload').href = rendered.url; $('wavDownload').download = `${data.model}-${data.options.seed}-${mode}.wav`;
  for (const id of ['midiDownload', 'wavDownload']) { $(id).classList.remove('disabled'); $(id).setAttribute('aria-disabled', 'false'); }
  const active = new Set(data.sample.notes.map(note => note.group)).size;
  const values = [data.sample.notes.length, data.sample.bars, active];
  $('metrics').querySelectorAll('strong').forEach((el, i) => { el.textContent = values[i].toLocaleString(); });
  drawScore(data.sample);
  setStatus(t('Ready to listen', '可以试听'), t('Ready to listen', '可以试听'), 'ready');
}

async function generateOne(model = selected, {lockUi = true} = {}) {
  if (busy && lockUi) return;
  if (lockUi && live?.running) live.stop();
  const token = ++viewToken;
  if (lockUi) lock(true);
  clearPlayback();
  try {
    const options = controls(model);
    setStatus(t('Generating with the selected checkpoint…', '正在使用所选模型生成…'), t('Generating with the selected checkpoint…', '正在使用所选模型生成…'), 'busy');
    const {key, data} = await fetchSample(options);
    if (model === selected) await showSample(key, data, token);
    return {key, data};
  } catch (error) {
    setStatus(error.message, error.message, 'error');
    throw error;
  } finally { if (lockUi) lock(false); }
}

async function generateAll() {
  if (busy) return;
  if (live?.running) live.stop();
  const target = selected;
  lock(true); clearPlayback();
  try {
    let selectedResult;
    for (let i = 0; i < modelData.length; i++) {
      const model = modelData[i];
      setStatus(t(`Generating ${i + 1} / 5 · ${NAMES[model.id][0]}`, `正在生成 ${i + 1} / 5 · ${NAMES[model.id][1]}`),
        t(`Generating ${i + 1} / 5 · ${NAMES[model.id][0]}`, `正在生成 ${i + 1} / 5 · ${NAMES[model.id][1]}`), 'busy');
      const result = await fetchSample(controls(model.id));
      if (model.id === target) selectedResult = result;
    }
    await showSample(selectedResult.key, selectedResult.data, ++viewToken);
    setStatus(t('All five ready · select a model to compare', '五组均已就绪 · 点击模型对比'),
      t('All five ready · select a model to compare', '五组均已就绪 · 点击模型对比'), 'ready');
  } catch (error) { setStatus(error.message, error.message, 'error'); }
  finally { lock(false); }
}

function drawScore(sample) {
  const canvas = $('roll');
  const viewport = $('rollViewport');
  const width = Math.max(viewport.clientWidth - 2, chart.margin + sample.totalQuarters * chart.scale + 22);
  const height = chart.header + GROUPS.length * chart.lane;
  chart.width = width;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
  $('rollInner').style.width = `${width}px`; $('rollInner').style.height = `${height}px`;
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#17221b'; ctx.fillRect(0, 0, width, height);
  ctx.font = '11px system-ui';
  for (let i = 0; i < GROUPS.length; i++) {
    const y = chart.header + i * chart.lane;
    if (i % 2 === 0) { ctx.fillStyle = '#1b2a20'; ctx.fillRect(0, y, width, chart.lane); }
    ctx.fillStyle = '#d6dfd0'; ctx.fillText(t(GROUPS[i][1], GROUPS[i][2]), 11, y + 27);
    ctx.fillStyle = '#435246'; ctx.fillRect(0, y + chart.lane - 1, width, 1);
  }
  for (let q = 0; q <= sample.totalQuarters; q++) {
    const x = chart.margin + q * chart.scale;
    const bar = sample.barEvents.findIndex(event => Math.abs(event.quarter - q) < .001);
    ctx.fillStyle = bar >= 0 ? '#728a70' : '#314037';
    ctx.fillRect(x, bar >= 0 ? 14 : chart.header, 1, height - (bar >= 0 ? 14 : chart.header));
    if (bar >= 0) { ctx.fillStyle = '#9eae9c'; ctx.fillText(String(bar + 1).padStart(2, '0'), x + 4, 20); }
  }
  noteHits.length = 0;
  for (const note of sample.notes) {
    const groupIndex = GROUPS.findIndex(g => g[0] === note.group);
    if (groupIndex < 0) continue;
    const x = chart.margin + note.quarter * chart.scale;
    const w = Math.max(3, Math.min(note.duration, sample.totalQuarters - note.quarter) * chart.scale - 1);
    const laneTop = chart.header + groupIndex * chart.lane;
    const range = note.drum ? (note.pitch - 35) / 46 : (note.pitch - 21) / 87;
    const y = laneTop + 31 - Math.max(0, Math.min(1, range)) * 21;
    ctx.globalAlpha = .54 + note.velocity / 280;
    ctx.fillStyle = GROUPS[groupIndex][3];
    ctx.beginPath(); ctx.roundRect(x, y, w, 6, 2); ctx.fill();
    noteHits.push({x, y, w, note});
  }
  ctx.globalAlpha = 1;
  positionPlayhead();
}

function secondsToQuarter(seconds, sample) {
  const bars = sample.barEvents;
  for (let i = bars.length - 1; i >= 0; i--) {
    const start = quarterToSeconds(bars[i].quarter, sample);
    if (seconds >= start) return Math.min(sample.totalQuarters, bars[i].quarter + (seconds - start) * bars[i].bpm / 60);
  }
  return 0;
}

function positionPlayhead() {
  if (current && Number.isFinite($('player').currentTime)) {
    const quarter = secondsToQuarter($('player').currentTime, current.sample);
    $('playhead').style.left = `${chart.margin + quarter * chart.scale}px`;
    $('playhead').style.display = 'block';
  }
}
function updatePlayhead() { positionPlayhead(); requestAnimationFrame(updatePlayhead); }

function noteLabel(note) {
  const name = t(GROUPS.find(g => g[0] === note.group)?.[1], GROUPS.find(g => g[0] === note.group)?.[2]);
  const pitchClass = ['C', 'C♯', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B'][note.pitch % 12];
  const pitch = note.drum ? `GM ${note.pitch}` : `${pitchClass}${Math.floor(note.pitch / 12) - 1}`;
  return `${name} · ${pitch} · ${t('beat', '拍')} ${note.quarter.toFixed(2)} · ${t('length', '时长')} ${note.duration.toFixed(2)} ${t('beats', '拍')}`;
}

$('language').onclick = () => { language = language === 'en' ? 'zh' : 'en'; translate(); };
$('modelList').onclick = async event => {
  const card = event.target.closest('[data-model]');
  if (!card || busy) return;
  selected = card.dataset.model;
  if (live?.running) live.stop();
  renderModels();
  $('stageTitle').textContent = NAMES[selected][language === 'en' ? 0 : 1];
  try { await generateOne(); } catch { /* status already shown */ }
};
$('groupControls').onclick = event => {
  const button = event.target.closest('[data-group]');
  if (!button || busy) return;
  const id = button.dataset.group;
  const states = ['auto', 'on', 'off'];
  const next = states[(states.indexOf(groupState[id]) + 1) % states.length];
  if (next === 'off' && Object.entries(groupState).every(([name, state]) => name === id || state === 'off')) {
    setStatus(t('Keep at least one group available.', '至少保留一个可用乐器组。'),
      t('Keep at least one group available.', '至少保留一个可用乐器组。'), 'error');
    return;
  }
  groupState[id] = next; renderGroups();
  live?.markPending();
  setStatus(t('Settings changed · generate to apply', '设置已改变 · 请重新生成'), t('Settings changed · generate to apply', '设置已改变 · 请重新生成'));
};
$('groupPresets').onclick = event => {
  const button = event.target.closest('[data-preset]');
  if (!button || busy) return;
  const preset = button.dataset.preset;
  const on = {strings: ['high_strings', 'low_strings'], winds: ['woodwinds', 'brass'],
    rhythm: ['percussion', 'keys'], full: GROUPS.map(([id]) => id)}[preset];
  for (const [id] of GROUPS) groupState[id] = preset === 'orchestra'
    ? (id.endsWith('strings') ? 'on' : 'auto') : on.includes(id) ? 'on' : 'off';
  renderGroups();
  live?.markPending();
  setStatus(t('Combination changed · generate to apply', '组合已改变 · 请重新生成'),
    t('Combination changed · generate to apply', '组合已改变 · 请重新生成'));
};
$('generate').onclick = async () => { try { await generateOne(); } catch { /* status already shown */ } };
$('generateAll').onclick = generateAll;
$('randomSeed').onclick = () => { if (live?.running) live.stop(); $('seed').value = String(crypto.getRandomValues(new Uint32Array(1))[0] % 1000000000); };
$('seed').onchange = () => { if (live?.running) live.stop(); };
$('tempo').oninput = () => { $('tempoValue').textContent = `${$('tempo').value} BPM`; live?.markPending(); };
$('temperature').oninput = () => { $('temperatureValue').textContent = Number($('temperature').value).toFixed(2); live?.markPending(); };
$('topP').oninput = () => { $('topPValue').textContent = Number($('topP').value).toFixed(2); live?.markPending(); };
$('soundMode').onchange = async () => {
  if (!current || busy) return;
  const token = ++viewToken;
  const key = JSON.stringify(current.options);
  const data = current;
  lock(true); clearPlayback();
  try { await showSample(key, data, token); }
  catch (error) { setStatus(error.message, error.message, 'error'); }
  finally { lock(false); }
};
$('roll').onmousemove = event => {
  if (!current) return;
  const rect = $('roll').getBoundingClientRect();
  const x = event.clientX - rect.left, y = event.clientY - rect.top;
  const hit = noteHits.findLast(item => x >= item.x && x <= item.x + item.w && Math.abs(y - item.y) < 6);
  $('hoverInfo').textContent = hit ? noteLabel(hit.note) : t('Hover over a note to inspect it. Click the map to seek.', '悬停查看音符；点击音符图可以跳转播放位置。');
};
$('roll').onmouseleave = () => { $('hoverInfo').textContent = t('Hover over a note to inspect it. Click the map to seek.', '悬停查看音符；点击音符图可以跳转播放位置。'); };
$('roll').onclick = event => {
  if (!current) return;
  const x = event.clientX - $('roll').getBoundingClientRect().left;
  const quarter = Math.max(0, Math.min(current.sample.totalQuarters, (x - chart.margin) / chart.scale));
  $('player').currentTime = quarterToSeconds(quarter, current.sample);
};
window.addEventListener('resize', () => { if (current) drawScore(current.sample); });
live = createLiveController({getOptions: () => controls(selected), pausePreview: () => $('player').pause(), language: () => language});
$('liveStart').onclick = () => live.start();
$('liveStop').onclick = () => live.stop();
$('player').onplay = () => { if (live.running) live.stop(); };
window.addEventListener('pagehide', () => { live.stop(); $('player').pause(); for (const url of audioUrls) URL.revokeObjectURL(url); });

try {
  requestAnimationFrame(updatePlayhead);
  const response = await fetch('/api/orchestra/models');
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  modelData = (await response.json()).models;
  translate();
  await generateOne();
} catch (error) { setStatus(error.message, error.message, 'error'); }
