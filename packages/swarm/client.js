window.__ModuleLoader__.load({
  id: '@local/dk-dsh-swarm',
  factory(require) {
    const React = require('react'), h = React.createElement;
    const id = '@local/dk-dsh-swarm', ns = 'dkSwarm', pages = ['overview','board','members','graph'];
    const dictionaries = {
      en: { title:'Swarm board', guide:'Messages, members and directed mentions in this session.', live:'Live', refresh:'Refresh now', loading:'Reading…', retry:'Retry now', retrying:'Could not refresh. Retrying automatically.', unavailable:'Live view unavailable. Use /swarm view in the local root session.', start:'Boards are shown in their root session. Switch back to the root session; if it has no board, run /swarm init.', overview:'Overview', board:'Board', members:'Members', graph:'Mention graph', all:'All channels', empty:'Nothing in this snapshot.', seq:'Snapshot', goal:'Goal', tasks:'Tasks', threads:'Threads', unread:'unread', cutoff:'Through message', edges:'Directed mentions in the displayed message window', active:'active', count:'members', channel:'Channel', window:'Latest messages in this snapshot'},
      zh: { title:'Swarm 黑板', guide:'查看本会话的消息、成员及定向呼唤。', live:'实时', refresh:'立即刷新', loading:'读取中…', retry:'立即重试', retrying:'刷新失败，将自动重试。', unavailable:'实时视图不可用。可在本机根会话使用 /swarm view。', start:'此面板只显示根会话的黑板。若在子会话请切回根会话；尚未建板可运行 /swarm init。', overview:'概览', board:'黑板', members:'成员', graph:'呼唤关系', all:'所有频道', empty:'当前快照暂无记录。', seq:'快照', goal:'目标', tasks:'任务', threads:'讨论线', unread:'未读', cutoff:'截至消息', edges:'当前消息窗口内的定向呼唤', active:'活跃', count:'成员', channel:'频道', window:'当前快照中的近期消息'},
    };
    const box = {padding:'0.8rem',display:'grid',alignContent:'start',gap:'0.7rem',height:'100%',overflow:'auto',boxSizing:'border-box',overflowWrap:'anywhere'};
    function list(rows, render, t) { return rows.length?h('ul',{style:{paddingInlineStart:'1.3em',margin:0}},rows.map(render)):h('p',null,t('empty')); }
    // Validate the wire shape before placing it in React state. A stale Host must
    // produce a recoverable error rather than breaking the entire sidebar tab.
    const count = x => Number.isSafeInteger(x) && x >= 0;
    function validateView(d) {
      const str = x => typeof x === 'string';
      const all = (xs, predicate) => Array.isArray(xs) && xs.every(predicate);
      const p = d?.plan;
      if (d?.v !== 1 || !str(d.title) || !count(d.seq)
        || !['members','active','messages','channels'].every(k => count(d.counts?.[k]))
        || !(p === null || (p && str(p.goal) && all(p.tasks,x => x && str(x.id) && str(x.title) && str(x.status) && (!x.owner || str(x.owner))) && all(p.threads,x => x && str(x.id) && str(x.channel) && str(x.goal))))
        || !all(d.members,x => x && str(x.name) && str(x.role) && str(x.status) && count(x.unread) && count(x.lastSeq))
        || !all(d.messages,x => x && count(x.seq) && str(x.author) && str(x.channel) && str(x.text) && (x.targets === undefined || all(x.targets,str)))
        || !all(d.channels,x => x && str(x.name))
        || d.messages.length > 30 || d.messages.some((m,i) => m.seq > d.seq || (i > 0 && m.seq <= d.messages[i-1].seq))
        || JSON.stringify(d).length > 12000) throw Error('Invalid Swarm snapshot');
      return d;
    }
    function nextView(reply, cursor, prior) {
      if (reply?.kind === 'empty') return null;
      if (typeof reply?.etag !== 'string' || !reply.etag || reply.etag.length > 256) throw Error('Invalid Swarm response');
      if (reply.kind === 'snapshot') return validateView(reply.view);
      if (reply.kind === 'unchanged' && cursor && reply.etag === cursor.etag) return prior;
      if (reply.kind !== 'delta' || !cursor || reply.baseEtag !== cursor.etag) throw Error('Invalid Swarm cursor');
      const view = validateView(reply.view), first = reply.firstSeq;
      if (view.seq < cursor.since || !(first === null || count(first))
        || view.messages.some(m => m.seq <= cursor.since || first === null || m.seq < first)) throw Error('Invalid Swarm delta');
      const messages = first === null ? [] : prior.messages.filter(m => m.seq >= first).concat(view.messages);
      if (first !== null && messages[0]?.seq !== first) throw Error('Incomplete Swarm delta');
      return validateView({...view, messages});
    }

    // One owner, one request at a time. Only visible successful reads advance the cursor.
    const initial = {data:null, status:'loading', error:''};
    function watchBoard(loadBoard, publish) {
      let shown = initial, cursor = null, failures = 0, stopped = false, request = null, timer;
      let hidden = document.hidden, visibilityEpoch = 0, wakePending = false, deadline;
      function update(data, status, error = '') {
        if (shown.data !== data || shown.status !== status || shown.error !== error) {
          shown = {data, status, error};
          publish(shown);
        }
      }
      function schedule() {
        clearTimeout(timer);
        if (stopped || request || shown.status === 'unavailable' || (document.hidden && !shown.data)) return;
        const delay = document.hidden ? 60000 : failures ? Math.min(60000, 3000 * 2 ** (failures-1)) : shown.data ? 1500 : 3000;
        timer = setTimeout(read, delay);
      }
      async function read(manual = false) {
        if (stopped || request || (document.hidden && !shown.data) || (!manual && shown.status === 'unavailable')) return;
        clearTimeout(timer);
        request = new AbortController();
        const {signal} = request, probe = document.hidden, epoch = visibilityEpoch;
        deadline = setTimeout(() => request.abort(new Error('Swarm request timed out')), 15000);
        const current = () => !stopped && !probe && !document.hidden && epoch === visibilityEpoch;
        if (manual && !probe) update(shown.data, 'loading');
        try {
          let reply = await loadBoard(cursor, signal);
          if (!current()) return;
          let data;
          try {
            data = nextView(reply, cursor, shown.data);
          } catch (err) {
            // Never use an unmergeable patch as a snapshot. Recover once, without a cursor.
            if (!['delta','unchanged'].includes(reply?.kind)) throw err;
            cursor = null;
            reply = await loadBoard(null, signal);
            if (!current()) return;
            data = nextView(reply, null, shown.data);
          }
          cursor = data ? {etag:reply.etag, since:data.seq} : null;
          failures = 0;
          update(data, data ? 'ready' : 'empty');
        } catch (err) {
          const reason = String(err?.message ?? err);
          if (!stopped && (['swarm/forbidden','swarm/bad-request'].includes(err?.code) || [400,401,403,404].includes(err?.status))) {
            // A denied read revokes the old view, even when the document is hidden.
            cursor = null;
            update(null, 'unavailable', reason);
          } else if (current()) {
            failures++;
            update(shown.data, 'error', reason);
          }
        } finally {
          clearTimeout(deadline);
          request = null;
          if (!stopped && wakePending && !document.hidden) {
            wakePending = false;
            void read();
          } else schedule();
        }
      }
      function onVisibility() {
        if (hidden === document.hidden) return;
        hidden = document.hidden;
        visibilityEpoch++;
        wakePending = !hidden && !!request;
        if (hidden) schedule();
        else if (request) request.abort(); // finally starts a fresh visible read, never in parallel
        else void read();
      }
      document.addEventListener('visibilitychange', onVisibility);
      void read();
      return {refresh:() => read(true), stop() {
        stopped = true; clearTimeout(timer); clearTimeout(deadline); request?.abort();
        document.removeEventListener('visibilitychange', onVisibility);
      }};
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
      const [{data,status,error},setView]=React.useState(initial),[page,choose]=React.useState('overview'),[channel,setChannel]=React.useState('');
      const watcher=React.useRef(null);
      React.useEffect(()=>{
        const owner=watchBoard(loadBoard,setView);
        watcher.current=owner;
        return ()=>{owner.stop(); watcher.current=null;};
      },[loadBoard]);
      const channels=data?[...new Set([...data.channels.map(c=>c.name),...data.messages.map(m=>m.channel)])]:[];
      const filter=channels.includes(channel)?channel:'';
      const content=!data?(status==='empty'?h('p',null,t('start')):null):page==='overview'?h('section',null,
        h('strong',null,data.title),h('p',null,`${data.counts.members} ${t('count')} · ${data.counts.active} ${t('active')} · #${data.seq}`),
        data.plan&&h(React.Fragment,null,h('h4',null,t('goal')),h('p',null,data.plan.goal),h('h4',null,t('tasks')),list(data.plan.tasks,x=>h('li',{key:x.id},x.title,' · ',x.status,x.owner?` · @${x.owner}`:''),t),h('h4',null,t('threads')),list(data.plan.threads,x=>h('li',{key:x.id},'#',x.channel,' · ',x.goal),t))):
        page==='members'?list(data.members,m=>h('li',{key:m.name},h('strong',null,m.name),' · ',m.role,' · ',m.status,` · ${m.unread} ${t('unread')} · #${m.lastSeq}`),t):
        page==='graph'?h(Graph,{messages:data.messages,t}):h('section',null,h('p',null,t('window')),h('label',null,t('channel'),' ',h('select',{value:filter,onChange:e=>setChannel(e.target.value)},h('option',{value:''},t('all')),channels.map(c=>h('option',{key:c,value:c},'#'+c)))),
        list(data.messages.filter(m=>!filter||m.channel===filter),m=>h('li',{key:m.seq},h('strong',null,`#${m.seq} ${m.author}`),' · #',m.channel,h('div',{style:{whiteSpace:'pre-wrap'}},m.text)),t));
      const busy=status==='loading', failed=status==='error'||status==='unavailable';
      return h('div',{style:box},h('header',null,h('strong',null,t('title')),data?` · #${data.seq}`:'',status==='ready'?h('small',null,' · ',t('live')):null),
        h('button',{type:'button',disabled:busy,onClick:()=>watcher.current?.refresh()},t(busy?'loading':failed?'retry':'refresh')),
        failed&&h('p',{role:'alert'},t(status==='unavailable'?'unavailable':'retrying'),' ',error),h('nav',{'aria-label':t('title'),style:{display:'flex',flexWrap:'wrap',gap:4}},pages.map(p=>h('button',{key:p,type:'button','aria-pressed':p===page,onClick:()=>choose(p)},t(p)))),content);
    }
    // The slot inject callback receives the owning session, including in a floating pane.
    function Body(props){return h(Snapshot,{...props,key:props.boardOwner});}
    function bindBoard(sessionId) {
      return {boardOwner:sessionId, async loadBoard(cursor,signal) {
        const response = await fetch('api/dk-swarm/liveView', {method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({sessionId,cursor}), signal});
        if (!response.ok) throw Object.assign(Error(`Swarm transport: HTTP ${response.status}`), {status:response.status});
        const result = await response.json();
        if (result?.ok !== true) throw Object.assign(Error(result?.error?.message ?? 'Swarm transport error'), {code:result?.error?.code});
        return result.value;
      }};
    }
    return {inject:['slots','locale','sidebarRightTabs'],apply(ctx){
      ctx.effect(()=>ctx.locale.register(ns,dictionaries)); const t=ctx.locale.bind(ns);
      ctx.effect(()=>ctx.sidebarRightTabs.register({id,kind:'swarm-board',title:()=>t('title'),guide:[{id:'board',order:80,title:()=>t('title'),description:()=>t('guide')}]}));
      ctx.slots.inject('sidebar.right.pane.tab',()=>ctx.slots.register({name:'sidebar.right.pane.tab',key:id,locale:ns,inject:bindBoard},Body));
    }};
  },
});
