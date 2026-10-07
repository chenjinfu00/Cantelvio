import {createLiveController} from './live.js';
import {renderAudio} from '../orchestra/audio.js';

const $ = id => document.getElementById(id);
const GROUPS = [
  ['woodwinds', 'Woodwinds', '木管'], ['brass', 'Brass', '铜管'],
  ['percussion', 'Percussion', '打击乐'], ['keys', 'Harp / keys', '竖琴／键盘'],
  ['high_strings', 'High strings', '高音弦乐'], ['low_strings', 'Low strings', '低音弦乐'],
];
let live;
let language = 'en';
let prompts = [];
let last = null;
let audioUrl = null;
const tr = (en, zh) => language === 'en' ? en : zh;

function status(en, zh, kind = 'idle') {
  $('status').textContent = tr(en, zh);
  $('status').dataset.state = kind;
}
function translate() {
  document.documentElement.lang = language === 'en' ? 'en' : 'zh-CN';
  document.title = tr('Cantelvio Compose · Four-pillar v2', 'Cantelvio Compose · 四大件 v2 试听');
  document.querySelectorAll('[data-en][data-zh]').forEach(node => { node.textContent = node.dataset[language]; });
  $('language').textContent = language === 'en' ? '中文' : 'EN';
  renderGroups(); renderPrompts(); updatePrior(); live?.updateLanguage();
  if (last) {
    renderSummary(last); draw(last.sample);
    if ($('status').dataset.state === 'ready') status('Ready to listen · original bars first, model bars second', '可以试听 · 前两小节为原谱，后两小节为模型续写', 'ready');
  }
}
function renderGroups() {
  const hasPrevious = !!$('groups').querySelector('input');
  const selected = new Set([...$('groups').querySelectorAll('input:checked')].map(node => node.value));
  $('groups').replaceChildren(...GROUPS.map(([id, en, zh]) => {
    const label = document.createElement('label'); label.className = 'group-option';
    const input = document.createElement('input'); input.type = 'checkbox'; input.value = id;
    input.checked = hasPrevious ? selected.has(id) : true;
    label.append(input, document.createTextNode(tr(en, zh)));
    return label;
  }));
}
function renderPrompts() {
  const selected = $('prompt').value;
  $('prompt').replaceChildren(...prompts.map(entry => {
    const option = document.createElement('option'); option.value = entry.id;
    const title = entry.work.split('/').slice(-2).join(' · ');
    option.textContent = `${entry.id + 1}. ${title}${entry.oldPrior ? tr(' · old prior', ' · 有旧先验') : ''}`;
    return option;
  }));
  if (selected) $('prompt').value = selected;
}
function updatePrior() {
  const hasPrior = prompts[Number($('prompt').value)]?.oldPrior;
  $('useLegacy').disabled = !hasPrior;
  if (!hasPrior) $('useLegacy').checked = false;
}
function options() {
  const groups = [...$('groups').querySelectorAll('input:checked')].map(node => node.value);
  if (!groups.length) throw new Error(tr('Choose at least one instrument group.', '至少选择一个乐器组。'));
  return {prompt: Number($('prompt').value), seed: Number($('seed').value),
    temperature: Number($('temperature').value), tempo: Number($('tempo').value),
    useLegacy: $('useLegacy').checked, groups};
}
function draw(sample) {
  const canvas = $('roll');
  const width = Math.max($('scoreWrap').clientWidth, 720);
  const height = 290, left = 89, right = 20;
  const dpr = Math.min(devicePixelRatio || 1, 2);
  canvas.style.width = `${width}px`; canvas.width = Math.ceil(width * dpr); canvas.height = Math.ceil(height * dpr);
  const ctx = canvas.getContext('2d'); ctx.scale(dpr, dpr);
  const x = quarter => left + quarter / sample.totalQuarters * (width - left - right);
  ctx.fillStyle = '#17251c'; ctx.fillRect(0, 0, width, height);
  const boundary = sample.barEvents[sample.promptBars]?.quarter ?? sample.totalQuarters / 2;
  ctx.fillStyle = '#2b2b1c'; ctx.fillRect(x(boundary), 0, width - x(boundary), height);
  ctx.fillStyle = '#8ca999'; ctx.font = '11px system-ui';
  GROUPS.forEach(([id, en, zh], i) => {
    const y = 28 + i * 42;
    ctx.fillStyle = i % 2 ? '#ffffff08' : '#ffffff04'; ctx.fillRect(0, y, width, 42);
    ctx.fillStyle = '#bdcfb9'; ctx.fillText(tr(en, zh), 9, y + 25);
  });
  for (let i = 0; i < sample.barEvents.length; i++) {
    const line = x(sample.barEvents[i].quarter);
    ctx.strokeStyle = i === sample.promptBars ? '#e6d299' : '#72907488';
    ctx.beginPath(); ctx.moveTo(line, 8); ctx.lineTo(line, height); ctx.stroke();
    ctx.fillStyle = '#cad5c5'; ctx.fillText(String(i + 1), line + 4, 15);
  }
  for (const note of sample.notes) {
    const lane = GROUPS.findIndex(([id]) => id === note.group);
    if (lane < 0) continue;
    const y = 28 + lane * 42 + 30 - Math.max(0, Math.min(1, (note.pitch - 30) / 70)) * 21;
    ctx.fillStyle = note.generated ? '#d9bd7e' : '#81a494';
    ctx.fillRect(x(note.quarter), y, Math.max(3, x(Math.min(sample.totalQuarters, note.quarter + note.duration)) - x(note.quarter) - 1), 6);
  }
}
function renderSummary(data) {
  const count = data.sample.notes.filter(note => note.generated).length;
  $('summary').textContent = tr(
    `${data.prompt.work.replaceAll('_', ' ')} · ${count} generated notes · v2 · step ${data.sample.checkpointStep} · ${data.sample.resourceClosures.length} resource closures`,
    `${data.prompt.work.replaceAll('_', ' ')} · ${count} 个生成音符 · v2 · 第 ${data.sample.checkpointStep} 步 · ${data.sample.resourceClosures.length} 次资源收束`);
}
async function generate() {
  live?.stop();
  const button = $('generate'); button.disabled = true;
  $('liveStart').disabled = true;
  $('player').pause(); $('player').removeAttribute('src'); $('player').load();
  $('download').classList.add('disabled'); $('download').setAttribute('aria-disabled', 'true');
  try {
    status('Generating on this computer…', '正在本机生成…', 'busy');
    const response = await fetch('/api/four-pillar/generate', {method: 'POST',
      headers: {'Content-Type': 'application/json'}, body: JSON.stringify(options())});
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    status('Rendering audio…', '正在合成声音…', 'busy');
    const audio = await renderAudio(data.sample, 'ensemble');
    if (audioUrl) URL.revokeObjectURL(audioUrl);
    audioUrl = URL.createObjectURL(audio.blob);
    $('player').src = audioUrl; $('player').load();
    $('download').href = audioUrl; $('download').download = `cantelvio-four-pillar-${data.options.seed}.wav`;
    $('download').classList.remove('disabled'); $('download').setAttribute('aria-disabled', 'false');
    last = data; draw(data.sample); renderSummary(data);
    status('Ready to listen · original bars first, model bars second', '可以试听 · 前两小节为原谱，后两小节为模型续写', 'ready');
  } catch (error) { status(error.message, error.message, 'error'); }
  finally { button.disabled = false; $('liveStart').disabled = false; }
}

$('language').onclick = () => { language = language === 'en' ? 'zh' : 'en'; translate(); };
$('prompt').onchange = () => { live?.stop(); updatePrior(); };
$('seed').onchange = () => live?.stop();
$('tempo').oninput = () => live?.markPending();
$('groups').onchange = () => live?.markPending();
$('temperature').oninput = () => { $('temperatureValue').value = Number($('temperature').value).toFixed(2); live?.markPending(); };
$('generate').onclick = generate;
window.addEventListener('resize', () => { if (last) draw(last.sample); });
window.addEventListener('pagehide', () => { live?.stop(); if (audioUrl) URL.revokeObjectURL(audioUrl); });

fetch('/api/four-pillar/prompts').then(response => response.json()).then(data => {
  prompts = data.prompts;
  if (!Array.isArray(prompts) || !prompts.length) throw new Error('No pilot prompts');
  renderPrompts(); updatePrior();
}).catch(error => status(error.message, error.message, 'error'));
renderGroups();

live = createLiveController({getOptions: options, pausePreview: () => $('player').pause(), language: () => language});
$('liveStart').onclick = () => live.start();
$('liveStop').onclick = () => live.stop();
$('player').onplay = () => { if (live.running) live.stop(); };
