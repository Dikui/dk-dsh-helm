import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { renderer } from './renderer.js';

// Small/spec: session-bound live board. Only the clock, document visibility and
// HTTP boundary are faked; tests enter through the registered sidebar body.
const source = await readFile(new URL('../client.js', import.meta.url), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));
const msg = (seq, overrides={}) => ({seq, author:'scout', channel:'main', text:`note-${seq}.`, ...overrides});
const view = (overrides={}) => ({v:1,title:'Hive',seq:3,plan:null,counts:{members:0,active:0,channels:1,messages:0},members:[],channels:[{name:'main'}],messages:[],...overrides});
const snapshot = (etag='etag-a', fields={}) => ({kind:'snapshot',etag,view:view(fields)});
const delta = (etag,baseEtag,firstSeq,fields) => ({kind:'delta',etag,baseEtag,firstSeq,view:view(fields)});
const ok = value => ({ok:true,value});

function harness(t,{hidden=false, ignoresAbort=false, primitives=null}={}) {
  t.mock.timers.enable({apis:['setTimeout']});
  const ui=renderer(), doc=Object.assign(new EventTarget(),{hidden});
  const defs=[], slots=[], disposers=[], calls=[];
  let pkg, panel;
  const fetch=(url,opts)=>{
    const {resolve,reject,promise}=Promise.withResolvers();
    if(!ignoresAbort) opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true});
    calls.push({url,body:JSON.parse(opts.body),opts,resolve,reject});
    return promise;
  };
  vm.runInNewContext(source,{window:{__ModuleLoader__:{load(v){pkg=v;}}},document:doc,fetch,AbortController,setTimeout,clearTimeout});
  assert.equal(pkg.id,'@local/dk-dsh-swarm');
  const mod=pkg.factory(key=>{
    if(key==='react') return ui.react;
    if(key==='@deepseek-ai/dsh-client-ui-primitives'&&primitives) return primitives(ui.react);
    assert.equal(key,'react');return ui.react;
  });
  // No remote.commands in this context: polling must never create transcript records.
  mod.apply({locale:{register(){return ()=>{};},bind(){return k=>k;}},effect(fn){disposers.push(fn());},
    sidebarRightTabs:{register(def){defs.push(def);return ()=>defs.pop();}},
    slots:{inject(_,fn){disposers.push(fn());},register(spec,Body){slots.push([spec,Body]);return ()=>slots.pop();}}});
  t.after(()=>{ui.close();disposers.reverse().forEach(fn=>fn?.());assert.equal(defs.length,0);assert.equal(slots.length,0);});
  const tree=()=>ui.render(panel);
  function mount(sessionId='root-A') {
    const [spec,Body]=slots[0];
    panel=Body({...spec.inject(sessionId),t:k=>k});
    tree();
  }
  const text=()=>ui.text(tree());
  const click=name=>{
    const button=ui.scan(tree(),e=>e.type==='button'&&ui.text(e)===name)[0];
    assert.ok(button,`missing ${name} button`); assert.ok(!button.props.disabled);
    return button.props.onClick();
  };
  function visible(show){doc.hidden=!show;doc.dispatchEvent(new Event('visibilitychange'));}
  async function tick(ms){t.mock.timers.tick(ms);await flush();}
  async function respond(body,status=200,index=calls.length-1){
    calls[index].resolve({ok:status>=200&&status<300,status,json:async()=>body});await flush();
  }
  return {ui,defs,slots,calls,tree,mount,text,click,visible,tick,respond,reply:value=>respond(ok(value))};
}

test('opening the session board reads immediately; idle registration never calls the host',async t=>{
  const h=harness(t); assert.equal(h.defs[0].kind,'swarm-board');assert.equal(h.defs[0].guide.length,1);
  assert.equal(h.slots[0][0].key,h.defs[0].id);assert.equal(h.calls.length,0);
  h.mount(); assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'api/dk-swarm/liveView');
  assert.equal(h.calls[0].opts.method,'POST');assert.equal(h.calls[0].opts.headers['content-type'],'application/json');
  assert.deepEqual(h.calls[0].body,{sessionId:'root-A',cursor:null});assert.match(h.text(),/loading/);assert.doesNotMatch(h.text(),/start/);
  await h.reply(snapshot());assert.match(h.text(),/live.*Hive/);
});

