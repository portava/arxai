import {describe,expect,it} from "vitest";
import {proposeChartSupportResistance} from "./chartSupportResistance";
import type {SmartChartAnalysisInput} from "./smartChartAnalysis";
const start=1_800_000_000;
function fixture():SmartChartAnalysisInput {
 const prices=[10,11,15,12,11,7,10,11,16,12,11];
 return {symbol:"EURUSD",timeframe:"M1",source:"mt5_broker",sourceIdentity:"a".repeat(64),asOfMs:(start+prices.length*60)*1000,bars:prices.map((p,i)=>({time:start+i*60,closeTime:start+(i+1)*60,open:p,high:p+1,low:p-1,close:p,isComplete:true,isFinal:true,isForming:false}))};
}
const read=(f:SmartChartAnalysisInput)=>proposeChartSupportResistance(f,f.bars);
describe("source-bound confirmed support/resistance candidates",()=>{
 it("uses the most recent qualifying pivots and records when each became knowable",()=>{
  const r=read(fixture());expect(r.status).toBe("ready");if(r.status!=="ready")return;
  expect(r.proposal.levels).toEqual([{side:"support",price:6,pivotTime:start+300,confirmedAt:start+480,laterCloseCrossings:0},{side:"resistance",price:17,pivotTime:start+480,confirmedAt:start+660,laterCloseCrossings:0}]);
  expect(r.proposal.referenceClose).toEqual({time:start+660,price:11});expect(r.proposal.note).toContain("not zones");
 });
 it("matches revealed replay prefixes and never borrows future confirmations",()=>{
  const f=fixture();for(let n=1;n<=f.bars.length;n++){
   const prefix={...f,bars:f.bars.slice(0,n),asOfMs:(start+n*60)*1000};const a=read(prefix),b=proposeChartSupportResistance({...f,replayCutoff:start+n*60},prefix.bars);
   expect(b.status).toBe(a.status);if(a.status==="ready"&&b.status==="ready"){expect(b.proposal.levels).toEqual(a.proposal.levels);expect(a.proposal.levels.every(x=>x.confirmedAt<=start+n*60)).toBe(true);if(n<11)expect(a.proposal.levels[1].pivotTime).not.toBe(start+480);}
  }
 });
 it("holds omitted original observations, changed OHLC, unknown source and out-of-order display",()=>{
  const f=fixture();expect(proposeChartSupportResistance(f,f.bars.filter((_,i)=>i!==4)).status).toBe("unavailable");
  expect(proposeChartSupportResistance(f,f.bars.map((b,i)=>i===4?{...b,close:b.close+.1}:b)).status).toBe("unavailable");
  expect(read({...f,sourceIdentity:null}).status).toBe("unavailable");expect(proposeChartSupportResistance(f,[...f.bars].reverse()).status).toBe("unavailable");
 });
 it("excludes forming confirmation and rejects one-sided windows rather than fabricate a level",()=>{
  const f=fixture(),forming={...f,bars:f.bars.map((b,i)=>i===10?{...b,isFinal:false,isComplete:false,isForming:true}:b)};const r=read(forming);if(r.status==="ready")expect(r.proposal.levels[1].price).not.toBe(17);
  const trend={...f,bars:f.bars.map((b,i)=>({...b,open:10+i,close:10+i,high:11+i,low:9+i}))};expect(read(trend)).toMatchObject({status:"unavailable",reason:expect.stringContaining("No two-sided")});
 });
 it("does not count equal high plateaus as strict pivots",()=>{
  const f=fixture();f.bars=f.bars.map((b,i)=>i===7?{...b,high:17}:b);const r=read(f);expect(r.status).toBe("ready");if(r.status==="ready")expect(r.proposal.levels[1].price).toBe(16);
 });
 it("binds a proposal to its source, displayed window and complete closed OHLC",()=>{
  const f=fixture(),a=read(f),b=read({...f,sourceIdentity:"b".repeat(64)});expect(a.status).toBe("ready");expect(b.status).toBe("ready");if(a.status==="ready"&&b.status==="ready")expect(a.proposal.comparisonKey).not.toBe(b.proposal.comparisonKey);
  const revised={...f,bars:f.bars.map((b,i)=>i===0?{...b,open:10.1}:b)};expect(read(revised)).not.toEqual(a);
 });
});
