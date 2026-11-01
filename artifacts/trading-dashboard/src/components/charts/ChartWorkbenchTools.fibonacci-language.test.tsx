import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ChartWorkbenchTools} from "./ChartWorkbenchTools";
import {DEFAULT_PREFERENCES,drawingStorageKey,type ChartDrawing} from "@/lib/chart-engine/chartWorkspace";
import {requestChartFibonacci} from "@/lib/chart-engine/chartFibonacciAssistant";
import type {ChartFibonacciRead} from "@/lib/chart-engine/chartAutoFibonacci";
import type {ChartEngineAdapter} from "@/lib/chart-engine";
const origin={method:"confirmed-swings-v1" as const,span:2 as const,symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),start:{time:1000,price:10},end:{time:1300,price:20},confirmedAt:1480,windowFrom:880,windowTo:1600,closedBars:12};
const ready=():ChartFibonacciRead=>({status:"ready",reason:null,proposal:{comparisonKey:"sample-a",origin,note:"Twelve observed closed bars; no forecast."}});
let read:ChartFibonacciRead;
const draw=vi.fn(),engine={setDrawings:draw,setDrawingInteraction:vi.fn()} as unknown as ChartEngineAdapter;
const props={adapter:engine,epoch:1,symbol:"EURUSD",timeframe:"M1",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:"Offline",getFibonacciProposal:()=>read,assistantPrimary:true};
const saved=()=>JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M1"))??"[]") as ChartDrawing[];
const ask=(text:string)=>{let reply:string|null=null;act(()=>{reply=requestChartFibonacci(text);});return reply;};
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();read=ready();});afterEach(cleanup);
it("manual and text preview share exact owner geometry and never auto-keep",()=>{
 render(<ChartWorkbenchTools {...props}/>);
 fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
 const manual=draw.mock.calls.at(-1)![0];fireEvent.click(screen.getByRole("button",{name:"Dismiss preview"}));
 const reply=ask("show automatic Fibonacci on this chart");
 expect(reply).toContain("Prepared an unaccepted Fibonacci preview");expect(draw.mock.calls.at(-1)![0]).toEqual(manual);
 expect(reply).toContain("23.6%: 12.36");expect(reply).toContain("EURUSD M1");expect(saved()).toEqual([]);
});
it("curiosity prepares a real preview while unsupported additions do nothing",()=>{
 render(<ChartWorkbenchTools {...props}/>);const reply=ask("what does Fibonacci show me about this chart?");
 expect(reply).toContain("confirmed by two observed closed bars");expect(screen.getByRole("button",{name:"Keep and edit Fibonacci"})).toBeTruthy();
 const calls=draw.mock.calls.length;
 for(const text of ["show Fibonacci on USDJPY","show Fibonacci on M5","show Fibonacci with span 5","keep Fibonacci","hide Fibonacci","remove Fibonacci","show Fibonacci and buy now"]){expect(ask(text)).toContain("Chart not changed");}
 expect(draw).toHaveBeenCalledTimes(calls);expect(saved()).toEqual([]);
});
it("refuses unknown source and explains refreshed evidence instead of retaining old anchors",()=>{
 const view=render(<ChartWorkbenchTools {...props}/>);ask("show Fibonacci");
 expect(ask("explain Fibonacci preview")).toContain("is applied");
 read={status:"unavailable",proposal:null,reason:"Unknown source evidence"};
 expect(ask("explain Fibonacci preview")).toContain("Unknown source evidence");expect(draw.mock.calls.at(-1)![0]).toEqual([]);
 read={status:"ready",reason:null,proposal:{...ready().proposal!,comparisonKey:"new-source",origin:{...origin,start:{...origin.start,price:20},end:{...origin.end,price:40},sourceIdentity:"b".repeat(64)}}};
 view.rerender(<ChartWorkbenchTools {...props} epoch={2}/>);
 const reply=ask("what is Fibonacci?");expect(reply).toContain("23.6%: 24.72");expect(reply).toContain("b".repeat(64));expect(reply).not.toContain("23.6%: 12.36");expect(saved()).toEqual([]);
});
it("distinguishes a selected user's edited anchors from archived automatic provenance",()=>{
 render(<ChartWorkbenchTools {...props}/>);ask("show Fibonacci");fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));
 const interaction=vi.mocked(engine.setDrawingInteraction!).mock.calls.at(-1)![0]!;
 act(()=>interaction.onCommit(saved().map(d=>({...d,end:{time:1300,price:30}}))));
 const before=JSON.stringify(saved()),reply=ask("explain selected Fibonacci");
 expect(reply).toContain("current editable anchors are your annotation");expect(reply).toContain("23.6%: 14.72");expect(reply).toContain("originally used 10");expect(reply).toContain("and 20");expect(JSON.stringify(saved())).toBe(before);
});
it("secondary and replay tools do not hijack primary ownership and unmount releases it",()=>{
 const primary=render(<ChartWorkbenchTools {...props}/>);
 const other=render(<><ChartWorkbenchTools {...props} assistantPrimary={false} symbol="USDJPY"/><ChartWorkbenchTools {...props} ephemeralDrawings assistantPrimary symbol="V75"/></>);
 expect(ask("show Fibonacci")).toContain("EURUSD M1");primary.unmount();expect(ask("show Fibonacci")).toContain("Open the primary");other.unmount();
});
it("explicit selected explanation without selection refuses without preparing or saving",()=>{
 render(<ChartWorkbenchTools {...props}/>);draw.mockClear();expect(ask("explain selected Fibonacci")).toContain("Select one");expect(draw).not.toHaveBeenCalled();expect(saved()).toEqual([]);
});
it("curiosity respects selected manual edits and visibility instead of creating another drawing",()=>{
 render(<ChartWorkbenchTools {...props}/>);ask("show Fibonacci");fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));
 fireEvent.click(screen.getByRole("button",{name:"Hide drawings",exact:true}));
 draw.mockClear();const before=JSON.stringify(saved()),reply=ask("what is Fibonacci?");
 expect(reply).toContain("Selected manual Fibonacci");expect(reply).toContain("(hidden)");expect(JSON.stringify(saved())).toBe(before);expect(draw).not.toHaveBeenCalled();
 expect(screen.queryByRole("button",{name:"Keep and edit Fibonacci"})).toBeNull();
});
it("preview explanation with no preview stays read-only and rendererless ownership refuses",()=>{
 const view=render(<ChartWorkbenchTools {...props}/>);draw.mockClear();expect(ask("explain Fibonacci preview")).toContain("no current Fibonacci preview");expect(draw).not.toHaveBeenCalled();
 view.rerender(<ChartWorkbenchTools {...props} adapter={null}/>);
 expect(ask("show Fibonacci")).toContain("not ready");expect(saved()).toEqual([]);
});
it("explaining a changed frozen preview never describes the old anchors as current",()=>{
 render(<ChartWorkbenchTools {...props}/>);ask("show Fibonacci");
 read={status:"ready",reason:null,proposal:{...ready().proposal!,comparisonKey:"revised",origin:{...origin,end:{time:1300,price:30}}}};
 const reply=ask("explain Fibonacci preview");expect(reply).toContain("previous Fibonacci preview is withdrawn");expect(reply).not.toContain("23.6%:");expect(draw.mock.calls.at(-1)![0]).toEqual([]);
});

it("explains a user's flat edited range without inventing a rise or fall",()=>{
 render(<ChartWorkbenchTools {...props}/>);ask("show Fibonacci");fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));
 const interaction=vi.mocked(engine.setDrawingInteraction!).mock.calls.at(-1)![0]!;
 act(()=>interaction.onCommit(saved().map(d=>({...d,end:{time:1300,price:10}}))));
 const reply=ask("explain selected Fibonacci");expect(reply).toContain("The range is flat");expect(reply).not.toContain("The range falls");
});

it("does not crash on an archived timestamp outside the Date range",()=>{
 localStorage.setItem(drawingStorageKey("EURUSD","M1"),JSON.stringify([{id:"saved",kind:"fibonacci",start:origin.start,end:origin.end,color:"#fbbf24",fibonacciOrigin:{...origin,confirmedAt:1e300,windowTo:1e300}}]));
 render(<ChartWorkbenchTools {...props}/>);fireEvent.click(screen.getByRole("button",{name:"Objects (1)",exact:true}));fireEvent.click(screen.getByRole("button",{name:"Select drawing 1"}));
 expect(ask("explain selected Fibonacci")).toContain("No automatic source provenance");
 expect(draw.mock.calls.at(-1)![0]).toHaveLength(1);
});
