import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartReplayPlayer from "./ChartReplayPlayer";
import type { ChartReplaySnapshot } from "@/lib/chart-engine/chartReplay";
import { parseWallClockInZone, toWallClockInput } from "@/lib/chart-engine/chartTimeZone";
const engine=vi.hoisted(()=>({init:vi.fn(),destroy:vi.fn(),resize:vi.fn(),setSymbol:vi.fn(),setTimeframe:vi.fn(),setFeedState:vi.fn(),setCandles:vi.fn(),setOverlays:vi.fn(),setStructureLines:vi.fn(),setChartStyle:vi.fn(),setScaleMode:vi.fn(),setPriceScaleInverted:vi.fn(),setStudies:vi.fn(),setDrawings:vi.fn(),setDrawingInteraction:vi.fn(),setDrawingHandler:vi.fn(),goToLatest:vi.fn(),panBy:vi.fn(),zoomBy:vi.fn(),fitHistory:vi.fn(),goToTime:vi.fn(),setDisplayTimeZone:vi.fn()}));
vi.mock("@/lib/chart-engine",()=>({createChartEngineAdapter:()=>engine}));
function snapshot():ChartReplaySnapshot{return {id:"session-1",ownerId:7,symbol:"V75",timeframe:"M15",source:"deriv_public",sourceIdentity:"a".repeat(64),capturedAt:1800000000000,lastClosedAt:1700000000+120*900,gaps:0,preferences:{style:"candles",scale:"linear",studies:[]},bars:Array.from({length:120},(_,i)=>({time:1700000000+i*900,closeTime:1700000000+(i+1)*900,open:100+i,high:102+i,low:99+i,close:101+i}))};}
beforeEach(()=>{vi.useFakeTimers();vi.clearAllMocks();vi.stubGlobal("ResizeObserver",class{observe(){}disconnect(){}});vi.stubGlobal("fetch",vi.fn());vi.stubGlobal("EventSource",vi.fn());vi.spyOn(document,"hidden","get").mockReturnValue(false);localStorage.clear();});
afterEach(()=>{cleanup();vi.useRealTimers();vi.restoreAllMocks();vi.unstubAllGlobals();});
describe("isolated chart replay player",()=>{
 it("installs historical prefix only and makes no market/account or stream requests",()=>{
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(100);
  expect(engine.setFeedState).toHaveBeenCalledWith({livePriceAffordance:false,source:"deriv_public"});
  expect(engine.setOverlays).toHaveBeenCalledWith([],null);expect(engine.setStructureLines).toHaveBeenCalledWith([],[]);
  expect(fetch).not.toHaveBeenCalled();expect(EventSource).not.toHaveBeenCalled();
  expect(screen.getByText("Historical replay · analysis only")).toBeTruthy();
  expect(screen.queryByRole("button",{name:/place|buy|sell|order|arm live/i})).toBeNull();
 });
 it("rapid backwards/forwards seeks install exactly the current prefix before paint",()=>{
  const seen:number[]=[];const read=(event:Event)=>seen.push((event as CustomEvent).detail.count);window.addEventListener("arx.chart.replay.applied",read);
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Replay position"),{target:{value:"120"}});
  fireEvent.change(screen.getByLabelText("Replay position"),{target:{value:"4"}});
  expect(engine.setCandles.mock.lastCall?.[0].map((bar:any)=>bar.time)).toEqual(snapshot().bars.slice(0,4).map(bar=>bar.time));
  expect(screen.getByTestId("replay-canvas").getAttribute("data-installed-count")).toBe("4");
  expect(seen.at(-1)).toBe(4);window.removeEventListener("arx.chart.replay.applied",read);
 });
 it("advances at requested speed, stops at end and never schedules catch-up bursts",()=>{
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Replay speed"),{target:{value:"4"}});fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));
  act(()=>vi.advanceTimersByTime(250));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(101);
  fireEvent.change(screen.getByLabelText("Replay position"),{target:{value:"119"}});fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));
  act(()=>vi.advanceTimersByTime(5000));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(120);
  expect((screen.getByRole("button",{name:"Play",exact:true}) as HTMLButtonElement).disabled).toBe(true);
 });
 it("pauses when hidden and disposes playback/engine on unmount",()=>{
  const view=render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  fireEvent.click(screen.getByRole("button",{name:"Play",exact:true}));vi.spyOn(document,"hidden","get").mockReturnValue(true);
  fireEvent(document,new Event("visibilitychange"));act(()=>vi.advanceTimersByTime(10_000));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(100);
  view.unmount();const calls=engine.setCandles.mock.calls.length;act(()=>vi.advanceTimersByTime(10_000));expect(engine.setCandles.mock.calls).toHaveLength(calls);expect(engine.destroy).toHaveBeenCalledTimes(1);
 });
 it("does not load live annotations and keeps replay drawings in memory only",()=>{
  localStorage.setItem("arx.chart.drawings.v1:V75:M15",JSON.stringify([{id:"live",kind:"horizontal",start:{time:1700000000,price:9000},color:"#ffffff"}]));
  const storage=vi.spyOn(Storage.prototype,"setItem");
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  expect(engine.setDrawings.mock.calls.every(call=>call[0].length===0)).toBe(true);
  expect(screen.getByRole("button",{name:"Objects (0)"})).toBeTruthy();expect(storage).not.toHaveBeenCalled();
 });
 it("focused chart keys pan/zoom without advancing the replay cursor",()=>{
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  const canvas=screen.getByTestId("replay-canvas"),calls=engine.setCandles.mock.calls.length;
  expect(canvas.getAttribute("tabindex")).toBe("0");
  fireEvent.keyDown(canvas,{key:"ArrowLeft"});fireEvent.keyDown(canvas,{key:"ArrowRight"});
  fireEvent.keyDown(canvas,{key:"+"});fireEvent.keyDown(canvas,{key:"-"});
  fireEvent.keyDown(canvas,{key:"Home"});fireEvent.keyDown(canvas,{key:"End"});
  expect(engine.panBy.mock.calls).toEqual([[-.25],[.25]]);expect(engine.zoomBy.mock.calls).toEqual([[.75],[4/3]]);
  expect(engine.fitHistory).toHaveBeenCalledOnce();expect(engine.goToLatest).toHaveBeenLastCalledWith(false);
  expect(engine.setCandles.mock.calls).toHaveLength(calls);
  expect(canvas.getAttribute("data-installed-count")).toBe("100");
 });
 it("date navigation explains the revealed replay boundary without promising a network history load",()=>{
  engine.goToTime.mockReturnValue(false);render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Go to UTC date and time"),{target:{value:"2020-01-01T00:00"}});
  fireEvent.click(screen.getByRole("button",{name:"Go to UTC",exact:true}));
  expect(screen.getByText(/outside the revealed replay window/)).toBeTruthy();
  expect(screen.queryByText(/Pan left to load older candles/)).toBeNull();
  expect(fetch).not.toHaveBeenCalled();
 });
 it("uses UTC close boundaries and preserves keyboard access without hijacking inputs",()=>{
  const data=snapshot();render(<ChartReplayPlayer snapshot={data} onExit={vi.fn()}/>);
  fireEvent.change(screen.getByLabelText("Replay through UTC close"),{target:{value:new Date(data.bars[49]!.closeTime*1000).toISOString().slice(0,19)}});
  fireEvent.click(screen.getByRole("button",{name:"Seek",exact:true}));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(50);
  fireEvent.keyDown(window,{key:"ArrowRight"});expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(51);
  fireEvent.keyDown(screen.getByLabelText("Replay through UTC close"),{key:"ArrowLeft"});expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(51);
 });
 it("leaves native evidence disclosure keys available without starting playback",()=>{
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  const summary=screen.getByText("Analysis, evidence and chart statistics");
  for(const [key,code] of [[" ","Space"],["ArrowRight","ArrowRight"],["ArrowLeft","ArrowLeft"]]){
   const event=new KeyboardEvent("keydown",{key,code,bubbles:true,cancelable:true});
   fireEvent(summary,event);expect(event.defaultPrevented).toBe(false);
  }
  act(()=>vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button",{name:"Play",exact:true}).getAttribute("aria-pressed")).toBe("false");
  expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(100);
 });
 it("does not take shortcuts already handled by another control",()=>{
  render(<ChartReplayPlayer snapshot={snapshot()} onExit={vi.fn()}/>);
  const event=new KeyboardEvent("keydown",{key:" ",code:"Space",bubbles:true,cancelable:true});
  event.preventDefault();fireEvent(window,event);act(()=>vi.advanceTimersByTime(2000));
  expect(screen.getByRole("button",{name:"Play",exact:true}).getAttribute("aria-pressed")).toBe("false");
  expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(100);
 });
 it("forwards a frozen Heikin Ashi style to the replay engine",()=>{
  const data={...snapshot(),preferences:{style:"heikinAshi",scale:"linear",studies:[]}} as ChartReplaySnapshot;
  render(<ChartReplayPlayer snapshot={data} onExit={vi.fn()}/>);
  expect(engine.setChartStyle).toHaveBeenLastCalledWith("heikinAshi");
  expect(engine.setChartStyle.mock.calls.every(args=>args[0]==="heikinAshi")).toBe(true);
 });
 it("keeps the UTC default and prints the capture time to the second with its zone",()=>{
  render(<ChartReplayPlayer snapshot={{...snapshot(),capturedAt:1800000000123}} onExit={vi.fn()}/>);
  expect(screen.getByText(/Captured 2027-01-15 08:00:00 UTC\./)).toBeTruthy();
  expect(screen.getByTestId("replay-cursor").textContent).toBe(`Bar 100 / 120 · closed ${new Date(snapshot().bars[99]!.closeTime*1000).toISOString().replace("T"," ").replace(".000Z"," UTC")} · Paused`);
  expect(engine.setDisplayTimeZone).toHaveBeenLastCalledWith("UTC");
 });
 it("labels, bounds and seeks the replay in the view's display zone",()=>{
  const data={...snapshot(),preferences:{style:"candles",scale:"linear",studies:[],timeZone:"Asia/Tokyo"}} as ChartReplaySnapshot;
  render(<ChartReplayPlayer snapshot={data} onExit={vi.fn()}/>);
  expect(engine.setDisplayTimeZone).toHaveBeenCalledWith("Asia/Tokyo");
  const input=screen.getByLabelText("Replay through Asia/Tokyo close") as HTMLInputElement;
  expect(input.min).toBe(toWallClockInput(data.bars[0]!.closeTime,"Asia/Tokyo",true));
  expect(input.max).toBe(toWallClockInput(data.lastClosedAt,"Asia/Tokyo",true));
  expect(screen.getByTestId("replay-cursor").textContent!.endsWith("GMT+9 · Paused")).toBe(true);
  fireEvent.change(input,{target:{value:toWallClockInput(data.bars[49]!.closeTime,"Asia/Tokyo",true)}});
  fireEvent.click(screen.getByRole("button",{name:"Seek",exact:true}));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(50);
  expect(screen.getByText("Showing closed candles at or before that Asia/Tokyo time.")).toBeTruthy();
  expect(screen.getByLabelText("Go to Asia/Tokyo date and time")).toBeTruthy();
 });
 it("rejects a clock-change gap close time and converts a typed seek on a zone switch without re-applying scale or studies",()=>{
  // 120 M15 bars across the New York spring-forward (2024-03-10 07:00 UTC).
  const start=Date.UTC(2024,2,10,5)/1000;
  const data={...snapshot(),lastClosedAt:start+120*900,bars:snapshot().bars.map((bar,i)=>({...bar,time:start+i*900,closeTime:start+(i+1)*900})),
    preferences:{style:"candles",scale:"log",studies:[],timeZone:"America/New_York"}} as ChartReplaySnapshot;
  render(<ChartReplayPlayer snapshot={data} onExit={vi.fn()}/>);
  const calls=engine.setCandles.mock.calls.length;
  expect((screen.getByLabelText("Replay through America/New_York close") as HTMLInputElement).min).toBe("2024-03-10T00:15:00");
  fireEvent.change(screen.getByLabelText("Replay through America/New_York close"),{target:{value:"2024-03-10T02:30:00"}});
  fireEvent.click(screen.getByRole("button",{name:"Seek",exact:true}));
  expect(screen.getByText("That close time does not exist in America/New_York (clock change).")).toBeTruthy();
  expect(engine.setCandles.mock.calls).toHaveLength(calls);
  const typed=toWallClockInput(data.bars[49]!.closeTime,"America/New_York",true);
  fireEvent.change(screen.getByLabelText("Replay through America/New_York close"),{target:{value:typed}});
  const scale=engine.setScaleMode.mock.calls.length,studies=engine.setStudies.mock.calls.length;
  fireEvent.change(screen.getByLabelText("Display time zone"),{target:{value:"Asia/Tokyo"}});
  expect(engine.setDisplayTimeZone).toHaveBeenLastCalledWith("Asia/Tokyo");
  expect(engine.setScaleMode.mock.calls).toHaveLength(scale);expect(engine.setStudies.mock.calls).toHaveLength(studies);
  // The input normalizes zero seconds away, as browsers do.
  expect((screen.getByLabelText("Replay through Asia/Tokyo close") as HTMLInputElement).value).toBe("2024-03-11T02:30");
  expect(parseWallClockInZone("2024-03-11T02:30","Asia/Tokyo")).toEqual({kind:"ok",time:data.bars[49]!.closeTime,ambiguous:false});
  fireEvent.click(screen.getByRole("button",{name:"Seek",exact:true}));expect(engine.setCandles.mock.lastCall?.[0]).toHaveLength(50);
 });
 it("passes the display zone to the replay chart reader",()=>{
  const flat=snapshot();
  const data={...flat,bars:flat.bars.map(bar=>({...bar,open:100,high:101,low:99,close:100})),preferences:{style:"candles",scale:"linear",studies:[],timeZone:"Asia/Tokyo"}} as ChartReplaySnapshot;
  const visible=engine as unknown as {getVisibleCandles?:()=>unknown};
  visible.getVisibleCandles=()=>engine.setCandles.mock.lastCall?.[0]??[];
  try {
   render(<ChartReplayPlayer snapshot={data} onExit={vi.fn()}/>);
   const reader=screen.getByTestId("smart-chart-reader");
   expect(reader.getAttribute("data-analysis-status")).toBe("ready");
   expect(reader.textContent).toMatch(/times in Asia\/Tokyo|observed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT\+9/);
   expect(reader.textContent).not.toMatch(/\d{2}:\d{2}:\d{2} UTC/);
  } finally { delete visible.getVisibleCandles; }
 });
});
