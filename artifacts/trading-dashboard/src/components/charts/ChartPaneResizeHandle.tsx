import { useLayoutEffect, useRef, type Dispatch, type SetStateAction } from 'react';
import type { ChartEngineAdapter, ChartStudyPaneControl } from '@/lib/chart-engine/types';
import { validatePreferences, type ChartPreferences } from '@/lib/chart-engine/chartWorkspace';
import { studyId } from '@/lib/chart-engine/chartStudies';

interface Props {adapter:ChartEngineAdapter;pane:ChartStudyPaneControl;onPreferences:Dispatch<SetStateAction<ChartPreferences>>}

/** Live canvas-only preview; persist once on release. Cancellation never writes
 * old preferences back into a newly selected chart. */
export function ChartPaneResizeHandle({adapter,pane,onPreferences}:Props){
  const owner=useRef<object|null>(null),drag=useRef<{token:number;pointer:number;y:number;element:HTMLDivElement}|null>(null);
  const cancel=()=>{const current=drag.current;drag.current=null;if(current){adapter.endStudyPaneResize?.(current.token,false);try{current.element.releasePointerCapture(current.pointer);}catch{}}};
  useLayoutEffect(()=>{
    owner.current={};const blur=()=>cancel(),hidden=()=>{if(document.hidden)cancel();};
    window.addEventListener('blur',blur);document.addEventListener('visibilitychange',hidden);
    return()=>{owner.current=null;cancel();window.removeEventListener('blur',blur);document.removeEventListener('visibilitychange',hidden);};
  },[adapter,pane.id]);
  const commit=(token:number)=>{
    const result=adapter.endStudyPaneResize?.(token,true),scope=owner.current;if(!result||!scope)return;
    onPreferences(previous=>{
      if(owner.current!==scope || !adapter.isStudyPaneResizeContextCurrent?.(result.contextKey) || JSON.stringify(validatePreferences(previous).studies)!==result.studiesKey)return previous;
      return {...previous,studies:previous.studies.map(study=>Object.hasOwn(result.weights,studyId(study))?{...study,paneWeight:result.weights[studyId(study)]}:study)};
    });
  };
  return <div role="separator" aria-orientation="horizontal" aria-label={`Resize pane ${pane.paneIndex}: ${pane.label}`} tabIndex={0}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pane.sizePercent??50)} aria-valuetext={`${Math.round(pane.height)} pixels high. Use Up or Down to resize; Shift changes one pixel.`}
    title="Drag to resize neighboring panes. Arrow keys resize; Escape cancels a drag."
    className="pointer-events-auto absolute z-10 cursor-row-resize rounded hover:bg-sky-400/40 focus-visible:bg-sky-400/40 focus-visible:outline focus-visible:outline-2 focus-visible:outline-sky-400"
    style={{left:pane.left,top:pane.top-4,width:Math.max(1,pane.width-66),height:8,touchAction:'none'}}
    onPointerDown={event=>{
      event.stopPropagation();if(event.button!==0||drag.current)return;
      const token=adapter.beginStudyPaneResize?.(pane.id);if(token==null)return;
      event.preventDefault();event.currentTarget.focus({preventScroll:true});
      try{event.currentTarget.setPointerCapture(event.pointerId);}catch{adapter.endStudyPaneResize?.(token,false);return;}
      drag.current={token,pointer:event.pointerId,y:event.clientY,element:event.currentTarget};
    }}
    onPointerMove={event=>{
      const current=drag.current;if(!current||current.pointer!==event.pointerId)return;
      event.preventDefault();event.stopPropagation();
      if(!adapter.previewStudyPaneResize?.(current.token,event.clientY-current.y))cancel();
    }}
    onPointerUp={event=>{
      const current=drag.current;if(!current||current.pointer!==event.pointerId)return;
      event.preventDefault();event.stopPropagation();drag.current=null;
      if(adapter.previewStudyPaneResize?.(current.token,event.clientY-current.y))commit(current.token);else adapter.endStudyPaneResize?.(current.token,false);
      try{event.currentTarget.releasePointerCapture(event.pointerId);}catch{}
    }}
    onPointerCancel={()=>cancel()} onLostPointerCapture={()=>cancel()}
    onDoubleClick={event=>event.stopPropagation()} onClick={event=>event.stopPropagation()}
    onKeyDown={event=>{
      if(event.key==='Escape'){if(drag.current){event.preventDefault();event.stopPropagation();cancel();}return;}
      if(event.key==='Tab'){cancel();return;}
      event.stopPropagation();
      if(!['ArrowUp','ArrowDown','Home','End'].includes(event.key)||drag.current)return;
      event.preventDefault();const token=adapter.beginStudyPaneResize?.(pane.id);if(token==null)return;
      const delta=event.key==='Home'?-1e6:event.key==='End'?1e6:(event.key==='ArrowUp'?-1:1)*(event.shiftKey?1:10);
      if(adapter.previewStudyPaneResize?.(token,delta))commit(token);else adapter.endStudyPaneResize?.(token,false);
    }}/>
}
