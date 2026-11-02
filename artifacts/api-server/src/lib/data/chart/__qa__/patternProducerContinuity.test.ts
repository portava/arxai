import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPatternLibraryRead, buildPatternTruthVerdict } from "../patternTruthService.js";
import { buildTrendlineTruthVerdict } from "../trendlineTruthService.js";
import type { Candle } from "../../types.js";
import { CHART_TIMEFRAMES, timeframeMs } from "../timeframes.js";

const STEP = 900000, START = Date.UTC(2024, 0, 1);
const up = [1,1.01,1.02,1.03,1.04].map(close=>({open:close-.001,high:close+.001,low:close-.002,close}));
const star = {open:1.04,high:1.06,low:1.0395,close:1.041};
const follow = {open:1.041,high:1.042,low:1.03,close:1.035};
const raw = (rows:Omit<Candle,"time">[], start=START):Candle[] => rows.map((r,i)=>({...r,time:new Date(start+i*STEP).toISOString()}));
const context = (rawCandles:Candle[],timeframe="M15") => ({symbol:"EURUSD",timeframe,rawCandles,source:"mt5_broker",feedConfirmed:true,feedStale:false,sufficiencyAllowsSetup:true,chartReadConfidenceLow:false,trend:"bearish" as const,momentumAligned:true,nearSupportResistance:false,distanceToSrAtr:null,volatilityAtr:null});
function shape():Candle[] {
 const points=[[0,90],[8,96],[12,105],[16,99],[20,112],[24,99],[28,105],[30,102],[31,98],[32,97]];
 return raw(Array.from({length:33},(_,i)=>{const n=points.findIndex(p=>p[0]!>=i),a=points[Math.max(0,n-1)]!,b=points[n]!;const close=n===0?a[1]!:a[1]!+(b[1]!-a[1]!)*(i-a[0]!)/(b[0]!-a[0]!);return{open:close-.05,high:close+.2,low:close-.2,close};}));
}
test("uninterrupted closed shooting star still confirms",()=>{
 const result=buildPatternLibraryRead(context(raw([...up,star,follow])));
 assert.equal(result?.candidates.find(p=>p.id==="bearish_pin_bar")?.status,"confirmed");
});
test("forming next candle cannot confirm the server shooting-star read",t=>{
 const now=Date.UTC(2026,0,2);t.mock.method(Date,"now",()=>now);
 const result=buildPatternLibraryRead(context(raw([...up,star,follow],now-6*STEP-1000)));
 assert.equal(result?.candidates.find(p=>p.id==="bearish_pin_bar")?.status,"forming");
});
test("a next candle across a time gap is not current confirmation",()=>{
 const candles=raw([...up,star,follow]);candles[6]!.time=new Date(START+7*STEP).toISOString();
 assert.equal(buildPatternLibraryRead(context(candles)),null);
});
test("a genuine complete later segment remains eligible",()=>{
 const candles=raw([{open:1,high:1.01,low:.99,close:1},...up,star,follow]);
 for(let i=1;i<candles.length;i++)candles[i]!.time=new Date(START+(i+1)*STEP).toISOString();
 assert.equal(buildPatternLibraryRead(context(candles))?.candidates.find(p=>p.id==="bearish_pin_bar")?.status,"confirmed");
});
for(const timeframe of CHART_TIMEFRAMES.filter(tf=>tf!=="W1"&&tf!=="MN1")){
 test(`qualified fixed interval remains usable without mutating observations (${timeframe})`,()=>{
  const candles=raw([...up,star,follow]).map((c,i)=>({...c,time:new Date(START+i*timeframeMs(timeframe)).toISOString()})),before=structuredClone(candles);
  assert.equal(buildPatternLibraryRead(context(candles,timeframe))?.candidates.find(p=>p.id==="bearish_pin_bar")?.status,"confirmed");
  assert.deepEqual(candles,before);
 });
}

for(const [name,build,fixture] of [
 ["pattern",buildPatternTruthVerdict,shape],
 ["trendline",buildTrendlineTruthVerdict,shape],
 ["library",buildPatternLibraryRead,()=>raw([...up,star,follow])],
] as const){
 test(`${name}: baseline contains actual detection`,()=>assert.ok(build(context(fixture()))));
 test(`${name}: no current geometry is borrowed across the last gap`,()=>{
  const candles=fixture();candles.at(-1)!.time=new Date(Date.parse(candles.at(-1)!.time)+STEP).toISOString();
  assert.equal(build(context(candles)),null);
 });
 test(`${name}: an unfinished tail after a gap cannot make old geometry current`,t=>{
  const candles=fixture(),last=Date.parse(candles.at(-1)!.time),now=last+3*STEP+1000;
  t.mock.method(Date,"now",()=>now);
  candles.push({...candles.at(-1)!,time:new Date(now-1000).toISOString()});
  assert.equal(build(context(candles)),null);
 });
 for(const invalid of ["unzoned","rolled date"]){
  test(`${name}: ${invalid} times cannot manufacture qualified observations`,()=>{
   const candles=fixture().map(c=>({...c,time:invalid==="unzoned"?c.time.replace(/Z$/,""):c.time.replace("2024-01-01","2024-02-30")}));
   assert.equal(build(context(candles)),null);
  });
 }
 for(const issue of ["duplicate","invalid timestamp","out of order","overlap","invalid price","zero price"]){
  test(`${name}: ${issue} cannot be repaired silently into pattern evidence`,()=>{
   const candles=fixture();
   if(issue==="duplicate")candles.splice(1,0,{...candles[0]!});
   if(issue==="invalid timestamp")candles.splice(1,0,{...candles[0]!,time:"invalid"});
   if(issue==="out of order")[candles[0],candles[1]]=[candles[1]!,candles[0]!];
   if(issue==="overlap")candles[1]!.time=new Date(START+STEP/2).toISOString();
   if(issue==="invalid price")candles[0]!.low=NaN;
   if(issue==="zero price")Object.assign(candles[0]!,{open:0,high:0,low:0,close:0});
   assert.equal(build(context(candles)),null);
  });
 }
 for(const timeframe of ["W1","MN1"]){
  test(`${name}: calendar periods without qualified boundaries remain withheld (${timeframe})`,()=>assert.equal(build(context(fixture(),timeframe)),null));
 }
}
