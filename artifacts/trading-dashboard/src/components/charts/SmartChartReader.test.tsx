import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineAdapter, ChartEngineCandle } from "@/lib/chart-engine";
import { SmartChartReader, findingAnnotation } from "./SmartChartReader";
import { captureChartReplay } from "@/lib/chart-engine/chartReplay";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { analyzeSmartChart, type SmartChartFinding } from "@/lib/chart-engine/smartChartAnalysis";
vi.mock("@/lib/chart-engine/smartChartAnalysis",async importOriginal=>{
  const actual=await importOriginal<typeof import("@/lib/chart-engine/smartChartAnalysis")>();
  return {...actual,analyzeSmartChart:vi.fn(actual.analyzeSmartChart)};
});
import { describeSmartChartWindow } from "@/lib/chart-engine/chartDescriptiveAnalysis";
vi.mock("@/lib/chart-engine/chartDescriptiveAnalysis",async importOriginal=>{
  const actual=await importOriginal<typeof import("@/lib/chart-engine/chartDescriptiveAnalysis")>();
  return {...actual,describeSmartChartWindow:vi.fn(actual.describeSmartChartWindow)};
});
const START=Date.parse("2026-10-25T10:00:00Z"),NOW=START+100*300_000;
function fixture(){
  const candles=Array.from({length:30},(_,i)=>({symbol:"V75",timeframe:"M5",source:"deriv_public",sourceMode:"live",openTime:new Date(START+i*300_000).toISOString(),closeTime:new Date(START+(i+1)*300_000).toISOString(),open:100,high:101,low:99,close:100,isComplete:true,isFinal:true,isForming:false,qualityFlags:[]}));
  const data={symbol:"V75",timeframe:"M5",source:"deriv_public",quality:"clean",candles,feedStatus:{source:"deriv_public"},marketEvidence:{symbol:"V75",timeframe:"M5",source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}} as unknown as ChartCandlesResponse;
  let visible:ChartEngineCandle[]=candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}));
  const all=visible;let listener:(()=>void)|undefined;
  const setSmartAnnotation=vi.fn(),unsubscribe=vi.fn(()=>{listener=undefined;});
  const adapter={getVisibleCandles:()=>visible,subscribeViewport:(fn:()=>void)=>{listener=fn;return unsubscribe;},setSmartAnnotation} as unknown as ChartEngineAdapter;
  const props={adapter,epoch:1,symbol:"V75",timeframe:"M5",data,older:[],historyEvidence:null,liveConfirmed:true,readFailed:false};
  return {data,props,all,setSmartAnnotation,unsubscribe,show:(bars:ChartEngineCandle[])=>{visible=bars;act(()=>listener?.());}};
}
beforeEach(()=>{vi.mocked(describeSmartChartWindow).mockClear();vi.mocked(analyzeSmartChart).mockClear();vi.spyOn(Date,"now").mockReturnValue(NOW);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("embedded chart reader follows applied candles",()=>{
  it("automatically explains closed patterns, exposes every detail and shows one annotation",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("are nearly equal");
    const bound=captureSmartChartBars(f.data,{symbol:"V75",timeframe:"M5"},[],null,NOW);
    const result=analyzeSmartChart({...bound.context,bars:bound.bars,asOfMs:NOW,visibleRange:{from:f.all[0]!.time,to:f.all.at(-1)!.time},dataState:"current"});
    expect(screen.getByTestId("chart-reader-anatomy").closest("details")?.hasAttribute("open")).toBe(false);
    expect(screen.getByTestId("chart-reader-anatomy").textContent).toContain("Open");
    const chips=within(screen.getByLabelText("Relevant chart patterns")).getAllByRole("button");
    const more=within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true});
    expect(chips.length).toBeLessThanOrEqual(3);expect(chips.length+more.length).toBe(result.allFindings.length);
    expect(f.setSmartAnnotation.mock.lastCall?.[0]?.id).toBe(result.findings[0]!.id);
    fireEvent.click(screen.getByRole("button",{name:"Show automatic chart annotations"}));
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
  });
  it("distinguishes repeated older readings by their exact UTC as-of time and preserves selection",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    expect(screen.getByText("More readings · deriv_public · times in UTC")).toBeTruthy();
    const more=within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true});
    const dates=more.map(button=>button.querySelector("time")!);
    expect(dates.length).toBeGreaterThan(1);
    expect(new Set(dates.map(time=>time.dateTime)).size).toBeGreaterThan(1);
    for(const time of dates){
      expect(time.textContent).toBe(`As of ${time.dateTime.slice(0,19).replace("T"," ")} UTC`);
      expect(Date.parse(time.dateTime)).toBeLessThanOrEqual(Date.parse(f.data.candles!.at(-1)!.closeTime!));
    }
    const chosenDate=dates.at(-1)!.dateTime;
    fireEvent.click(more.at(-1)!);
    expect(screen.getByText(`Observed shape · observed ${chosenDate.slice(0,19).replace("T"," ")} UTC`)).toBeTruthy();
    expect(f.setSmartAnnotation.mock.lastCall?.[0]?.anchors.at(-1).time).toBeLessThan(Date.parse(chosenDate)/1000);
    expect(screen.getByText("Analysis, evidence and chart statistics").parentElement?.hasAttribute("open")).toBe(false);
  });
  it("historical viewport explains only its own closed prefix and keeps the stale warning",()=>{
    const f=fixture();render(<SmartChartReader {...f.props} liveConfirmed={false} readFailed/>);
    f.show(f.all.slice(0,10));
    expect(screen.getByText(/Historical window · Stored candles/)).toBeTruthy();
    expect(screen.getByText(/10 closed candles analyzed/)).toBeTruthy();
    expect(screen.getByText(/The feed is stale; this describes stored candles/)).toBeTruthy();
    const latest=f.setSmartAnnotation.mock.lastCall?.[0];
    expect(latest.anchors.every((anchor:any)=>anchor.time<=f.all[9]!.time)).toBe(true);
  });
  it("withholds readings when the applied OHLC disagrees, then recovers after application",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    f.show(f.all.map((bar,i)=>i===10?{...bar,close:100.5}:bar));
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("displayed candles are updating");
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    f.show(f.all);expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("are nearly equal");
  });
  it("clears old findings on a source/identity boundary and releases listeners on unmount",()=>{
    const f=fixture(),view=render(<SmartChartReader {...f.props}/>);
    view.rerender(<SmartChartReader {...f.props} data={{...f.data,marketEvidence:null}}/>);
    expect(screen.queryByLabelText("Relevant chart patterns")).toBeNull();
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    view.unmount();expect(f.unsubscribe).toHaveBeenCalled();
  });
  it("historical replay consumes only acknowledged bars and never claims current-feed analysis",()=>{
    const f=fixture();
    const snapshot=captureChartReplay(f.data,7,DEFAULT_PREFERENCES,NOW).snapshot!;
    f.show(f.all.slice(0,10));
    const view=render(<SmartChartReader {...f.props} data={{...f.data,symbol:"EURUSD"}} liveConfirmed replay={{snapshot,installedCount:10}}/>);
    expect(screen.getByText("Historical replay · closed candles only")).toBeTruthy();
    expect(screen.getByText(/10 closed candles analyzed/)).toBeTruthy();
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-replay-installed-count")).toBe("10");
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-analysis-asof")).toBe(String(snapshot.bars[9]!.closeTime));
    expect(screen.getByText(/Replay: only candles known by this point are analyzed/)).toBeTruthy();
    const first=f.setSmartAnnotation.mock.lastCall?.[0];
    expect(first.anchors.every((anchor:any)=>anchor.time<=f.all[9]!.time)).toBe(true);
    // New requested count is not enough: the installed count remains10. A
    // mismatched applied future window refuses instead of using live DTO bars.
    f.show(f.all.slice(15,30));
    expect(screen.queryByLabelText("Relevant chart patterns")).toBeNull();
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    f.show(f.all.slice(0,5));
    view.rerender(<SmartChartReader {...f.props} replay={{snapshot,installedCount:5}}/>);
    expect(screen.getByText(/5 closed candles analyzed/)).toBeTruthy();
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-replay-installed-count")).toBe("5");
    expect(f.setSmartAnnotation.mock.lastCall?.[0]?.anchors.every((anchor:any)=>anchor.time<=f.all[4]!.time)).toBe(true);
    view.rerender(<SmartChartReader {...f.props} replay={{snapshot,installedCount:0}}/>);
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-analysis-asof")).toBeNull();
    expect(screen.queryByLabelText("Relevant chart patterns")).toBeNull();
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
  });
  it("renders actual sloped neckline anchors without inventing a horizontal historical level",()=>{
    const finding={id:"head_and_shoulders:1",status:"confirmed",anchors:[{time:1,price:102,role:"left_shoulder"},{time:2,price:100,role:"neckline_left"},{time:3,price:110,role:"head"},{time:4,price:101,role:"neckline_right"},{time:5,price:103,role:"right_shoulder"}],levels:[{price:104,label:"Neckline now"}]} as SmartChartFinding;
    const annotation=findingAnnotation(finding)!;
    expect(annotation.level).toBeUndefined();expect(annotation.guide).toMatchObject({from:{time:2,price:100},to:{time:4,price:101}});
  });
  it("discloses inverted/nonlinear and close-only views while preserving underlying analysis",()=>{
    const f=fixture();render(<SmartChartReader {...f.props} view={{style:"line",scale:"log",inverted:true}}/>);
    expect(screen.getByText("Inverted scale · higher prices appear lower")).toBeTruthy();
    expect(screen.getByText(/The line shows closes; candle patterns also use open, high and low/)).toBeTruthy();
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("are nearly equal");
  });
  it("keeps factual context concise and metric details collapsed with visible-only warmup",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    expect(screen.getByTestId("chart-reader-context").textContent).toContain("30 closed candles");
    const summary=screen.getByText("Analysis, evidence and chart statistics");expect(summary.parentElement?.hasAttribute("open")).toBe(false);
    expect(screen.getByText("RSI14 · visible seed").parentElement?.textContent).toContain("50");
    f.show(f.all.slice(0,14));
    expect(screen.getByText("RSI14 · visible seed").parentElement?.textContent).toContain("Unavailable");
    expect(screen.getByText("ATR14 · visible seed").parentElement?.textContent).not.toContain("Unavailable");
    expect(screen.getByTestId("chart-reader-context").textContent).toContain("14 closed candles");
    expect(screen.getByText(/RSI14 needs 15 closed candles/)).toBeTruthy();
    expect(screen.getByText("Fit R² in this window").parentElement?.textContent).toContain("Unavailable");
  });
  it("withdraws every descriptive metric with stale display ownership or missing source evidence",()=>{
    const f=fixture(),view=render(<SmartChartReader {...f.props}/>);
    expect(screen.getByLabelText("Descriptive window metrics")).toBeTruthy();
    f.show(f.all.map((bar,i)=>i===2?{...bar,close:100.5}:bar));
    expect(screen.queryByTestId("chart-reader-context")).toBeNull();expect(screen.queryByLabelText("Descriptive window metrics")).toBeNull();
    f.show(f.all);expect(screen.getByLabelText("Descriptive window metrics")).toBeTruthy();
    view.rerender(<SmartChartReader {...f.props} data={{...f.data,marketEvidence:null}}/>);
    expect(screen.queryByLabelText("Descriptive window metrics")).toBeNull();
  });
  it("preserves gap-aware price context while withholding cadence-dependent readings",()=>{
    const f=fixture();
    const gapped=f.data.candles!.filter((_,i)=>i!==10);
    const data={...f.data,candles:gapped};f.show(f.all.filter((_,i)=>i!==10));
    render(<SmartChartReader {...f.props} data={data}/>);
    expect(screen.getByTestId("chart-reader-context").textContent).toContain("29 closed candles");
    expect(screen.getByText("RSI14 · visible seed").parentElement?.textContent).toContain("Unavailable");
    expect(screen.getByText("ATR14 · visible seed").parentElement?.textContent).toContain("Unavailable");
    expect(screen.getAllByText(/Unequal observation intervals are present/).length).toBeGreaterThan(0);
    expect(screen.getByTestId("chart-reader-unusual-move").textContent).toContain("unavailable");
    expect(screen.getByText("Lower / upper close quartile").parentElement?.textContent).toContain("100");
  });

});


