import test from 'node:test';
import assert from 'node:assert/strict';
import { openStore } from '../src/store.js';

function backend() {
  const durable = new Map(); let fail = false; let opened = false;
  return { fail() { fail = true; }, ctx: { storageDomain: { async open(spec) {
    assert.match(spec.name, /^[a-z][a-z0-9_]+$/); assert.equal(opened,false); opened=true;
    for (const value of durable.values()) spec.tables.runs.valueSchema.parse(value);
    return { table: () => ({ get: k => durable.get(k), entries: () => durable.entries(), async put(k,v) {
      await new Promise(resolve => setImmediate(resolve)); if (fail) {fail=false; throw Error('disk unavailable');} durable.set(k,v);
    }}), async close(){opened=false;} };
  } } } };
}
const add = prev => { const next=(prev?.n||0)+1; return {state:{n:next},result:next}; };
test('simultaneous creation and updates return every durable commit, in order', async () => {
  const {ctx}=backend(); const s=await openStore(ctx);
  assert.deepEqual(await Promise.all(Array.from({length:12},()=>s.transact('root',add))), Array.from({length:12},(_,i)=>i+1));
  const copy=s.get('root'); copy.n=99; assert.equal(s.get('root').n,12);
  await s.close(); const reopened=await openStore(ctx); assert.deepEqual(reopened.entries(),[['root',{n:12}]]); await reopened.close();
});
test('failed transaction cannot mutate authoritative state or poison the next update', async () => {
  const b=backend(),s=await openStore(b.ctx); await s.transact('r',add); b.fail();
  await assert.rejects(s.transact('r',prev=>{prev.n=600;return {state:prev,result:600};}), /disk unavailable/);
  assert.equal(s.get('r').n,1); assert.equal(await s.transact('r',add),2); await s.close();
});
test('close drains admitted operations, refuses new work, and is idempotent', async () => {
  const {ctx}=backend(), s=await openStore(ctx); const op=s.transact('r',add), closed=s.close();
  await assert.rejects(s.transact('r',add),/clos/i); await closed; await s.close(); assert.equal(await op,1);
  const reopened=await openStore(ctx); assert.equal(reopened.get('r').n,1); await reopened.close();
});
test('reject invalid results and async transitions without committing anything',async()=>{
  const {ctx}=backend(),s=await openStore(ctx); await assert.rejects(s.transact('r',async()=>({state:{bad:true}})));
  await assert.rejects(s.transact('r',()=>({state:{bad:Infinity}}))); assert.deepEqual(s.entries(),[]); await s.close();
});
