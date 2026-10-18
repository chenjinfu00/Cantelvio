// The launcher and guide share the existing Cantelvio language preference.
const control = document.getElementById('lang');
let saved;
try { saved = localStorage.getItem('cantelvio-lang'); } catch { /* Use browser language. */ }
function setLanguage(language) {
  const value = language === 'en' ? 'en' : 'zh';
  document.documentElement.lang = value === 'en' ? 'en' : 'zh-CN';
  control.value = value;
  for (const element of document.querySelectorAll('[data-zh]')) {
    element.textContent = element.getAttribute('data-' + value);
  }
  const page = document.documentElement.dataset.cvPage;
  document.title = page === 'demo'
    ? (value === 'en' ? 'Cantelvio · Guide & demos' : 'Cantelvio · 演示与使用说明')
    : page === 'concerto' ? (value === 'en' ? 'Cantelvio Concerto · Repertoire' : 'Cantelvio Concerto · 协奏伴奏曲目')
    : page === 'concerto-play' ? (value === 'en' ? 'Cantelvio Concerto · Rehearsal' : 'Cantelvio Concerto · 伴奏排练')
    : (value === 'en' ? 'Cantelvio · Music workspaces' : 'Cantelvio · 音乐工作台');
}
setLanguage(saved === 'en' || saved === 'zh' ? saved : navigator.language.startsWith('zh') ? 'zh' : 'en');
control.addEventListener('change', () => {
  setLanguage(control.value);
  try { localStorage.setItem('cantelvio-lang', control.value); } catch { /* Works for this visit. */ }
});