test('all four views render the same live snapshot, filter channels and replay trusted graph edges',async t=>{
  const messages=[msg(2,{author:'lead',text:'first note',targets:['scout']}),msg(5,{channel:'ops',text:'second note',targets:['lead']})];
  const h=harness(t);h.mount();await h.reply(snapshot('v1',{title:'Blue Hive',seq:5,counts:{members:2,active:1,channels:2,messages:2},members:[{name:'scout',role:'worker',status:'paused',unread:1,lastSeq:2}],messages,channels:[{name:'main'},{name:'ops'}],plan:{goal:'Ship it',tasks:[{id:'1',title:'Run test',status:'waiting'}],threads:[]}}));
  assert.match(h.text(),/Blue Hive.*Ship it.*Run test/);
  await h.click('members');assert.match(h.text(),/scout.*paused.*1 unread/);
  await h.click('board');h.ui.scan(h.tree(),e=>e.type==='select')[0].props.onChange({target:{value:'ops'}});
  assert.match(h.text(),/second note/);assert.doesNotMatch(h.text(),/first note/);
  await h.click('graph');const graph=h.ui.scan(h.tree(),e=>typeof e.type==='function')[0];let replay=h.ui.render(graph);
  assert.equal(h.ui.scan(replay,e=>e.type==='svg').length,1);assert.equal(h.ui.scan(replay,e=>e.type==='li').length,2);
  h.ui.scan(replay,e=>e.type==='input')[0].props.onChange({target:{value:2}});replay=h.ui.render(graph);
  assert.equal(h.ui.scan(replay,e=>e.type==='li').length,1);assert.match(h.ui.text(replay),/lead.*→.*scout/);assert.equal(h.calls.length,1);
});

test('an empty board polls in 3s; a live board checks its cursor in 1.5s without updating React on unchanged',async t=>{
  const h=harness(t);h.mount();await h.reply({kind:'empty'});assert.match(h.text(),/start/);
  await h.tick(2999);assert.equal(h.calls.length,1);await h.tick(1);assert.equal(h.calls[1].body.cursor,null);
  await h.reply(snapshot());const writes=h.ui.writes;await h.tick(1499);assert.equal(h.calls.length,2);
  await h.tick(1);assert.deepEqual(h.calls[2].body.cursor,{etag:'etag-a',since:3});
  await h.reply({kind:'unchanged',etag:'etag-a'});assert.equal(h.ui.writes,writes);
  await h.tick(1500);await h.reply({kind:'empty'});assert.doesNotMatch(h.text(),/Hive/);assert.match(h.text(),/start/);
  await h.tick(3000);assert.equal(h.calls[4].body.cursor,null);
});

test('without a known board a hidden document sends no reads until it becomes visible',async t=>{
  const h=harness(t,{hidden:true});h.mount();await h.tick(180000);assert.equal(h.calls.length,0);
  h.visible(true);assert.equal(h.calls.length,1);await h.reply({kind:'empty'});
  h.visible(false);await h.tick(180000);assert.equal(h.calls.length,1);h.visible(true);assert.equal(h.calls.length,2);
});

test('hidden probes never advance the cursor or publish; a wake during a probe schedules one fresh visible read',async t=>{
  const h=harness(t);h.mount();await h.reply(snapshot());const writes=h.ui.writes;
  h.visible(false);await h.tick(59999);assert.equal(h.calls.length,1);await h.tick(1);assert.equal(h.calls.length,2);
  await h.reply(snapshot('hidden',{title:'Do not display'}));assert.equal(h.ui.writes,writes);
  await h.tick(60000);h.visible(true);h.visible(true);const ignoredClick=h.click('refresh');assert.equal(h.calls.length,3);
  assert.ok(h.calls[2].opts.signal.aborted);await ignoredClick;await flush();assert.equal(h.calls.length,4);assert.equal(h.ui.writes,writes);
  for(const c of h.calls.slice(1))assert.deepEqual(c.body.cursor,{etag:'etag-a',since:3});
  await h.reply(snapshot('visible',{title:'Back online'}));assert.match(h.text(),/Back online/);
});

