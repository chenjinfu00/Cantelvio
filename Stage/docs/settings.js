export const defaults={theme:'blue',surface:'white',tap:true,sensitivity:'fast',preload:true,fullscreen:true,protectFit:true,rememberPosition:true,autoOffline:true};
const booleans=['tap','preload','fullscreen','protectFit','rememberPosition','autoOffline'];
export function normalizeSettings(value={}){
  if(!value||typeof value!=='object')value={};
  return {theme:['blue','jade','graphite'].includes(value.theme)?value.theme:'blue',surface:['white','paper','mist','dark'].includes(value.surface)?value.surface:'white',sensitivity:['fast','standard','guarded'].includes(value.sensitivity)?value.sensitivity:'fast',...Object.fromEntries(booleans.map(key=>[key,typeof value[key]==='boolean'?value[key]:defaults[key]]))};
}
export function readSettings(){try{return normalizeSettings(JSON.parse(localStorage.getItem('volta:settings')||'{}'));}catch{return {...defaults};}}
export function setupSettings(onChange,toast){
  let value=readSettings();const dialog=document.getElementById('settings-dialog');
  dialog.querySelector('.settings-layout > section:first-child').append(document.getElementById('reading-settings-template').content.cloneNode(true));
  function apply(){
    document.documentElement.dataset.theme=value.theme;
    document.documentElement.dataset.surface=value.surface;
    document.querySelector('meta[name="theme-color"]').content={blue:'#1e4c92',jade:'#235c52',graphite:'#3d4657'}[value.theme];
    dialog.querySelectorAll('[data-theme-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.themeChoice===value.theme)));
    dialog.querySelectorAll('[data-surface-choice]').forEach(button=>button.setAttribute('aria-pressed',String(button.dataset.surfaceChoice===value.surface)));
    for(const key of booleans)document.getElementById('setting-'+key).checked=value[key];
    document.getElementById('setting-sensitivity').value=value.sensitivity;
  }
  function update(patch){value=normalizeSettings({...value,...patch});apply();try{localStorage.setItem('volta:settings',JSON.stringify(value));}catch{toast('设置已生效，但浏览器不允许保存偏好。');}onChange(value);}
  dialog.querySelectorAll('[data-theme-choice]').forEach(button=>button.onclick=()=>update({theme:button.dataset.themeChoice}));
  dialog.querySelectorAll('[data-surface-choice]').forEach(button=>button.onclick=()=>update({surface:button.dataset.surfaceChoice}));
  for(const key of booleans)document.getElementById('setting-'+key).onchange=e=>update({[key]:e.target.checked});
  document.getElementById('setting-sensitivity').onchange=e=>update({sensitivity:e.target.value});
  document.querySelectorAll('[data-open-settings]').forEach(button=>button.onclick=()=>dialog.showModal());
  apply();return {get value(){return value;}};
}
