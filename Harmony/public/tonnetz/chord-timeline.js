const escape = (value) => String(value ?? "").replace(/[&<>"']/g, (c) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
}[c]));

export function createChordTimeline({ container, getTransport, getControls,
  onToggle, onAutoToggle, onTempo, onStyle, onEdit = () => {} }) {
  let frame = null;
  let language = "en";
  let destroyed = false;
  let mounted = false;
  let optionSignature = "";
  let controls = {};
  let inspectedIndex = null;
  let entryLabels = [];
  let fitFrame = null;
  const icons = {
    play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>'
  };

  function mount() {
    if (mounted || destroyed) return;
    container.innerHTML = `<output class="wb-timeline-inspector" hidden aria-live="polite"></output><div class="wb-timeline-actions">
      <button type="button" data-timeline-action="toggle"></button>
      <button type="button" data-timeline-action="auto"></button>
    </div>
    <div class="wb-timeline-viewport">
      <div class="wb-timeline-playhead" aria-hidden="true"></div>
      <div class="wb-timeline-track" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i></div>
      <ol class="wb-timeline-harmonies"></ol>
    </div>
    <div class="wb-timeline-options">
      <select data-timeline-style></select>
      <label class="wb-timeline-tempo"><span>BPM</span><input data-timeline-tempo type="number" min="40" max="200" step="1" inputmode="numeric"></label>
    </div>`;
    mounted = true;
  }

  function syncControls() {
    if (destroyed) return;
    mount();
    controls = getControls();
    const zh = language === "zh-CN";
    const toggle = container.querySelector('[data-timeline-action="toggle"]');
    const active = controls.playing || controls.starting;
    const state = controls.starting ? "starting" : controls.playing ? "playing" : "stopped";
    if (toggle.dataset.state !== state) {
      toggle.dataset.state = state;
      toggle.innerHTML = active ? icons.stop : icons.play;
    }
    const toggleLabel = active ? (zh ? "停止伴奏" : "Stop accompaniment") : (zh ? "开始伴奏" : "Start accompaniment");
    toggle.setAttribute("aria-label", toggleLabel);
    toggle.title = toggleLabel;
    toggle.setAttribute("aria-pressed", String(active));
    const auto = container.querySelector('[data-timeline-action="auto"]');
    const automatic = controls.mode !== "hold";
    auto.textContent = automatic ? (zh ? "自动" : "Auto") : (zh ? "保持" : "Hold");
    auto.setAttribute("aria-label", zh ? "自动换和弦" : "Automatic chord changes");
    auto.setAttribute("aria-pressed", String(automatic));
    auto.title = automatic
      ? (zh ? "下个小节自动换和弦；点击保持当前和弦" : "Change chords each bar; click to hold the current chord")
      : (zh ? "保持当前和弦；点击从下个小节开始自动换和弦" : "Hold the current chord; click to change chords from the next bar");
    const style = container.querySelector('[data-timeline-style]');
    style.setAttribute("aria-label", zh ? "伴奏风格" : "Accompaniment style");
    style.title = zh ? "伴奏风格" : "Accompaniment style";
    const signature = JSON.stringify(controls.styles);
    if (signature !== optionSignature) {
      style.innerHTML = controls.styles.map(item => `<option value="${escape(item.id)}">${escape(item.label)}</option>`).join("");
      optionSignature = signature;
    }
    style.value = controls.style;
    const tempo = container.querySelector('[data-timeline-tempo]');
    tempo.setAttribute("aria-label", zh ? "伴奏速度（BPM）" : "Accompaniment tempo (BPM)");
    tempo.title = "40–200 BPM";
    // Do not overwrite a partly entered number on each chord boundary.
    if (document.activeElement !== tempo) tempo.value = controls.bpm;
  }

  function fitSlots() {
    if (!mounted || destroyed) return;
    const phone = window.matchMedia('(max-width: 600px)').matches;
    container.querySelectorAll('[data-timeline-info]').forEach(button => {
      button.classList.remove('is-name-only','is-no-roman');
      const name=button.querySelector('strong'), roman=button.querySelector('span'), notes=button.querySelector('small');
      const css=getComputedStyle(button), gap=parseFloat(css.gap)||0;
      const width=button.clientWidth-parseFloat(css.paddingLeft)-parseFloat(css.paddingRight);
      const nameWidth=name.scrollWidth, noteWidth=notes.scrollWidth, romanWidth=roman.scrollWidth;
      let details=phone;
      if(phone || nameWidth+noteWidth+gap>width) {
        button.classList.add('is-name-only'); details=true;
      } else if(nameWidth+noteWidth+romanWidth+gap*2>width) button.classList.add('is-no-roman');
      button.dataset.details=String(details);
      button.disabled=!details && Number(button.dataset.timelineInfo)===0;
      if(!details){button.removeAttribute('aria-expanded');if(inspectedIndex===Number(button.dataset.timelineInfo))inspectedIndex=null;}
    });
    showInspection();
  }
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    if(fitFrame!==null) cancelAnimationFrame(fitFrame);
    fitFrame=requestAnimationFrame(() => {fitFrame=null;fitSlots();});
  }) : null;
  resize?.observe(container);

  function showInspection() {
    const output = container.querySelector('.wb-timeline-inspector');
    output.hidden = inspectedIndex === null;
    output.textContent = inspectedIndex === null ? "" : (entryLabels[inspectedIndex] || "");
    container.querySelectorAll('[data-timeline-info]').forEach(button => {if(button.dataset.details === 'true') button.setAttribute('aria-expanded', String(Number(button.dataset.timelineInfo) === inspectedIndex));});
  }
  function dismissInspection(event) {
    if (!container.contains(event.target) || event.key === 'Escape') { inspectedIndex = null; showInspection(); }
  }
  function click(event) {
    const info = event.target.closest('[data-timeline-info]');
    if (info && Number(info.dataset.timelineInfo)>0) { inspectedIndex=null;showInspection();onEdit(Number(info.dataset.uid));return; }
    if (info && info.dataset.details === "true") { const index = Number(info.dataset.timelineInfo); inspectedIndex = inspectedIndex === index ? null : index; showInspection(); return; }

    const action = event.target.closest('[data-timeline-action]')?.dataset.timelineAction;
    if (action === "toggle") onToggle();
    if (action === "auto") onAutoToggle();
  }
  function change(event) {
    if (event.target.matches('[data-timeline-style]')) onStyle(event.target.value);
    if (event.target.matches('[data-timeline-tempo]')) {
      const value = event.target.value === "" ? controls.bpm : Number(event.target.value);
      const bounded = Number.isFinite(value) ? Math.max(40, Math.min(200, value)) : controls.bpm;
      onTempo(bounded);
      event.target.value = bounded;
    }
  }
  container.addEventListener("click", click);
  container.addEventListener("change", change);
  document.addEventListener("pointerdown", dismissInspection, true);
  document.addEventListener("keydown", dismissInspection);

  function paint() {
    frame = null;
    if (destroyed) return;
    const transport = getTransport();
    const progress = transport.playing ? transport.progress : 0;
    container.style.setProperty("--bar-progress", progress);
    container.dataset.progress = progress.toFixed(3);
    container.classList.toggle("is-playing", transport.playing);
    if (transport.playing) frame = requestAnimationFrame(paint);
  }

  function refresh() {
    if (frame !== null) cancelAnimationFrame(frame);
    paint();
  }

  function render({ entries, language: nextLanguage }) {
    if (destroyed || !entries[0]) return;
    language = nextLanguage;
    syncControls();
    const zh = language === "zh-CN";
    container.setAttribute("aria-label", zh ? "当前及接下来三个和弦" : "Current and next three chords");
    container.querySelector('.wb-timeline-harmonies').innerHTML = entries.map((entry, index) => {
      const label = `${index === 0 ? (zh ? "当前" : "Current") : `+${index}`}: ${entry.label} · ${entry.roman} · ${entry.notes}${entry.keyLabel ? ` · ${entry.keyLabel}` : ""}`;
      entryLabels[index] = label;
      const slash = entry.inversion ? entry.label.lastIndexOf("/") : -1;
      const symbol = slash < 0 ? escape(entry.label) : `${escape(entry.label.slice(0, slash))}<wbr>${escape(entry.label.slice(slash))}`;
      return `<li class="wb-timeline-chord ${index === 0 ? "is-current" : ""} ${entry.edited ? "is-edited" : ""}" data-timeline-chord="${escape(entry.id)}" aria-label="${escape(label)}" title="${escape(label)}" ${index === 0 ? 'aria-current="true"' : ""}>
        <button type="button" class="wb-timeline-inline" data-timeline-info="${index}" data-uid="${entry.uid}" aria-description="${index > 0 ? (zh ? '点按修改此和弦，并重新生成后续进行' : 'Edit this chord and regenerate later chords') : (zh ? '和弦包含的音符' : 'Chord notes')}" aria-label="${escape(label)}" aria-expanded="${inspectedIndex === index}"><strong>${symbol}</strong><span>${escape(entry.roman)}</span><small>${escape(entry.notes)}</small></button>
      </li>`;
    }).join("");
    fitSlots();
    showInspection();
    refresh();
  }

  function destroy() {
    destroyed = true;
    resize?.disconnect();
    if(fitFrame!==null)cancelAnimationFrame(fitFrame);
    if (frame !== null) cancelAnimationFrame(frame);
    frame = null;
    container.removeEventListener("click", click);
    container.removeEventListener("change", change);
    document.removeEventListener("pointerdown", dismissInspection, true);
    document.removeEventListener("keydown", dismissInspection);
  }
  return Object.freeze({ render, refresh, syncControls, destroy });
}
