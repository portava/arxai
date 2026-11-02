import { ChartPaneScaleHandle } from './ChartPaneScaleHandle';
import { ChartPaneResizeHandle } from './ChartPaneResizeHandle';
import { Fragment, useLayoutEffect, useRef, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import { createPortal } from 'react-dom';
import type { ChartEngineAdapter, ChartStudyPaneControl } from '@/lib/chart-engine/types';
import { studyDefinition, studyId } from '@/lib/chart-engine/chartStudies';
import type { ChartPreferences } from '@/lib/chart-engine/chartWorkspace';

interface Props {
  adapter:ChartEngineAdapter|null;
  chartTarget?:RefObject<HTMLDivElement|null>;
  enabled:boolean;
  onPreferences:Dispatch<SetStateAction<ChartPreferences>>;
}

/** Uses the existing workspace's pane state; never owns calculations or gestures. */
export function ChartPaneControls({adapter,chartTarget,enabled,onPreferences}:Props) {
  const [panes,setPanes]=useState<ChartStudyPaneControl[]>([]);
  const active=useRef<object|null>(null);
  useLayoutEffect(()=>{
    const token={};active.current=token;
    let requested:string|undefined;
    const update=()=>{
      if(active.current!==token)return;
      if(enabled && !adapter?.getStudyPaneControls)return;
      const next=enabled ? adapter!.getStudyPaneControls!() : [];
      // Pending paint is not a source reset. Keep the focusable DOM node, but
      // the click path below still requires a current painted owner.
      if(next===null)return;
      const key=JSON.stringify(next);if(requested===key)return;requested=key;
      setPanes(previous=>active.current!==token || JSON.stringify(previous)===key ? previous : next);
    };
    update();
    const unsubscribe=enabled&&adapter?.getStudyPaneControls ? adapter.subscribeViewport?.(update) : undefined;
    return ()=>{active.current=null;unsubscribe?.();};
  },[adapter,enabled,chartTarget]);
  const target=chartTarget?.current;
  if(!enabled || !target || !adapter?.getStudyPaneControls)return null;
  const toggle=(pane:ChartStudyPaneControl)=>{
    const token=active.current;if(!token||adapter.prepareStudyPaneAction?.()===false)return;
    const isCurrent=()=>active.current===token && adapter.getStudyPaneControls?.()?.some(current=>current.id===pane.id&&current.collapsed===pane.collapsed);
    if(pane.maximized || !isCurrent())return;
    onPreferences(previous=>{
      if(!isCurrent())return previous;
      const owner=previous.studies.find(study=>studyId(study)===pane.id);
      if(!owner || !studyDefinition(owner.kind).pane || (owner.paneCollapsed===true)!==pane.collapsed)return previous;
      return {...previous,studies:previous.studies.map(study=>study===owner?{...study,paneCollapsed:!pane.collapsed}:study)};
    });
  };
  return createPortal(<div className="pointer-events-none absolute inset-0" data-testid="chart-pane-controls">
    {panes.map(pane=><Fragment key={pane.id}>
      {adapter.setMaximizedStudyPane && !pane.collapsed && <button type="button"
        className="pointer-events-auto absolute rounded border border-slate-600 bg-slate-950 text-slate-200 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
        style={{left:pane.left+pane.width-58,top:pane.top,width:26,height:24}}
        aria-label={`${pane.maximized?'Restore layout from':'Maximize'} pane ${pane.paneIndex}: ${pane.label}`}
        title={pane.maximized?'Restore chart layout':'Maximize indicator pane'} aria-pressed={pane.maximized===true}
        onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
        onKeyDown={event=>{if(event.key!=='Escape'&&event.key!=='Tab')event.stopPropagation();}}
        onClick={event=>{event.stopPropagation();if(active.current&&adapter.prepareStudyPaneAction?.()!==false&&adapter.getStudyPaneControls?.()?.some(current=>current.id===pane.id&&!current.collapsed&&current.maximized===pane.maximized))adapter.setMaximizedStudyPane?.(pane.maximized?null:pane.id);}}>
        <span aria-hidden="true">{pane.maximized?'⤢':'□'}</span>
      </button>}
      {pane.scaleAnchor && !pane.collapsed && adapter.beginStudyPaneScale && adapter.previewStudyPaneScale && adapter.endStudyPaneScale && adapter.isStudyPaneScaleContextCurrent && <ChartPaneScaleHandle adapter={adapter} pane={pane} onPreferences={onPreferences}/>}
      {pane.resizable && adapter.beginStudyPaneResize && adapter.previewStudyPaneResize && adapter.endStudyPaneResize && adapter.isStudyPaneResizeContextCurrent && <ChartPaneResizeHandle adapter={adapter} pane={pane} onPreferences={onPreferences}/>}
      <button type="button"
      className="pointer-events-auto absolute rounded border border-slate-600 bg-slate-950 text-slate-200 hover:bg-slate-700 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
      style={{left:pane.left+pane.width-28,top:pane.top,width:26,height:24}}
      disabled={pane.maximized===true}
      aria-label={`${pane.collapsed?'Expand':'Collapse'} pane ${pane.paneIndex}: ${pane.label}`}
      title={`${pane.collapsed?'Expand':'Collapse'} ${pane.label}`} aria-pressed={pane.collapsed}
      onPointerDown={event=>event.stopPropagation()} onDoubleClick={event=>event.stopPropagation()}
      onKeyDown={event=>{if(event.key!=='Escape'&&event.key!=='Tab')event.stopPropagation();}}
      onClick={event=>{event.stopPropagation();toggle(pane);}}>
      <span aria-hidden="true">{pane.collapsed?'▴':'▾'}</span>
    </button></Fragment>)}
  </div>,target);
}
