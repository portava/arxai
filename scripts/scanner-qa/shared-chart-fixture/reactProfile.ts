// Diagnostic fixture only. Never import from application code. React fiber
// fields are version-specific observations, not a production performance API.
type Fiber = {type?: unknown; tag?: number; actualDuration?: number; selfBaseDuration?: number; treeBaseDuration?: number; alternate?: unknown; child?: Fiber | null; sibling?: Fiber | null};
const finite = (value: unknown) => typeof value === "number" && Number.isFinite(value) ? value : null;
export function summarizeFibers(root: Fiber, limit = 10000) {
  const stack=[root],seen=new Set<Fiber>(),rows=[];
  while(stack.length && seen.size<limit) {
    const node=stack.pop()!;
    if(seen.has(node))continue;
    seen.add(node);
    if(node.sibling)stack.push(node.sibling);
    if(node.child)stack.push(node.child);
    const type=node.type as {displayName?:string;name?:string;render?:{displayName?:string;name?:string}}|string|undefined;
    const name=typeof type==="string" ? null : type?.displayName??type?.name??type?.render?.displayName??type?.render?.name;
    const duration=finite(node.actualDuration);
    if(!name||duration===null||duration<=0)continue;
    let childDuration=0,child=node.child,children=new Set<Fiber>();
    while(child&&!children.has(child)&&children.size<limit){children.add(child);childDuration+=finite(child.actualDuration)??0;child=child.sibling;}
    rows.push({name,tag:node.tag,actualDuration:duration,exclusiveEstimate:Math.max(0,duration-childDuration),selfBaseDuration:finite(node.selfBaseDuration),treeBaseDuration:finite(node.treeBaseDuration),alternateAbsent:node.alternate==null});
  }
  return {visited:seen.size,truncated:stack.length>0,topInclusive:[...rows].sort((a,b)=>b.actualDuration-a.actualDuration).slice(0,60),topExclusive:rows.sort((a,b)=>b.exclusiveEstimate-a.exclusiveEstimate).slice(0,60)};
}
export function installReactProfile() {
  if(location.origin!=="http://127.0.0.1:4299")throw Error("Profiling fixture requires its separate loopback port");
  const target=window as unknown as Record<string,unknown>;
  if(target.__REACT_DEVTOOLS_GLOBAL_HOOK__)throw Error("Use an isolated browser without another DevTools hook");
  const record={diagnosticOnly:true,renderers:[] as unknown[],commits:[] as unknown[],droppedCommits:0,
    limitations:["Profiling runtime and observer overhead: never performance acceptance.","Fiber fields are React-version-specific. Nested/bailout durations are not independently additive.","alternateAbsent is a fiber observation, not proof the node mounted or rendered in this commit.","Names, timing and tags only; no props, state, DOM or account data are retained."]};
  target.__arxReactProfile=record;
  target.__REACT_DEVTOOLS_GLOBAL_HOOK__={supportsFiber:true,isDisabled:false,
    inject(renderer:{version?:string;rendererPackageName?:string}){record.renderers.push({version:renderer.version,package:renderer.rendererPackageName});return record.renderers.length;},
    onCommitFiberRoot(rendererId:number,root:{current:Fiber;effectDuration?:number;passiveEffectDuration?:number}){
      if(record.commits.length>=128){record.droppedCommits++;return;}
      const started=performance.now(),summary=summarizeFibers(root.current);
      record.commits.push({rendererId,at:started,path:location.pathname,rootActualDuration:finite(root.current.actualDuration),effectDuration:finite(root.effectDuration),passiveEffectDuration:finite(root.passiveEffectDuration),...summary,observerMs:performance.now()-started});
    },onCommitFiberUnmount(){},onPostCommitFiberRoot(){}};
}
