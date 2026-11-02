import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineAdapter, ChartEngineCandle } from "@/lib/chart-engine";
import { SmartChartReader, findingAnnotation } from "./SmartChartReader";
import { captureChartReplay } from "@/lib/chart-engine/chartReplay";
import { DEFAULT_PREFERENCES } from "@/lib/chart-engine/chartWorkspace";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { analyzeSmartChart, type SmartChartFinding } from "@/lib/chart-engine/smartChartAnalysis";
it("preserves independent flag-channel segments without adding a horizontal trigger line",()=>{
 const segments=[{from:{time:1,price:100},to:{time:2,price:110}},{from:{time:3,price:109},to:{time:4,price:108}},{from:{time:3,price:107},to:{time:4,price:106}}];
 const finding={id:"flag",title:"Bull Flag",status:"developing",connectAnchors:false,segments,anchors:[{time:1,price:100,role:"flagpole_start"},{time:2,price:110,role:"flagpole_end"}],levels:[{price:108,label:"Projected trigger"}]} as SmartChartFinding;
 expect(findingAnnotation(finding)).toMatchObject({connectAnchors:false,segments});expect(findingAnnotation(finding)).not.toHaveProperty("level");
});
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
function fixture(timeframe="M5",start=START,step=300_000){
  const candles=Array.from({length:30},(_,i)=>({symbol:"V75",timeframe,source:"deriv_public",sourceMode:"live",timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null},openTime:new Date(start+i*step).toISOString(),closeTime:new Date(start+(i+1)*step).toISOString(),open:100,high:101,low:99,close:100,isComplete:true,isFinal:true,isForming:false,qualityFlags:[]}));
  const data={symbol:"V75",timeframe,source:"deriv_public",quality:"clean",candles,feedStatus:{source:"deriv_public",isLive:true,stale:false,quality:"clean",aiUsable:true,warning:null,message:"Fixture",lastCandleTime:candles.at(-1)!.closeTime},marketEvidence:{symbol:"V75",timeframe,source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}} as unknown as ChartCandlesResponse;
  let visible:ChartEngineCandle[]=candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}));
  const all=visible;let listener:(()=>void)|undefined;
  const setSmartAnnotation=vi.fn(),unsubscribe=vi.fn(()=>{listener=undefined;});
  const adapter={getVisibleCandles:()=>visible,subscribeViewport:(fn:()=>void)=>{listener=fn;return unsubscribe;},setSmartAnnotation} as unknown as ChartEngineAdapter;
  const props={adapter,epoch:1,symbol:"V75",timeframe,data,older:[],historyEvidence:null,liveConfirmed:true,readFailed:false};
  return {data,props,all,setSmartAnnotation,unsubscribe,show:(bars:ChartEngineCandle[])=>{visible=bars;act(()=>listener?.());}};
}
beforeEach(()=>{vi.mocked(describeSmartChartWindow).mockClear();vi.mocked(analyzeSmartChart).mockClear();vi.spyOn(Date,"now").mockReturnValue(NOW);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("embedded chart reader follows applied candles",()=>{
  it("keeps rendered star explanation, annotation and assistant bound to the same actual candle",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();
    const rows=[...[1,1.01,1.02,1.03,1.04].map(close=>({open:close-.001,high:close+.001,low:close-.002,close})),
      {open:1.04,high:1.06,low:1.0395,close:1.041},
      {open:1.04,high:1.06,low:1.0395,close:1.055},
      {open:1.055,high:1.056,low:1.03,close:1.035}];
    const candles=f.data.candles!.slice(0,8).map((bar,i)=>({...bar,...rows[i]!}));
    const data={...f.data,candles,marketEvidence:{...f.data.marketEvidence,lastClosedCandleAt:candles.at(-1)!.closeTime},
      feedStatus:{...f.data.feedStatus,lastCandleTime:candles.at(-1)!.closeTime}} as ChartCandlesResponse;
    f.show(candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close})));
    render(<SmartChartReader {...f.props} data={data} onFindingExplanation={onFindingExplanation}/>);
    const buttons=screen.getAllByRole("button",{name:/^Shooting Star · observed/,hidden:true});
    expect(buttons).toHaveLength(1);fireEvent.click(buttons[0]!);
    const annotation=f.setSmartAnnotation.mock.lastCall![0];
    expect(annotation.id).toBe(`shooting_star:${Date.parse(candles[5]!.openTime)/1000}`);
    expect(annotation.anchors).toEqual([{time:Date.parse(candles[5]!.openTime)/1000,price:1.06,label:"shooting star"}]);
    expect(annotation.dashed).toBe(true);
    const explanation=onFindingExplanation.mock.lastCall![0]();
    expect(explanation).toContain("next close did not confirm");
    expect(explanation).not.toContain("confirming the rejection");
    expect(screen.getByTestId("smart-chart-reader").textContent).toContain("next close did not confirm");
  });

  it("publishes the displayed finding's source, observed geometry and caveats for the local assistant",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();render(<SmartChartReader {...f.props} onFindingExplanation={onFindingExplanation}/>);
    const getter=onFindingExplanation.mock.lastCall?.[0];expect(typeof getter).toBe("function");
    const reply=getter();expect(reply).toContain("V75");expect(reply).toContain("M5");expect(reply).toContain("deriv public");expect(reply).toContain("Observed shape");expect(reply).toContain("Anchors");expect(reply).toContain("not a forecast");
    expect(reply).toContain("UTC");
  });
  it("rejects retained finding readers after a source switch or unmount",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();const view=render(<SmartChartReader {...f.props} onFindingExplanation={onFindingExplanation}/>);
    const old=onFindingExplanation.mock.lastCall?.[0];expect(typeof old).toBe("function");
    view.rerender(<SmartChartReader {...f.props} data={{...f.data,marketEvidence:{...f.data.marketEvidence,sourceIdentity:"b".repeat(64)}} as ChartCandlesResponse} onFindingExplanation={onFindingExplanation}/>);
    expect(old()).toMatch(/changed|no longer|unavailable/i);view.unmount();expect(onFindingExplanation.mock.lastCall?.[0]).toBeNull();expect(old()).toMatch(/changed|no longer|unavailable/i);
  });
  it("states when the selected finding's geometry is hidden",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();render(<SmartChartReader {...f.props} presentationHidden onFindingExplanation={onFindingExplanation}/>);
    const getter=onFindingExplanation.mock.lastCall?.[0];expect(typeof getter).toBe("function");expect(getter()).toMatch(/annotation.*hidden/i);
  });
  it("does not substitute another finding after an explicitly selected observation leaves the viewport",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();render(<SmartChartReader {...f.props} onFindingExplanation={onFindingExplanation}/>);
    const more=within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true});fireEvent.click(more.at(-1)!);
    const old=onFindingExplanation.mock.lastCall![0];f.show(f.all.slice(0,8));
    expect(old()).toMatch(/changed|no longer/);expect(onFindingExplanation.mock.lastCall![0]()).toMatch(/No current selected finding/);
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("no other pattern was substituted");
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
  });
  it("rechecks actual applied OHLC at the instant of the question",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();render(<SmartChartReader {...f.props} onFindingExplanation={onFindingExplanation}/>);
    const getter=onFindingExplanation.mock.lastCall![0];f.all[0].close+=.01;
    expect(getter()).toContain("displayed candles changed");
  });
  it("shows a fallback notice when the existing assistant cannot receive the manual explanation",()=>{
    const f=fixture(),onExplainFinding=vi.fn(()=>false);render(<SmartChartReader {...f.props} onExplainFinding={onExplainFinding}/>);
    fireEvent.click(screen.getByRole("button",{name:"Explain this finding"}));expect(onExplainFinding).toHaveBeenCalledOnce();expect(screen.getByRole("status").textContent).toContain("assistant is unavailable");expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("nearly equal");
  });
  it("preserves unverified-clock and stale-feed caveats in the assistant explanation",()=>{
    const f=fixture(),onFindingExplanation=vi.fn();const data={...f.data,candles:f.data.candles!.map(bar=>({...bar,timeBasisEvidence:undefined})),feedStatus:{...f.data.feedStatus,stale:true,quality:'stale'}} as ChartCandlesResponse;
    render(<SmartChartReader {...f.props} data={data} liveConfirmed={false} onFindingExplanation={onFindingExplanation}/>);
    const reply=onFindingExplanation.mock.lastCall![0]();expect(reply).toContain('feed is stale');expect(reply).toMatch(/clock.*unverified|not.*UTC|UTC.*not/i);expect(reply).not.toContain('Live feed confirmed');
  });
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
    const f=fixture();render(<SmartChartReader {...f.props} data={{...f.data,feedStatus:{...f.data.feedStatus,stale:true,quality:"stale"} as any}} liveConfirmed={false} readFailed/>);
    f.show(f.all.slice(0,10));
    expect(screen.getByText(/Historical window · Stored candles/)).toBeTruthy();
    expect(screen.getByText(/10 closed candles analyzed/)).toBeTruthy();
    expect(screen.getByTestId("chart-reader-feed-evidence").textContent).toContain("The feed is stale; this describes stored candles");
    const latest=f.setSmartAnnotation.mock.lastCall?.[0];
    expect(latest.anchors.every((anchor:any)=>anchor.time<=f.all[9]!.time)).toBe(true);
  });
  it.each([
    ["unconfirmed", false, false, {}, "The feed is not live-confirmed"],
    ["read failure", true, true, {}, "The latest candle read failed"],
    ["unavailable", false, false, {quality:"unavailable"}, "The current feed is unavailable"],
    ["delayed", false, false, {quality:"delayed"}, "The feed reports delayed data"],
  ] as const)("does not invent stale evidence for %s",(_,liveConfirmed,readFailed,feed,message)=>{
    const f=fixture();render(<SmartChartReader {...f.props} liveConfirmed={liveConfirmed} readFailed={readFailed} data={{...f.data,feedStatus:{...f.data.feedStatus,...feed} as any}}/>);
    const text=screen.getByTestId("smart-chart-reader").textContent!;
    expect(text).toContain(message);expect(text).not.toContain("The feed is stale");
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
    expect(screen.getByText(/30 closed candles analyzed/)).toBeTruthy();
    expect(f.setSmartAnnotation.mock.lastCall?.[0]).not.toBeNull();
  });
  it("preserves proven stale evidence and independent read failure, then recovers without changing geometry",()=>{
    const f=fixture();const stale={...f.data,feedStatus:{...f.data.feedStatus,stale:true,quality:"stale"} as any};
    const view=render(<SmartChartReader {...f.props} data={stale} liveConfirmed={false}/>);
    const first=f.setSmartAnnotation.mock.lastCall?.[0];
    view.rerender(<SmartChartReader {...f.props} data={stale} liveConfirmed={false} readFailed/>);
    expect(screen.getByTestId("smart-chart-reader").textContent).toContain("The feed is stale");
    expect(screen.getByTestId("smart-chart-reader").textContent).toContain("The latest candle read failed");
    expect(f.setSmartAnnotation.mock.lastCall?.[0]).toEqual(first);
    view.rerender(<SmartChartReader {...f.props}/>);
    expect(screen.getByTestId("smart-chart-reader").textContent).not.toContain("The feed is stale");
    expect(screen.getByTestId("smart-chart-reader").textContent).not.toContain("The latest candle read failed");
    expect(f.setSmartAnnotation.mock.lastCall?.[0]).toEqual(first);
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
  it("labels reading times in the view's display zone while machine-readable times stay UTC ISO",()=>{
    const f=fixture();
    const visible=vi.fn(f.props.adapter.getVisibleCandles!);
    const props={...f.props,adapter:{...f.props.adapter,getVisibleCandles:visible} as ChartEngineAdapter};
    const view=render(<SmartChartReader {...props} view={{style:"candles",scale:"linear",timeZone:"Asia/Tokyo"}}/>);
    expect(screen.getByText("More readings · deriv_public · times in Asia/Tokyo")).toBeTruthy();
    const dates=within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true}).map(button=>button.querySelector("time")!);
    expect(dates.length).toBeGreaterThan(1);
    for(const time of dates){
      expect(time.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      expect(time.textContent).toMatch(/^As of \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT\+9$/);
    }
    fireEvent.click(within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true}).at(-1)!);
    expect(screen.getByText(/· observed \d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2} GMT\+9$/)).toBeTruthy();
    const reads=visible.mock.calls.length,analyses=vi.mocked(analyzeSmartChart).mock.calls.length,descriptions=vi.mocked(describeSmartChartWindow).mock.calls.length;
    view.rerender(<SmartChartReader {...props} view={{style:"candles",scale:"linear",timeZone:"America/New_York"}}/>);
    view.rerender(<SmartChartReader {...props} view={{style:"candles",scale:"linear"}}/>);
    expect(visible.mock.calls).toHaveLength(reads);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(analyses);expect(describeSmartChartWindow).toHaveBeenCalledTimes(descriptions);
    expect(screen.getByText("More readings · deriv_public · times in UTC")).toBeTruthy();
  });
  it("keeps daily readings in UTC whatever zone the view selects",()=>{
    const start=Date.parse("2026-09-01T00:00:00Z");
    vi.spyOn(Date,"now").mockReturnValue(start+40*86_400_000);
    const f=fixture("D1",start,86_400_000);
    render(<SmartChartReader {...f.props} view={{style:"candles",scale:"linear",timeZone:"Asia/Tokyo"}}/>);
    expect(screen.getByTestId("smart-chart-reader").getAttribute("data-analysis-status")).toBe("ready");
    expect(screen.getByText("More readings · deriv_public · times in UTC")).toBeTruthy();
    expect(screen.getByTestId("smart-chart-reader").textContent).not.toContain("GMT+9");
  });
  it("discloses inverted/nonlinear and close-only views while preserving underlying analysis",()=>{
    const f=fixture();render(<SmartChartReader {...f.props} view={{style:"line",scale:"log",inverted:true}}/>);
    expect(screen.getByText("Inverted scale · higher prices appear lower")).toBeTruthy();
    expect(screen.getByText(/The line shows closes; candle patterns also use open, high and low/)).toBeTruthy();
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("are nearly equal");
  });
  it.each([
    ["heikinAshi","Display: Heikin Ashi · linear scale","Heikin Ashi bodies are averaged, not traded prices; readings, pattern anchors, drawings and trade levels use the underlying candles."],
    ["area","Display: Close area · linear scale","The area shows closes; candle patterns also use open, high and low prices."],
    ["hollow","Display: Hollow candles · linear scale","Hollow candle fill and colour are display encodings of the same OHLC"],
  ] as const)("names the %s style and states what it shows",(style,name,note)=>{
    const f=fixture();render(<SmartChartReader {...f.props} view={{style,scale:"linear"}}/>);
    const display=screen.getByText(text=>text.startsWith("Display: "));
    expect(display.textContent).toContain(name);
    expect(display.textContent).toContain("Readings use the underlying prices and selected period.");
    expect(display.textContent).toContain(note);
    expect(display.textContent).not.toContain("The line shows closes");
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
  it("invalidates changed OHLC, source/epoch and axis state while frozen replay ignores unrelated live read failure",()=>{
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
    expect(analyzeSmartChart).toHaveBeenCalledTimes(calls+2);
    expect(screen.queryByTestId("chart-reader-feed-evidence")).toBeNull();
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
  it("reuses validated closed analysis for duplicate live callbacks and a revised unconfirmed tip",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    f.show(f.all);expect(analyzeSmartChart).toHaveBeenCalledTimes(1);
    f.show([...f.all,{...f.all.at(-1)!,time:f.all.at(-1)!.time+300}]);
    f.show([...f.all,{...f.all.at(-1)!,time:f.all.at(-1)!.time+300,close:100.5}]);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(1);expect(describeSmartChartWindow).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-asof')).toBe(String(START/1000+30*300));
  });
  it("withdraws cached live findings on clock rollback, then recovers without stale annotations",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    vi.mocked(Date.now).mockReturnValue(START+30*300_000-1);
    f.show(f.all);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')).toBe('unavailable');
    expect(screen.queryByTestId('chart-reader-context')).toBeNull();
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
    vi.mocked(Date.now).mockReturnValue(NOW);f.show(f.all);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')).toBe('ready');
    expect(f.setSmartAnnotation.mock.lastCall?.[0]).toBeTruthy();
    expect(analyzeSmartChart).toHaveBeenCalledTimes(3);
  });
  it("does not carry a live cache across read failure, engine epoch or source changes",()=>{
    const f=fixture(),view=render(<SmartChartReader {...f.props}/>);
    f.show(f.all);expect(analyzeSmartChart).toHaveBeenCalledTimes(1);
    view.rerender(<SmartChartReader {...f.props} readFailed/>);
    expect(screen.getByTestId("chart-reader-feed-evidence").textContent).toContain("The latest candle read failed");
    expect(screen.getByTestId("chart-reader-feed-evidence").textContent).not.toContain("The feed is stale");
    expect(analyzeSmartChart).toHaveBeenCalledTimes(2);
    view.rerender(<SmartChartReader {...f.props} epoch={2}/>);
    expect(analyzeSmartChart).toHaveBeenCalledTimes(3);
    view.rerender(<SmartChartReader {...f.props} epoch={2} data={{...f.data,marketEvidence:null}}/>);
    expect(screen.getByTestId('smart-chart-reader').getAttribute('data-analysis-status')).toBe('unavailable');
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
  });
});


