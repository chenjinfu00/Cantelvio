const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const DICE_ICON = '<svg class="wb-dice" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="4" fill="none" stroke="currentColor" stroke-width="1.8"/><g fill="currentColor"><circle cx="8" cy="8" r="1.5"/><circle cx="16" cy="8" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="8" cy="16" r="1.5"/><circle cx="16" cy="16" r="1.5"/></g></svg>';
export function createPerformanceControls({ container, getState, onKey, onWalk, onTemperature, onRandom, onSolo }) {
    let language = '', open = false;
    function render() {
        const s = getState(), zh = s.language === 'zh-CN';
        if (language !== s.language) {
            language = s.language;
            container.innerHTML = `<div class="wb-quick-key"><select data-quick="key" aria-label="${zh ? '选择主调' : 'Choose key'}">${s.keys.map(k => `<option value="${k.id}">${esc(k.label)}</option>`).join('')}</select><button type="button" data-quick="walk" aria-label="${zh ? '主调随机游走' : 'Key random walk'}" title="${zh ? '点亮：主调游走；熄灭：固定主调' : 'Lit: key walk. Unlit: fixed key.'}">↝</button></div>
   <button type="button" data-quick="temperature" aria-controls="wbTemperaturePopover"></button>
   <button type="button" data-quick="random" aria-label="${zh ? '随机编配' : 'Random arrangement'}" title="${zh ? '随机编配' : 'Random arrangement'}">${DICE_ICON}<span>${zh ? '随机' : 'Random'}</span></button>
   <button type="button" data-quick="solo" aria-label="${zh ? '自动旋律' : 'Automatic melody'}" title="${zh ? '自动旋律' : 'Automatic melody'}"><i aria-hidden="true">♪</i><span>${zh ? '旋律' : 'Solo'}</span></button>
   <div id="wbTemperaturePopover" class="wb-quick-popover" role="dialog" aria-label="${zh ? '和声温度' : 'Harmony temperature'}" hidden><div><strong>${zh ? '和声温度' : 'Harmony temperature'}</strong><button type="button" data-quick="close" aria-label="${zh ? '关闭温度' : 'Close temperature'}">×</button></div><label>${zh ? '更稳定 ↔ 更多意外' : 'More familiar ↔ More surprising'}<input data-quick="temperatureRange" type="range" min="0.25" max="2" step="0.01" aria-label="${zh ? 'Transformer 温度' : 'Transformer temperature'}"><output></output></label></div>`;
        }
        const key = container.querySelector('[data-quick="key"]');
        if (document.activeElement !== key)
            key.value = s.key;
        for (const [name, pressed] of [['walk', s.keyWalk], ['random', s.random], ['solo', s.solo]])
            container.querySelector(`[data-quick="${name}"]`).setAttribute('aria-pressed', String(pressed));
        const button = container.querySelector('[data-quick="temperature"]');
        button.textContent = `${zh ? '温度' : 'Temp'} ${s.temperature.toFixed(2)}`;
        button.setAttribute('aria-label', `${zh ? '和声温度' : 'Harmony temperature'} ${s.temperature.toFixed(2)}`);
        button.setAttribute('aria-expanded', String(open));
        const slider = container.querySelector('input');
        if (document.activeElement !== slider)
            slider.value = s.temperature;
        container.querySelector('output').textContent = s.temperature.toFixed(2);
        container.querySelector('.wb-quick-popover').hidden = !open;
    }
    function click(event) {
        const action = event.target.closest('[data-quick]')?.dataset.quick;
        if (action === 'temperature' || action === 'close') {
            open = action === 'temperature' ? !open : false;
            render();
        }
        if (action === 'walk')
            onWalk();
        if (action === 'random')
            onRandom();
        if (action === 'solo')
            onSolo();
    }
    function input(event) { if (event.target.dataset.quick === 'temperatureRange')
        onTemperature(Number(event.target.value)); }
    function change(event) { if (event.target.dataset.quick === 'key')
        onKey(event.target.value); }
    function dismiss(event) { if ((!container.contains(event.target) || event.key === 'Escape') && open) {
        open = false;
        render();
    } }
    container.addEventListener('click', click);
    container.addEventListener('input', input);
    container.addEventListener('change', change);
    document.addEventListener('pointerdown', dismiss, true);
    document.addEventListener('keydown', dismiss);
    return { render, destroy() { container.removeEventListener('click', click); container.removeEventListener('input', input); container.removeEventListener('change', change); document.removeEventListener('pointerdown', dismiss, true); document.removeEventListener('keydown', dismiss); } };
}
