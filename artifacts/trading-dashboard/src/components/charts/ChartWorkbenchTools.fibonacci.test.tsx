import {act,cleanup,fireEvent,render,screen} from "@testing-library/react";
import {afterEach,beforeEach,expect,it,vi} from "vitest";
import {ChartWorkbenchTools,exportLabels} from "./ChartWorkbenchTools";
import {DEFAULT_PREFERENCES,drawingStorageKey,type ChartDrawing} from "@/lib/chart-engine/chartWorkspace";
import type {ChartEngineAdapter} from "@/lib/chart-engine";
import type {ChartFibonacciRead} from "@/lib/chart-engine/chartAutoFibonacci";
import type {DrawingInteraction} from "@/lib/chart-engine/chartDrawingEditor";
const origin={method:"confirmed-swings-v1" as const,span:2 as const,symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),start:{time:1000,price:10},end:{time:1300,price:20},confirmedAt:1480,windowFrom:880,windowTo:1600,closedBars:12};
const ready=():ChartFibonacciRead=>({status:"ready",reason:null,proposal:{comparisonKey:"sample-a",origin,note:"Twelve closed observations; no trade signal."}});
let read:ChartFibonacciRead,viewport:()=>void,interaction:DrawingInteraction|null;
const setDrawings=vi.fn(),exportImage=vi.fn();
const engine={setDrawings,exportImage,subscribeViewport:(fn:()=>void)=>{viewport=fn;return()=>{};},setDrawingInteraction:(next:DrawingInteraction|null)=>{interaction=next;}} as unknown as ChartEngineAdapter;
const supplier=()=>read;
const props={adapter:engine,epoch:1,symbol:"EURUSD",timeframe:"M1",preferences:DEFAULT_PREFERENCES,onPreferences:vi.fn(),hasCandles:true,feedLabel:"Offline",getFibonacciProposal:supplier};
const saved=()=>JSON.parse(localStorage.getItem(drawingStorageKey("EURUSD","M1"))??"[]") as ChartDrawing[];
beforeEach(()=>{localStorage.clear();vi.clearAllMocks();read=ready();interaction=null;});
afterEach(cleanup);
it("previews without storing or exporting, then keeps one editable drawing through undo",()=>{
  const manual={id:"manual",kind:"horizontal",start:{time:1000,price:12},color:"#ffffff"};
  localStorage.setItem(drawingStorageKey("EURUSD","M1"),JSON.stringify([manual]));
  render(<ChartWorkbenchTools {...props}/>);
  fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  expect(saved()).toEqual([manual]);
  const rendered=setDrawings.mock.calls.at(-1)![0] as ChartDrawing[];
  expect(rendered).toHaveLength(2);expect(rendered[1].locked).toBe(true);
  expect(screen.getByRole("button",{name:"Export PNG"}).hasAttribute("disabled")).toBe(false);
  expect(exportLabels({symbol:"EURUSD",timeframe:"M1",capture:"Now",feedLabel:"Offline",style:"candles",studies:[],fibonacciPreview:true}).join(" ")).toContain("UNACCEPTED automatic Fibonacci preview");
  act(()=>interaction?.onCommit([...rendered.map(d=>d.id==="manual"?{...d,start:{time:1000,price:13}}:d)]));
  expect(saved()).toHaveLength(1);expect(saved()[0].start.price).toBe(13);
  fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));
  expect(saved()).toHaveLength(2);expect(saved()[1]).toMatchObject({locked:false,fibonacciOrigin:origin});
  expect(screen.getByRole("button",{name:"Export PNG"}).hasAttribute("disabled")).toBe(false);
  fireEvent.click(screen.getByRole("button",{name:"Undo",exact:true}));expect(saved()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button",{name:"Redo",exact:true}));expect(saved()).toHaveLength(2);
});
it("withdraws a frozen preview when its source or window changes instead of moving anchors",()=>{
  render(<ChartWorkbenchTools {...props}/>);fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  read={status:"unavailable",proposal:null,reason:"Source evidence changed"};act(()=>viewport());
  expect(setDrawings.mock.calls.at(-1)![0]).toEqual([]);expect(saved()).toEqual([]);
  expect(screen.queryByRole("button",{name:"Keep and edit Fibonacci"})).toBeNull();
  expect(screen.getByText(/Preview withdrawn/)).toBeTruthy();
});
it("rechecks at Keep and preserves kept original provenance when edited or source is revoked",()=>{
  const view=render(<ChartWorkbenchTools {...props}/>);fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  read={...ready(),proposal:{...ready().proposal!,comparisonKey:"changed"}} as ChartFibonacciRead;
  fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));expect(saved()).toEqual([]);
  fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  fireEvent.click(screen.getByRole("button",{name:"Keep and edit Fibonacci"}));
  act(()=>interaction?.onCommit(saved().map(d=>({...d,end:{time:1400,price:21}}))));
  expect(saved()[0].end?.price).toBe(21);expect(saved()[0].fibonacciOrigin?.end.price).toBe(20);
  read={status:"unavailable",proposal:null,reason:"Revoked"};view.rerender(<ChartWorkbenchTools {...props} getFibonacciProposal={()=>read}/>);
  expect(saved()).toHaveLength(1);expect(setDrawings.mock.calls.at(-1)![0][0].end.price).toBe(21);
  expect(screen.getByText(/Original automatic proposal/)).toBeTruthy();
});

it("rechecks at export and does not capture a revoked preview",()=>{
  render(<ChartWorkbenchTools {...props}/>);fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  read={status:"unavailable",proposal:null,reason:"Source revoked immediately before export"};
  fireEvent.click(screen.getByRole("button",{name:"Export PNG"}));
  expect(exportImage).not.toHaveBeenCalled();expect(setDrawings.mock.calls.at(-1)![0]).toEqual([]);expect(saved()).toEqual([]);
});
it("keeps manual undo and template snapshots free of the preview",()=>{
  render(<ChartWorkbenchTools {...props}/>);fireEvent.change(screen.getByLabelText("Drawing tool"),{target:{value:"auto_fibonacci"}});
  expect(screen.getByRole("button",{name:"Undo",exact:true}).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button",{name:"Objects (0)",exact:true})).toBeTruthy();
  expect(localStorage.length).toBe(0);
  fireEvent.click(screen.getByRole("button",{name:"Dismiss preview"}));expect(setDrawings.mock.calls.at(-1)![0]).toEqual([]);
});
