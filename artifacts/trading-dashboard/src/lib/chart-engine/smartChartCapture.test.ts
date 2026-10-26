import { describe, expect, it } from "vitest";
import type { ChartCandlesResponse } from "@workspace/api-client-react";
import { captureSmartChartBars } from "./smartChartCapture";
import { analyzeSmartChart } from "./smartChartAnalysis";

const START=Date.parse("2026-10-25T10:00:00Z"),NOW=START+100*300_000;
const expected={symbol:"V75",timeframe:"M5"};
function response():ChartCandlesResponse {
  const candles=Array.from({length:30},(_,i)=>({symbol:"V75",displaySymbol:"Volatility 75",timeframe:"M5" as const,
    openTime:new Date(START+i*300_000).toISOString(),closeTime:new Date(START+(i+1)*300_000).toISOString(),
    open:100+i,high:102+i,low:99+i,close:101+i,volume:0,tickVolume:null,source:"deriv_public",
    sourceMode:"live" as const,priceBasis:"SYNTHETIC" as const,isComplete:true,isFinal:true,isForming:false,receivedAt:new Date(NOW).toISOString(),qualityFlags:[]}));
  // Feed rendering/score fields are not consumed by this source-binding boundary.
  return {symbol:"V75",timeframe:"M5",source:"deriv_public",quality:"clean",candles,
    feedStatus:{source:"deriv_public"},marketEvidence:{...expected,source:"deriv_public",sourceIdentity:"a".repeat(64),lastClosedCandleAt:candles.at(-1)!.closeTime}} as ChartCandlesResponse;
}
const history=(data:ChartCandlesResponse)=>({...data.marketEvidence!,scope:"public_provider" as const});
const capture=(data=response(),older:any[]=[],evidence:any=null)=>captureSmartChartBars(data,expected,older,evidence,NOW);
const oldBar=(time=START-300_000)=>({time,open:99,high:101,low:98,close:100});

describe("automatic analysis captures observed source candles",()=>{
  it("retains raw closed OHLC, seconds and finality without modifying its response",()=>{
    const data=response(),before=structuredClone(data),result=capture(data);
    expect(result.status).toBe("ready");expect(result.bars).toHaveLength(30);
    expect(result.bars[0]).toMatchObject({time:START/1000,closeTime:START/1000+300,open:100,close:101,isFinal:true});
    expect(data).toEqual(before);
  });
  it.each(["symbol","timeframe","source","sourceIdentity"] as const)("refuses mismatched history %s",key=>{
    const data=response(),proof=history(data);Object.assign(proof,{[key]:"different"});
    expect(capture(data,[oldBar()],proof).status).toBe("unavailable");
  });
  it("never stamps source identity or closed status onto unattested history",()=>{
    const data=response();
    for(const proof of [null,{...history(data),scope:"account"},{...history(data),source:"mt5_broker"}])expect(capture(data,[oldBar()],proof).status).toBe("unavailable");
    expect(capture(data,[oldBar()],history(data)).bars[0]?.time).toBe((START-300_000)/1000);
  });
  it("rejects future or non-closed historical pages and nonascending observations",()=>{
    const data=response();
    expect(capture(data,[oldBar()],{...history(data),lastClosedCandleAt:new Date(NOW+1).toISOString()}).status).toBe("unavailable");
    expect(capture(data,[oldBar()],{...history(data),lastClosedCandleAt:new Date(START-1).toISOString()}).status).toBe("unavailable");
    expect(capture(data,[oldBar(),oldBar(START-600_000)],history(data)).status).toBe("unavailable");
  });
  it("refuses conflicting overlap instead of choosing the newer window silently",()=>{
    const data=response(),same={time:START,open:100,high:102,low:99,close:101};
    expect(capture(data,[same],history(data)).bars).toHaveLength(30);
    expect(capture(data,[{...same,close:100.5}],history(data)).reason).toContain("disagrees");
  });
  it("only omits an explicitly forming final tip; contradictory and interior flags fail",()=>{
    const data=response(),tip={...data.candles.at(-1)!,openTime:new Date(START+30*300_000).toISOString(),closeTime:new Date(START+31*300_000).toISOString(),isComplete:false,isFinal:false,isForming:true};
    data.candles.push(tip);expect(capture(data).bars).toHaveLength(30);
    tip.isFinal=true;expect(capture(data).status).toBe("unavailable");tip.isFinal=false;
    data.candles.unshift(data.candles.pop()!);expect(capture(data).status).toBe("unavailable");
  });
  it("does not repair endpoint, order, bad quality or response identities",()=>{
    for(const mutate of [
      (d:ChartCandlesResponse)=>{d.marketEvidence!.lastClosedCandleAt=d.candles[0]!.closeTime;},
      (d:ChartCandlesResponse)=>{d.candles.reverse();},
      (d:ChartCandlesResponse)=>{d.candles[0]!.sourceMode="mock";},
      (d:ChartCandlesResponse)=>{d.candles[0]!.qualityFlags=["OHLC_INVALID"];},
      (d:ChartCandlesResponse)=>{d.source="mt5_broker";},
      (d:ChartCandlesResponse)=>{d.feedStatus.source="mt5_broker";},
      (d:ChartCandlesResponse)=>{d.marketEvidence!.sourceIdentity="legacy-account";},
    ]){const data=response();mutate(data);expect(capture(data).status).toBe("unavailable");}
  });
  it("the downstream model refuses future final candles and invalid geometry",()=>{
    const data=response();data.candles[0]!.high=1;
    const captured=capture(data);
    expect(analyzeSmartChart({...captured.context,bars:captured.bars,asOfMs:NOW}).status).toBe("unavailable");
    const valid=capture();expect(analyzeSmartChart({...valid.context,bars:valid.bars,asOfMs:START+300_000}).status).toBe("unavailable");
  });
});
