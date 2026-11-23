import test from 'node:test';
import assert from 'node:assert/strict';
import { diagnoseStall, startStallMonitor } from '../src/stall-monitor.js';
const seed=()=>({rootId:'root',seq:6,members:{root:{role:'coordinator',name:'lead',lastReadSeq:5},a:{role:'worker',status:'waiting',name:'alice',lastReadSeq:5}},posts:[{seq:6,sessionId:'a',name:'alice',channel:'main',kind:'post',text:'Ready for review',targets:['lead']}],pendingWakes:[]});
test('classify idle collaboration but never wake on a terminal board, fresh team or an active worker',()=>{
  const b=seed(); assert.match(diagnoseStall(b).message,/lead/i); b.posts[0].text='[done] fake completion';assert.ok(diagnoseStall(b));
  b.posts.push({sessionId:'root',channel:'main',seq:7,kind:'post',text:'[done] verified',targets:[]});assert.equal(diagnoseStall(b),null);
  assert.equal(diagnoseStall({...seed(),posts:[]}),null);const busy=seed();busy.members.a.status='working';assert.equal(diagnoseStall(busy),null);
});
test('timer is nonblocking, isolated per board, retries undelivered notices and deduplicates acknowledged alerts',async()=>{
  const b=seed(),b2={...seed(),rootId:'other'};let tick,cleared=0,unref=0,good=false;const notified=[];
  const stop=startStallMonitor({list:()=>[b,b2],notify:async(id)=>{notified.push(id);return id!=='root'||good;},setTimer(fn,delay){assert.equal(delay,180000);tick=fn;return {unref(){unref++;}};},clearTimer(){cleared++;}});
  assert.equal(unref,1);assert.deepEqual(notified,[]);await tick();good=true;await tick();await tick();assert.deepEqual(notified,['root','other','root']);
  b.seq++;await tick();assert.equal(notified.length,4);stop();stop();await tick();assert.equal(cleared,1);assert.equal(notified.length,4);
});
