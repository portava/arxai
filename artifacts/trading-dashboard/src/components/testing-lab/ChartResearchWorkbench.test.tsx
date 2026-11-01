import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import { runCausalResearchV2 } from "@workspace/domain/backtest/research";
import type { ResearchV2Config, ResearchV2Input } from "@workspace/domain/backtest/research-core";
const h=vi.hoisted(()=>({run:vi.fn(),cancel:vi.fn()}));
vi.mock("@/lib/chart-research/researchRunner",()=>({createBrowserResearchRunner:()=>h}));
import ChartResearchWorkbench from "./ChartResearchWorkbench";

function fixture() {
  const start=Date.parse("2026-01-01T00:00:00Z"), step=60_000;
  const candles=Array.from({length:160},(_,i)=>{
    const close=100+Math.sin(i/5)*4;
    return {symbol:"EURUSD",timeframe:"M1",openTime:new Date(start+i*step).toISOString(),closeTime:new Date(start+(i+1)*step).toISOString(),open:close-.1,high:close+.3,low:close-.3,close,source:"mt5_broker",sourceMode:"live",priceBasis:"BID",priceBasisEvidence:{kind:"producer_declared",basis:"BID",reason:null},timeBasisEvidence:{kind:"original_utc",basis:"UTC",authority:"offline:utc-clock-fixture-v1",reason:null},isComplete:true,isFinal:true,isForming:false,qualityFlags:[]};
  });
  const data={symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",quality:"clean",candles,feedStatus:{source:"mt5_broker"},marketEvidence:{symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}} as ChartCandlesResponse;
  const canonicalBars=candles.map(c=>({time:Date.parse(c.openTime)/1000,open:c.open,high:c.high,low:c.low,close:c.close}));
  return {data,symbol:"EURUSD",timeframe:"M1",canonicalBars,getVisibleBars:()=>canonicalBars,request:null,onOverlays:vi.fn(),onExplanation:vi.fn(),onClose:vi.fn()};
}
function finish() {
  const [input,config,receive]=h.run.mock.calls.at(-1)! as [ResearchV2Input,ResearchV2Config,(value:unknown)=>void];
  const result=runCausalResearchV2(input,config);
  act(()=>receive({status:"complete",result}));return result;
}
beforeEach(()=>{h.run.mockReset();h.cancel.mockReset();});
afterEach(cleanup);
describe("real engine chart research orchestration",()=>{
  it("does not run on open; shows exact engine ledger and selected historical overlays",()=>{
    const props=fixture();render(<ChartResearchWorkbench {...props}/>);
    expect(h.run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button',{name:'Run historical test'}));
    const result=finish();expect(screen.getByTestId('chart-research-result')).toBeTruthy();
    const count=result.partitions.reduce((n,p)=>n+p.trades.length,0);expect(count).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button',{name:'Trade 1',exact:true}));
    const overlays=props.onOverlays.mock.calls.at(-1)![0];
    const trade=result.partitions.flatMap(p=>p.trades)[0]!;
    expect(overlays.map((o:any)=>o.source)).toEqual(['research','research','research','research']);
    expect(overlays[0].startTime).toBe(trade.entryTimeMs/1000);
    expect(overlays[1].startTime).toBe(result.inputSnapshot.bars[trade.exitIndex]!.openTimeMs/1000);
    expect(screen.getByTestId('chart-research-trade-detail').textContent).toContain('ledger-derived simulation');
    expect(props.onExplanation.mock.calls.at(-1)![0]).toContain(result.fingerprints.result.slice(0,12));
  });
  it("withdraws markers and explanations when metadata is revoked without a price change",()=>{
    const props=fixture(),view=render(<ChartResearchWorkbench {...props}/>);
    fireEvent.click(screen.getByRole('button',{name:'Run historical test'}));finish();
    fireEvent.click(screen.getByRole('button',{name:'Trade 1',exact:true}));
    const data=structuredClone(props.data);
    delete (data.candles[0] as any).priceBasisEvidence;
    view.rerender(<ChartResearchWorkbench {...props} data={data}/>);
    expect(props.onOverlays.mock.calls.at(-1)![0]).toEqual([]);
    expect(props.onExplanation.mock.calls.at(-1)![0]).toBeNull();
    expect(screen.queryByTestId('chart-research-trade-detail')).toBeNull();
  });
  it("refuses missing requested years instead of running a smaller sample",()=>{
    const props=fixture();render(<ChartResearchWorkbench {...props} request={{id:1,text:'Test buying when the 20 EMA crosses above the 50 EMA, with an ATR-based stop, over the last two years'}}/>);
    fireEvent.click(screen.getByRole('button',{name:'Run historical test'}));
    expect(h.run).not.toHaveBeenCalled();expect(screen.getByRole('status').textContent).toMatch(/exact requested|shorter sample/i);
  });
  it("clears old valid settings after unsupported AI modifiers",()=>{
    const props=fixture(),view=render(<ChartResearchWorkbench {...props}/>);
    expect(screen.getByRole('button',{name:'Run historical test'})).toBeTruthy();
    view.rerender(<ChartResearchWorkbench {...props} request={{id:1,text:'Backtest buying when the 20 EMA crosses above the 50 EMA, with an ATR-based stop, over the last two years with $10000'}}/>);
    expect(screen.queryByRole('button',{name:'Run historical test'})).toBeNull();expect(h.run).not.toHaveBeenCalled();
    expect(screen.getByRole('status').textContent).toContain('unsupported');
  });
  it("cancels and rejects late results when edited, then cancels on unmount",()=>{
    const props=fixture(),view=render(<ChartResearchWorkbench {...props}/>);
    fireEvent.click(screen.getByRole('button',{name:'Run historical test'}));
    fireEvent.change(screen.getByLabelText('Fast EMA'),{target:{value:'10'}});finish();
    expect(screen.queryByTestId('chart-research-result')).toBeNull();
    const before=h.cancel.mock.calls.length;view.unmount();expect(h.cancel.mock.calls.length).toBeGreaterThan(before);
  });
});


describe("historical clock authority",()=>{
 it("does not run source-clock candles merely because their ISO strings end in Z",()=>{
  const props=fixture();props.data.candles.forEach(c=>delete (c as any).timeBasisEvidence);
  render(<ChartResearchWorkbench {...props}/>);
  expect(screen.queryByRole('button',{name:'Run historical test'})).toBeNull();
  expect(screen.getByRole('status').textContent).toMatch(/UTC|source-clock/i);expect(h.run).not.toHaveBeenCalled();
 });
 it("withdraws selected overlays and explanation when clock authority disappears",()=>{
  const props=fixture(),view=render(<ChartResearchWorkbench {...props}/>);
  fireEvent.click(screen.getByRole('button',{name:'Run historical test'}));finish();
  fireEvent.click(screen.getByRole('button',{name:'Trade 1',exact:true}));
  const data=structuredClone(props.data);delete (data.candles[0] as any).timeBasisEvidence;
  view.rerender(<ChartResearchWorkbench {...props} data={data}/>);
  expect(props.onOverlays.mock.calls.at(-1)![0]).toEqual([]);expect(props.onExplanation.mock.calls.at(-1)![0]).toBeNull();
  expect(screen.queryByTestId('chart-research-trade-detail')).toBeNull();
 });
});
