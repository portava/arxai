import { layoutNativeStudyPanes } from './nativeChartStudies';
import type { NativePlot } from './nativePriceRenderer';

export interface StudyPaneResizeLayout {
  price:NativePlot;
  panes:(NativePlot & {id:string;weight:number;collapsed:boolean})[];
  /** Exact installed studies, used only to reject a mismatched UI context. */
  studiesKey:string;
}
export interface StudyPaneResizeCommit {contextKey:string;studiesKey:string;weights:Record<string,number>}
export interface StudyPaneResizeResult {delta:number;weights:Record<string,number>}

/** Invert the native constrained layout. Only the two adjacent heights change;
 * all open-pane weights are expressed against the price pane's fixed weight 3. */
export function resizeStudyPaneBoundary(layout:StudyPaneResizeLayout,id:string,requestedDelta:number):StudyPaneResizeResult|null {
  const index=layout.panes.findIndex(p=>p.id===id);
  if(index<0 || !Number.isFinite(requestedDelta) || layout.panes[index]!.collapsed || (index>0&&layout.panes[index-1]!.collapsed))return null;
  const plots=[layout.price,...layout.panes],heights=plots.map(p=>p.height),collapsed=[false,...layout.panes.map(p=>p.collapsed)];
  if(new Set(layout.panes.map(p=>p.id)).size!==layout.panes.length || plots.some(p=>![p.left,p.top,p.width,p.height].every(Number.isFinite)||p.width<=0||p.height<=0))return null;
  const full={...layout.price,height:heights.reduce((a,b)=>a+b,0)};
  const original=layoutNativeStudyPanes(full,layout.panes.length,layout.panes.map(p=>p.weight),layout.panes.map(p=>p.collapsed));
  const same=(a:NativePlot,b:NativePlot)=>['left','top','width','height'].every(k=>Math.abs(a[k as keyof NativePlot]-b[k as keyof NativePlot])<=1e-7);
  if(!original || !same(original.price,layout.price)||original.panes.some((p,i)=>!same(p,layout.panes[i]!)))return null;
  const upper=index,lower=index+1,priceSlope=upper===0?1:0;
  let min=(upper===0?100:40)-heights[upper]!,max=heights[lower]!-40;
  const constrain=(constant:number,slope:number)=>{if(slope>0)min=Math.max(min,-constant/slope);else if(slope<0)max=Math.min(max,-constant/slope);else if(constant< -1e-7){min=1;max=0;}};
  for(let i=1;i<plots.length;i++){
    if(collapsed[i])continue;
    const slope=i===upper?1:i===lower?-1:0;
    constrain(12*heights[i]!-heights[0]!,12*slope-priceSlope);
    constrain(8*heights[0]!-3*heights[i]!,8*priceSlope-3*slope);
  }
  // Ratios at a saved-weight boundary can cross by a floating-point ulp.
  if(min>max && min-max<1e-7)min=max=(min+max)/2;
  if(min>max || !Number.isFinite(min)||!Number.isFinite(max))return null;
  const delta=Math.min(max,Math.max(min,requestedDelta));
  if(Math.abs(delta)<1e-9)return {delta:0,weights:Object.fromEntries(layout.panes.map(p=>[p.id,p.weight]))};
  const next=[...heights];next[upper]!+=delta;next[lower]!-=delta;
  const weights=layout.panes.map((p,i)=>p.collapsed?p.weight:Math.max(.25,Math.min(8,3*next[i+1]!/next[0]!)));
  const result=layoutNativeStudyPanes(full,layout.panes.length,weights,layout.panes.map(p=>p.collapsed));
  if(!result || [result.price,...result.panes].some((p,i)=>Math.abs(p.height-next[i]!)>1e-7))return null;
  return {delta,weights:Object.fromEntries(layout.panes.map((p,i)=>[p.id,weights[i]!]))};
}
