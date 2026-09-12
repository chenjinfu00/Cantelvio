import {pbkdf2Sync,randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import {getStore} from '@netlify/blobs';
import path from 'node:path';
// Read without terminal echo; plaintext never enters a file, command argument,
// build, browser bundle or Netlify logs. Only the salted verifier is configured.
if(!process.stdin.isTTY)throw Error('Use an interactive terminal.');
process.stdout.write('Enter the chosen Volta password (hidden): ');
process.stdin.setRawMode(true);process.stdin.resume();let password='';
process.stdin.on('data',async chunk=>{
  for(const ch of chunk.toString()){
    if(ch==='\u0003'){process.stdin.setRawMode(false);process.exit(1);}
    if(ch==='\r'||ch==='\n'){
      process.stdin.setRawMode(false);process.stdin.pause();
      if(password.length<12){console.error('\nPassword must have at least 12 characters.');process.exit(1);}
      const salt=randomBytes(16),hash=pbkdf2Sync(password,salt,310000,32,'sha256');password='';
      const verifier=`pbkdf2$310000$${salt.toString('hex')}$${hash.toString('hex')}`;
      try{
        const {siteId}=JSON.parse(await fs.readFile(path.resolve(import.meta.dirname,'../.netlify/state.json')));
        const config=JSON.parse(await fs.readFile(path.join(os.homedir(),'Library/Preferences/netlify/config.json')));
        // A server-only store, deliberately separate from every download route.
        // No public URL, browser credential, plaintext or build-time injection.
        const store=getStore('volta-auth-config',{siteID:siteId,token:config.users[config.userId].auth.token,consistency:'strong'});
        await store.setJSON('password',{verifier});
        const saved=await store.get('password',{type:'json'});
        if(saved?.verifier!==verifier)throw Error('Configuration verification failed');
        console.log('\nPrivate server password verifier saved and read-back verified.');
        process.exit(0);
      }catch(error){console.error('\nUnable to configure verifier. Status: '+(error.status||error.name)+'. No plaintext password was saved.');process.exit(1);}
    }
    else if(ch==='\u007f')password=password.slice(0,-1);else password+=ch;
  }
});
