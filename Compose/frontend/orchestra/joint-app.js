import {JointOrchestraBridge, JOINT_GROUPS} from './joint-bridge.js';
import {renderAudio, quarterToSeconds} from './audio.js';

const $ = id => document.getElementById(id);
const LABELS = {
  woodwinds: ['Woodwinds', '木管'], brass: ['Brass', '铜管'], percussion: ['Percussion', '打击乐'],
  keys: ['Harp / keys', '竖琴／键盘'], high_strings: ['High strings', '高音弦乐'], low_strings: ['Low strings', '低音弦乐'],
};
const COLORS = {woodwinds: '#9cc9b4', brass: '#e8b26d', percussion: '#d78f7f',
  keys: '#c8b2d9', high_strings: '#94b9dd', low_strings: '#b5c58d'};
const groups = Object.fromEntries(JOINT_GROUPS.map(id => [id, id.endsWith('strings') ? 'on' : 'auto']));
let language = 'en', active = false, runId = 0, context = null, master = null;
let bridge = null, segments = [], nextAt = null, previewSample = null, previewUrl = null;
let chartKey = '';
const tr = (en, zh) => language === 'en' ? en : zh;

function status(en, zh, kind = '') {
  $('status').textContent = tr(en, zh);
  $('status').dataset.state = kind;
}

function fixedOptions() {
  const seed = Number($('seed').value);
  if (!Number.isSafeInteger(seed) || seed < 0 || seed > 999999999) throw new RangeError(tr('Seed must be 0–999999999.', '随机种子须为 0–999999999。'));
  return {seed, style: $('style').value, key: Number($('key').value), mode: $('mode').value,
    changeMode: $('changeMode').value, harmonyT: Number($('harmonyT').value),
    melodyT: Number($('melodyT').value), density: Number($('density').value)};
}

function liveOptions() { return {tempo: Number($('tempo').value), groups: {...groups}}; }

function renderGroups() {
  $('groupControls').replaceChildren(...JOINT_GROUPS.map(id => {
    const button = document.createElement('button');
    button.className = 'group-control'; button.type = 'button'; button.dataset.group = id;
    button.dataset.state = groups[id];
    const name = document.createElement('span'); name.textContent = LABELS[id][language === 'en' ? 0 : 1];
    const state = document.createElement('strong');
    state.textContent = {auto: tr('Auto', '自动'), on: tr('On', '开启'), off: tr('Off', '关闭')}[groups[id]];
    button.setAttribute('aria-label', `${name.textContent}: ${state.textContent}`);
    button.append(name, state);
    return button;
  }));
}

function chartCell(number, spans) {
  const cell = document.createElement('div');
  cell.className = `chord-bar${spans ? '' : ' pending'}`;
  const n = document.createElement('span'); n.className = 'number'; n.textContent = spans ? String(number).padStart(2, '0') : '··';
  const row = document.createElement('div'); row.className = 'harmonies';
  if (spans) for (const span of spans) {
    const label = document.createElement('strong'); label.textContent = span.name;
    label.style.flexGrow = String(span.lengthBeats); label.title = `${span.name} · ${span.lengthBeats} ${tr('beats', '拍')}`;
    row.append(label);
  } else { const label = document.createElement('strong'); label.textContent = '—'; row.append(label); }
  cell.append(n, row);
  return cell;
}

function drawChart() {
  const now = currentSegment();
  const next = now ? segments.find(s => s.firstBar === now.firstBar + 4) : null;
  const key = `${language}|${now?.firstBar ?? -1}|${next?.firstBar ?? -1}`;
  if (key === chartKey) return;
  chartKey = key;
  const cells = [];
  for (let i = 0; i < 8; i++) {
    const s = i < 4 ? now : next;
    const local = i % 4;
    cells.push(chartCell(s?.sample.firstBar + local + 1, s?.sample.harmony[local]));
  }
  $('chart').replaceChildren(...cells);
}

function drawPreviewChart(sample) {
  $('previewChart').replaceChildren(...Array.from({length: sample.bars}, (_, i) =>
    chartCell(i + 1, sample.harmony[i])));
}