describe("Replay analysis duplicate notifications",()=>{
  it("runs once per installed prefix; skips identical viewport notifications and unrelated parent renders",()=>{
    const f=fixture(),snapshot=captureChartReplay(f.data,7,DEFAULT_PREFERENCES,NOW).snapshot!;
    f.show(f.all.slice(0,10));const replay={snapshot,installedCount:10};
    const v=render(<SmartChartReader {...f.props} replay={replay}/>);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(1);expect(describeSmartChartWindow).toHaveBeenCalledTimes(1);
    f.show(f.all.slice(0,10));f.show(f.all.slice(0,10));
    v.rerender(<SmartChartReader {...f.props} replay={replay}/>);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(1);expect(describeSmartChartWindow).toHaveBeenCalledTimes(1);
    f.show(f.all.slice(0,9)); // changed actual view recomputes even before installation
    expect(analyzeSmartChart).toHaveBeenCalledTimes(2);
    v.rerender(<SmartChartReader {...f.props} replay={{snapshot,installedCount:9}}/>);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(3);expect(describeSmartChartWindow).toHaveBeenCalledTimes(3);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-asof')).toBe(String(snapshot.bars[8]!.closeTime));
    expect(screen.getByTestId('chart-reader-context').textContent).toContain('9 closed candles');
    f.show(f.all.slice(0,9));expect(analyzeSmartChart).toHaveBeenCalledTimes(3);expect(describeSmartChartWindow).toHaveBeenCalledTimes(3);
  });
  it("invalidates changed OHLC, source/epoch, read failure, and axis state while retaining independent annotation controls",()=>{
    const f=fixture(),snapshot=captureChartReplay(f.data,7,DEFAULT_PREFERENCES,NOW).snapshot!;
    const replay={snapshot,installedCount:30};const v=render(<SmartChartReader {...f.props} replay={replay}/>);
    f.show(f.all.map((bar,i)=>i===10?{...bar,close:100.5}:bar));
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')).toBe('unavailable');
    expect(screen.queryByTestId('chart-reader-context')).toBeNull();
    f.show(f.all);expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')).toBe('ready');
    const calls=vi.mocked(analyzeSmartChart).mock.calls.length;
    v.rerender(<SmartChartReader {...f.props} replay={replay} readFailed/>);
    v.rerender(<SmartChartReader {...f.props} replay={replay} epoch={2}/>);
    v.rerender(<SmartChartReader {...f.props} replay={replay} view={{style:'line',scale:'log',inverted:true}}/>);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(calls+3);
    fireEvent.click(screen.getByRole('button',{name:'Show automatic chart annotations'}));
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    const selected=within(screen.getByLabelText('Relevant chart patterns')).getAllByRole('button');
    fireEvent.click(selected.at(-1)!);
    f.show(f.all);expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    fireEvent.click(screen.getByRole('button',{name:'Show automatic chart annotations'}));
    expect(f.setSmartAnnotation.mock.lastCall?.[0]).toBeTruthy();
    const next={...snapshot,sourceIdentity:'b'.repeat(64)};
    v.rerender(<SmartChartReader {...f.props} replay={{snapshot:next,installedCount:30}}/>);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-source-identity')).toBe('b'.repeat(64));
    v.unmount();expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
  });
  it("never deduplicates live callbacks or a revised same-bar forming tip",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    f.show(f.all);expect(analyzeSmartChart).toHaveBeenCalledTimes(2);
    f.show([...f.all,{...f.all.at(-1)!,time:f.all.at(-1)!.time+300}]);
    f.show([...f.all,{...f.all.at(-1)!,time:f.all.at(-1)!.time+300,close:100.5}]);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(4);expect(describeSmartChartWindow).toHaveBeenCalledTimes(4);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-asof')).toBe(String(START/1000+30*300));
  });
});
