// Tiny hook harness for client behavior in CI (not a browser/layout test).
export function renderer(){
  let cursor=0, instance, writes=0;
  const instances=new Map();
  const dispose=inst=>inst?.effects.forEach(fn=>fn?.());
  const react={createElement:(type,props,...children)=>({type,props:props??{},children:children.flat(Infinity)}),Fragment:Symbol('fragment'),
    useState(value){const {cells}=instance,i=cursor++;if(!(i in cells))cells[i]=value;return [cells[i],v=>{writes++;cells[i]=v;}];},
    useRef(value){const i=cursor++;return instance.cells[i]??={current:value};},
    useEffect(fn,deps){const {cells,effects}=instance,i=cursor++;
      if(!cells[i]||deps.some((v,j)=>cells[i][j]!==v)){effects[i]?.();cells[i]=deps;effects[i]=fn();}}};
  const render=el=>{
    instance=instances.get(el.type);
    if(!instance||instance.key!==el.props.key){dispose(instance);instance={key:el.props.key,cells:[],effects:[]};instances.set(el.type,instance);}
    cursor=0;return el.type(el.props);
  };
  const scan=(el,fn)=> (!el||typeof el!=='object')?[]:[...(fn(el)?[el]:[]),...el.children.flatMap(c=>scan(c,fn))];
  const text=el=>(!el||typeof el!=='object')?String(el??''):el.children.map(text).join(' ');
  return {react,render,scan,text,get writes(){return writes;},close(){instances.forEach(dispose);instances.clear();}};
}
