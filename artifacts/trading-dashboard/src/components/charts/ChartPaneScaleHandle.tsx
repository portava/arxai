import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ChartEngineAdapter, ChartStudyPaneControl } from '@/lib/chart-engine/types';
import { validatePreferences, type ChartPreferences } from '@/lib/chart-engine/chartWorkspace';
import { studyId } from '@/lib/chart-engine/chartStudies';

interface Props {adapter:ChartEngineAdapter;pane:ChartStudyPaneControl;onPreferences:Dispatch<SetStateAction<ChartPreferences>>}

/** Live canvas-only preview; persist once on release. Cancellation never writes
 * old preferences back into a newly selected chart. */
export function ChartPaneScaleHandle({adapter,pane,onPreferences}:Props){
  const owner=useRef<object|null>(null),drag=useRef<{token:number;pointer:number;y:number;element:HTMLDivElement}|null>(null);
  const cancel=()=>{const current=drag.current;drag.current=null;if(current){adapter.endStudyPaneScale?.(current.token,false);try{current.element.releasePointerCapture(current.pointer);}catch{}}};
  useLayoutEffect(()=>{
    owner.current={};const blur=()=>cancel(),hidden=()=>{if(document.hidden)cancel();};
    window.addEventListener('blur',blur);document.addEventListener('visibilitychange',hidden);
    return()=>{owner.current=null;cancel();window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);};
  },[adapter,pane.id]);
  const commit=(token:number)=>{
    const result=adapter.endStudyPaneScale?.(token,true),scope=owner.current;if(!result||!scope)return;
    onPreferences(previous=>{
      if(owner.current!==scope || !adapter.isStudyPaneScaleContextCurrent?.(result.contextKey) || JSON.stringify(validatePreferences(previous).studies)!==result.studiesKey)return previous;
      return {...previous,studies:previous.studies.map(study=>studyId(study)===result.id?{...study,paneScale:result.scale}:study)};
    });
  };
  const anchor=pane.scaleAnchor;if(!anchor)return null;
  return <div role="slider" aria-orientation="vertical" aria-label={`Move scale anchor for pane ${pane.paneIndex}: ${pane.label}`} tabIndex={0}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={anchor.percent} aria-valuetext={`Value ${anchor.value} at ${Number(anchor.percent.toFixed(2))}% from bottom. Up or Down moves one percent; Shift moves one tenth.`}
    title="Drag the scale anchor. Up/Down adjust it; Escape cancels a drag."
    className="pointer-events-auto absolute z-20 cursor-ns-resize rounded hover:bg-amber-400/40 focus-visible:bg-amber-400/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
    style={{left:pane.left+48,top:Math.max(pane.top,Math.min(pane.top+pane.height-10,anchor.y-5)),width:Math.max(1,pane.width-114),height:10,touchAction:'none'}}
    onPointerDown={event=>{
      event.stopPropagation();if(event.button!==0||drag.current)return;
      const token=adapter.beginStudyPaneScale?.(pane.id);if(token==null)return;
      event.preventDefault();event.currentTarget.focus({preventScroll:true});
      try{event.currentTarget.setPointerCapture(event.pointerId);}catch{adapter.endStudyPaneScale?.(token,false);return;}
      drag.current={token,pointer:event.pointerId,y:event.clientY,element:event.currentTarget};
    }}
    onPointerMove={event=>{
      const current=drag.current;if(!current||current.pointer!==event.pointerId)return;
      event.preventDefault();event.stopPropagation();
      if(!adapter.previewStudyPaneScale?.(current.token,event.clientY-current.y))cancel();
    }}
    onPointerUp={event=>{
      const current=drag.current;if(!current||current.pointer!==event.pointerId)return;
      event.preventDefault();event.stopPropagation();drag.current=null;
      if(adapter.previewStudyPaneScale?.(current.token,event.clientY-current.y))commit(current.token);else adapter.endStudyPaneScale?.(current.token,false);
      try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{}
    }}
    onPointerCancel={()=>cancel()} onLostPointerCapture={()=>cancel()}
    onDoubleClick={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
    onKeyDown={event=>{
      if(event.key==='Escape'){if(drag.current){event.preventDefault();event.stopPropagation();cancel();}return;}
      if(event.key==='Tab'){cancel();return;}
      event.stopPropagation();
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||drag.current)return;
      event.preventDefault();const token=adapter.beginStudyPaneScale?.(pane.id);if(token==null)return;
      const delta=event.key==='Home'?1e6:event.key==='End'?-1e6:(event.key==='ArrowUp'?-1:1)*pane.height/100*(event.shiftKey?.1:1);
      if(adapter.previewStudyPaneScale?.(token,delta))commit(token);else adapter.endStudyPaneScale?.(token,false);
    }}/>
}
