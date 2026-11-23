// Tiny hook harness for client behavior in CI (not a browser/layout test).
export function renderer(){
  let cursor=0,cells=[];const instances=new Map(),clean=[];
  const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),Fragment:Symbol('fragment'),
    useState(value){const i=cursor++;if(!(i in cells))cells[i]=value;return [cells[i],v=>{cells[i]=v;}];},
    useRef(value){const i=cursor++;return cells[i]??={current:value};},
    useEffect(fn){const i=cursor++;if(!cells[i]){cells[i]=true;clean.push(fn());}}};
  const render=(el)=>{cursor=0;cells=instances.get(el.type)??[];instances.set(el.type,cells);return el.type(el.props);};
  const scan=(el,fn)=> (!el||typeof el!=='object')?[]:[...(fn(el)?[el]:[]),...el.children.flatMap(c=>scan(c,fn))];
  const text=el=>(!el||typeof el!=='object')?String(el??''):el.children.map(text).join(' ');
  return {react,render,scan,text,close:()=>clean.forEach(fn=>fn?.())};
}
