import { describe, expect, it } from "vitest";
import { compareChartPerformance, comparisonPaths } from "./chartPerformanceComparison";

import {start,comparisonFixture} from "./chartPerformanceComparison.fixture";
const run=(a=comparisonFixture(),b=comparisonFixture("GBPUSD",[50,60,45,55]),from=start,to=start+900)=>compareChartPerformance({primary:a,comparison:b,primarySymbol:"EURUSD",comparisonSymbol:"GBPUSD",timeframe:"M5",range:{from,to},now:(start+2000)*1000});
describe("visible-window percentage comparison",()=>{
  it("uses one shared timestamp and independent bases without changing source OHLC",()=>{
    const a=comparisonFixture(),b=comparisonFixture("GBPUSD",[50,60,45,55]),before=structuredClone([a,b]);
    const result=run(a,b);expect(result.status).toBe("ready");if(result.status!=="ready")return;
    expect(result.baseline).toEqual({time:start,primary:100,comparison:50});
    expect(result.rows[1]!.primary).toBeCloseTo(10);expect(result.rows[1]!.comparison).toBeCloseTo(20);
    expect(result.lastCommon).toMatchObject({time:start+900,primary:-10,comparison:10});
    expect([a,b]).toEqual(before);
  });
  it("rebases when the visible range moves and never substitutes two different origins",()=>{
    const b=comparisonFixture("GBPUSD",[50,60,45,55]);b.candles.shift();
    const result=run(comparisonFixture(),b);expect(result.status).toBe("ready");if(result.status!=="ready")return;
    expect(result.baseline.time).toBe(start+300);expect(result.rows[0]).toMatchObject({primary:0,comparison:0});
    const moved=run(undefined,undefined,start+600);expect(moved.status).toBe("ready");if(moved.status==="ready")expect(moved.baseline.time).toBe(start+600);
  });
  it("leaves missing observations and session gaps disconnected",()=>{
    const a=comparisonFixture(),b=comparisonFixture("GBPUSD");b.candles.splice(1,1);
    const result=run(a,b);expect(result.status).toBe("ready");if(result.status!=="ready")return;
    expect(result.rows[1]!.comparison).toBeNull();
    const paths=comparisonPaths(result.rows,"comparison",300,t=>t,v=>v);
    expect(paths.match(/M/g)).toHaveLength(2);expect(paths.match(/L/g)).toHaveLength(1);
    expect(comparisonPaths([result.rows[0]!,result.rows[3]!],"primary",300,t=>t,v=>v).match(/M/g)).toHaveLength(2);
  });
  it.each(["owner","clock","identity","order","ohlc","future","duration","zero"])("withholds %s problems",problem=>{
    const b=comparisonFixture("GBPUSD");
    if(problem==="owner")b.symbol="USDJPY";
    if(problem==="clock")delete b.candles[0]!.timeBasisEvidence;
    if(problem==="identity")b.marketEvidence!.sourceIdentity="unknown";
    if(problem==="order")b.candles.reverse();
    if(problem==="ohlc")b.candles[0]!.high=1;
    if(problem==="future")b.candles[1]!.closeTime="2099-01-01T00:00:00Z";
    if(problem==="duration")b.candles[1]!.closeTime=b.candles[1]!.openTime;
    if(problem==="zero")b.candles[0]!.close=0;
    expect(run(undefined,b).status).toBe("unavailable");
  });
  it("refuses insufficient overlap rather than joining nearest timestamps",()=>{
    expect(run(undefined,undefined,start+900,start+1200).status).toBe("unavailable");
    expect(run(undefined,undefined,start+3000,start+4000).status).toBe("unavailable");
  });
  it("rejects overlapping closed intervals even when both sources share the same malformed times",()=>{
    const a=comparisonFixture(),b=comparisonFixture("GBPUSD");
    for(const data of [a,b]){
      data.candles[1]!.openTime=new Date((start+360)*1000).toISOString();
      data.candles[1]!.closeTime=new Date((start+660)*1000).toISOString();
    }
    expect(run(a,b).status).toBe("unavailable");
  });
  it("does not treat a forming tip as a closed result",()=>{
    const a=comparisonFixture(),last=a.candles.at(-1)!;
    a.candles.push({...last,openTime:last.closeTime,closeTime:new Date((start+1500)*1000).toISOString(),isFinal:false,isComplete:false,isForming:true,close:999});
    const result=run(a);expect(result.status).toBe("ready");if(result.status==="ready")expect(result.rows).toHaveLength(4);
  });
  it("retains outliers and identifies stale data without calling it live",()=>{
    const b=comparisonFixture("GBPUSD",[50,500,45,55]);b.feedStatus.stale=true;
    const result=run(undefined,b);expect(result.status).toBe("ready");if(result.status!=="ready")return;
    expect(result.rows[1]!.comparison).toBe(900);expect(result.comparison.stale).toBe(true);
  });
});
