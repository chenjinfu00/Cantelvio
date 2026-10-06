import {renderAudio, quarterToSeconds} from '../orchestra/audio.js';
import {estimateHarmony} from '../orchestra/harmony.js';

export function createLiveController({getOptions, pausePreview, language}) {
  const $ = id => document.getElementById(id);
  const t = (en, zh) => language() === 'en' ? en : zh;
  let context = null;
  let master = null;
  let session = null;
  let index = 0;
  let runId = 0;
  let nextAt = null;
  let active = false;
  let controller = null;
  let segments = [];
  let chartKey = '';
  let startModel = '';
  let startSeed = 0;

  function status(en, zh, kind = '') {
    $('liveStatus').textContent = t(en, zh);
    $('liveStatus').dataset.state = kind;
  }

  function currentSegment() {
    if (!segments.length) return null;
    const now = context?.currentTime ?? 0;
    return segments.find(item => now >= item.start && now < item.end)
      ?? segments.find(item => now < item.start)
      ?? segments.at(-1);
  }

  function chartView() {
    const now = currentSegment();
    const upcoming = now ? segments.find(item => item.index === now.index + 1) : null;
    const next = upcoming ?? null;
    const key = `${language()}|${now?.index ?? -1}|${next?.index ?? -1}`;
    if (key === chartKey) return;
    chartKey = key;
    const blocks = [];
    for (let i = 0; i < 8; i++) {
      const segment = i < 4 ? now : next;
      const bar = i % 4;
      const cell = document.createElement('div');
      cell.className = `chord-bar${segment ? '' : ' pending'}`;
      const number = document.createElement('span'); number.className = 'number';
      number.textContent = segment ? String(segment.sample.firstBar + bar + 1).padStart(2, '0') : '··';
      const chord = document.createElement('strong');
      chord.textContent = segment ? segment.harmony[bar].name : '—';
      const detail = document.createElement('small');
      detail.textContent = segment ? (segment.harmony[bar].confidence === 'none'
        ? t('few notes', '音符不足') : segment.harmony[bar].confidence === 'low'
          ? t('uncertain', '不确定') : t('estimated', '推测')) : t('writing…', '正在生成…');
      cell.append(number, chord, detail); blocks.push(cell);
    }
    $('liveChart').replaceChildren(...blocks);
  }

  function tick(id) {
    if (!active || id !== runId) return;
    chartView();
    const segment = currentSegment();
    if (segment) {
      const elapsed = Math.max(0, context.currentTime - segment.start);
      const bar = segment.sample.barEvents.findLastIndex(event =>
        quarterToSeconds(event.quarter, segment.sample) <= elapsed);
      const localBar = Math.max(0, Math.min(3, bar));
      const item = $('liveChart').children[localBar];
      for (const cell of $('liveChart').children) { cell.classList.remove('active'); cell.style.setProperty('--fill', '0%'); }
      if (item && context.currentTime >= segment.start && context.currentTime < segment.end) {
        item.classList.add('active');
        const barStart = quarterToSeconds(segment.sample.barEvents[localBar].quarter, segment.sample);
        const barEnd = localBar < 3 ? quarterToSeconds(segment.sample.barEvents[localBar + 1].quarter, segment.sample)
          : quarterToSeconds(segment.sample.totalQuarters, segment.sample);
        item.style.setProperty('--fill', `${Math.max(0, Math.min(100, (elapsed - barStart) / (barEnd - barStart) * 100))}%`);
      }
      if (context.currentTime >= segment.end) {
        $('liveNow').textContent = t('Waiting for the next segment…', '正在等待下一段…');
      } else $('liveNow').textContent = t(`Bar ${segment.sample.firstBar + localBar + 1} · model continuing`,
        `第 ${segment.sample.firstBar + localBar + 1} 小节 · 模型持续写作`);
    }
    requestAnimationFrame(() => tick(id));
  }

  async function fetchChunk(options, id) {
    controller = new AbortController();
    const response = await fetch('/api/four-pillar/continue', {
      method: 'POST', headers: {'Content-Type': 'application/json'}, signal: controller.signal,
      body: JSON.stringify({...options, bars: 4, session, index}),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
    if (!active || id !== runId) return null;
    return data;
  }

  async function pump(id) {
    while (active && id === runId) {
      // Maintain about one four-bar segment ahead; do not generate indefinitely ahead of playback.
      const lastDuration = segments.length ? segments.at(-1).end - segments.at(-1).start : 16;
      if (nextAt !== null && nextAt - context.currentTime > lastDuration) {
        await new Promise(resolve => setTimeout(resolve, 500));
        continue;
      }
      const options = getOptions();
      if (options.prompt !== startModel || options.seed !== startSeed) {
        stop();
        status('Prompt or seed changed · start a new piece', '提示或种子已改变 · 请重新开始', 'error');
        return;
      }
      status(index === 0 ? 'Writing first four bars…' : 'Writing upcoming bars…',
        index === 0 ? '正在写出前四小节…' : '正在写出后续小节…', 'busy');
      const data = await fetchChunk(options, id);
      if (!data) return;
      session = data.session;
      status('Rendering the next segment…', '正在合成下一段声音…', 'busy');
      const {blob, duration} = await renderAudio(data.sample, 'ensemble', {preserveTails: true});
      if (!active || id !== runId) return;
      const buffer = await context.decodeAudioData(await blob.arrayBuffer());
      if (!active || id !== runId) return;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(master);
      const start = Math.max(context.currentTime + .08, nextAt ?? context.currentTime + .08);
      source.start(start);
      segments.push({index, start, end: start + duration, source, sample: data.sample,
        harmony: estimateHarmony(data.sample)});
      segments = segments.filter(item => item.end >= context.currentTime - 5);
      nextAt = start + duration;
      index++;
      chartKey = '';
      chartView();
      status('Playing · next bars prepared', '正在播放 · 后续小节已准备', 'ready');
    }
  }

  async function start() {
    if (active) return;
    pausePreview();
    let options;
    try { options = getOptions(); } catch (error) { status(error.message, error.message, 'error'); return; }
    active = true;
    session = null; index = 0; nextAt = null; segments = []; chartKey = '';
    startModel = options.prompt; startSeed = options.seed;
    const id = ++runId;
    $('liveStart').disabled = true; $('liveStop').disabled = false;
    try {
      const startingContext = new AudioContext();
      context = startingContext;
      await startingContext.resume();
      if (!active || id !== runId) { startingContext.close().catch(() => {}); return; }
      master = context.createGain();
      master.gain.value = .8;
      const limiter = context.createDynamicsCompressor();
      limiter.threshold.value = -12;
      limiter.ratio.value = 5;
      master.connect(limiter); limiter.connect(context.destination);
      context.onstatechange = () => {
        if (active && ['interrupted', 'suspended'].includes(context.state)) {
          stop(); status('Audio interrupted · press Start to resume', '声音中断 · 点击开始重新演奏', 'error');
        }
      };
      requestAnimationFrame(() => tick(id));
      await pump(id);
    } catch (error) {
      if (id !== runId || error.name === 'AbortError') return;
      stop();
      status(error.message, error.message, 'error');
    }
  }

  function stop() {
    const wasActive = active;
    active = false; runId++;
    controller?.abort(); controller = null;
    if (session) fetch('/api/four-pillar/stop', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({session}), keepalive:true}).catch(() => {});
    session = null;
    for (const segment of segments) { try { segment.source.stop(); } catch { /* already stopped */ } }
    if (context) { context.onstatechange = null; context.close().catch(() => {}); }
    context = null; master = null;
    $('liveStart').disabled = false; $('liveStop').disabled = true;
    $('liveNow').textContent = t('No bars playing', '尚未播放');
    if (wasActive) status('Stopped', '已停止');
    for (const cell of $('liveChart').children) { cell.classList.remove('active'); cell.style.setProperty('--fill', '0%'); }
  }

  function markPending() {
    if (active) status('New settings queued for upcoming bars', '新设置已排队，将用于后续小节', 'busy');
  }

  function updateLanguage() {
    chartKey = '';
    chartView();
    if (!active) { status('Stopped', '已停止'); $('liveNow').textContent = t('No bars playing', '尚未播放'); }
    else status('Playing · preparing later bars', '正在播放 · 准备后续小节', 'ready');
  }

  chartView();
  return {start, stop, updateLanguage, markPending, get running() { return active; }};
}
