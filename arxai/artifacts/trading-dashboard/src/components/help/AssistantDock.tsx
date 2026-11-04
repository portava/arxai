import { createContext, useCallback, useContext, useId, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";

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
type PaneOwner=PaneSelection & {findingDelivery:{pane:AssistantChartPane;notice:string}|null;register:(pane:AssistantChartPane)=>()=>void;activate:(id:string,key:string)=>boolean;isCurrent:(pane:AssistantChartPane)=>boolean;registerLocalReceiver:(receiver:LocalChartReceiver)=>()=>void;deliverFinding:(pane:AssistantChartPane,read:()=>string)=>boolean};
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
  const pendingFinding=useRef<{pane:AssistantChartPane;read:()=>string;answer:string;expiresAt:number;timer:ReturnType<typeof setTimeout>}|null>(null);
  const [findingDelivery,setFindingDelivery]=useState<{pane:AssistantChartPane;notice:string}|null>(null);
  const cancelPending=useCallback((notice:string|null)=>{const pending=pendingFinding.current;if(!pending)return;clearTimeout(pending.timer);pendingFinding.current=null;setFindingDelivery(notice?{pane:pending.pane,notice}:null);},[]);
  useEffect(()=>()=>{if(pendingFinding.current)clearTimeout(pendingFinding.current.timer);pendingFinding.current=null;},[]);
  const initialPrimary=useRef<AssistantChartPane|null>(null),explicitChoice=useRef(false);
  const select=useCallback((pane:AssistantChartPane|null)=>{if(pendingFinding.current&&pendingFinding.current.pane!==pane)cancelPending("The selected chart changed. Choose a current finding to explain.");active.current=pane;setSelection(previous=>({selected:pane,lastAnalysisOnly:pane?.analysisOnly??previous.lastAnalysisOnly}));},[cancelPending]);
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
  const registerLocalReceiver=useCallback((receiver:LocalChartReceiver)=>{
    localReceiver.current=receiver;
    const pending=pendingFinding.current;
    if(pending){
      // Read again only to verify the exact selected evidence still matches.
      // Never substitute a new answer, pane or source while the panel loads.
      cancelPending(null);
      try{
        if(performance.now()>=pending.expiresAt){
          setFindingDelivery({pane:pending.pane,notice:"The assistant has not opened in time. Try again; the chart explanation remains below."});
        }else if(!isCurrent(pending.pane)||pending.read()!==pending.answer||!isCurrent(pending.pane)||performance.now()>=pending.expiresAt){
          setFindingDelivery({pane:pending.pane,notice:"The chart reading changed while the assistant opened. Choose a current finding to explain."});
        }else if(!receiver("Explain this finding",pending.answer)){
          setFindingDelivery({pane:pending.pane,notice:"The assistant is unavailable. The selected finding’s explanation remains below."});
        }
      }catch{setFindingDelivery({pane:pending.pane,notice:"The chart reading is no longer available. Choose a current finding to explain."});}
    }
    return()=>{if(localReceiver.current===receiver)localReceiver.current=null;};
  },[cancelPending,isCurrent]);
  const deliverFinding=useCallback((pane:AssistantChartPane,read:()=>string)=>{
    if(!isCurrent(pane))return false;
    cancelPending(null);setFindingDelivery(null);
    try{
      const answer=read();if(!isCurrent(pane))return false;
      if(localReceiver.current)return localReceiver.current("Explain this finding",answer);
      const request={pane,read,answer,expiresAt:performance.now()+10000,timer:setTimeout(()=>{if(pendingFinding.current===request)cancelPending("The assistant has not opened. Try again; the chart explanation remains below.");},10000)};
      pendingFinding.current=request;
      setFindingDelivery({pane,notice:"Opening the assistant… Your selected chart explanation will appear when it is ready."});
      return true;
    }catch{return false;}
  },[cancelPending,isCurrent]);
  const selectedTargets=useMemo(()=>Object.fromEntries((["assistant","quickActions","search"] as const).map(kind=>[kind,[...targets].reverse().find(target=>target[kind])?.[kind]])),[targets]);
  return <RegisterContext.Provider value={register}><TargetContext.Provider value={selectedTargets}>
    <PaneContext.Provider value={{...selection,findingDelivery,register:registerPane,activate,isCurrent,registerLocalReceiver,deliverFinding}}>{children}</PaneContext.Provider>
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
  return {findingDeliveryNotice:owner?.findingDelivery?.pane===pane?owner.findingDelivery.notice:null,active:owner?.selected?.id===id&&owner.selected.contextKey===pane.contextKey&&pane.ready,isCurrent,
    activate:()=>activate?.(id,latest.current.contextKey)??false,
    explainFinding:(read:()=>string)=>latest.current===pane&&activate?.(id,pane.contextKey)?deliverFinding?.(pane,read)??false:false};
}
/** The existing assistant panel receives a validated local answer; this cannot
 * invoke its remote send path. One cold-click request may wait for its mount;
 * it is discarded on context/evidence change or after ten seconds. */
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
