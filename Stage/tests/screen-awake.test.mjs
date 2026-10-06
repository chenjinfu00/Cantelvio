import test from 'node:test';
import assert from 'node:assert/strict';
import {ScreenAwake,installScreenAwake} from '../docs/screen-awake.js';

const sentinel=()=>{let release;return {released:false,addEventListener:(name,fn)=>{if(name==='release')release=fn;},fire:()=>release?.(),release:async()=>{}};};

test('screen wake lock is shared, then can be reacquired after Safari releases it',async()=>{
  let requests=0;const locks=[];
  const awake=new ScreenAwake({request:async()=>{requests++;const lock=sentinel();locks.push(lock);return lock;}});
  await awake.acquire();await awake.acquire();assert.equal(requests,1);
  locks[0].fire();await awake.acquire();assert.equal(requests,2);
});

test('hidden pages do not request a wake lock',async()=>{
  let requests=0,visible=false;const awake=new ScreenAwake({request:async()=>{requests++;return sentinel();},visible:()=>visible});
  await awake.acquire();assert.equal(requests,0);visible=true;await awake.acquire();assert.equal(requests,1);
});

test('the app retries wake lock on a gesture and when returning to the foreground',async()=>{
  const listeners=new Map();let requests=0;
  const doc={visibilityState:'visible',addEventListener:(name,fn)=>listeners.set(name,fn)};
  const awake=installScreenAwake({doc,nav:{wakeLock:{request:async()=>{requests++;return sentinel();}}}});
  await awake.acquire();assert.equal(requests,1);
  listeners.get('pointerdown')();await Promise.resolve();assert.equal(requests,1,'a held lock is reused');
  doc.visibilityState='hidden';listeners.get('visibilitychange')();
  doc.visibilityState='visible';listeners.get('visibilitychange')();await awake.acquire();assert.equal(requests,2);
});
