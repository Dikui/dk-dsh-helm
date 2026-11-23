import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {renderer} from './renderer.js';
import { readFile } from 'node:fs/promises';

async function harness(reply,react={createElement(){}}) {
  const defs=[], calls=[], slots=[], disposers=[]; let pkg;
  vm.runInNewContext(await readFile(new URL('../client.js',import.meta.url),'utf8'),{window:{__ModuleLoader__:{load(v){pkg=v;}}}});
  assert.equal(pkg.id,'@local/dk-dsh-swarm');
  const mod=pkg.factory(key=>{assert.equal(key,'react');return react;});
  mod.apply({locale:{register(){return ()=>{};},bind(){return k=>k;}},effect(fn){disposers.push(fn());},
    remote:{commands:{async execute(...args){calls.push(args);return reply;}}},
    sidebarRightTabs:{register(def){defs.push(def);return ()=>defs.pop();}},
    slots:{inject(_,fn){fn();},register(spec,Body){slots.push([spec,Body]);return ()=>slots.pop();}}});
  return {defs,calls,slots,disposers};
}
test('guide opens a session-bound read-only board; rendering/registering never calls the host',async()=>{
  const reply={ok:true,value:{result:{kind:'success',text:JSON.stringify({v:1,title:'Hive',seq:3,plan:null,counts:{members:0,active:0,messages:0,channels:0},members:[],channels:[],messages:[]})}}};
  const h=await harness(reply); assert.equal(h.defs[0].kind,'swarm-board'); assert.equal(h.defs[0].guide.length,1); assert.equal(h.calls.length,0);
  assert.equal(h.slots[0][0].key,h.defs[0].id); const a=h.slots[0][0].inject('root-A'); assert.equal((await a.loadBoard()).title,'Hive');
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls)),[['root-A','/swarm view',[]]]); h.disposers.forEach(fn=>fn?.()); assert.equal(h.defs.length,0);
});
test('all four views render the same snapshot, filter channels and replay trusted graph edges',async()=>{
  const messages=[{seq:2,author:'lead',channel:'main',text:'first note',targets:['scout']},{seq:5,author:'scout',channel:'ops',text:'second note',targets:['lead']}];
  const snapshot={v:1,title:'Blue Hive',seq:5,counts:{members:2,active:1,channels:2,messages:2},members:[{name:'scout',role:'worker',status:'paused',unread:1,lastSeq:2}],messages,channels:[{name:'main'},{name:'ops'}],plan:{goal:'Ship it',tasks:[{id:'1',title:'Run test',status:'waiting'}],threads:[]}};
  const ui=renderer(),h=await harness({ok:true,value:{result:{kind:'success',text:JSON.stringify(snapshot)}}},ui.react);
  const [spec,Body]=h.slots[0],panel=Body({sessionId:'root',...spec.inject('root'),t:k=>k});let tree=ui.render(panel);
  const click=async(name)=>{await ui.scan(tree,e=>e.type==='button'&&ui.text(e)===name)[0].props.onClick();tree=ui.render(panel);};
  await click('refresh');assert.match(ui.text(tree),/Blue Hive.*Ship it.*Run test/);
  await click('members');assert.match(ui.text(tree),/scout.*paused.*1 unread/);
  await click('board');ui.scan(tree,e=>e.type==='select')[0].props.onChange({target:{value:'ops'}});tree=ui.render(panel);assert.match(ui.text(tree),/second note/);assert.doesNotMatch(ui.text(tree),/first note/);
  await click('graph');const graph=ui.scan(tree,e=>typeof e.type==='function')[0];let replay=ui.render(graph);assert.equal(ui.scan(replay,e=>e.type==='svg').length,1);assert.equal(ui.scan(replay,e=>e.type==='li').length,2);
  ui.scan(replay,e=>e.type==='input')[0].props.onChange({target:{value:2}});replay=ui.render(graph);assert.equal(ui.scan(replay,e=>e.type==='li').length,1);assert.match(ui.text(replay),/lead.*→.*scout/);assert.equal(h.calls.length,1);ui.close();
});
test('failed transport, command denial, missing command and malformed snapshots do not masquerade as an empty board',async()=>{
  for(const reply of [{ok:false,error:{message:'offline'}},{ok:true},{ok:true,value:{result:{kind:'error',text:'root only'}}},{ok:true,value:{result:{kind:'success',text:'null'}}},
    {ok:true,value:{result:{kind:'success',text:JSON.stringify({v:1,title:'bad',seq:1,counts:{},plan:{},members:[],messages:[],channels:[]})}}},
    {ok:true,value:{result:{kind:'success',text:JSON.stringify({v:1,title:'bad',seq:1,counts:{members:1,channels:1,active:1,messages:1},plan:null,members:[null],messages:[null],channels:[null]})}}}]){
    const h=await harness(reply); await assert.rejects(h.slots[0][0].inject('root').loadBoard());
  }
});