it("keeps source-coordinate reading times and omits false UTC machine timestamps after evidence withdrawal",()=>{
 const f=fixture(), view=render(<SmartChartReader {...f.props} view={{style:"candles",scale:"linear",timeZone:"Asia/Tokyo"}}/>);
 const data=structuredClone(f.data);data.candles.forEach(c=>delete (c as any).timeBasisEvidence);
 view.rerender(<SmartChartReader {...f.props} data={data} view={{style:"candles",scale:"linear",timeZone:"Asia/Tokyo"}}/>);
 const reader=screen.getByTestId("smart-chart-reader");
 expect(screen.getByTestId("chart-reader-clock-authority").textContent).toContain("UTC mapping unverified");
 expect(reader.textContent).toContain("source clock (UTC unverified)");
 expect(reader.textContent).not.toContain("GMT+9");
 for(const time of reader.querySelectorAll("time"))expect(time.hasAttribute("datetime")).toBe(false);
});

it("labels temporarily suppressed annotations without changing saved annotation choice or recalculating",()=>{
 const f=fixture();const view=render(<SmartChartReader {...f.props}/>);const count=vi.mocked(analyzeSmartChart).mock.calls.length;
 view.rerender(<SmartChartReader {...f.props} presentationHidden/>);expect(screen.getByRole("button",{name:"Show automatic chart annotations"}).textContent).toContain("hidden (saved on)");expect(screen.getByRole("button",{name:"Show automatic chart annotations"}).getAttribute("aria-description")).toContain("temporarily hidden");expect(vi.mocked(analyzeSmartChart).mock.calls.length).toBe(count);
 fireEvent.click(screen.getByRole("button",{name:"Show automatic chart annotations"}));view.rerender(<SmartChartReader {...f.props}/>);expect(screen.getByRole("button",{name:"Show automatic chart annotations"}).textContent).toContain("Annotations off");
});

it("preserves explicit disconnected event semantics without inferring them from names",()=>{
 const finding={id:"arbitrary",title:"Any name",status:"confirmed",connectAnchors:false,anchors:[{time:1,price:100,role:"broken_level"},{time:2,price:99.9,role:"retest"}],levels:[{price:100,label:"Reference"}]} as SmartChartFinding;
 expect(findingAnnotation(finding)).toMatchObject({connectAnchors:false,level:{price:100,label:"Reference"}});
 expect(findingAnnotation({...finding,connectAnchors:undefined})).not.toMatchObject({connectAnchors:false});
});
