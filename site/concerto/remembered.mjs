import {SessionStore} from './session.mjs?v=20261018-score-1';
try{
  const value=await new SessionStore().load();
  if(value?.midi && value.confirmed){
    const badge=document.getElementById('saved-badge'),link=document.getElementById('resume-work');
    for(const [element,zh,en] of [[badge,'此浏览器已配置','Configured in this browser'],[link,'继续我的伴奏 →','Resume my accompaniment →']]){
      element.dataset.zh=zh;element.dataset.en=en;element.textContent=document.documentElement.lang.startsWith('zh')?zh:en;
    }
  }
}catch{/* Repertoire remains usable when browser storage is unavailable. */}
