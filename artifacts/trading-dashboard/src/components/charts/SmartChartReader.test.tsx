import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import type { ChartEngineAdapter, ChartEngineCandle } from "@/lib/chart-engine";
import { SmartChartReader, findingAnnotation } from "./SmartChartReader";
import { captureSmartChartBars } from "@/lib/chart-engine/smartChartCapture";
import { analyzeSmartChart, type SmartChartFinding } from "@/lib/chart-engine/smartChartAnalysis";
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
beforeEach(()=>{vi.spyOn(Date,"now").mockReturnValue(NOW);});
afterEach(()=>{cleanup();vi.restoreAllMocks();});
describe("embedded chart reader follows applied candles",()=>{
  it("automatically explains closed patterns, exposes every detail and shows one annotation",()=>{
    const f=fixture();render(<SmartChartReader {...f.props}/>);
    expect(screen.getByTestId("chart-reader-explanation").textContent).toContain("are nearly equal");
    const bound=captureSmartChartBars(f.data,{symbol:"V75",timeframe:"M5"},[],null,NOW);
    const result=analyzeSmartChart({...bound.context,bars:bound.bars,asOfMs:NOW,visibleRange:{from:f.all[0]!.time,to:f.all.at(-1)!.time},dataState:"current"});
    const chips=within(screen.getByLabelText("Relevant chart patterns")).getAllByRole("button");
    const more=within(screen.getByLabelText("More observed patterns")).getAllByRole("button",{hidden:true});
    expect(chips.length).toBeLessThanOrEqual(3);expect(chips.length+more.length).toBe(result.allFindings.length);
    expect(f.setSmartAnnotation.mock.lastCall?.[0]?.id).toBe(result.findings[0]!.id);
    fireEvent.click(screen.getByRole("button",{name:"Show automatic chart annotations"}));
    expect(f.setSmartAnnotation).toHaveBeenLastCalledWith(null);
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
});
