window.__ModuleLoader__.load({
  id: '@local/dk-dsh-swarm',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const id = '@local/dk-dsh-swarm', ns = 'dkSwarm', pages = ['overview','board','members','graph'];
    const dictionaries = {
      en: { title:'Swarm board', guide:'Messages, members and directed mentions in this session.', refresh:'Read latest snapshot', loading:'Reading…', start:'Use /swarm to start a board in the root session. Read a snapshot to inspect it.', overview:'Overview', board:'Board', members:'Members', graph:'Mention graph', all:'All channels', empty:'Nothing in this snapshot.', seq:'Snapshot', goal:'Goal', tasks:'Tasks', threads:'Threads', unread:'unread', cutoff:'Through message', edges:'Directed mentions in the displayed message window', active:'active', count:'members', channel:'Channel', window:'Latest messages in this snapshot'},
      zh: { title:'Swarm 黑板', guide:'查看本会话的消息、成员及定向呼唤。', refresh:'读取最新快照', loading:'读取中…', start:'在根会话用 /swarm 启动黑板，点击读取查看当前快照。', overview:'概览', board:'黑板', members:'成员', graph:'呼唤关系', all:'所有频道', empty:'当前快照暂无记录。', seq:'快照', goal:'目标', tasks:'任务', threads:'讨论线', unread:'未读', cutoff:'截至消息', edges:'当前消息窗口内的定向呼唤', active:'活跃', count:'成员', channel:'频道', window:'当前快照中的近期消息'},
    };
    const box = {padding:'0.8rem',display:'grid',alignContent:'start',gap:'0.7rem',height:'100%',overflow:'auto',boxSizing:'border-box',overflowWrap:'anywhere'};
    function list(rows, render, t) { return rows.length?h('ul',{style:{paddingInlineStart:'1.3em',margin:0}},rows.map(render)):h('p',null,t('empty')); }
    // Validate the wire shape before placing it in React state. A stale Host must
    // produce a recoverable error rather than breaking the entire sidebar tab.
    function parseSnapshot(text) {
      const str = x => typeof x === 'string';
      const count = x => Number.isSafeInteger(x) && x >= 0;
      const all = (xs, predicate) => Array.isArray(xs) && xs.every(predicate);
      if (!str(text) || text.length > 12000) throw Error('Invalid Swarm snapshot');
      const d = JSON.parse(text), p = d?.plan;
      if (d?.v !== 1 || !str(d.title) || !count(d.seq)
        || !['members','active','messages','channels'].every(k => count(d.counts?.[k]))
        || !(p === null || (p && str(p.goal) && all(p.tasks,x => x && str(x.id) && str(x.title) && str(x.status) && (!x.owner || str(x.owner))) && all(p.threads,x => x && str(x.id) && str(x.channel) && str(x.goal))))
        || !all(d.members,x => x && str(x.name) && str(x.role) && str(x.status) && count(x.unread) && count(x.lastSeq))
        || !all(d.messages,x => x && count(x.seq) && str(x.author) && str(x.channel) && str(x.text) && (x.targets === undefined || all(x.targets,str)))
        || !all(d.channels,x => x && str(x.name))) throw Error('Invalid Swarm snapshot');
      return d;
    }
    function Graph({messages,t}) {
      const [pos,setPos]=React.useState(null), max=messages.at(-1)?.seq??0, min=messages[0]?.seq??0, seq=Math.max(min,Math.min(pos??max,max));
      const edges=new Map(); for(const m of messages) if(m.seq<=seq) for(const target of new Set(m.targets??[])) {
        const key=JSON.stringify([m.author,target]), old=edges.get(key); edges.set(key,{from:m.author,to:target,n:(old?.n??0)+1});
      }
      const rows=[...edges.values()];
      // Keep the graphic legible; the accessible edge list below is not truncated.
      const names=[...new Set(rows.flatMap(e=>[e.from,e.to]))].slice(0,12), points=new Map(names.map((name,i)=>{
        const angle=2*Math.PI*i/names.length-Math.PI/2;return [name,[130+87*Math.cos(angle),100+65*Math.sin(angle)]];
      }));
      const diagram=names.length>0&&h('svg',{viewBox:'0 0 260 200',width:'100%',role:'img','aria-label':t('edges')},
        rows.filter(e=>points.has(e.from)&&points.has(e.to)&&e.from!==e.to).map(e=>{
          const [x,y]=points.get(e.from),[u,v]=points.get(e.to),dx=u-x,dy=v-y,len=Math.hypot(dx,dy),tipX=u-7*dx/len,tipY=v-7*dy/len;
          return h('g',{key:JSON.stringify([e.from,e.to]),stroke:'currentColor',opacity:0.65},h('line',{x1:x,y1:y,x2:tipX,y2:tipY}),
            h('path',{fill:'currentColor',d:`M${tipX} ${tipY}l${(-5*dx-2.5*dy)/len} ${(-5*dy+2.5*dx)/len}l${5*dy/len} ${-5*dx/len}z`}));
        }), names.map(name=>{const [x,y]=points.get(name);return h('g',{key:name},h('title',null,name),h('circle',{cx:x,cy:y,r:4,fill:'currentColor'}),h('text',{x,y:y+13,textAnchor:'middle',fill:'currentColor',fontSize:8},name.length>12?name.slice(0,12)+'…':name));}));
      return h('section',null,h('p',null,t('edges')),diagram,h('label',null,t('cutoff'),' #',seq,' ',h('input',{type:'range',min,max,value:seq,onChange:e=>setPos(Number(e.target.value)),disabled:min===max})),
        list(rows,({from,to,n})=>h('li',{key:JSON.stringify([from,to])},from,' → ',to,' ×',n),t));
    }
    function Snapshot({loadBoard,t}) {
      const [data,setData]=React.useState(null),[error,setError]=React.useState(''),[busy,setBusy]=React.useState(false),[page,choose]=React.useState('overview'),[channel,setChannel]=React.useState('');
      const mounted=React.useRef(false),lock=React.useRef(false);
      React.useEffect(()=>{mounted.current=true; return ()=>{mounted.current=false;};},[]);
      async function refresh(){ if(lock.current)return; lock.current=true; setBusy(true); setError(''); try{const next=await loadBoard();if(mounted.current)setData(next);}catch(e){if(mounted.current)setError(String(e?.message??e));}finally{lock.current=false;if(mounted.current)setBusy(false);} }
      const content=!data?h('p',null,t('start')):page==='overview'?h('section',null,
        h('strong',null,data.title),h('p',null,`${data.counts.members} ${t('count')} · ${data.counts.active} ${t('active')} · #${data.seq}`),
        data.plan&&h(React.Fragment,null,h('h4',null,t('goal')),h('p',null,data.plan.goal),h('h4',null,t('tasks')),list(data.plan.tasks,x=>h('li',{key:x.id},x.title,' · ',x.status,x.owner?` · @${x.owner}`:''),t),h('h4',null,t('threads')),list(data.plan.threads,x=>h('li',{key:x.id},'#',x.channel,' · ',x.goal),t))):
        page==='members'?list(data.members,m=>h('li',{key:m.name},h('strong',null,m.name),' · ',m.role,' · ',m.status,` · ${m.unread} ${t('unread')} · #${m.lastSeq}`),t):
        page==='graph'?h(Graph,{messages:data.messages,t}):h('section',null,h('p',null,t('window')),h('label',null,t('channel'),' ',h('select',{value:channel,onChange:e=>setChannel(e.target.value)},h('option',{value:''},t('all')),[...new Set([...data.channels.map(c=>c.name),...data.messages.map(m=>m.channel)])].map(c=>h('option',{key:c,value:c},'#'+c)))),
        list(data.messages.filter(m=>!channel||m.channel===channel),m=>h('li',{key:m.seq},h('strong',null,`#${m.seq} ${m.author}`),' · #',m.channel,h('div',{style:{whiteSpace:'pre-wrap'}},m.text)),t));
      return h('div',{style:box},h('header',null,h('strong',null,t('title')),data?` · #${data.seq}`:''),'',h('button',{type:'button',disabled:busy,onClick:refresh},t(busy?'loading':'refresh')),
        error&&h('p',{role:'alert'},error),h('nav',{'aria-label':t('title'),style:{display:'flex',flexWrap:'wrap',gap:4}},pages.map(p=>h('button',{key:p,type:'button','aria-pressed':p===page,onClick:()=>choose(p)},t(p)))),content);
    }
    // Keyed by owner session: a late response to an unmounted tab cannot populate the next one.
    function Body(props){return h(Snapshot,{key:props.sessionId,...props});}
    return {inject:['slots','remote','remote.commands','locale','sidebarRightTabs'],apply(ctx){
      ctx.effect(()=>ctx.locale.register(ns,dictionaries)); const t=ctx.locale.bind(ns);
      ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind:'swarm-board',title:()=>t('title'),guide:[{id:'board',order:80,title:()=>t('title'),description:()=>t('guide')}]}));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:id,locale:ns,inject:sessionId=>({async loadBoard(){
        const res=await ctx.remote.commands.execute(sessionId,'/swarm view',[]); if(!res.ok)throw Error(res.error?.message??'Swarm transport error');
        const out=res.value?.result; if(out?.kind!=='success')throw Error(out?.text??'Swarm command unavailable');
        return parseSnapshot(out.text);
      }})},Body));
    }};
  },
});
