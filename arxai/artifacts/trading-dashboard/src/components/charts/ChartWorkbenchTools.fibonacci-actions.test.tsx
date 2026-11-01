import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ChartWorkbenchTools} from "./ChartWorkbenchTools";
import {DEFAULT_PREFERENCES,MAX_DRAWINGS,drawingStorageKey,type ChartDrawing} from "@/lib/chart-engine/chartWorkspace";
import {parseFibonacciRequest,requestChartFibonacci} from "@/lib/chart-engine/chartFibonacciAssistant";
import type {ChartFibonacciRead} from "@/lib/chart-engine/chartAutoFibonacci";
import type {ChartEngineAdapter} from "@/lib/chart-engine";
const origin={method:"confirmed-swings-v1" as const,span:2 as const,symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),start:{time:1000,price:10},end:{time:1300,price:20},confirmedAt:1480,windowFrom:880,windowTo:1600,closedBars:12};
const ready=():ChartFibonacciRead=>({status:"ready",reason:null,proposal:{comparisonKey:"sample-a",origin,note:"Twelve closed bars; no forecast."}});
let read:ChartFibonacciRead;
const draw=vi.fn(),engine={setDrawings:draw,setDrawingInteraction:vi.fn()} as unknown as ChartEngineAdapter;
const props={adapter:engine,epoch:1,symbol:"EURUSD",timeframe:"M1",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:"Offline",getFibonacciProposal:()=>read,assistantActive:true};
const key=drawingStorageKey("EURUSD","M1"),saved=()=>JSON.parse(localStorage.getItem(key)??"[]") as ChartDrawing[];
const ask=(text:string)=>{let reply:string|null=null;act(()=>{reply=requestChartFibonacci(text);});return reply;};
const preview=()=>ask("preview Fibonacci");
const stripIds=(rows:ChartDrawing[])=>rows.map(({id,...rest})=>rest);
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();read=ready();});afterEach(cleanup);
it("parses only explicit kept-annotation controls and preview Keep",()=>{
 expect(parseFibonacciRequest("Keep Fibonacci")).toEqual({action:"keep"});
 for(const action of ["hide","show","remove"]){expect(parseFibonacciRequest(`${action} the selected Fibonacci drawing`)).toEqual({action:`${action}_selected`});}
 for(const text of ["keep Fibonacci on GBPUSD","keep Fibonacci and buy","remove Fibonacci","hide Fibonacci","show selected Fibonacci on M5","remove all Fibonacci","show selected Fibonacci then trade","keep Fibonacci with span 5"]){expect(parseFibonacciRequest(text)).toHaveProperty("error");}
 expect(parseFibonacciRequest("show Fibonacci")).toEqual({action:"preview"});
});
it("explicit Keep shares manual drawing geometry, storage and undo",()=>{
 const manual=render(<ChartWorkbenchTools {...props}/>);preview();fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));const expected=saved();manual.unmount();localStorage.clear();
 render(<ChartWorkbenchTools {...props}/>);preview();expect(saved()).toEqual([]);expect(ask("keep Fibonacci")).toContain("kept as your editable drawing");
 expect(stripIds(saved())).toEqual(stripIds(expected));expect(draw.mock.calls.at(-1)![0]).toEqual(saved());
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual([]);fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));expect(stripIds(saved())).toEqual(stripIds(expected));
});
it("consumes preview synchronously so same-turn Keep does not duplicate history",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();let replies:(string|null)[]=[];
 act(()=>{replies=[requestChartFibonacci("keep Fibonacci"),requestChartFibonacci("keep Fibonacci")];});
 expect(saved()).toHaveLength(1);expect(replies[1]).toContain("No current Fibonacci preview");
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual([]);expect((screen.getByRole("button",{name:"Undo",exact:true}) as HTMLButtonElement).disabled).toBe(true);
});
it("stale source/window refuses Keep and withdraws preview with no save",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();read={...ready(),proposal:{...ready().proposal!,comparisonKey:"revised"}} as ChartFibonacciRead;
 expect(ask("keep Fibonacci")).toContain("Preview withdrawn");expect(saved()).toEqual([]);expect(draw.mock.calls.at(-1)![0]).toEqual([]);
 expect(ask("keep Fibonacci")).toContain("No current Fibonacci preview");
});
it("unknown source and absent preview never create a kept object",()=>{
 render(<ChartWorkbenchTools {...props}/>);expect(ask("keep Fibonacci")).toContain("No current Fibonacci preview");preview();read={status:"unavailable",proposal:null,reason:"Original source unavailable"};expect(ask("keep Fibonacci")).toContain("Original source unavailable");expect(saved()).toEqual([]);
});
it("an external full collection prevents Keep without removing its manual objects",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();
 const full=Array.from({length:MAX_DRAWINGS},(_,i)=>({id:`manual-${i}`,kind:"horizontal",start:{time:1000,price:10+i},color:"#ffffff"}));
 act(()=>{localStorage.setItem(key,JSON.stringify(full));window.dispatchEvent(new StorageEvent("storage",{key}));});
 expect(ask("keep Fibonacci")).not.toContain("kept as your editable drawing");expect(saved()).toEqual(full);
});
it("hide/show/remove selected Fib use manual history and preserve every other property",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();ask("keep Fibonacci");const kept=saved()[0]!;
 expect(ask("hide selected Fibonacci")).toContain("hidden");expect(saved()).toEqual([{...kept,hidden:true}]);
 expect(ask("show selected Fibonacci")).toContain("shown");expect(saved()).toEqual([kept]);
 expect(ask("remove selected Fibonacci")).toContain("removed");expect(saved()).toEqual([]);
 fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual([kept]);
});
it("manual hidden selected Fib can be recovered through language even without automatic pivots",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));const kept=saved()[0]!;
 fireEvent.click(screen.getByRole("button",{name:"Hide drawing 1",exact:true}));read={status:"unavailable",proposal:null,reason:"No confirmed pivots"};
 expect(ask("show selected Fibonacci")).toContain("shown");expect(saved()).toEqual([kept]);
 fireEvent.click(screen.getByRole("button",{name:"Hide drawings",exact:true}));expect(ask("show selected Fibonacci")).toContain("global drawing visibility remains off");
 expect(draw.mock.calls.at(-1)![0]).toEqual([]);
});
it("no selection, non-Fib selection, unsupported compounds and unmount refuse without mutations",()=>{
 localStorage.setItem(key,JSON.stringify([{id:"line",kind:"horizontal",start:origin.start,color:"#ffffff"}]));const view=render(<ChartWorkbenchTools {...props}/>);const before=saved();
 expect(ask("remove selected Fibonacci")).toContain("Select one");fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));fireEvent.click(screen.getByRole("button",{name:"Select drawing 1"}));
 for(const text of ["hide selected Fibonacci","show selected Fibonacci","remove selected Fibonacci"]){expect(ask(text)).toContain("Select one");}expect(saved()).toEqual(before);
 for(const text of ["keep Fibonacci and buy","remove selected Fibonacci on USDJPY","hide all Fibonacci"]){expect(ask(text)).toContain("Chart not changed");}expect(saved()).toEqual(before);
 view.unmount();expect(ask("keep Fibonacci")).toContain("Select a ready");expect(saved()).toEqual(before);
});
it("same-turn selected hide then show retains both reversible edits",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();ask("keep Fibonacci");const kept=saved()[0]!;
 act(()=>{requestChartFibonacci("hide selected Fibonacci");requestChartFibonacci("show selected Fibonacci");});
 expect(saved()).toEqual([kept]);fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual([{...kept,hidden:true}]);
});