function drawRoll(sample) {
  const canvas = $('roll'), width = Math.max(canvas.parentElement.clientWidth - 2, 760), height = 6 * 42 + 30;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`; canvas.style.height = `${height}px`;
  canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  ctx.fillStyle = '#17221b'; ctx.fillRect(0, 0, width, height);
  const left = 99, scale = (width - left - 12) / sample.totalQuarters;
  ctx.font = '10px system-ui';
  for (let i = 0; i < 6; i++) {
    const y = 30 + i * 42;
    if (!(i % 2)) { ctx.fillStyle = '#1b2a20'; ctx.fillRect(0, y, width, 42); }
    ctx.fillStyle = '#d6dfd0'; ctx.fillText(LABELS[JOINT_GROUPS[i]][language === 'en' ? 0 : 1], 8, y + 26);
    ctx.fillStyle = '#435246'; ctx.fillRect(0, y + 41, width, 1);
  }
  for (let bar = 0; bar <= sample.bars; bar++) {
    const x = left + bar * 4 * scale;
    ctx.fillStyle = '#728a70'; ctx.fillRect(x, 12, 1, height - 12);
    if (bar < sample.bars) { ctx.fillStyle = '#9eae9c'; ctx.fillText(String(bar + 1).padStart(2, '0'), x + 4, 18); }
  }
  for (const note of sample.notes) {
    const i = JOINT_GROUPS.indexOf(note.group); if (i < 0) continue;
    const x = left + note.quarter * scale, w = Math.max(2, Math.min(note.duration, sample.totalQuarters - note.quarter) * scale - 1);
    const y = 30 + i * 42 + (note.drum ? 21 : 32 - Math.max(0, Math.min(1, (note.pitch - 24) / 72)) * 22);
    ctx.fillStyle = COLORS[note.group]; ctx.globalAlpha = .55 + note.velocity / 280;
    ctx.fillRect(x, y, w, 5);
  }
  ctx.globalAlpha = 1;
}

function currentSegment() {
  if (!segments.length) return null;
  const now = context?.currentTime ?? 0;
  return segments.find(s => now >= s.start && now < s.end)
    ?? segments.find(s => now < s.start) ?? segments.at(-1);
}

function tick(id) {
  if (!active || id !== runId) return;
  const s = currentSegment();
  drawChart();
  for (const cell of $('chart').children) { cell.classList.remove('active'); cell.style.setProperty('--fill', '0%'); }
  if (s && context.currentTime >= s.start && context.currentTime < s.end) {
    const elapsed = context.currentTime - s.start;
    const bar = Math.max(0, Math.min(3, Math.floor(elapsed / (60 / s.tempo * 4))));
    const cell = $('chart').children[bar];
    cell?.classList.add('active');
    cell?.style.setProperty('--fill', `${Math.max(0, Math.min(100, (elapsed / (60 / s.tempo * 4) - bar) * 100))}%`);
    $('now').textContent = tr(`Bar ${s.firstBar + bar + 1} · original joint model`, `第 ${s.firstBar + bar + 1} 小节 · 旧联合模型`);
  }
  requestAnimationFrame(() => tick(id));
}

function fixedDisabled(value) {
  for (const id of ['style', 'key', 'mode', 'changeMode', 'seed', 'harmonyT', 'melodyT', 'density']) $(id).disabled = value;
  $('start').disabled = value; $('stop').disabled = !value;
}

async function pump(id) {
  while (active && id === runId) {
    const lastDuration = segments.length ? segments.at(-1).end - segments.at(-1).start : 12;
    if (nextAt !== null && nextAt - context.currentTime > lastDuration) {
      await new Promise(resolve => setTimeout(resolve, 400)); continue;
    }
    status(segments.length ? 'Writing upcoming bars…' : 'Writing first four bars…',
      segments.length ? '正在写出后续小节…' : '正在写出前四小节…', 'busy');
    const options = liveOptions();
    const sample = await bridge.next(4, options);
    if (!active || id !== runId) return;
    const {blob, duration} = await renderAudio(sample, 'ensemble', {preserveTails: true});
    if (!active || id !== runId) return;
    const buffer = await context.decodeAudioData(await blob.arrayBuffer());
    if (!active || id !== runId) return;
    const source = context.createBufferSource(); source.buffer = buffer; source.connect(master);
    const start = Math.max(context.currentTime + .08, nextAt ?? context.currentTime + .08);
    source.start(start);
    segments.push({sample, source, firstBar: sample.firstBar, tempo: options.tempo, start, end: start + duration});
    segments = segments.filter(s => s.end >= context.currentTime - 5);
    nextAt = start + duration;
    drawChart();
    status('Playing · next bars prepared', '正在播放 · 后续小节已准备', 'ready');
  }
}

async function start() {
  if (active) return;
  try { bridge = new JointOrchestraBridge(fixedOptions()); }
  catch (error) { status(error.message, error.message, 'error'); return; }
  $('player').pause();
  active = true; segments = []; nextAt = null;
  fixedDisabled(true);
  const id = ++runId;
  try {
    context = new AudioContext(); await context.resume();
    master = context.createGain(); master.gain.value = .78;
    const limiter = context.createDynamicsCompressor(); limiter.threshold.value = -12; limiter.ratio.value = 5;
    master.connect(limiter); limiter.connect(context.destination);
    context.onstatechange = () => {
      if (active && ['interrupted', 'suspended'].includes(context.state)) {
        stop(); status('Audio interrupted · press Start to restart', '声音中断 · 点击开始重新演奏', 'error');
      }
    };
    requestAnimationFrame(() => tick(id));
    await pump(id);
  } catch (error) {
    if (id !== runId) return;
    stop(); status(error.message, error.message, 'error');
  }
}

function stop() {
  const wasActive = active;
  active = false; runId++;
  for (const s of segments) { try { s.source.stop(); } catch { /* already ended */ } }
  if (context) { context.onstatechange = null; context.close().catch(() => {}); }
  context = null; master = null; bridge = null; nextAt = null; segments = [];
  fixedDisabled(false); drawChart();
  $('now').textContent = tr('No bars playing', '尚未播放');
  if (wasActive) status('Stopped', '已停止');
}

async function preview() {
  if (active) stop();
  $('preview').disabled = true;
  try {
    status('Writing eight bars…', '正在写出八小节…', 'busy');
    const generator = new JointOrchestraBridge(fixedOptions());
    const sample = await generator.next(8, liveOptions());
    status('Rendering the sound…', '正在合成声音…', 'busy');
    const {blob} = await renderAudio(sample);
    if (previewUrl) URL.revokeObjectURL(previewUrl);
    previewUrl = URL.createObjectURL(blob); previewSample = sample;
    $('player').src = previewUrl; $('player').load();
    $('wav').href = previewUrl; $('wav').download = `AIlegro-joint-orchestra-${sample.seed}.wav`;
    $('wav').classList.remove('disabled'); $('wav').setAttribute('aria-disabled', 'false');
    drawPreviewChart(sample); drawRoll(sample);
    status('Ready to listen', '可以试听', 'ready');
  } catch (error) { status(error.message, error.message, 'error'); }
  finally { $('preview').disabled = false; }
}

function translate() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.title = tr('AIlegro · Joint-model orchestra prototype', 'AIlegro · 旧模型管弦乐原型');
  document.querySelectorAll('[data-en][data-zh]').forEach(el => { el.textContent = el.dataset[language]; });
  $('language').textContent = language === 'en' ? '中文' : 'EN';
  renderGroups(); chartKey = ''; drawChart();
  if (previewSample) { drawPreviewChart(previewSample); drawRoll(previewSample); }
}

for (const [id, digits] of [['tempo', 0], ['harmonyT', 2], ['melodyT', 2], ['density', 2]]) {
  $(id).oninput = () => { $(`${id}Value`).textContent = Number($(id).value).toFixed(digits) + (id === 'tempo' ? ' BPM' : '');
    if (active && id === 'tempo') status('Tempo queued for upcoming bars', '新速度用于后续小节', 'busy'); };
}
$('groupControls').onclick = event => {
  const button = event.target.closest('[data-group]'); if (!button) return;
  const id = button.dataset.group, states = ['auto', 'on', 'off'];
  const next = states[(states.indexOf(groups[id]) + 1) % 3];
  if (next === 'off' && JOINT_GROUPS.every(g => g === id || groups[g] === 'off')) {
    status('Keep one group available.', '至少保留一组乐器。', 'error'); return;
  }
  groups[id] = next; renderGroups();
  if (active) status('Group change queued for upcoming bars', '乐器组合用于后续小节', 'busy');
};
$('groupPresets').onclick = event => {
  const button = event.target.closest('[data-preset]'); if (!button) return;
  const preset = button.dataset.preset;
  const on = {strings: ['high_strings', 'low_strings'], winds: ['woodwinds', 'brass'],
    rhythm: ['percussion', 'keys'], full: JOINT_GROUPS}[preset];
  for (const id of JOINT_GROUPS) groups[id] = preset === 'orchestra'
    ? (id.endsWith('strings') ? 'on' : 'auto') : on.includes(id) ? 'on' : 'off';
  renderGroups();
  if (active) status('Group change queued for upcoming bars', '乐器组合用于后续小节', 'busy');
};
$('language').onclick = () => { language = language === 'en' ? 'zh' : 'en'; translate(); };
$('start').onclick = start; $('stop').onclick = stop; $('preview').onclick = preview;
$('player').onplay = () => { if (active) stop(); };
window.addEventListener('resize', () => { if (previewSample) drawRoll(previewSample); });
window.addEventListener('pagehide', () => { stop(); $('player').pause(); if (previewUrl) URL.revokeObjectURL(previewUrl); });
translate();
