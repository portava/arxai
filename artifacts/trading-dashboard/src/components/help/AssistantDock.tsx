import { createContext, useCallback, useContext, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

type DockKind = "assistant" | "quickActions" | "search";
type DockTargets = Partial<Record<DockKind, HTMLElement>>;
type RegisterDock = (elements: DockTargets) => () => void;
const RegisterContext = createContext<RegisterDock | null>(null);
const TargetContext = createContext<DockTargets | null>(null);
export interface AssistantChartPane {
  id:string; contextKey:string; symbol:string; timeframe:string; source:string;
  analysisOnly:boolean; ready:boolean;
}
type PaneSelection={selected:AssistantChartPane|null;lastAnalysisOnly:boolean};
type LocalChartReceiver=(prompt:string,answer:string)=>boolean;
type PaneOwner=PaneSelection & {register:(pane:AssistantChartPane)=>()=>void;activate:(id:string,key:string)=>boolean;isCurrent:(pane:AssistantChartPane)=>boolean;registerLocalReceiver:(receiver:LocalChartReceiver)=>()=>void;deliverFinding:(pane:AssistantChartPane,read:()=>string)=>boolean};
const PaneContext=createContext<PaneOwner|null>(null);

/** One existing assistant, with explicit local-chart ownership. Trading/search
 * launchers remain primary; an analysis pane may host only the assistant. */
export function AssistantDockProvider({ children }: { children: ReactNode }) {
  const [targets, setTargets] = useState<DockTargets[]>([]);
  const register = useCallback<RegisterDock>(element => {
    setTargets(previous => previous.includes(element) ? previous : [...previous, element]);
    return () => setTargets(previous => previous.filter(target => target !== element));
  }, []);
  const [selection,setSelection]=useState<PaneSelection>({selected:null,lastAnalysisOnly:false});
  const active=useRef<AssistantChartPane|null>(null),panes=useRef(new Map<string,AssistantChartPane>());
  const initialPrimary=useRef<AssistantChartPane|null>(null),explicitChoice=useRef(false);
  const select=useCallback((pane:AssistantChartPane|null)=>{active.current=pane;setSelection(previous=>({selected:pane,lastAnalysisOnly:pane?.analysisOnly??previous.lastAnalysisOnly}));},[]);
  const registerPane=useCallback((pane:AssistantChartPane)=>{
    panes.current.set(pane.id,pane);
    if(pane.ready&&!pane.analysisOnly&&!explicitChoice.current){
      initialPrimary.current??=pane;
      if(!active.current&&initialPrimary.current===pane)select(pane);
    }
    return()=>{if(panes.current.get(pane.id)!==pane)return;panes.current.delete(pane.id);if(active.current?.id===pane.id)select(null);};
  },[select]);
  const activate=useCallback((id:string,key:string)=>{const pane=panes.current.get(id);if(!pane?.ready||pane.contextKey!==key)return false;explicitChoice.current=true;select(pane);return true;},[select]);
  const isCurrent=useCallback((pane:AssistantChartPane)=>pane.ready&&panes.current.get(pane.id)===pane&&active.current?.id===pane.id&&active.current.contextKey===pane.contextKey,[]);
  const localReceiver=useRef<LocalChartReceiver|null>(null);
  const registerLocalReceiver=useCallback((receiver:LocalChartReceiver)=>{localReceiver.current=receiver;return()=>{if(localReceiver.current===receiver)localReceiver.current=null;};},[]);
  const deliverFinding=useCallback((pane:AssistantChartPane,read:()=>string)=>{
    if(!isCurrent(pane)||!localReceiver.current)return false;
    try{const answer=read();if(!isCurrent(pane)||!localReceiver.current)return false;return localReceiver.current("Explain this finding",answer);}catch{return false;}
  },[isCurrent]);
  const selectedTargets=useMemo(()=>Object.fromEntries((["assistant","quickActions","search"] as const).map(kind=>[kind,[...targets].reverse().find(target=>target[kind])?.[kind]])),[targets]);
  return <RegisterContext.Provider value={register}><TargetContext.Provider value={selectedTargets}>
    <PaneContext.Provider value={{...selection,register:registerPane,activate,isCurrent,registerLocalReceiver,deliverFinding}}>{children}</PaneContext.Provider>
  </TargetContext.Provider></RegisterContext.Provider>;
}
export function useAssistantChartSelection(){
  const owner=useContext(PaneContext);
  return {selected:owner?.selected??null,remoteBlocked:owner?.selected?.analysisOnly??owner?.lastAnalysisOnly??false};
}
export function useAssistantChartPane(info:Omit<AssistantChartPane,"id">){
  const owner=useContext(PaneContext),id=useId();
  const pane=useMemo(()=>({...info,id}),[id,info.contextKey,info.symbol,info.timeframe,info.source,info.analysisOnly,info.ready]);
  const latest=useRef(pane);latest.current=pane;
  const register=owner?.register,check=owner?.isCurrent,activate=owner?.activate,deliverFinding=owner?.deliverFinding;
  useLayoutEffect(()=>register?.(pane),[register,pane]);
  const isCurrent=useCallback(()=>check?.(latest.current)??false,[check]);
  return {active:owner?.selected?.id===id&&owner.selected.contextKey===pane.contextKey&&pane.ready,isCurrent,
    activate:()=>activate?.(id,latest.current.contextKey)??false,
    explainFinding:(read:()=>string)=>latest.current===pane&&activate?.(id,pane.contextKey)?deliverFinding?.(pane,read)??false:false};
}
/** The existing assistant panel receives a validated local answer; this cannot
 * invoke its remote send path or invent a fallback when the panel is absent. */
export function useLocalChartAssistantReceiver(receiver:LocalChartReceiver){
  const register=useContext(PaneContext)?.registerLocalReceiver;
  useLayoutEffect(()=>register?.(receiver),[register,receiver]);
}
export function useAssistantDockTarget(): HTMLElement | null {return useChartActionDockTarget("assistant");}
export function useChartActionDockTarget(kind: DockKind): HTMLElement | null {return useContext(TargetContext)?.[kind] ?? null;}

/** Comparisons never receive primary quick-action/search controls. */
export function AssistantDockSlot({assistantOnly=false,assistantEnabled=true}:{assistantOnly?:boolean;assistantEnabled?:boolean}={}) {
  const register = useContext(RegisterContext);
  const assistant = useRef<HTMLDivElement>(null),quickActions=useRef<HTMLDivElement>(null),search=useRef<HTMLDivElement>(null);
  useLayoutEffect(()=>{
    if(!register)return;
    const targets:DockTargets={};
    if(assistantEnabled&&assistant.current)targets.assistant=assistant.current;
    if(!assistantOnly&&quickActions.current&&search.current){targets.quickActions=quickActions.current;targets.search=search.current;}
    return register(targets);
  },[register,assistantOnly,assistantEnabled]);
  return register?<div className="flex h-11 shrink-0 gap-1" role="group" aria-label={assistantOnly?"Chart assistant":"Chart help and navigation"} data-testid="chart-assistant-dock">
    {!assistantOnly&&<><div ref={quickActions} className="h-11 w-11"/><div ref={search} className="h-11 w-11"/></>}
    {assistantEnabled&&<div ref={assistant} className="h-11 w-11"/>}
  </div>:null;
}
