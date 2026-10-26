import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import ChartReplayPlayer from "./ChartReplayPlayer";
import type { ChartReplaySnapshot } from "@/lib/chart-engine/chartReplay";
const engine=vi.hoisted(()=>({init:vi.fn(),destroy:vi.fn(),resize:vi.fn(),setSymbol:vi.fn(),setTimeframe:vi.fn(),setFeedState:vi.fn(),setCandles:vi.fn(),setOverlays:vi.fn(),setStructureLines:vi.fn(),setChartStyle:vi.fn(),setScaleMode:vi.fn(),setPriceScaleInverted:vi.fn(),setStudies:vi.fn(),setDrawings:vi.fn(),setDrawingInteraction:vi.fn(),setDrawingHandler:vi.fn(),goToLatest:vi.fn(),panBy:vi.fn(),zoomBy:vi.fn(),fitHistory:vi.fn(),goToTime:vi.fn()}));
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
});
