import {DEFAULTS, PRESETS, normalize, palette, storageKey, readPreferences, writePreferences} from './core.mjs';

const root = document.documentElement;
const scope = new URL(root.dataset.cvRoot || './', document.baseURI);
const key = storageKey(scope);
const media = matchMedia('(prefers-color-scheme: dark)');
let storage;
try { storage = localStorage; } catch { /* Preferences still work for this visit. */ }
let preferences = readPreferences(storage, key), dialog, lastFocus;
let saved = true;
const strings = {
  zh: {open:'外观设置', title:'统一外观', about:'一次调整，应用到 Cantelvio 的所有页面。设置保存在这个浏览器。', mode:'明暗模式', system:'跟随系统', light:'浅色', dark:'深色', custom:'自定义背景', accent:'主色', background:'背景色', preview:'主按钮', previewText:'面板、文字与按钮使用同一套颜色。', note:'文字颜色会自动匹配背景。谱纸、批注及音乐标记保持原样。', reset:'恢复默认', done:'完成', close:'关闭外观设置', unsaved:'外观已应用，但浏览器不允许保存偏好。'},
  en: {open:'Appearance', title:'Shared appearance', about:'One setting for every Cantelvio page. Preferences are saved in this browser.', mode:'Color mode', system:'Follow system', light:'Light', dark:'Dark', custom:'Custom background', accent:'Accent color', background:'Background color', preview:'Primary button', previewText:'Panels, text and buttons share one palette.', note:'Text colors adapt to the background. Score paper, annotations and musical markers keep their colors.', reset:'Reset to defaults', done:'Done', close:'Close appearance settings', unsaved:'Appearance applied, but this browser does not allow saving preferences.'},
};
const language = () => root.lang.startsWith('zh') ? 'zh' : 'en';
const t = name => strings[language()][name];
function apply() {
  const theme = palette(preferences, media.matches);
  root.dataset.cvTheme = theme.theme;
  root.style.colorScheme = theme.theme;
  for (const [name, color] of Object.entries(theme.colors)) root.style.setProperty('--cv-' + name, color);
  root.style.setProperty('--cv-shadow', theme.shadow);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', theme.colors.bg);
  document.dispatchEvent(new CustomEvent('cantelvio:appearance', {detail:{preferences:{...preferences}, theme}}));
  syncControls();
}
function update(patch) {
  preferences = normalize({...preferences, ...patch});
  saved = writePreferences(storage, key, preferences);
  apply();
}
function translate() {
  for (const el of document.querySelectorAll('[data-cv-label]')) {
    const label = t(el.dataset.cvLabel);
    if (el.textContent !== label) el.textContent = label;
  }
  for (const el of document.querySelectorAll('[data-cv-open]')) {el.title = t('open');el.setAttribute('aria-label', t('open'));}
  if (!dialog) return;
  dialog.querySelector('.cv-close').setAttribute('aria-label', t('close'));
  for (const button of dialog.querySelectorAll('[data-cv-preset]')) button.querySelector('.cv-preset-label').textContent = PRESETS.find(p => p.color === button.dataset.cvPreset)[language()];
  syncControls();
}
function syncControls() {
  if (!dialog) return;
  dialog.querySelector('#cv-mode').value = preferences.mode;
  dialog.querySelector('#cv-accent').value = preferences.accent;
  dialog.querySelector('#cv-background').value = preferences.mode === 'custom' ? preferences.background : palette(preferences, media.matches).colors.bg;
  for (const button of dialog.querySelectorAll('[data-cv-preset]')) button.setAttribute('aria-pressed', String(button.dataset.cvPreset === preferences.accent));
  const status = dialog.querySelector('#cv-storage-status');
  status.textContent = saved ? '' : t('unsaved');status.hidden = saved;
}
function launcher(compact = false) {
  const button = document.createElement('button');
  button.type = 'button';button.className = 'cv-appearance-trigger';button.dataset.cvOpen = '';
  if (compact) button.dataset.cvCompact = '';
  button.innerHTML = '<span class="cv-gear" aria-hidden="true">⚙</span><span class="cv-trigger-label" data-cv-label="open"></span>';
  button.addEventListener('keydown', e=>e.stopPropagation());
  return button;
}
function open() {
  if (dialog.open) return;
  lastFocus = document.activeElement;
  translate();dialog.showModal();dialog.querySelector('#cv-mode').focus();
}
function mount() {
  dialog = document.createElement('dialog');
  dialog.className = 'cv-appearance';dialog.setAttribute('aria-labelledby','cv-appearance-title');
  dialog.innerHTML = `<div class="cv-settings-header"><h2 id="cv-appearance-title" data-cv-label="title"></h2><button type="button" class="cv-close">×</button></div>
    <p data-cv-label="about"></p>
    <label class="cv-field" for="cv-mode"><span data-cv-label="mode"></span><select id="cv-mode">${['system','light','dark','custom'].map(mode=>`<option value="${mode}" data-cv-label="${mode}"></option>`).join('')}</select></label>
    <label class="cv-field" for="cv-accent"><span data-cv-label="accent"></span><input type="color" id="cv-accent"></label>
    <div class="cv-presets">${PRESETS.map(p=>`<button type="button" data-cv-preset="${p.color}" aria-pressed="false"><i class="cv-swatch" style="--swatch:${p.color}" aria-hidden="true"></i><span class="cv-preset-label"></span></button>`).join('')}</div>
    <label class="cv-field" for="cv-background"><span data-cv-label="background"></span><input type="color" id="cv-background"></label>
    <div class="cv-preview"><strong data-cv-label="preview"></strong><span data-cv-label="previewText"></span></div>
    <p data-cv-label="note"></p><p id="cv-storage-status" role="status" hidden></p>
    <div class="cv-settings-actions"><button type="button" class="cv-reset" data-cv-label="reset"></button><button type="button" class="cv-done" data-cv-label="done"></button></div>`;
  document.body.append(dialog);
  for (const button of document.querySelectorAll('[data-cv-open]')) button.addEventListener('keydown', e=>e.stopPropagation());
  dialog.querySelector('#cv-mode').addEventListener('change', e=>update({mode:e.target.value}));
  dialog.querySelector('#cv-accent').addEventListener('input', e=>update({accent:e.target.value}));
  dialog.querySelector('#cv-background').addEventListener('input', e=>update({mode:'custom',background:e.target.value}));
  for (const button of dialog.querySelectorAll('[data-cv-preset]')) button.addEventListener('click',()=>update({accent:button.dataset.cvPreset}));
  dialog.querySelector('.cv-reset').addEventListener('click',()=>update({...DEFAULTS}));
  for (const button of dialog.querySelectorAll('.cv-close,.cv-done')) button.addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{if(lastFocus?.isConnected) lastFocus.focus();});
  // Editor and instrument shortcuts must never run while a settings control is focused.
  dialog.addEventListener('keydown', e=>e.stopPropagation());
  dialog.addEventListener('click', e=>{
    if(e.target!==dialog)return;
    const box=dialog.getBoundingClientRect();
    if(e.clientX<box.left||e.clientX>box.right||e.clientY<box.top||e.clientY>box.bottom)dialog.close();
  });
  document.addEventListener('click', e=>{if(e.target.closest('[data-cv-open]')) open();});
  const hosts = {
    home:'header',results:'header.top',score:'#root .topbar',harmony:'#performanceToggles',
    stage:'.sidebar',compose:'.top-actions, .cv-landing-actions',
  };
  function placeLaunchers() {
    const host = document.querySelector(hosts[root.dataset.cvApp]);
    if(host&&!host.querySelector('[data-cv-open]')) {
      const button=launcher();
      if(root.dataset.cvApp==='stage') {
        const home = host.querySelector('a[href="../"]');
        if(home)home.after(button);else host.prepend(button);
      } else if(root.dataset.cvApp==='score') {
        const brand = host.querySelector('.brand');
        if(brand)brand.after(button);else host.prepend(button);
      } else if(root.dataset.cvApp==='home'||root.dataset.cvApp==='results') {
        const languageControl = host.querySelector('#lang');
        if(languageControl)languageControl.before(button);else host.append(button);
      }
      else host.append(button);
    }
    if(root.dataset.cvApp==='harmony') {
      const sheet=document.querySelector('#settingsSheet .sheet-header');
      if(sheet&&!sheet.querySelector('[data-cv-open]'))sheet.querySelector('#closeSettings')?.before(launcher());
    }
    translate();
  }
  placeLaunchers();
  // React mounts its toolbar after the document is ready; observe just that app root.
  if(root.dataset.cvApp==='score')new MutationObserver(placeLaunchers).observe(document.querySelector('#root'),{childList:true,subtree:true});
  else if(!document.querySelector('[data-cv-open]')) {const fallback=launcher();fallback.classList.add('cv-appearance-fallback');document.body.append(fallback);translate();}
  new MutationObserver(translate).observe(root,{attributes:true,attributeFilter:['lang']});
  apply();
}
window.addEventListener('storage', e=>{
  if(e.key!==key&&e.key!==null)return;
  preferences=readPreferences(storage,key);saved=true;apply();
});
media.addEventListener('change',()=>{if(preferences.mode==='system')apply();});
apply();
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',mount,{once:true});else mount();
