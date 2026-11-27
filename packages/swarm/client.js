window.__ModuleLoader__.load({
  id: '@local/dk-dsh-swarm',
  factory(require) {
    const React = require('react'), h = React.createElement;
    // The shared model menu control is the app's own primitives. Fall back to
    // the local control only for hosts and tests that do not expose it.
    const primitives = (() => { try { return require('@deepseek-ai/dsh-client-ui-primitives') ?? null; } catch { return null; } })();
    const ns = 'dkSwarm', pages = ['overview','board','members','graph','options'];
    const dictionaries = {
      en: { title:'Swarm board', helm:'Helm', guide:'Messages, members and directed mentions in this session.', live:'Live', refresh:'Refresh now', loading:'Reading…', retry:'Retry now', retrying:'Could not refresh. Retrying automatically.', unavailable:'Live view unavailable. Use /swarm view in the local root session.', start:'Boards are shown in their root session. Switch back to the root session; if it has no board, run /swarm init.', overview:'Overview', board:'Board', members:'Members', graph:'Mention graph', all:'All channels', empty:'Nothing in this snapshot.', seq:'Snapshot', goal:'Goal', tasks:'Tasks', threads:'Threads', unread:'unread', cutoff:'Through message', edges:'Directed mentions in the displayed message window', active:'active', count:'members', channel:'Channel', window:'Latest messages in this snapshot', swarm:'Swarm', swarmHint:'Expose this session’s Swarm tools and reminders only while on.', swarmFailed:'Could not change Swarm mode.'},
      zh: { title:'Swarm 黑板', helm:'Helm', guide:'查看本会话的消息、成员及定向呼唤。', live:'实时', refresh:'立即刷新', loading:'读取中…', retry:'立即重试', retrying:'刷新失败，将自动重试。', unavailable:'实时视图不可用。可在本机根会话使用 /swarm view。', start:'此面板只显示根会话的黑板。若在子会话请切回根会话；尚未建板可运行 /swarm init。', overview:'概览', board:'黑板', members:'成员', graph:'呼唤关系', all:'所有频道', empty:'当前快照暂无记录。', seq:'快照', goal:'目标', tasks:'任务', threads:'讨论线', unread:'未读', cutoff:'截至消息', edges:'当前消息窗口内的定向呼唤', active:'活跃', count:'成员', channel:'频道', window:'当前快照中的近期消息', swarm:'Swarm', swarmHint:'开启后才会向本会话注入 Swarm 工具和提醒。', swarmFailed:'无法切换 Swarm 开关。'},
    };
    Object.assign(dictionaries.en, {
      modelOptions:'Model candidates', options:'Model candidates', candidatePool:'Candidate pool',
      manualInvalid:'Provider and model are required.', manualDuplicate:'That route is already selected.', added:'Added.',
      modelOptionsHint:'Pick the routes the Helm panel offers to the Swarm lead. This list is a candidate pool, not an authorization; dispatch still checks this Session\'s subagent model policy.',
      modelOptionsEmpty:'No candidates yet. Leave empty to use every model this Session may already use.',
      searchModels:'Search models or providers', manualRoute:'Route not in the catalog? Add manually',
      provider:'Provider', model:'Model', addRoute:'Add', saveOptions:'Save candidates',
      save:'Save', saving:'Saving…', discard:'Discard changes', saved:'Saved',
      saveFailed:'Could not save model options.', catalogFailed:'Could not load the model catalog.',
      unavailableSaved:'Saved but currently unavailable',
      unavailableHint:'The catalog does not list this route; the provider may be missing or signed out.',
      maxOptions:'At most 16 routes.', selected:'selected', noMatch:'No model matches the search.',
      reloadOptions:'Reload', unsaved:'Unsaved changes',
    });
    Object.assign(dictionaries.zh, {
      modelOptions:'模型候选', options:'模型候选', candidatePool:'候选池',
      manualInvalid:'Provider 和 Model 都不能为空。', manualDuplicate:'这条路由已经选中。', added:'已添加。',
      modelOptionsHint:'选择 Helm 提供给 Swarm lead 的候选路由。它只是候选清单，不是授权；实际派发仍按本 Session 的子智能体模型策略校验。',
      modelOptionsEmpty:'还没有候选。留空表示使用本 Session 已经可以使用的全部模型。',
      searchModels:'搜索模型或 provider', manualRoute:'目录里没有？手动添加路由',
      provider:'Provider', model:'Model', addRoute:'添加', saveOptions:'保存候选',
      save:'保存', saving:'保存中…', discard:'放弃更改', saved:'已保存',
      saveFailed:'模型候选保存失败。', catalogFailed:'模型目录加载失败。',
      unavailableSaved:'已保存但当前不可用',
      unavailableHint:'目录中没有这条路由，可能是 provider 未安装或未登录。',
      maxOptions:'最多 16 条路由。', selected:'已选', noMatch:'没有匹配的模型。',
      reloadOptions:'重新加载', unsaved:'有未保存的更改',
    });
    const helmCss = `
.dk-helm{display:flex;height:100%;min-height:0;background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,inherit);overflow-wrap:anywhere}
.dk-helm-nav{width:208px;flex:none;display:flex;flex-direction:column;gap:2px;padding:16px 12px;border-right:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));overflow:auto;box-sizing:border-box}
.dk-helm-brand{font-size:15px;line-height:22px;font-weight:600;padding:0 8px 10px;letter-spacing:.01em}
.dk-helm-group{padding:8px 8px 4px;font-size:11px;line-height:16px;letter-spacing:.08em;text-transform:uppercase;color:var(--dsw-alias-label-caption,#888)}
.dk-helm-navbtn{appearance:none;border:0;background:transparent;color:inherit;text-align:left;font:inherit;font-size:13px;line-height:20px;padding:7px 8px;border-radius:8px;cursor:pointer}
.dk-helm-navbtn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dk-helm-navbtn[aria-current="page"]{background:var(--dsw-alias-interactive-bg-selected,rgba(47,124,246,.14));font-weight:500}
.dk-helm-main{flex:1;min-width:0;overflow:auto;padding:24px clamp(16px,4vw,40px);box-sizing:border-box}
.dk-helm-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:18px;max-width:980px}
.dk-helm-title{margin:0;font-size:18px;line-height:26px;font-weight:600}
.dk-helm-sub{margin:4px 0 0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-btn{appearance:none;flex:none;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));background:var(--dsw-alias-bg-elevated,transparent);color:inherit;font:inherit;font-size:13px;line-height:20px;padding:5px 10px;border-radius:8px;cursor:pointer}
.dk-helm-btn:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.1))}
.dk-helm-btn:disabled{cursor:default;opacity:.55}
.dk-helm-card{max-width:980px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));border-radius:10px;padding:16px;background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.03));box-sizing:border-box}
.dk-helm-card+.dk-helm-card{margin-top:12px}
.dk-helm-cardtitle{margin:0 0 8px;font-size:15px;line-height:22px;font-weight:600}
.dk-helm-stats{margin:0 0 10px;font-size:12px;line-height:18px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-muted{color:var(--dsw-alias-label-caption,#888)}
.dk-helm-error{max-width:980px;margin:0 0 12px;font-size:12px;line-height:18px;color:var(--dsw-alias-state-error-primary,#c33)}
.dk-helm-empty{max-width:980px;padding:24px;border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.3));border-radius:10px;color:var(--dsw-alias-label-secondary,#777);font-size:13px;line-height:20px}
.dk-helm-filter{display:inline-flex;align-items:center;gap:6px;margin:0 0 10px;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-filter select{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:6px;padding:2px 6px}
.dk-helm-pre{white-space:pre-wrap}
.dk-helm-list{padding-inline-start:1.25em;margin:8px 0 0}
.dk-helm-list li{margin:6px 0;line-height:1.55}
.dk-helm-opt-toolbar{display:flex;flex-wrap:wrap;align-items:center;gap:8px;margin:0 0 12px}
.dk-helm-opt-toolbar input{flex:1 1 220px;min-width:0;font:inherit;font-size:13px;padding:7px 10px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:8px;background:transparent;color:inherit}
.dk-helm-opt-count{font-size:12px;color:var(--dsw-alias-label-secondary,#777);white-space:nowrap}
.dk-helm-opt-group{border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));border-radius:10px;margin:0 0 10px;overflow:hidden}
.dk-helm-opt-head{display:flex;align-items:baseline;justify-content:space-between;gap:8px;padding:10px 12px;background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.04));font-size:13px}
.dk-helm-opt-head strong{font-weight:600}
.dk-helm-opt-head span{font-size:11px;color:var(--dsw-alias-label-caption,#888)}
.dk-helm-opt-row{display:flex;align-items:flex-start;gap:9px;padding:10px 12px;border-top:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.12));cursor:pointer}
.dk-helm-opt-row:hover{background:var(--dsw-alias-interactive-bg-hover,rgba(127,127,127,.06))}
.dk-helm-opt-row input{margin:3px 0 0;flex:none;accent-color:var(--dsw-alias-state-accent-primary,#2f7cf6)}
.dk-helm-opt-body{min-width:0;display:flex;flex-direction:column;gap:2px}
.dk-helm-opt-name{font-size:13px;line-height:19px;font-weight:500}
.dk-helm-opt-meta{font-size:11px;line-height:17px;color:var(--dsw-alias-label-secondary,#777);overflow-wrap:anywhere}
.dk-helm-opt-desc{font-size:12px;line-height:18px;color:var(--dsw-alias-label-caption,#888)}
.dk-helm-opt-warn{border-color:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b26a00) 42%,transparent)}
.dk-helm-opt-warn .dk-helm-opt-head{background:color-mix(in srgb,var(--dsw-alias-state-warning-primary,#b26a00) 9%,transparent)}
.dk-helm-opt-manual{border:1px dashed var(--dsw-alias-border-secondary,rgba(127,127,127,.3));border-radius:10px;padding:10px 12px;margin:0 0 12px}
.dk-helm-opt-manual summary{cursor:pointer;font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-opt-manualrow{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px;margin-top:10px}
.dk-helm-opt-manualrow label{display:flex;flex-direction:column;gap:3px;font-size:11px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-opt-manualrow input{font:inherit;font-size:13px;padding:6px 8px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.28));border-radius:7px;background:transparent;color:inherit;min-width:0}
.dk-helm-opt-bar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;max-width:980px;margin-top:14px;padding:10px 12px;border:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));border-radius:10px;background:var(--dsw-alias-bg-elevated,rgba(127,127,127,.04))}
.dk-helm-opt-bar span{font-size:12px;color:var(--dsw-alias-label-secondary,#777)}
.dk-helm-opt-actions{display:flex;gap:8px}
.dk-helm-opt-notice{font-size:12px;color:var(--dsw-alias-state-success-primary,#1f8a4c)}
@media (max-width:720px){
.dk-helm{flex-direction:column}
.dk-helm-nav{width:auto;flex-direction:row;flex-wrap:wrap;align-items:center;border-right:0;border-bottom:1px solid var(--dsw-alias-border-secondary,rgba(127,127,127,.18));padding:10px 12px}
.dk-helm-brand{padding:0 8px}
.dk-helm-group{padding:0 4px}
.dk-helm-main{padding:16px}
.dk-helm-opt-row{padding:10px}
.dk-helm-opt-bar{align-items:stretch}
.dk-helm-opt-actions{justify-content:flex-end}
}
`;
    function list(rows, render, t) { return rows.length?h('ul',{className:'dk-helm-list'},rows.map(render)):h('p',null,t('empty')); }
    // Validate the wire shape before placing it in React state. A stale Host must
    // produce a recoverable error rather than breaking the entire Helm view.
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
    const routeKey = route => `${route.provider}/${route.model}`;
    function sameRouteList(left, right) {
      if (left.length !== right.length) return false;
      const keys = new Set(left.map(routeKey));
      return right.every(route => keys.has(routeKey(route)));
    }
    function ModelOptionsPage({t, modelCatalog}) {
      const [saved, setSaved] = React.useState([]);
      const [draft, setDraft] = React.useState([]);
      const [groups, setGroups] = React.useState([]);
      const [status, setStatus] = React.useState('loading');
      const [error, setError] = React.useState('');
      const [query, setQuery] = React.useState('');
      const [manual, setManual] = React.useState({provider:'', model:''});
      const [saving, setSaving] = React.useState(false);
      const [notice, setNotice] = React.useState('');
      const load = React.useCallback(async () => {
        setStatus('loading'); setError(''); setNotice('');
        try {
          if (typeof modelCatalog !== 'function') throw Error('model catalog unavailable');
          const [reply, catalog] = await Promise.all([
            fetch('api/dk-swarm/model-options', {headers:{accept:'application/json'}}),
            modelCatalog(),
          ]);
          const body = await reply.json().catch(() => null);
          if (!reply.ok || body?.ok !== true) throw Error(body?.error?.message ?? `HTTP ${reply.status}`);
          if (!catalog?.ok) throw Error(catalog?.error?.message ?? 'model catalog unavailable');
          const options = Array.isArray(body.value?.options) ? body.value.options : [];
          setSaved(options); setDraft(options);
          setGroups(Array.isArray(catalog.value?.groups) ? catalog.value.groups : []);
          setStatus('ready');
        } catch (err) { setStatus('error'); setError(String(err?.message ?? err)); }
      }, [modelCatalog]);
      React.useEffect(() => { void load(); }, [load]);
      const safeGroups = groups.filter(g => g && typeof g.id === 'string' && Array.isArray(g.models));
      const known = React.useMemo(() => {
        const routes = new Set();
        for (const group of safeGroups) for (const model of group.models) routes.add(`${group.id}/${model.id}`);
        return routes;
      }, [groups]);
      const unavailable = draft.filter(route => !known.has(routeKey(route)));
      const dirty = !sameRouteList(draft, saved);
      const needle = query.trim().toLowerCase();
      const filtered = safeGroups.map(group => ({
        ...group,
        models: group.models.filter(model => !needle
          || `${group.name ?? ''} ${group.id} ${model.name ?? ''} ${model.id}`.toLowerCase().includes(needle)),
      })).filter(group => group.models.length > 0);
      const countFor = provider => draft.filter(route => route.provider === provider).length;
      const toggle = (provider, model) => {
        setNotice('');
        const exists = draft.some(route => route.provider === provider && route.model === model);
        if (!exists && draft.length >= 16) { setNotice(t('maxOptions')); return; }
        setDraft(previous => exists
          ? previous.filter(route => !(route.provider === provider && route.model === model))
          : [...previous, {provider, model}]);
      };
      const addManual = () => {
        const provider = manual.provider.trim(), model = manual.model.trim();
        if (!provider || !model) { setNotice(t('manualInvalid')); return; }
        if (draft.some(route => route.provider === provider && route.model === model)) { setNotice(t('manualDuplicate')); return; }
        if (draft.length >= 16) { setNotice(t('maxOptions')); return; }
        setDraft(previous => [...previous, {provider, model}]);
        setManual({provider:'', model:''}); setNotice(t('added'));
      };
      const save = async () => {
        setSaving(true); setError(''); setNotice('');
        try {
          const reply = await fetch('api/dk-swarm/model-options', {method:'POST',
            headers:{'content-type':'application/json', accept:'application/json'}, body:JSON.stringify({options:draft})});
          const body = await reply.json().catch(() => null);
          if (!reply.ok || body?.ok !== true) throw Error(body?.error?.message ?? `HTTP ${reply.status}`);
          const options = Array.isArray(body.value?.options) ? body.value.options : [];
          setSaved(options); setDraft(options); setNotice(t('saved'));
        } catch (err) { setError(String(err?.message ?? err)); }
        finally { setSaving(false); }
      };
      const row = (provider, model, name, meta, description) => {
        const checked = draft.some(route => route.provider === provider && route.model === model);
        return h('label', {className:'dk-helm-opt-row', key:`${provider}/${model}`},
          h('input', {type:'checkbox', checked, onChange:() => toggle(provider, model)}),
          h('span', {className:'dk-helm-opt-body'},
            h('span', {className:'dk-helm-opt-name'}, name),
            h('span', {className:'dk-helm-opt-meta'}, meta),
            description && h('span', {className:'dk-helm-opt-desc'}, description)));
      };
      return h('section', {className:'dk-helm-card'},
        h('div', {className:'dk-helm-opt-toolbar'},
          h('input', {type:'search', value:query, placeholder:t('searchModels'), 'aria-label':t('searchModels'), onChange:e => setQuery(e.target.value)}),
          h('span', {className:'dk-helm-opt-count'}, `${draft.length} / 16 ${t('selected')}`),
          h('button', {type:'button', className:'dk-helm-btn', disabled:status === 'loading', onClick:() => { void load(); }}, t('reloadOptions'))),
        h('p', {className:'dk-helm-muted'}, t('modelOptionsHint')),
        status === 'loading' && h('p', {className:'dk-helm-empty'}, t('loading')),
        error && h('p', {role:'alert', className:'dk-helm-error'}, error),
        notice && h('p', {className:'dk-helm-opt-notice', role:'status'}, notice),
        status === 'ready' && h(React.Fragment, null,
          draft.length === 0 && safeGroups.length === 0 && h('p', {className:'dk-helm-muted'}, t('modelOptionsEmpty')),
          unavailable.length > 0 && h('section', {className:'dk-helm-opt-group dk-helm-opt-warn'},
            h('div', {className:'dk-helm-opt-head'}, h('strong', null, t('unavailableSaved')), h('span', null, String(unavailable.length))),
            unavailable.map(route => row(route.provider, route.model, route.model,
              `${route.provider}/${route.model} · ${t('unavailableHint')}`))),
          filtered.map(group => h('section', {className:'dk-helm-opt-group', key:group.id},
            h('div', {className:'dk-helm-opt-head'},
              h('strong', null, group.name ?? group.id),
              h('span', null, `${group.id} · ${countFor(group.id)}/${group.models.length} ${t('selected')}`)),
            group.models.map(model => row(group.id, model.id, model.name ?? model.id,
              `${group.name ?? group.id} · ${group.id}/${model.id}`, model.description)))),
          filtered.length === 0 && needle && h('p', {className:'dk-helm-empty'}, t('noMatch')),
          h('details', {className:'dk-helm-opt-manual'},
            h('summary', null, t('manualRoute')),
            h('div', {className:'dk-helm-opt-manualrow'},
              h('label', null, t('provider'), h('input', {value:manual.provider, onChange:e => setManual({...manual, provider:e.target.value})})),
              h('label', null, t('model'), h('input', {value:manual.model, onChange:e => setManual({...manual, model:e.target.value})})),
              h('button', {type:'button', className:'dk-helm-btn', disabled:!manual.provider.trim() || !manual.model.trim(), onClick:addManual}, t('addRoute')))),
          h('div', {className:'dk-helm-opt-bar'},
            h('span', null, dirty ? t('unsaved') : t('saved')),
            h('div', {className:'dk-helm-opt-actions'},
              h('button', {type:'button', className:'dk-helm-btn', disabled:!dirty || saving, onClick:() => { setDraft(saved); setNotice(''); }}, t('discard')),
              h('button', {type:'button', className:'dk-helm-btn', disabled:!dirty || saving, onClick:() => { void save(); }}, t(saving ? 'saving' : 'save'))))));
    }
    function HelmView({loadBoard, boardOwner, t, modelCatalog}) {
      const [{data,status,error},setView]=React.useState(initial);
      const [page,choose]=React.useState('overview');
      const [channel,setChannel]=React.useState('');
      const watcher=React.useRef(null);
      React.useEffect(()=>{
        const owner=watchBoard(loadBoard,setView);
        watcher.current=owner;
        return ()=>{owner.stop(); watcher.current=null;};
      },[loadBoard]);
      const channels=data?[...new Set([...data.channels.map(c=>c.name),...data.messages.map(m=>m.channel)])]:[];
      const filter=channels.includes(channel)?channel:'';
      const busy=status==='loading', failed=status==='error'||status==='unavailable';
      let content=null;
      if(page==='options') content=h(ModelOptionsPage,{t,modelCatalog});
      else if(!data) {
        if(status==='empty') content=h('p',{className:'dk-helm-empty'},t('start'));
      } else if(page==='overview') content=h('section',{className:'dk-helm-card'},
        h('h3',{className:'dk-helm-cardtitle'},data.title),
        h('p',{className:'dk-helm-stats'},`${data.counts.members} ${t('count')} · ${data.counts.active} ${t('active')} · #${data.seq}`),
        data.plan&&h(React.Fragment,null,
          h('h4',null,t('goal')),h('p',null,data.plan.goal),
          h('h4',null,t('tasks')),list(data.plan.tasks,x=>h('li',{key:x.id},x.title,' · ',x.status,x.owner?` · @${x.owner}`:''),t),
          h('h4',null,t('threads')),list(data.plan.threads,x=>h('li',{key:x.id},'#',x.channel,' · ',x.goal),t)));
      else if(page==='members') content=h('section',{className:'dk-helm-card'},
        h('h3',{className:'dk-helm-cardtitle'},t('members')),
        list(data.members,m=>h('li',{key:m.name},h('strong',null,m.name),' · ',m.role,' · ',m.status,` · ${m.unread} ${t('unread')} · #${m.lastSeq}`),t));
      else if(page==='graph') content=h('section',{className:'dk-helm-card'},h(Graph,{messages:data.messages,t}));
      else content=h('section',{className:'dk-helm-card'},
        h('p',{className:'dk-helm-muted'},t('window')),
        h('label',{className:'dk-helm-filter'},t('channel'),' ',
          h('select',{value:filter,onChange:e=>setChannel(e.target.value)},
            h('option',{value:''},t('all')),
            channels.map(c=>h('option',{key:c,value:c},'#'+c)))),
        list(data.messages.filter(m=>!filter||m.channel===filter),
          m=>h('li',{key:m.seq},h('strong',null,`#${m.seq} ${m.author}`),' · #',m.channel,
            h('div',{className:'dk-helm-pre'},m.text)),t));
      return h('div',{className:'dk-helm'},
        h('nav',{className:'dk-helm-nav','aria-label':t('helm')},
          h('div',{className:'dk-helm-brand'},t('helm')),
          h('div',{className:'dk-helm-group'},t('swarm')),
          pages.map(p=>h('button',{key:p,type:'button',className:'dk-helm-navbtn','aria-current':p===page?'page':undefined,onClick:()=>choose(p)},t(p)))),
        h('main',{className:'dk-helm-main'},
          h('header',{className:'dk-helm-head'},
            h('div',null,
              h('h2',{className:'dk-helm-title'},t('title')),
              h('p',{className:'dk-helm-sub'},t('guide'),status==='ready'?` · ${t('live')}`:'',data?` · #${data.seq}`:'')),
            h('button',{type:'button',className:'dk-helm-btn',disabled:busy,onClick:()=>watcher.current?.refresh()},t(busy?'loading':failed?'retry':'refresh'))),
          failed&&h('p',{role:'alert',className:'dk-helm-error'},t(status==='unavailable'?'unavailable':'retrying'),' ',error),
          content));
    }
    function HelmViewSlot(props){return h(HelmView,{...props,key:props.boardOwner});}
    // Session-level switch in the model menu. The row exists only for a root;
    // the read never creates a board, and the write is rejected by the Host for
    // children. Turning it on later lazily creates the board.
    async function readMode(sessionId, signal, enabled) {
      const body = enabled === undefined ? {sessionId} : {sessionId, enabled};
      const response = await fetch('api/dk-swarm/mode', {method:'POST', headers:{'content-type':'application/json'},
        body:JSON.stringify(body), signal});
      if (!response.ok) throw Object.assign(Error(`Swarm mode: HTTP ${response.status}`), {status:response.status});
      const result = await response.json();
      if (result?.ok !== true) throw Object.assign(Error(result?.error?.message ?? 'Swarm mode error'), {code:result?.error?.code});
      return result.value ?? {};
    }
    function SwarmMode({sessionId,t,locked=false,reportFailure}) {
      const [swarm,setSwarm]=React.useState({loaded:false,root:false,enabled:false,busy:false,error:''});
      const [hover,setHover]=React.useState(false);
      const mounted=React.useRef(true);
      const inFlight=React.useRef(null);
      React.useEffect(()=>{
        mounted.current=true;
        const request=new AbortController();
        readMode(sessionId,request.signal).then(value=>{
          if (mounted.current) setSwarm({loaded:true,root:value.root===true,enabled:value.enabled===true,busy:false,error:''});
        }).catch(()=>{
          // A child, a stale session or a transport error must never add a
          // model-menu row; the Helm tab remains the explicit diagnostics path.
          if (mounted.current) setSwarm({loaded:true,root:false,enabled:false,busy:false,error:''});
        });
        return ()=>{mounted.current=false;request.abort();inFlight.current?.abort();};
      },[sessionId]);
      if (!swarm.loaded||!swarm.root) return null;
      const pending=swarm.busy;
      async function toggle(next=!swarm.enabled) {
        if (pending||locked||typeof next!=='boolean') return;
        setSwarm({...swarm,busy:true,error:''});
        inFlight.current?.abort();
        const request=new AbortController();
        inFlight.current=request;
        try {
          const value=await readMode(sessionId,request.signal,next);
          if (mounted.current) setSwarm({loaded:true,root:true,enabled:value.enabled===true,busy:false,error:''});
        } catch {
          const message=t('swarmFailed');
          if (mounted.current) setSwarm({...swarm,busy:false,error:message});
          if (mounted.current && typeof reportFailure==='function') reportFailure(message);
        } finally {
          if (inFlight.current===request) inFlight.current=null;
        }
      }
      const hint=t('swarmHint');
      const nativeSwitch=primitives?.Switch;
      const info=primitives?.Tooltip&&primitives?.Button&&primitives?.IconInfoOutlineRegular
        ? h(primitives.Tooltip,{label:hint,side:'top',delayMs:300,maxWidth:300,portal:true,openOnClick:true},
            h(primitives.Button,{variant:'ghost',size:'sm','aria-label':hint,
              style:{position:'relative',zIndex:1,flex:'none',width:20,height:20,minWidth:20,minHeight:20,padding:0,
                color:'var(--dsw-alias-label-caption)'}},
              h(primitives.IconInfoOutlineRegular,{size:11,'aria-hidden':'true'})))
        : h('span',{role:'img','aria-label':hint,title:hint,style:{flex:'none',display:'inline-flex',alignItems:'center',
            justifyContent:'center',width:12,height:12,border:'1px solid currentColor',borderRadius:'50%',fontSize:8,
            lineHeight:1,color:'var(--dsw-alias-label-caption)',cursor:'help'}},'i');
      return h('div',{onMouseEnter:()=>setHover(true),onMouseLeave:()=>setHover(false),
        style:{position:'relative',display:'flex',alignItems:'center',justifyContent:'space-between',gap:'16px',minHeight:34,
          padding:'0 8px',borderRadius:'var(--dsw-radius-md)',color:'var(--dsw-alias-label-primary)',fontSize:13,
          lineHeight:'20px',background:hover?'var(--dsw-alias-interactive-bg-hover)':'transparent',
          transition:'background 120ms ease'}},
        h('div',{style:{display:'flex',flexDirection:'column',gap:'2px',minWidth:0}},
          h('div',{style:{display:'inline-flex',alignItems:'center',gap:'4px',minWidth:0}},
            h('span',null,t('swarm')),
            info),
          swarm.error&&h('small',{role:'alert',style:{fontSize:11,lineHeight:'16px',color:'var(--dsw-alias-state-error-primary)'}},swarm.error)),
        nativeSwitch
          ? h(nativeSwitch,{checked:swarm.enabled,disabled:pending||locked,label:t('swarm'),
              onChange:value=>{if(!pending&&!locked) void toggle(value);}})
          : h('button',{type:'button',role:'switch','aria-checked':swarm.enabled,'aria-label':t('swarm'),title:hint,
              disabled:pending||locked,onClick:()=>toggle(),style:{flex:'none',width:34,height:20,padding:0,border:0,borderRadius:10,
                cursor:pending||locked?'default':'pointer',background:swarm.enabled?'#2f7cf6':'rgba(127,127,127,0.35)',
                opacity:pending?0.6:locked?0.5:1,transition:'background 120ms ease'}},
              h('span',{style:{display:'block',width:16,height:16,margin:2,marginLeft:swarm.enabled?16:2,borderRadius:'50%',
                background:'#fff',boxShadow:'0 1px 2px rgba(0,0,0,0.25)',transition:'margin-left 120ms ease'}})));
    }
    // A function component wrapper keeps the slot's hooks inside React's
    // renderer; the slot registry is handed a component, not the hook body.
    function SwarmModeSlot(props){return h(SwarmMode,props);}
    let modelCatalog = async () => { throw Error('model catalog unavailable'); };
    function bindBoard(sessionId) {
      return {boardOwner:sessionId, modelCatalog, async loadBoard(cursor,signal) {
        const response = await fetch('api/dk-swarm/liveView', {method:'POST', headers:{'content-type':'application/json'},
          body:JSON.stringify({sessionId,cursor}), signal});
        if (!response.ok) throw Object.assign(Error(`Swarm transport: HTTP ${response.status}`), {status:response.status});
        const result = await response.json();
        if (result?.ok !== true) throw Object.assign(Error(result?.error?.message ?? 'Swarm transport error'), {code:result?.error?.code});
        return result.value;
      }};
    }
    return {inject:['slots','locale','remote','remote.session'],apply(ctx){
      ctx.effect(()=>ctx.locale.register(ns,dictionaries)); const t=ctx.locale.bind(ns);
      modelCatalog = () => ctx.remote.session.modelCatalog();
      ctx.effect(()=>{
        if (typeof document==='undefined'||typeof document.createElement!=='function'||!document.head) return;
        const style=document.createElement('style'); style.textContent=helmCss; document.head.appendChild(style);
        return ()=>style.remove();
      });
      ctx.slots.inject('conversation.view',()=>ctx.slots.register({name:'conversation.view',id:'helm',order:40,locale:ns,label:()=>t('helm'),inject:bindBoard},HelmViewSlot));
      ctx.slots.inject('conversation.input.model.options',()=>ctx.slots.register({name:'conversation.input.model.options',id:'swarm',locale:ns,inject:sessionId=>({sessionId,t})},SwarmModeSlot));
    }};
  },
});