test('waking during the initial visible read aborts it and retries immediately with the original cursor',async t=>{
  const h=harness(t);h.mount();h.visible(false);h.visible(true);
  assert.ok(h.calls[0].opts.signal.aborted);assert.equal(h.calls.length,1);await flush();
  assert.equal(h.calls.length,2);assert.equal(h.calls[1].body.cursor,null);
  await h.reply(snapshot('replacement'));assert.match(h.text(),/live.*Hive/);
});

test('a denial on a hidden probe revokes the board and waking cannot restore it implicitly',async t=>{
  const h=harness(t);h.mount();await h.reply(snapshot());h.visible(false);await h.tick(60000);
  await h.respond(null,403);h.visible(true);await h.tick(60000);
  assert.equal(h.calls.length,2);assert.match(h.text(),/unavailable/);assert.doesNotMatch(h.text(),/Hive/);
});

test('switching owner aborts the old request and starts with no board or cursor even if old replies arrive late',async t=>{
  const h=harness(t,{ignoresAbort:true});h.mount('A');await h.reply(snapshot('A',{title:'First board'}));
  await h.tick(1500);h.mount('B');assert.ok(h.calls[1].opts.signal.aborted);
  assert.deepEqual(h.calls[2].body,{sessionId:'B',cursor:null});assert.doesNotMatch(h.text(),/First board/);
  await h.reply(snapshot('B',{title:'Second board'}));const writes=h.ui.writes;
  await h.respond(ok(snapshot('A-late',{title:'Stale board'})),200,1);
  assert.equal(h.ui.writes,writes);assert.match(h.text(),/Second board/);
  await h.tick(1500);assert.deepEqual(h.calls[3].body,{sessionId:'B',cursor:{etag:'B',since:3}});
});

test('closing the board cancels its timer and active read; a late reply or visibility event starts no more work',async t=>{
  const h=harness(t,{ignoresAbort:true});h.mount();h.ui.close();assert.ok(h.calls[0].opts.signal.aborted);
  const writes=h.ui.writes;await h.reply(snapshot());h.visible(false);h.visible(true);await h.tick(120000);
  assert.equal(h.calls.length,1);assert.equal(h.ui.writes,writes);
});

test('stalled fetches time out and release the single flight for automatic retry',async t=>{
  const h=harness(t);h.mount();await h.tick(14999);assert.equal(h.calls.length,1);
  await h.tick(1);assert.ok(h.calls[0].opts.signal.aborted);assert.match(h.text(),/retrying.*timed out/);
  await h.tick(3000);assert.equal(h.calls.length,2);await h.reply(snapshot());assert.match(h.text(),/live.*Hive/);
});

test('temporary failures retain the last board, back off to 60s and can be retried manually',async t=>{
  const h=harness(t);h.mount();await h.reply(snapshot());await h.tick(1500);
  for(const delay of [3000,6000,12000,24000,48000,60000,60000]){
    h.calls.at(-1).reject(new Error('offline'));await flush();assert.match(h.text(),/retrying.*offline.*Hive/);
    const n=h.calls.length;await h.tick(delay-1);assert.equal(h.calls.length,n);await h.tick(1);assert.equal(h.calls.length,n+1);
    assert.deepEqual(h.calls.at(-1).body.cursor,{etag:'etag-a',since:3});
  }
  await h.respond(null,503);const n=h.calls.length;const result=h.click('retry');assert.equal(h.calls.length,n+1);
  await h.reply({kind:'unchanged',etag:'etag-a'});await result;assert.match(h.text(),/live.*Hive/);assert.doesNotMatch(h.text(),/retrying/);
  await h.tick(1500);assert.equal(h.calls.length,n+2);
});

