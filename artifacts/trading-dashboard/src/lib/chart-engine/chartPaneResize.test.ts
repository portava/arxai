import { expect, it } from 'vitest';
import { resizeStudyPaneBoundary, type StudyPaneResizeLayout } from './chartPaneResize';
import { layoutNativeStudyPanes } from './nativeChartStudies';

function layout(weights:number[],collapsed=weights.map(()=>false),height=800):StudyPaneResizeLayout {
 const geometry=layoutNativeStudyPanes({left:8,top:8,width:700,height},weights.length,weights,collapsed)!;
 return {price:geometry.price,studiesKey:'fixture',panes:geometry.panes.map((p,i)=>({...p,id:`pane-${i}`,weight:weights[i]!,collapsed:collapsed[i]!}))};
}
it('resizes adjacent study panes without moving the price or other panes',()=>{
 const base=layout([1,1,1]),result=resizeStudyPaneBoundary(base,'pane-1',30)!;
 const next=layout(Object.values(result.weights));
 expect(result.delta).toBe(30);expect(next.price.height).toBeCloseTo(base.price.height,8);expect(next.price.top).toBe(base.price.top);
 expect(next.panes[0]!.height).toBeCloseTo(base.panes[0]!.height+30,8);expect(next.panes[1]!.height).toBeCloseTo(base.panes[1]!.height-30,8);
 expect(next.panes[2]!.height).toBeCloseTo(base.panes[2]!.height,8);expect(next.panes[2]!.top).toBeCloseTo(base.panes[2]!.top,8);
});
it('resizes the price boundary while retaining every unrelated height',()=>{
 const base=layout([3,1,2]),result=resizeStudyPaneBoundary(base,'pane-0',40)!;
 const next=layout(Object.values(result.weights));expect(next.price.height).toBeCloseTo(base.price.height+40,8);
 expect(next.panes[0]!.height).toBeCloseTo(base.panes[0]!.height-40,8);
 expect(next.panes[1]!.height).toBeCloseTo(base.panes[1]!.height,8);expect(next.panes[2]!.height).toBeCloseTo(base.panes[2]!.height,8);
});
it('clamps motion to readable heights and representable saved weights',()=>{
 for(const weights of [[1],[.25,8],[8,.25,1],[1,1,1,1]])for(const height of [480,800,1400])for(const index of weights.keys())for(const delta of [-1e6,-10,0,10,1e6]){
  const base=layout(weights,undefined,height),result=resizeStudyPaneBoundary(base,`pane-${index}`,delta);expect(result,JSON.stringify({weights,height,index,delta})).not.toBeNull();
  const next=layout(Object.values(result!.weights),undefined,height);expect(next.price.height).toBeGreaterThanOrEqual(100);
  next.panes.forEach(p=>expect(p.height).toBeGreaterThanOrEqual(40));Object.values(result!.weights).forEach(w=>{expect(w).toBeGreaterThanOrEqual(.25);expect(w).toBeLessThanOrEqual(8);});
  [next.price,...next.panes].forEach((p,i)=>expect(p.height).toBeCloseTo([base.price,...base.panes][i]!.height+(i===index?result!.delta:i===index+1?-result!.delta:0),6));
 }
});
it('preserves collapsed and hidden weights and rejects dragging against a collapsed neighbor',()=>{
 const base=layout([1,3,1],[false,true,false]);expect(resizeStudyPaneBoundary(base,'pane-1',20)).toBeNull();expect(resizeStudyPaneBoundary(base,'pane-2',20)).toBeNull();
 const result=resizeStudyPaneBoundary(base,'pane-0',20)!;expect(result.weights['pane-1']).toBe(3);expect(layout(Object.values(result.weights),[false,true,false]).panes[1]!.height).toBe(24);
});
it('rejects malformed and mismatched geometry instead of silently moving unrelated panes',()=>{
 const base=layout([1,1]);expect(resizeStudyPaneBoundary(base,'missing',5)).toBeNull();expect(resizeStudyPaneBoundary(base,'pane-0',NaN)).toBeNull();
 expect(resizeStudyPaneBoundary({...base,panes:[base.panes[0]!,{...base.panes[1]!,height:150}]},'pane-0',10)).toBeNull();
 expect(resizeStudyPaneBoundary({...base,panes:[base.panes[0]!,{...base.panes[1]!,id:'pane-0'}]},'pane-0',10)).toBeNull();
});
