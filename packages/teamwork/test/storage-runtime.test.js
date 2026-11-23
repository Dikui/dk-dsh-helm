// Exercise the installed DSH JSON backend across two independent Host instances.
// No agent profile, sqlite, API credentials, shell tool or browser needed.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { openStore } from '../src/store.js';
const runtime=process.env.DSH_TEST_RUNTIME;
test('DSH domain and JSON backend retain acknowledged state after a complete runtime teardown', {skip:!runtime&&'Set DSH_TEST_RUNTIME to the installed resolver manifest'},async()=>{
  const require=createRequire(runtime),{Context}=require('@deepseek-ai/cordis'), temp=await mkdtemp(path.join(tmpdir(),'dk-coordination-'));
  const tick=()=>new Promise(resolve=>setImmediate(resolve));
  async function round(fn){
    const ctx=new Context(); const fibers=[ctx.plugin(require('@deepseek-ai/dsh-storage').default)];
    try {
      await tick(); fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-json'),{root:temp})); await tick();
      fibers.push(ctx.plugin(require('@deepseek-ai/dsh-storage-domain'),{backend:'json'})); await tick();
      const store=await openStore(ctx); try{await fn(store);}finally{await store.close();}
    } finally {for(const f of fibers.reverse()) await f.dispose();}
  }
  try{await round(async s=>{await Promise.all(Array.from({length:30},()=>s.transact('session-1',prev=>({state:{version:(prev?.version??0)+1}}))));});
    await round(async s=>assert.deepEqual(s.get('session-1'),{version:30}));
  } finally {if(path.dirname(temp)!==path.resolve(tmpdir())||!path.basename(temp).startsWith('dk-coordination-'))throw Error('unexpected temporary root');await rm(temp,{recursive:true,force:true});}
});