test('access denial or a missing route clears the last view and waits for a manual retry from scratch',async t=>{
  for(const status of [400,401,403,404,200])await t.test(`HTTP ${status}`,async t=>{
    const h=harness(t);h.mount();await h.reply(snapshot());await h.tick(1500);
    await h.respond({ok:false,error:{code:'swarm/forbidden',message:'local only'}},status);
    assert.match(h.text(),/unavailable/);assert.doesNotMatch(h.text(),/Hive|retrying|start/);
    await h.tick(180000);assert.equal(h.calls.length,2);const result=h.click('retry');assert.equal(h.calls[2].body.cursor,null);
    await h.reply(snapshot());await result;assert.match(h.text(),/live.*Hive/);
  });
});

test('a malformed view or transport failure is not presented as an empty board',async t=>{
  for(const [name,body] of Object.entries({missingEnvelope:{},invalidEnvelope:{ok:'yes',value:snapshot()},badTag:ok(snapshot('x'.repeat(257))),logicError:{ok:false,error:{message:'offline'}},nullView:ok(snapshot('v',{plan:0})),
    invalidRow:ok(snapshot('v',{messages:[null]})),oversizedView:ok(snapshot('v',{title:'x'.repeat(12000)}))}))await t.test(name,async t=>{
    const h=harness(t);h.mount();await h.respond(body);assert.match(h.text(),/retrying/);assert.doesNotMatch(h.text(),/start|live/);
  });
});

test('delta rows replace metadata and keep exactly the bounded suffix; null firstSeq clears the message window',async t=>{
  const h=harness(t),rows=Array.from({length:30},(_,i)=>msg(i+1));
  h.mount();await h.reply(snapshot('a',{seq:31,messages:rows}));await h.click('board');
  await h.tick(1500);assert.deepEqual(h.calls.at(-1).body.cursor,{etag:'a',since:31}); // control seq 31 is not visible
  await h.reply(delta('b','a',3,{seq:34,title:'Updated',messages:[msg(32),msg(34)]}));
  assert.doesNotMatch(h.text(),/note-[12]\./);assert.match(h.text(),/note-3\..*note-30\..*note-32\..*note-34\./);
  assert.equal(h.ui.scan(h.tree(),e=>e.type==='li').length,30);await h.click('overview');assert.match(h.text(),/Updated/);
  await h.tick(1500);assert.deepEqual(h.calls.at(-1).body.cursor,{etag:'b',since:34});
  await h.reply(delta('c','b',null,{seq:34,messages:[]}));await h.click('board');assert.doesNotMatch(h.text(),/note-/);
});

test('a channel that leaves the displayed window falls back to the all-channels list',async t=>{
  const h=harness(t);h.mount();await h.reply(snapshot('a',{messages:[msg(1,{channel:'extra'})]}));await h.click('board');
  const select=()=>h.ui.scan(h.tree(),e=>e.type==='select')[0];select().props.onChange({target:{value:'extra'}});
  await h.tick(1500);await h.reply(delta('b','a',4,{seq:4,messages:[msg(4)]}));
  assert.equal(select().props.value,'');assert.match(h.text(),/note-4\./);
});

test('an unusable delta is never displayed and triggers one immediate full read',async t=>{
  for(const [name,bad] of Object.entries({wrongBase:delta('b','other',1,{}),oldRow:delta('b','a',1,{messages:[msg(2)]}),
    badFloor:delta('b','a',2,{}),nullWithNew:delta('b','a',null,{seq:4,messages:[msg(4)]}),regressedSeq:delta('b','a',1,{seq:2}),
    malformed:delta('b','a',1,{members:[null]}),wrongUnchanged:{kind:'unchanged',etag:'other'}}))await t.test(name,async t=>{
    const h=harness(t);h.mount();await h.reply(snapshot('a',{messages:[msg(1)]}));const writes=h.ui.writes;
    await h.tick(1500);await h.reply(bad);assert.equal(h.calls.length,3);assert.equal(h.calls[2].body.cursor,null);assert.equal(h.ui.writes,writes);
    await h.reply(snapshot('fresh',{title:'Recovered board'}));assert.match(h.text(),/Recovered board/);
  });
});

