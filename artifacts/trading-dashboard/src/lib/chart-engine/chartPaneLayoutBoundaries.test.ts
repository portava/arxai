import {it,expect} from 'vitest';
import {layoutNativeStudyPanes} from './nativeChartStudies';
it('keeps all readable panes across realistic fractional layouts',()=>{
 for(let count=1;count<=12;count++)for(const extra of [0,.1,1,13.3,127.7,500])for(const weight of [.25,.75,1,1.25,3,8]){
  const height=(count+3)*40+extra;
  const weights=Array.from({length:count},(_,i)=>i===count-1?.25:weight);
  const layout=layoutNativeStudyPanes({left:8,top:8,width:700,height},count,weights);
  expect(layout,JSON.stringify({count,height,weights})).not.toBeNull();
  expect(layout!.price.height).toBeGreaterThanOrEqual(100);
  for(const pane of layout!.panes)expect(pane.height).toBeGreaterThanOrEqual(40);
  expect(layout!.panes.at(-1)!.top+layout!.panes.at(-1)!.height).toBeCloseTo(8+height,9);
 }
});
