import {CLOUD_LIBRARY,CLOUD_HOME} from './site-config.js';
const $=id=>document.getElementById(id),trustedKey='volta:trusted-local:v1';
export async function cloudRequest(path,options={}){
  const response=await fetch(new URL('./api/'+path,import.meta.url),{...options,cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(30000)});
  if(response.status===401&&path!=='login')throw new Error('登录已失效或此设备已撤销，请联网重新登录；本机批注仍保留。');
  return response;
}
// A device that has logged in before opens straight into the reader, online or not; the session is
// re-checked in the background so a revoked device still gets asked for the password.
export function startupDecision({cloudLibrary=true,trusted=null,online=true}={}){
  if(!cloudLibrary)return 'open';
  if(trusted)return 'open';
  return online?'verify':'login';
}
export function readTrustedDevice(storage=localStorage){
  try{const saved=JSON.parse(storage.getItem(trustedKey));return saved&&typeof saved==='object'?saved:null;}catch{return null;}
}
export async function requireCloudLogin(){
  if(CLOUD_HOME&&location.hostname.endsWith('.github.io')&&navigator.onLine){location.replace(CLOUD_HOME);return false;}
  if(!CLOUD_LIBRARY)return true;
  const dialog=$('cloud-login'),status=$('cloud-login-status');
  const askForPassword=()=>{
    if(dialog.open)return;
    status.textContent=navigator.onLine?'输入密码后，将此浏览器记为受信任设备。':'请先联网登录一次，再下载需要离线使用的曲谱。';
    dialog.showModal();dialog.addEventListener('cancel',event=>event.preventDefault());
    $('cloud-login-form').onsubmit=async event=>{
      event.preventDefault();const button=$('cloud-login-submit');button.disabled=true;status.textContent='正在验证…';
      try{
        const response=await cloudRequest('login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:$('cloud-password').value,label:$('cloud-device-name').value||'我的设备'})});
        const data=await response.json();if(!response.ok)throw Error(data.error||'请求过于频繁，请一分钟后重试。');
        localStorage.setItem(trustedKey,JSON.stringify(data.device));$('cloud-password').value='';dialog.close();pending?.(true);pending=null;
      }catch(error){status.textContent=error.message;}finally{button.disabled=false;}
    };
  };
  let pending=null;
  async function confirmSession({quiet=false}={}){
    try{
      const response=await cloudRequest('session');
      if(response.status===401){localStorage.removeItem(trustedKey);$('cloud-status').textContent='此设备的登录已失效，请重新输入密码。';askForPassword();return false;}
      if(!response.ok)throw Error('服务暂不可用');
      const data=await response.json();localStorage.setItem(trustedKey,JSON.stringify(data.device));
      if($('cloud-status').textContent.startsWith('离线模式'))$('cloud-status').textContent='';
      return true;
    }catch(error){
      if(quiet||readTrustedDevice()){$('cloud-status').textContent='离线模式 · 使用这台设备已下载的曲谱与批注';return true;}
      throw error;
    }
  }
  const decision=startupDecision({cloudLibrary:CLOUD_LIBRARY,trusted:readTrustedDevice(),online:navigator.onLine});
  if(decision==='open'){
    if(!navigator.onLine)$('cloud-status').textContent='离线模式 · 使用这台设备已下载的曲谱与批注';
    // Never block the reader on the network: verify while the score is already loading.
    confirmSession({quiet:true}).catch(()=>{});
    return true;
  }
  if(decision==='verify'){try{if(await confirmSession())return true;}catch{}}
  askForPassword();
  return new Promise(resolve=>{pending=resolve;});
}
export function setupCloudAccount(toast){
  const list=$('trusted-devices');
  async function refresh(){
    if(!CLOUD_LIBRARY){$('cloud-status').textContent='云端同步与受信任设备管理在私有云端版本启用。';$('cloud-sync').disabled=true;$('cloud-devices-refresh').disabled=true;return;}
    try{
      const response=await cloudRequest('devices');if(!response.ok)throw Error('暂时无法读取设备');const data=await response.json();list.replaceChildren();
      for(const device of data.devices){
        const row=document.createElement('div');row.className='offline-item';const title=document.createElement('span');title.textContent=device.label+(device.current?' · 当前设备':'');
        const detail=document.createElement('small');detail.textContent='信任至 '+new Date(device.expiresAt).toLocaleDateString();title.append(detail);
        const button=document.createElement('button');button.className='quiet';button.textContent='撤销';button.onclick=async()=>{
          if(!confirm('撤销后，此设备不能继续下载或同步。已下载的离线副本无法远程删除。确定撤销？'))return;
          try{const result=await cloudRequest('devices/revoke',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({id:device.id})});if(!result.ok)throw Error('撤销失败');if(device.current){localStorage.removeItem(trustedKey);toast('当前设备已撤销，下次联网需要重新登录。');}await refresh();}catch(error){toast(error.message);}
        };row.append(title,button);list.append(row);
      }
    }catch(error){$('cloud-status').textContent=error.message;}
  }
  $('cloud-devices-refresh').onclick=refresh;$('settings-dialog').addEventListener('toggle',()=>{if($('settings-dialog').open)refresh();});
  refresh();return {refresh};
}
