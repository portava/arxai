import {expect,it} from "vitest";
import {chartAssistantBounds} from "./chartAssistantLayout";
it("reserves chart space on a normal phone but keeps the panel inside short keyboard viewports",()=>{
 const phone={width:390,height:844,offsetTop:0,offsetLeft:0,layoutHeight:844};const compact=chartAssistantBounds(phone,false),expanded=chartAssistantBounds(phone,true);
 expect(compact.height).toBeLessThanOrEqual(340);expect(expanded.height).toBeGreaterThan(compact.height);
 for(const width of [240,320,390])for(const height of [100,160,280,844])for(const expanded of [false,true]){
  const box=chartAssistantBounds({...phone,width,height,offsetTop:60,offsetLeft:12},expanded);
  expect(box.top).toBeGreaterThanOrEqual(60);expect(box.top+box.height).toBeLessThanOrEqual(60+height);expect(box.left).toBeGreaterThanOrEqual(12);expect(box.left+box.width).toBeLessThanOrEqual(12+width);expect(box.height).toBeGreaterThan(0);
 }
});
