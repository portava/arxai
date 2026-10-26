import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANDLE_DEFINITIONS, scanCandlestickCatalogue, type CatalogueCandle } from "../candlestickCatalogue.js";
import { CANDLE_FIXTURES, observed, mirror } from "./candlestickFixtures.js";
const scan=(bars:readonly CatalogueCandle[],asOf=bars.at(-1)!.closeTime)=>scanCandlestickCatalogue(bars,{asOf,intervalSeconds:300,eventLookback:1});
const ids=(bars:readonly CatalogueCandle[])=>scan(bars).observations.map(o=>o.definition.id);
const fixture=(id:string)=>CANDLE_FIXTURES.find(f=>f.id===id)!.bars.map(b=>({...b}));
test("every advertised definition has a distinct named fixture; related variants remain grouped",()=>{
 assert.deepEqual([...CANDLE_DEFINITIONS.map(d=>d.id)].sort(),CANDLE_FIXTURES.map(f=>f.id).sort());
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.id)).size,34);
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.family)).size,10);
});
test("owner coverage preserves all 104 entries and never advertises a missing catalogue implementation",()=>{
 const coverage=JSON.parse(readFileSync(new URL("../../../../../docs/SMART_CHART_CANDLE_COVERAGE.json",import.meta.url),"utf8"));
 assert.equal(coverage.entries.length,104);
 const catalogue=coverage.entries.filter((r:{status:string})=>r.status==="IMPLEMENTED_EXPLICIT_ARX_VARIANT");
 assert.deepEqual(catalogue.map((r:{definitionId:string})=>r.definitionId).sort(),CANDLE_DEFINITIONS.map(d=>d.id).sort());
 const pending=coverage.entries.filter((r:{definitionId:unknown})=>r.definitionId===null);
 assert.equal(pending.length,67);
 assert.ok(pending.every((r:{status:string})=>r.status.startsWith("PENDING_")));
});
for(const f of CANDLE_FIXTURES){
 test(`${f.id}: observed positive and finite actual evidence`,()=>{
  const result=scan(f.bars),o=result.observations.find(o=>o.definition.id===f.id);
  assert.equal(result.status,"ready");assert.ok(o,JSON.stringify(result.observations.map(o=>o.definition.id)));
  assert.equal(o.observedAt,f.bars.at(-1)!.closeTime);assert.ok(o.startIndex<=o.endIndex);
  assert.ok(o.explanation.length>20);assert.doesNotMatch(JSON.stringify(o),/"confidence"|"buy"|"sell"|trade_now|guarantee/);
 });
 test(`${f.id}: flat negative control (four-price remains a neutral observation)`,()=>{
  const bars=f.bars.map(b=>({...b,open:100,high:100,low:100,close:100}));
  if(f.id==="four_price_doji")assert.ok(ids(bars).includes(f.id));else assert.ok(!ids(bars).includes(f.id));
 });
 test(`${f.id}: scale-invariant across tiny FX and large prices`,()=>{
  const expected=ids(f.bars);
  for(const scale of [1e-9,.01,10000]){
   const scaled=f.bars.map(b=>({...b,open:b.open*scale,high:b.high*scale,low:b.low*scale,close:b.close*scale}));
   assert.deepEqual(ids(scaled),expected,`scale ${scale}`);
  }
 });
 test(`${f.id}: no future or forming-candle confirmation`,()=>{
  const end=f.bars.at(-1)!,future={...end,time:end.closeTime,closeTime:end.closeTime+300,open:999,high:1,low:-3,close:Infinity};
  assert.deepEqual(scan([...f.bars,future],end.closeTime),scan(f.bars));
  const forming=[...f.bars.slice(0,-1),{...end,isComplete:false,isFinal:false,isForming:true}];
  const before=scan(forming,end.time+1);
  assert.ok(!before.observations.some(o=>o.definition.id===f.id&&o.observedAt===end.closeTime));
 });
}
test("reversal names require actual prior trend, not merely the candle outline",()=>{
 for(const id of ["takuri_line","hammer","hanging_man","inverted_hammer","bullish_belt_hold","bearish_belt_hold","bullish_harami","bearish_harami","bullish_harami_cross","bearish_harami_cross","piercing_line","dark_cloud_cover","tweezer_bottom","tweezer_top","morning_star","evening_star","morning_doji_star","evening_doji_star"]){
  const bars=fixture(id);for(let i=0;i<12;i++)bars[i]={...bars[i]!,open:101,high:103,low:100,close:102};
  assert.ok(!ids(bars).includes(id),id);
 }
});
test("family-specific negative controls reject near misses",()=>{
 const cases:[string,(b:CatalogueCandle[])=>void][]=[
  ["bullish_marubozu",b=>{b.at(-1)!.high+=2;}],
  ["opening_marubozu",b=>{b.at(-1)!.low-=2;}],
  ["closing_marubozu",b=>{b.at(-1)!.high+=2;}],
  ["doji",b=>{b.at(-1)!.close=103;}],
  ["dragonfly_doji",b=>{b.at(-1)!.high+=2;}],
  ["gravestone_doji",b=>{b.at(-1)!.low-=2;}],
  ["four_price_doji",b=>{b.at(-1)!.high+=.001;}],
  ["rickshaw_man",b=>{b.at(-1)!.high+=5;}],
  ["hammer",b=>{b.at(-1)!.high+=3;}],
  ["inverted_hammer",b=>{b.at(-1)!.low-=3;}],
  ["bullish_harami",b=>{b.at(-1)!.open=98.8;b.at(-1)!.low=98;}],
  ["bullish_harami_cross",b=>{b.at(-1)!.close=101.3;}],
  ["piercing_line",b=>{b.at(-1)!.open=99;}],
  ["dark_cloud_cover",b=>{b.at(-1)!.close=149.5;}],
  ["tweezer_bottom",b=>{b.at(-1)!.low-=1;}],
  ["tweezer_top",b=>{b.at(-1)!.high+=1;}],
  ["morning_star",b=>{b.at(-2)!.close=99.2;b.at(-2)!.high=99.5;}],
  ["morning_doji_star",b=>{b.at(-1)!.close=100.5;}],
 ];
 for(const [id,mutate] of cases){const b=fixture(id);mutate(b);assert.ok(!ids(b).includes(id),id);}
});
test("malformed/future/contradictory/duplicate evidence never yields observations",()=>{
 for(const change of [{close:NaN},{high:Infinity},{low:0},{high:1},{isFinal:false},{isForming:true},{closeTime:1}]){
  const b=fixture("hammer"),asOf=b.at(-1)!.closeTime;b[b.length-1]={...b.at(-1)!,...change};const result=scan(b,asOf);assert.equal(result.status,"unavailable");assert.equal(result.observations.length,0);
 }
 const b=fixture("hammer");assert.equal(scan(b,b.at(-1)!.time+1).status,"unavailable");
 assert.equal(scan([b[0]!,...b]).status,"unavailable");
});
test("gaps do not pretend that separated observations form adjacent multi-candle patterns",()=>{
 const b=fixture("morning_star");b[b.length-1]={...b.at(-1)!,time:b.at(-1)!.time+300,closeTime:b.at(-1)!.closeTime+300};
 assert.ok(!ids(b).includes("morning_star"));
});
test("warmup excludes the evaluated candle and does not invent a long-body baseline",()=>{
 const b=observed([{open:100,high:110,low:100,close:110}]);
 assert.deepEqual(ids(b),["white_candle"]);
 const flat=Array.from({length:10},()=>({open:100,high:100,low:100,close:100}));
 assert.ok(!ids(observed([...flat,{open:100,high:110,low:100,close:110}])).includes("long_body"));
});
test("opening/closing Marubozu respect both candle colours and full shapes are not double-counted",()=>{
 for(const id of ["opening_marubozu","closing_marubozu"]){
  assert.ok(ids(mirror(fixture(id))).includes(id));
  assert.ok(!ids(fixture("bullish_marubozu")).includes(id));
  assert.ok(!ids(fixture("bearish_marubozu")).includes(id));
 }
});
test("Harami crosses and Doji stars remain explicit variants rather than duplicated ordinary patterns",()=>{
 for(const [cross,ordinary] of [["bullish_harami_cross","bullish_harami"],["bearish_harami_cross","bearish_harami"],["morning_doji_star","morning_star"],["evening_doji_star","evening_star"]]){
  assert.ok(!ids(fixture(cross!)).includes(ordinary!));
 }
});
test("touching midpoint and body-gap boundaries do not satisfy strict penetration",()=>{
 const piercing=fixture("piercing_line"),first=piercing.at(-2)!;
 piercing.at(-1)!.close=(first.open+first.close)/2;
 assert.ok(!ids(piercing).includes("piercing_line"));
 const cloud=fixture("dark_cloud_cover"),cloudFirst=cloud.at(-2)!;
 cloud.at(-1)!.close=(cloudFirst.open+cloudFirst.close)/2;
 assert.ok(!ids(cloud).includes("dark_cloud_cover"));
 const star=fixture("morning_star");star.at(-1)!.open=Math.max(star.at(-2)!.open,star.at(-2)!.close);
 assert.ok(!ids(star).includes("morning_star"));
});
test("missing session observations cannot create a five-close trend across a gap",()=>{
 const bars=fixture("hammer");for(let i=bars.length-3;i<bars.length;i++){bars[i]!.time+=300;bars[i]!.closeTime+=300;}
 assert.ok(!ids(bars).includes("hammer"));
});
test("a completed bar cannot follow an unfinished earlier bar",()=>{
 const bars=fixture("hammer");Object.assign(bars.at(-2)!,{isComplete:false,isFinal:false,isForming:true});
 assert.equal(scan(bars).status,"unavailable");
});