it("storage failure reports open-view-only Keep instead of claiming persistence",()=>{
 render(<ChartWorkbenchTools {...props}/>);preview();const failure=vi.spyOn(Storage.prototype,"setItem").mockImplementation(()=>{throw new Error("quota");});
 try{expect(ask("keep Fibonacci")).toContain("Browser storage is unavailable");expect(saved()).toEqual([]);expect(draw.mock.calls.at(-1)![0]).toHaveLength(1);}finally{failure.mockRestore();}
});
it("hidden manual Fib remains explicitly selectable and all owned controls share manual effects",()=>{
 localStorage.setItem(key,JSON.stringify([{id:"saved",kind:"fibonacci",start:origin.start,end:origin.end,color:"#ffffff",width:3,locked:true,hidden:true}]));
 render(<ChartWorkbenchTools {...props}/>);fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));fireEvent.click(screen.getByRole("button",{name:"Select drawing 1"}));
 ask("show selected Fibonacci");const shown=saved();expect(shown[0].hidden).toBeUndefined();expect(shown[0].locked).toBe(true);expect(shown[0].width).toBe(3);
 fireEvent.click(screen.getByRole("button",{name:"Hide drawing 1",exact:true}));const manualHidden=saved();ask("show selected Fibonacci");ask("hide selected Fibonacci");expect(saved()).toEqual(manualHidden);
 fireEvent.click(screen.getByRole("button",{name:"Delete drawing 1",exact:true}));expect(saved()).toEqual([]);fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toEqual(manualHidden);
 fireEvent.click(screen.getByRole("button",{name:"Select drawing 1"}));ask("remove selected Fibonacci");expect(saved()).toEqual([]);
});