test('an invalid response to full recovery backs off without reusing the broken cursor',async t=>{
  const h=harness(t);h.mount();await h.reply(snapshot());await h.tick(1500);
  const bad=delta('x','unknown',null,{});await h.reply(bad);await h.reply(bad);
  assert.equal(h.calls.length,3);assert.match(h.text(),/retrying.*Hive/);
  await h.tick(3000);assert.equal(h.calls[3].body.cursor,null);
});

test('the model menu switch is root-only, lazy and writes the session mode',async t=>{
  const h=harness(t);
  const entry=h.slots.find(([spec])=>spec.name==='conversation.input.model.options');
  assert.ok(entry,'model options slot is registered');
  const [spec,Body]=entry;
  const panel=Body({...spec.inject('root-A'),locked:false,reportFailure(){}});
  h.ui.render(panel);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].url,'api/dk-swarm/mode');
  assert.deepEqual(h.calls[0].body,{sessionId:'root-A'});
  await h.reply({root:true,exists:false,enabled:false,title:null});
  let tree=h.ui.render(panel);
  assert.match(h.ui.text(tree),/swarm/);
  let toggle=h.ui.scan(tree,e=>e.type==='button'&&e.props.role==='switch')[0];
  assert.ok(toggle);assert.equal(toggle.props['aria-checked'],false);
  const clicked=toggle.props.onClick();
  assert.deepEqual(h.calls[1].body,{sessionId:'root-A',enabled:true});
  await h.reply({root:true,exists:true,enabled:true,title:'Hive'});
  await clicked;
  tree=h.ui.render(panel);
  toggle=h.ui.scan(tree,e=>e.type==='button'&&e.props.role==='switch')[0];
  assert.equal(toggle.props['aria-checked'],true);
});

test('the model menu switch stays hidden for a child or an unreadable session',async t=>{
  const h=harness(t);
  const [spec,Body]=h.slots.find(([spec])=>spec.name==='conversation.input.model.options');
  const panel=Body(spec.inject('child-A'));
  h.ui.render(panel);
  await h.respond({ok:false,error:{code:'swarm/forbidden',message:'local only'}},403);
  assert.equal(h.ui.text(h.ui.render(panel)),'');
});

test('the model menu uses the shared switch and info primitives when the host exposes them',async t=>{
  const native={};
  const primitives=React=>{
    const h=React.createElement;
    native.Switch=({checked,disabled,label,onChange})=>h('button',{type:'button',role:'switch',
      'aria-checked':checked,disabled,onClick:()=>onChange(!checked)},label);
    native.Tooltip=({label,children})=>h('span',{'data-native-tooltip':label},children);
    native.Button=({children,...props})=>h('button',props,children);
    native.IconInfoOutlineRegular=({size})=>h('span',{'data-native-info':String(size)});
    return {Switch:native.Switch,Tooltip:native.Tooltip,Button:native.Button,IconInfoOutlineRegular:native.IconInfoOutlineRegular};
  };
  const h=harness(t,{primitives});
  const [spec,Body]=h.slots.find(([spec])=>spec.name==='conversation.input.model.options');
  const panel=Body({...spec.inject('root-A'),locked:false,reportFailure(){}});
  h.ui.render(panel);await h.reply({root:true,exists:true,enabled:false,title:'Hive'});
  let tree=h.ui.render(panel);
  let toggle=h.ui.scan(tree,e=>e.type===native.Switch)[0];
  assert.ok(toggle,'the shared Switch is used');
  assert.equal(toggle.props.checked,false);
  const icon=h.ui.scan(tree,e=>e.type===native.IconInfoOutlineRegular)[0];
  assert.ok(icon,'the shared info icon is used');assert.equal(icon.props.size,11);
  assert.equal(h.ui.scan(tree,e=>e.type===native.Tooltip)[0].props.label,'swarmHint');
  toggle.props.onChange(true);
  assert.deepEqual(h.calls[1].body,{sessionId:'root-A',enabled:true});
  await h.reply({root:true,exists:true,enabled:true,title:'Hive'});await flush();
  tree=h.ui.render(panel);
  toggle=h.ui.scan(tree,e=>e.type===native.Switch)[0];
  assert.equal(toggle.props.checked,true);
});
