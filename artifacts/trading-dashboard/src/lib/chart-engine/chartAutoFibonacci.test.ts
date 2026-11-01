import {describe,expect,it} from "vitest";
import {fibonacciProposalDrawing,proposeChartFibonacci} from "./chartAutoFibonacci";
import {drawingSegments,validateDrawings} from "./chartWorkspace";
import type {SmartChartAnalysisInput} from "./smartChartAnalysis";
const start=1_800_000_000;
function fixture():SmartChartAnalysisInput {
  const prices=[10,11,15,12,11,7,10,11,16,12,11];
  return {symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),asOfMs:(start+prices.length*60)*1000,
    bars:prices.map((p,i)=>({time:start+i*60,closeTime:start+(i+1)*60,open:p,high:p+1,low:p-1,close:p,isComplete:true,isFinal:true,isForming:false}))};
}
const actual=(f:SmartChartAnalysisInput)=>f.bars.map(b=>({...b}));
describe("automatic confirmed-swing Fibonacci",()=>{
  it("uses latest opposite confirmed pivots and the existing direction-aware ratio geometry",()=>{
    const f=fixture(),r=proposeChartFibonacci(f,actual(f));expect(r.status).toBe("ready");if(r.status!=="ready")return;
    expect(r.proposal.origin).toMatchObject({start:{time:start+5*60,price:6},end:{time:start+8*60,price:17},confirmedAt:start+11*60,span:2});
    const drawing=fibonacciProposalDrawing(r.proposal,"kept",false),levels=drawingSegments(drawing);
    expect(levels.map(l=>l.start.price)).toEqual([6,6+11*.236,6+11*.382,11.5,6+11*.618,6+11*.786,17]);
    expect(validateDrawings([drawing])[0]).toEqual(drawing);
    expect(validateDrawings([{...drawing,end:{...drawing.end!,price:19}}])[0].fibonacciOrigin?.end.price).toBe(17);
  });
  it("never confirms the latest pivot before both right bars close; replay prefix is causal",()=>{
    const f=fixture();for(let count=1;count<=f.bars.length;count++) {
      const cutoff=start+count*60,prefix={...f,bars:f.bars.slice(0,count),asOfMs:cutoff*1000};
      const replay={...f,asOfMs:f.asOfMs,replayCutoff:cutoff};
      const a=proposeChartFibonacci(prefix,actual(prefix)),b=proposeChartFibonacci(replay,actual(prefix));
      expect(b.status).toBe(a.status);
      if(a.status==="ready"&&b.status==="ready")expect(a.proposal.origin).toEqual(b.proposal.origin);
      if(count<11&&a.status==="ready")expect(a.proposal.origin.end.time).not.toBe(start+8*60);
    }
  });
  it("refuses a future replay candle even when it is the last applied bar",()=>{
    const f=fixture(),cutoff=f.bars.at(-2)!.closeTime;
    expect(proposeChartFibonacci({...f,replayCutoff:cutoff},actual(f)).status).toBe("unavailable");
    expect(proposeChartFibonacci({...f,bars:f.bars.slice(0,-1),replayCutoff:cutoff},actual(f)).status).toBe("unavailable");
  });
  it("refuses overlapping observation intervals instead of claiming impossible confirmation spacing",()=>{
    const f=fixture();f.bars=f.bars.map((b,i)=>({...b,time:start+i*30,closeTime:start+i*30+60}));
    expect(proposeChartFibonacci(f,actual(f))).toMatchObject({status:"unavailable",reason:expect.stringMatching(/Overlapping/)});
  });
  it("withholds when the applied window silently omits an original interior observation",()=>{
    const f=fixture();expect(proposeChartFibonacci(f,actual(f).filter((_,i)=>i!==4))).toMatchObject({status:"unavailable",reason:expect.stringContaining("omits source observations")});
  });
  it("rejects same-bar high/low ambiguity instead of guessing sequence or skipping it",()=>{
    const f=fixture();f.bars[8]={...f.bars[8],low:1};expect(proposeChartFibonacci(f,actual(f))).toMatchObject({status:"unavailable",reason:expect.stringMatching(/both a high and a low/)});
  });
  it("rejects unknown source, mismatch, forming confirmations and unsupported windows",()=>{
    const f=fixture();expect(proposeChartFibonacci({...f,sourceIdentity:null},actual(f)).status).toBe("unavailable");
    const changed=actual(f);changed[2].high+=1;expect(proposeChartFibonacci(f,changed).status).toBe("unavailable");
    const partial={...f,bars:f.bars.map((b,i)=>i===10?{...b,isComplete:false,isFinal:false,isForming:true}:b)};
    const r=proposeChartFibonacci(partial,actual(partial));if(r.status==="ready")expect(r.proposal.origin.end.time).not.toBe(start+8*60);
    expect(proposeChartFibonacci({...f,timeframe:"MN1"},actual(f)).status).toBe("unavailable");
  });
  it("binds comparison to source, window and OHLC revisions, while preserving origin through edits",()=>{
    const f=fixture(),r=proposeChartFibonacci(f,actual(f));if(r.status!=="ready")throw Error("fixture");
    const changed={...f,sourceIdentity:"b".repeat(64)};expect(proposeChartFibonacci(changed,actual(changed))).not.toEqual(r);
    const revised={...f,bars:f.bars.map((b,i)=>i===0?{...b,close:b.close+.1}:b)};
    expect(proposeChartFibonacci(revised,actual(revised))).not.toEqual(r);
    const kept=fibonacciProposalDrawing(r.proposal,"kept",false);expect(validateDrawings([{...kept,fibonacciOrigin:{...kept.fibonacciOrigin,sourceIdentity:"fake"}}])[0].fibonacciOrigin).toBeUndefined();
  });
});

describe("archived automatic provenance is descriptive but must remain causally possible",()=>{
  it.each(["unknown interval","early confirmation","too few bars","missing left bars","negative window","equal anchors"])("strips impossible %s without deleting the user's drawing",scenario=>{
    const f=fixture(),r=proposeChartFibonacci(f,actual(f));if(r.status!=="ready")throw Error("fixture");
    const d=fibonacciProposalDrawing(r.proposal,"kept",false),p={...d.fibonacciOrigin!};
    if(scenario==="unknown interval")p.timeframe="garbage";
    if(scenario==="early confirmation")p.confirmedAt=p.end.time+.001;
    if(scenario==="too few bars")p.closedBars=5;
    if(scenario==="missing left bars")p.windowFrom=p.start.time;
    if(scenario==="negative window")p.windowFrom=-1;
    if(scenario==="equal anchors")p.end={...p.end,price:p.start.price};
    const kept=validateDrawings([{...d,fibonacciOrigin:p}]);
    expect(kept).toHaveLength(1);expect(kept[0].fibonacciOrigin).toBeUndefined();expect(kept[0].start).toEqual(d.start);
  });
});
