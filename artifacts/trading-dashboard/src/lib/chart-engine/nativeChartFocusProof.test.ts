import {afterEach,beforeEach,describe,expect,it,vi} from "vitest";
import {NativeChartViewport} from "./nativeChartViewport";
const bars=Array.from({length:30},(_,i)=>({time:1700000000+i*60,open:100+i,high:104+i,low:98+i,close:102+i}));
let host:HTMLDivElement,viewport:NativeChartViewport,ctx:any,queue:Map<number,FrameRequestCallback>,id:number;
function flush(){const work=[...queue.values()];queue.clear();work.forEach(callback=>callback(1));}
function mount(onViewportChange?:()=>void,withBars=true){viewport=new NativeChartViewport(host,{onViewportChange});if(withBars)viewport.setCandles(bars);return viewport;}
beforeEach(()=>{
 queue=new Map();id=0;ctx=new Proxy({measureText:vi.fn((text:string)=>({width:text.length*6}))} as any,{get(target,key){if(!(key in target))target[key]=vi.fn();return target[key];}});
 vi.spyOn(HTMLCanvasElement.prototype,"getContext").mockReturnValue(ctx);vi.spyOn(HTMLCanvasElement.prototype,"toDataURL").mockReturnValue("data:image/png;base64,fixture");
 vi.spyOn(HTMLElement.prototype,"getBoundingClientRect").mockReturnValue({x:0,y:0,left:0,top:0,right:800,bottom:400,width:800,height:400,toJSON(){}});
 vi.stubGlobal("requestAnimationFrame",(callback:FrameRequestCallback)=>{const next=++id;queue.set(next,callback);return next;});vi.stubGlobal("cancelAnimationFrame",(value:number)=>queue.delete(value));
 vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});vi.stubGlobal("matchMedia",()=>({addEventListener(){},removeEventListener(){}}));host=document.createElement("div");document.body.append(host);
});
afterEach(()=>{viewport?.destroy();host.remove();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("native focus presentation proof",()=>{
 it("withholds before first paint and after focus requests until the requested pixels paint",()=>{
  mount();expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);viewport.setAnalysisFocus(true);expect(viewport.isAnalysisFocused()).toBe(true);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);viewport.setAnalysisFocus(false);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("cannot prove empty or unsupported-size presentation even after a successful clearing paint",()=>{
  mount(undefined,false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(false);viewport.setCandles(bars);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);viewport.resize(0,0);flush();expect(viewport.isAnalysisFocusVerified()).toBe(false);viewport.resize(800,400);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("failure stays unverified across invalidation until successful recovery paint",()=>{
  mount();flush();ctx.stroke.mockImplementation(()=>{throw new Error("paint failed");});viewport.setAnalysisFocus(true);flush();expect(viewport.getState().status).toBe("error");expect(viewport.isAnalysisFocusVerified()).toBe(false);ctx.stroke.mockReset();viewport.setRange({from:2,to:20});expect(viewport.getState().status).toBe("ready");expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("direct overlay repaint invalidates proof while retaining the same frame",()=>{
  mount();flush();const frame=viewport.getFrame();viewport.setStructureLines([],[]);expect(viewport.getFrame()).toBe(frame);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("coalesced requests prove only the final successful presentation",()=>{
  mount();flush();viewport.setAnalysisFocus(true);viewport.setAnalysisFocus(false);viewport.setAnalysisFocus(true);expect(queue.size).toBe(1);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);expect(viewport.isAnalysisFocused()).toBe(true);
 });
 it("viewport callback invalidation cannot be overwritten by the older paint completion",()=>{
  let change=false;mount(()=>{if(change){change=false;viewport.setAnalysisFocus(false);}});flush();change=true;viewport.setAnalysisFocus(true);flush();expect(viewport.isAnalysisFocused()).toBe(false);expect(viewport.isAnalysisFocusVerified()).toBe(false);expect(queue.size).toBe(1);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("reset and retained old paint callbacks cannot prove another market",()=>{
  mount();flush();viewport.setAnalysisFocus(true);const old=[...queue.values()][0]!;viewport.resetContext();old(2);expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(false);viewport.setCandles(bars.map(bar=>({...bar,time:bar.time+10000})));expect(viewport.isAnalysisFocusVerified()).toBe(false);flush();expect(viewport.isAnalysisFocusVerified()).toBe(true);
 });
 it("export can complete pending paint, but destruction revokes proof",()=>{
  mount();viewport.setAnalysisFocus(true);expect(viewport.isAnalysisFocusVerified()).toBe(false);expect(viewport.exportImage()).toBe("data:image/png;base64,fixture");expect(viewport.isAnalysisFocusVerified()).toBe(true);viewport.destroy();expect(viewport.isAnalysisFocusVerified()).toBe(false);
 });
});
