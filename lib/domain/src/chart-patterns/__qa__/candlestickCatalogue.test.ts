import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { CANDLE_CRITERIA_VERSION, CANDLE_DEFINITIONS, scanCandlestickCatalogue, type CatalogueCandle } from "../candlestickCatalogue.js";
import { CANDLE_FIXTURES, observed, mirror } from "./candlestickFixtures.js";
const scan=(bars:readonly CatalogueCandle[],asOf=bars.at(-1)!.closeTime)=>scanCandlestickCatalogue(bars,{asOf,intervalSeconds:300,eventLookback:1});
const ids=(bars:readonly CatalogueCandle[])=>scan(bars).observations.map(o=>o.definition.id);
const fixture=(id:string)=>CANDLE_FIXTURES.find(f=>f.id===id)!.bars.map(b=>({...b}));
test("every advertised definition has a distinct named fixture; related variants remain grouped",()=>{
 assert.deepEqual([...CANDLE_DEFINITIONS.map(d=>d.id)].sort(),CANDLE_FIXTURES.map(f=>f.id).sort());
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.id)).size,78);
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.family)).size,19);
});
test("owner coverage preserves all 104 entries and never advertises a missing catalogue implementation",()=>{
 const coverage=JSON.parse(readFileSync(new URL("../../../../../docs/SMART_CHART_CANDLE_COVERAGE.json",import.meta.url),"utf8"));
 assert.equal(coverage.entries.length,104);
 const catalogue=coverage.entries.filter((r:{status:string})=>r.status==="IMPLEMENTED_EXPLICIT_ARX_VARIANT");
 assert.deepEqual(catalogue.map((r:{definitionId:string})=>r.definitionId).sort(),CANDLE_DEFINITIONS.map(d=>d.id).sort());
 const pending=coverage.entries.filter((r:{definitionId:unknown})=>r.definitionId===null);
 assert.equal(pending.length,23);
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
test("v2 reversal and continuation names require their stated preceding trend",()=>{
 for(const id of ["rising_window","falling_window","bullish_abandoned_baby","bearish_abandoned_baby","three_inside_up","three_inside_down","three_outside_up","three_outside_down","three_white_soldiers","three_black_crows","bullish_doji_star","bearish_doji_star","bullish_counterattack","bearish_counterattack"]){
  const bars=fixture(id);for(let i=0;i<12;i++)bars[i]={...bars[i]!,open:101,high:103,low:100,close:102};
  assert.ok(!ids(bars).includes(id),id);
 }
});
test("full-range gaps cannot be replaced by body gaps or touching shadows",()=>{
 for(const [id,mutate] of [
  ["rising_window",(b:CatalogueCandle[])=>{b.at(-1)!.low=b.at(-2)!.high;}],
  ["falling_window",(b:CatalogueCandle[])=>{b.at(-1)!.high=b.at(-2)!.low;}],
  ["bullish_abandoned_baby",(b:CatalogueCandle[])=>{b.at(-2)!.high=b.at(-3)!.low;}],
  ["bearish_abandoned_baby",(b:CatalogueCandle[])=>{b.at(-2)!.low=b.at(-3)!.high;}],
  ["bullish_kicking",(b:CatalogueCandle[])=>{b.at(-1)!.low=b.at(-2)!.high;}],
  ["bearish_kicking",(b:CatalogueCandle[])=>{b.at(-1)!.high=b.at(-2)!.low;}],
 ] as [string,(b:CatalogueCandle[])=>void][]){const bars=fixture(id);mutate(bars);assert.ok(!ids(bars).includes(id),id);}
 const baby=fixture("bullish_abandoned_baby");baby.at(-1)!.low=baby.at(-2)!.high;
 assert.ok(!ids(baby).includes("bullish_abandoned_baby"));
});
test("Three Inside requires penetration of the first open, not just the contained candle",()=>{
 const bars=fixture("three_inside_up");bars.at(-1)!.close=bars.at(-3)!.open;
 assert.ok(!ids(bars).includes("three_inside_up"));
 const sameColour=fixture("three_inside_up");Object.assign(sameColour.at(-2)!,{open:100.8,close:100});
 assert.ok(ids(sameColour).includes("three_inside_up"),"middle colour is not restricted by the Three Inside definition");
});
test("Three Outside needs strict body engulfment and actual third-close follow-through",()=>{
 const edge=fixture("three_outside_up");edge.at(-2)!.open=edge.at(-3)!.close;
 assert.ok(!ids(edge).includes("three_outside_up"));
 const noFollow=fixture("three_outside_down");noFollow.at(-1)!.close=noFollow.at(-2)!.close;
 assert.ok(!ids(noFollow).includes("three_outside_down"));
});
test("Three Outside records closing progression even when the third candle colour differs",()=>{
 const bars=fixture("three_outside_up");Object.assign(bars.at(-1)!,{open:106,high:106.2,low:104.8,close:105});
 assert.ok(ids(bars).includes("three_outside_up"));
});
test("Soldiers/Crows reject shrinking bodies, large final-side shadows, and opens outside prior bodies",()=>{
 const shrinking=fixture("three_white_soldiers");Object.assign(shrinking.at(-1)!,{open:106.5,high:108.1,low:106.4,close:108});
 assert.ok(!ids(shrinking).includes("three_white_soldiers"));
 const wick=fixture("three_black_crows");wick.at(-1)!.low-=4;
 assert.ok(!ids(wick).includes("three_black_crows"));
 const outside=fixture("three_white_soldiers");outside.at(-1)!.open=outside.at(-2)!.close;
 assert.ok(!ids(outside).includes("three_white_soldiers"));
});
test("two-candle Doji Star is not a three-candle Morning/Evening Star or Abandoned Baby",()=>{
 for(const id of ["bullish_doji_star","bearish_doji_star"]){
  const result=ids(fixture(id));assert.ok(result.includes(id));
  assert.ok(!result.some(x=>["morning_star","morning_doji_star","evening_star","evening_doji_star","bullish_abandoned_baby","bearish_abandoned_baby"].includes(x)));
 }
 const gap=fixture("bullish_doji_star");Object.assign(gap.at(-1)!,{open:99,close:99.01,high:99.5,low:98.5});
 assert.ok(!ids(gap).includes("bullish_doji_star"));
});
test("Doji Star needs a body gap, not an invented whole-shadow gap",()=>{
 const bars=fixture("bullish_doji_star");bars.at(-1)!.high=99.5;
 assert.ok(bars.at(-1)!.high>bars.at(-2)!.low);
 assert.ok(ids(bars).includes("bullish_doji_star"));
});
test("Kicking requires both long nearly shadowless bodies, but no invented prior trend",()=>{
 const b=fixture("bullish_kicking");b.at(-2)!.low-=4;assert.ok(!ids(b).includes("bullish_kicking"));
 const small=fixture("bearish_kicking");small.at(-1)!.close=small.at(-1)!.open-.1;small.at(-1)!.low=small.at(-1)!.close;
 assert.ok(!ids(small).includes("bearish_kicking"));
 assert.equal(scan(fixture("bullish_kicking")).observations.find(o=>o.definition.id==="bullish_kicking")!.priorTrend,"none");
});
test("Counterattack rejects unmatched closes and short bodies",()=>{
 const b=fixture("bullish_counterattack");b.at(-1)!.close+=.5;b.at(-1)!.high+=.5;assert.ok(!ids(b).includes("bullish_counterattack"));
 const small=fixture("bearish_counterattack");small.at(-1)!.open=small.at(-1)!.close+.1;assert.ok(!ids(small).includes("bearish_counterattack"));
});
test("every new multi-candle definition refuses missing and future final observations",()=>{
 for(const f of CANDLE_FIXTURES.slice(34)){
  const bars=f.bars.map(b=>({...b})),end=bars.at(-1)!;
  end.time+=300;end.closeTime+=300;assert.ok(!ids(bars).includes(f.id),f.id);
  const priorEnd=f.bars.at(-2)!.closeTime;
  const full=scanCandlestickCatalogue(f.bars,{asOf:priorEnd,intervalSeconds:300,eventLookback:12});
  const prefix=scanCandlestickCatalogue(f.bars.slice(0,-1),{asOf:priorEnd,intervalSeconds:300,eventLookback:12});
  assert.deepEqual(full,prefix,f.id);
 }
});
test("public definition metadata cannot be mutated by callers",()=>{
 assert.ok(Object.isFrozen(CANDLE_DEFINITIONS));
 for(const d of CANDLE_DEFINITIONS){assert.ok(Object.isFrozen(d));assert.ok(Object.isFrozen(d.sources));}
});
test("trend-based catalogue names do not infer context from their own formation",()=>{
 for(const f of CANDLE_FIXTURES.slice(50).filter(f=>f.id!=="kicking_by_length")){
  const bars=f.bars.map(b=>({...b}));for(let i=0;i<12;i++)bars[i]={...bars[i]!,open:101,high:103,low:100,close:102};
  assert.ok(!ids(bars).includes(f.id),f.id);
 }
});
test("Matching Low compares closes rather than lows and does not invent a long-body requirement",()=>{
 const matching=fixture("matching_low");assert.notEqual(matching.at(-2)!.low,matching.at(-1)!.low);assert.ok(ids(matching).includes("matching_low"));
 const lows=fixture("matching_low");Object.assign(lows.at(-1)!,{low:lows.at(-2)!.low,close:99.5});assert.ok(!ids(lows).includes("matching_low"));
 const short=fixture("matching_low");Object.assign(short.at(-2)!,{open:99.5,high:99.7,low:98.5,close:99});Object.assign(short.at(-1)!,{open:99.4,high:99.6,low:98,close:99.05});assert.ok(ids(short).includes("matching_low"));
 const colour=fixture("matching_low");Object.assign(colour.at(-1)!,{open:98.9,close:99.05});assert.ok(!ids(colour).includes("matching_low"));
});
test("Homing Pigeon requires same down colour, strict containment and its causal short-body baseline",()=>{
 const colour=fixture("homing_pigeon");Object.assign(colour.at(-1)!,{open:101,close:102});assert.ok(!ids(colour).includes("homing_pigeon"));
 const edge=fixture("homing_pigeon");edge.at(-1)!.close=edge.at(-2)!.close;edge.at(-1)!.low=98.5;assert.ok(!ids(edge).includes("homing_pigeon"));
 const long=fixture("homing_pigeon");Object.assign(long.at(-1)!,{open:102,close:100.4,low:100.2});assert.ok(!ids(long).includes("homing_pigeon"),"inside half-body is not sufficient if not short versus its own prior baseline");
});
test("On-Neck, In-Neck and Thrusting use distinct reference prices and penetration boundaries",()=>{
 for(const id of ["on_neck","in_neck","thrusting"]){
  const result=ids(fixture(id));assert.ok(result.includes(id));assert.ok(["on_neck","in_neck","thrusting"].filter(x=>x!==id).every(x=>!result.includes(x)));
  const noGap=fixture(id);noGap.at(-1)!.open=noGap.at(-2)!.low;assert.ok(!ids(noGap).includes(id));
 }
 const edge=fixture("in_neck");edge.at(-1)!.close=99.125;
 assert.ok(ids(edge).includes("in_neck"));assert.ok(!ids(edge).includes("thrusting"));
 const midpoint=fixture("thrusting");midpoint.at(-1)!.close=101;midpoint.at(-1)!.high=101.3;
 assert.ok(ids(midpoint).includes("thrusting"));assert.ok(!ids(midpoint).includes("piercing_line"));
 midpoint.at(-1)!.close=101.01;assert.ok(!ids(midpoint).includes("thrusting"));assert.ok(ids(midpoint).includes("piercing_line"));
});
test("Separating Lines require near-equal opens and a long second body with a small opening shadow",()=>{
 const open=fixture("bullish_separating_lines");open.at(-1)!.open+=.5;assert.ok(!ids(open).includes("bullish_separating_lines"));
 const wick=fixture("bearish_separating_lines");wick.at(-1)!.high+=1;assert.ok(!ids(wick).includes("bearish_separating_lines"));
 const short=fixture("bullish_separating_lines");Object.assign(short.at(-1)!,{close:103.4,high:103.5});assert.ok(!ids(short).includes("bullish_separating_lines"));
});
test("Tri-Star requires all three Doji, a middle body gap and movement from the middle extreme",()=>{
 const notDoji=fixture("bullish_tri_star");notDoji.at(-3)!.close=102.3;assert.ok(!ids(notDoji).includes("bullish_tri_star"));
 const noGap=fixture("bullish_tri_star");Object.assign(noGap.at(-2)!,{open:102,close:102.01,high:102.5,low:101.5});assert.ok(!ids(noGap).includes("bullish_tri_star"));
 const notRecovered=fixture("bullish_tri_star");Object.assign(notRecovered.at(-1)!,{open:101,close:101.01,high:101.5,low:100.5});assert.ok(!ids(notRecovered).includes("bullish_tri_star"));
 const overlap=fixture("bullish_tri_star");Object.assign(overlap.at(-1)!,{open:101.005,close:101.008,high:101.5,low:100.5});assert.ok(ids(overlap).includes("bullish_tri_star"),"third body need not gap above the middle body");
});
test("Tasuki retains a strict unfilled body gap, an interior open and similar last-two body lengths",()=>{
 const filled=fixture("upside_tasuki_gap");filled.at(-1)!.close=104;filled.at(-1)!.low=103.8;assert.ok(!ids(filled).includes("upside_tasuki_gap"));
 const open=fixture("upside_tasuki_gap");open.at(-1)!.open=open.at(-2)!.open;assert.ok(!ids(open).includes("upside_tasuki_gap"));
 const unequal=fixture("upside_tasuki_gap");unequal.at(-1)!.close=104.1;unequal.at(-1)!.low=103.8;assert.ok(!ids(unequal).includes("upside_tasuki_gap"));
 const freeFirst=fixture("upside_tasuki_gap");Object.assign(freeFirst.at(-3)!,{open:104,close:103});freeFirst.at(-2)!.low=103.8;
 assert.ok(ids(freeFirst).includes("upside_tasuki_gap"),"first colour and whole-shadow gaps are not required");
});
test("Kicking by Length describes the larger body, never silently the final body or a tied pair",()=>{
 const largerSecond=fixture("kicking_by_length"),second=scan(largerSecond).observations.find(o=>o.definition.id==="kicking_by_length")!;assert.match(second.explanation,/longer body is up/);assert.equal(second.priorTrend,"none");
 const largerFirst=fixture("kicking_by_length");Object.assign(largerFirst.at(-2)!,{open:103,high:103,low:97,close:97});
 const first=scan(largerFirst).observations.find(o=>o.definition.id==="kicking_by_length")!;assert.match(first.explanation,/longer body is down/);assert.ok(ids(largerFirst).includes("bullish_kicking"));
 assert.ok(!ids(fixture("bullish_kicking")).includes("kicking_by_length"),"equal body lengths have no longer colour");
 const noGap=fixture("kicking_by_length");Object.assign(noGap.at(-1)!,{open:103,low:103,high:108,close:108});assert.ok(!ids(noGap).includes("kicking_by_length"));
});
test("coverage bookkeeping matches code",()=>{
 const coverage=JSON.parse(readFileSync(new URL("../../../../../docs/SMART_CHART_CANDLE_COVERAGE.json",import.meta.url),"utf8"));
 const entries=coverage.entries as {status:string;definitionId:string|null}[];
 assert.equal(coverage.criteriaVersion,CANDLE_CRITERIA_VERSION);
 assert.equal(coverage.counts.ownerNamedEntries,entries.length);
 assert.equal(coverage.counts.newCatalogueNamedVariants,CANDLE_DEFINITIONS.length);
 assert.equal(coverage.counts.newGeometryFamilies,new Set(CANDLE_DEFINITIONS.map(d=>d.family)).size);
 assert.equal(coverage.counts.includingExistingCoreNamedEntries,CANDLE_DEFINITIONS.length+entries.filter(r=>r.status==="EXISTING_CORE_IMPLEMENTATION").length);
 assert.equal(coverage.counts.pendingNamedEntries,entries.filter(r=>r.definitionId===null).length);
});
/** Near misses must stay valid closed evidence, so a rejection is never just an unavailable scan. */
const has=(bars:readonly CatalogueCandle[],id:string)=>{const result=scan(bars);assert.equal(result.status,"ready",result.reason??"");return result.observations.some(o=>o.definition.id===id);};
/** Mutate a bullish-side fixture, then check both it and its mirrored bearish side. */
function bothSides(upId:string,downId:string,mutate:(b:CatalogueCandle[])=>void,expected:boolean,label:string){
 const b=fixture(upId);mutate(b);
 assert.equal(has(b,upId),expected,`${upId}: ${label}`);
 assert.equal(has(mirror(b),downId),expected,`${downId} (mirror): ${label}`);
}
test("Rising/Falling Three Methods need contained reactions and a strict final close",()=>{
 const pair=["rising_three_methods","falling_three_methods"] as const;
 bothSides(...pair,b=>{Object.assign(b.at(-2)!,{open:102.1,high:102.2,low:101.6,close:101.75});},false,"reaction body below the first low");
 bothSides(...pair,b=>{Object.assign(b.at(-2)!,{open:102.1,high:102.2,low:101.6,close:101.85});},true,"control: reaction body inside the first range");
 bothSides(...pair,b=>{b.at(-1)!.close=b.at(-5)!.close;},false,"final close equals the first close");
 bothSides(...pair,b=>{Object.assign(b.at(-4)!,{open:105.1,close:105.6});},false,"a reaction with the first candle's colour");
 bothSides(...pair,b=>{b.at(-3)!.open=105.5;b.at(-3)!.high=105.6;},false,"a reaction body that is not short");
});
test("Three-Line Strike needs strict engulfment",()=>{
 const pair=["bullish_three_line_strike","bearish_three_line_strike"] as const;
 bothSides(...pair,b=>{b.at(-1)!.close=b.at(-4)!.open;},false,"strike close equals the first open");
 bothSides(...pair,b=>{b.at(-1)!.open=b.at(-2)!.close;},false,"strike open equals the third close");
 bothSides(...pair,b=>{b.at(-3)!.open=104.7;},false,"second open beyond the first body plus .25 of the mean range");
 bothSides(...pair,b=>{b.at(-3)!.open=104.6;},true,"control: second open inside the near tolerance");
 bothSides(...pair,b=>{b.at(-2)!.close=b.at(-3)!.close;},false,"closes do not progress");
});
test("Gap Three Methods needs a body gap, opposite third colour and a fill into the first body",()=>{
 const pair=["upside_gap_three_methods","downside_gap_three_methods"] as const;
 bothSides(...pair,b=>{b.at(-2)!.open=b.at(-3)!.close;b.at(-2)!.low=104.8;},false,"no body gap");
 bothSides(...pair,b=>{Object.assign(b.at(-1)!,{open:103.5,close:107.5});},false,"third candle has the second candle's colour");
 bothSides(...pair,b=>{b.at(-1)!.open=b.at(-2)!.close;b.at(-1)!.high=b.at(-2)!.close+.2;},false,"third open touches the second close");
 bothSides(...pair,b=>{b.at(-1)!.close=105.5;},false,"third close stays inside the gap");
 assert.ok(!has(fixture("upside_tasuki_gap"),"upside_gap_three_methods"));
 assert.ok(!has(fixture("upside_gap_three_methods"),"upside_tasuki_gap"));
 assert.ok(!has(fixture("downside_tasuki_gap"),"downside_gap_three_methods"));
 assert.ok(!has(fixture("downside_gap_three_methods"),"downside_tasuki_gap"));
});
test("Side-by-Side White Lines need near-equal opens, similar bodies and two white candles",()=>{
 const upId="upside_gap_side_by_side_white_lines",downId="downside_gap_side_by_side_white_lines";
 const open=fixture(upId);open.at(-1)!.open=open.at(-2)!.open+.5;assert.ok(!has(open,upId));
 const near=fixture(upId);near.at(-1)!.open=near.at(-2)!.open+.1;assert.ok(has(near,upId),"control: opens within .05 of the mean range");
 const black=fixture(upId);Object.assign(black.at(-1)!,{open:107.1,close:105.55});assert.ok(!has(black,upId));
 const unequal=fixture(upId);unequal.at(-1)!.close=105.9;assert.ok(!has(unequal,upId),"body difference 1.15 exceeds .25 of the mean range");
 const down=fixture(downId),[mid,last]=[down.at(-2)!,down.at(-1)!];
 assert.ok(mid.close>mid.open&&last.close>last.open,"downside variant keeps two white candles");
 const touching=fixture(downId);Object.assign(touching.at(-2)!,{close:99.45,high:99.5});Object.assign(touching.at(-1)!,{close:99.5,high:99.6});
 assert.ok(!has(touching,downId),"third body touches the first body");
 const below=fixture(downId);Object.assign(below.at(-2)!,{close:99.45,high:99.5});Object.assign(below.at(-1)!,{close:99.45,high:99.6});
 assert.ok(has(below,downId),"control: same lengths with the gap intact");
});
test("Mat Hold and Rising Three Methods never alias",()=>{
 assert.ok(!has(fixture("mat_hold"),"rising_three_methods"));
 assert.ok(!has(fixture("rising_three_methods"),"mat_hold"));
 const gapped=fixture("rising_three_methods");Object.assign(gapped.at(-4)!,{open:106.15,high:106.2,low:106,close:106.05});
 assert.ok(!has(gapped,"rising_three_methods"),"a first reaction gapped above the first body is not Rising Three Methods");
 const deep=fixture("mat_hold");Object.assign(deep.at(-2)!,{open:104.4,high:104.5,low:103.7,close:103.9});
 assert.ok(!has(deep,"mat_hold"),"reaction penetrates more than half the first body");
 const noClear=fixture("mat_hold");noClear.at(-1)!.close=107;
 assert.ok(!has(noClear,"mat_hold"),"final close equals the highest reaction high");
 const longReaction=fixture("mat_hold");Object.assign(longReaction.at(-4)!,{open:107.3,high:107.5});
 assert.ok(!has(longReaction,"mat_hold"),"first reaction body is not short");
});
test("4- and 5-candle windows refuse internal gaps and short histories",()=>{
 for(const [id,size] of [["bullish_three_line_strike",4],["bearish_three_line_strike",4],["rising_three_methods",5],["falling_three_methods",5],["mat_hold",5]] as const){
  const bars=fixture(id);for(const b of bars.slice(-2)){b.time+=300;b.closeTime+=300;}
  assert.ok(!has(bars,id),`${id}: internal gap`);
  const tail=observed(fixture(id).slice(-size).map(({open,high,low,close})=>({open,high,low,close})));
  const result=scanCandlestickCatalogue(tail,{asOf:tail.at(-1)!.closeTime,intervalSeconds:300});
  assert.equal(result.status,"ready");assert.ok(!result.observations.some(o=>o.definition.id===id),`${id}: no prior history`);
 }
});
test("Identical Three Crows needs equal opens and very short lower shadows",()=>{
 assert.ok(!has(fixture("three_black_crows"),"identical_three_crows"),"opens 2 inside the prior body exceed the .125 equal tolerance");
 assert.ok(!has(fixture("identical_three_crows"),"three_black_crows"),"opens equal to the prior close are not strictly inside the prior body");
 const far=fixture("identical_three_crows");far.at(-2)!.open=far.at(-3)!.close+.2;assert.ok(!has(far,"identical_three_crows"));
 const overlap=fixture("identical_three_crows");overlap.at(-2)!.open=overlap.at(-3)!.close+.1;overlap.at(-1)!.open=overlap.at(-2)!.close+.1;
 assert.ok(has(overlap,"identical_three_crows")&&has(overlap,"three_black_crows"),"control: within tolerance and inside the prior bodies emits both ids");
 const shadow=fixture("identical_three_crows");shadow.at(-3)!.low=shadow.at(-3)!.close-.4;assert.ok(!has(shadow,"identical_three_crows"),"first lower shadow .4 exceeds .25");
});
test("Two Crows needs a body gap, an open inside the second body and a close inside the first body",()=>{
 const id="two_crows";
 const outside=fixture(id);outside.at(-1)!.close=106.2;assert.ok(!has(outside,id),"third close above the first body");
 const below=fixture(id);Object.assign(below.at(-1)!,{close:101.9,low:101.7});assert.ok(!has(below,id),"third close below the first open");
 const touching=fixture(id);Object.assign(touching.at(-2)!,{close:106,low:105.9});assert.ok(!has(touching,id),"no body gap");
 const high=fixture(id);Object.assign(high.at(-1)!,{open:107.1,high:107.2});assert.ok(!has(high,id),"third open above the second open");
});
test("Upside Gap Two Crows needs the third body to engulf the second and close above the first",()=>{
 const id="upside_gap_two_crows";
 const notBelow=fixture(id);notBelow.at(-1)!.close=106.7;assert.ok(!has(notBelow,id),"third close not below the second close");
 const notAbove=fixture(id);notAbove.at(-1)!.open=106.9;assert.ok(!has(notAbove,id),"third open not above the second open");
 const atFirst=fixture(id);Object.assign(atFirst.at(-1)!,{close:106,low:105.9});assert.ok(!has(atFirst,id),"third close equals the first close");
 const bodyGap=fixture(id);assert.ok(bodyGap.at(-2)!.low<=bodyGap.at(-3)!.high);assert.ok(has(bodyGap,id),"a body gap is enough");
 const fullGap=fixture(id);fullGap.at(-2)!.low=106.3;assert.ok(has(fullGap,id),"a full-range gap also qualifies");
 // Touching bodies also leave no room for a third close between the second and first closes.
 const touching=fixture(id);Object.assign(touching.at(-2)!,{close:106,low:105.9});assert.ok(!has(touching,id),"no body gap");
});
test("Stick Sandwich needs matching closes and a white middle",()=>{
 const id="stick_sandwich";
 const far=fixture(id);far.at(-1)!.close=99.7;assert.ok(!has(far,id),"closes .2 apart exceed .125");
 const near=fixture(id);near.at(-1)!.close=99.6;assert.ok(has(near,id),"control: closes .1 apart");
 const black=fixture(id);Object.assign(black.at(-2)!,{open:101.5,close:100});assert.ok(!has(black,id),"black middle");
 const touch=fixture(id);touch.at(-2)!.low=touch.at(-3)!.close;assert.ok(!has(touch,id),"middle low touches the first close");
});
test("Unique Three-River needs a lower second low and a short third body",()=>{
 const id="unique_three_river_bottom";
 const long=fixture(id);Object.assign(long.at(-1)!,{close:100.9,high:101});assert.ok(!has(long,id),"third body 1.3 is not short");
 const low=fixture(id);low.at(-2)!.low=99.4;assert.ok(!has(low,id),"second low not below the first low");
 const open=fixture(id);Object.assign(open.at(-1)!,{open:98.5,low:98.4,close:98.7});assert.ok(!has(open,id),"third open at the second low");
 const higher=fixture(id);Object.assign(higher.at(-2)!,{open:103.1,high:103.2});assert.ok(!has(higher,id),"second open above the first open");
});
test("Three Stars in the South keeps the third range inside the second",()=>{
 const id="three_stars_in_the_south";
 const low=fixture(id);low.at(-1)!.low=97.05;assert.ok(!has(low,id),"third low below the second low");
 const high=fixture(id);high.at(-1)!.high=100.8;assert.ok(!has(high,id),"third high above the second high");
 const shadow=fixture(id);Object.assign(shadow.at(-2)!,{open:100.4,close:98,low:97.75});assert.ok(!has(shadow,id),"second lower shadow .25 is within .1 of the mean range");
 const deep=fixture(id);deep.at(-2)!.low=94.9;assert.ok(!has(deep,id),"second low below the first low");
});
test("Ladder Bottom needs a visible fourth upper shadow and a fifth open above the fourth body",()=>{
 const id="ladder_bottom";
 const shadow=fixture(id);shadow.at(-2)!.high=96.9;assert.ok(!has(shadow,id),"fourth upper shadow .1 is below .1 of the mean range");
 const open=fixture(id);Object.assign(open.at(-1)!,{open:96.8,low:96.7});assert.ok(!has(open,id),"fifth open equals the fourth open");
 const close=fixture(id);close.at(-1)!.close=97.8;assert.ok(!has(close,id),"fifth close equals the fourth high");
 const opens=fixture(id);Object.assign(opens.at(-4)!,{open:101.5,high:101.6});assert.ok(!has(opens,id),"opens do not fall");
 const gap=fixture(id);for(const b of gap.slice(-2)){b.time+=300;b.closeTime+=300;}assert.ok(!has(gap,id),"internal gap");
 const tail=observed(fixture(id).slice(-5).map(({open,high,low,close})=>({open,high,low,close})));
 assert.ok(!scanCandlestickCatalogue(tail,{asOf:tail.at(-1)!.closeTime,intervalSeconds:300}).observations.some(o=>o.definition.id===id),"no prior history");
});
/** One-predicate near misses for the v4/v5 shapes. Each miss breaks exactly one published
 * criterion while the rest still hold; the passing control beside it shows that. */
const set=(b:CatalogueCandle[],at:number,v:Partial<CatalogueCandle>)=>{Object.assign(b.at(at)!,v);};
function oneSide(id:string,mutate:(b:CatalogueCandle[])=>void,expected:boolean,label:string){const b=fixture(id);mutate(b);assert.equal(has(b,id),expected,`${id}: ${label}`);}
test("Rising/Falling Three Methods: one-predicate near misses",()=>{
 const pair=["rising_three_methods","falling_three_methods"] as const;
 bothSides(...pair,b=>set(b,-3,{open:105.6,high:105.8,close:105.1}),false,"second reaction close equals the first reaction close");
 bothSides(...pair,b=>{set(b,-2,{open:105.1,high:105.3,close:104.55});set(b,-1,{open:104.8});},true,"control: third reaction close below the second");
 bothSides(...pair,b=>{set(b,-2,{open:105.1,high:105.3,close:104.6});set(b,-1,{open:104.8});},false,"third reaction close equals the second reaction close");
 bothSides(...pair,b=>set(b,-1,{open:104.3,high:106.7,low:104.1,close:106.5}),true,"control: a long fifth body closing above the first close");
 bothSides(...pair,b=>set(b,-1,{open:105.9,high:106.7,low:105.8,close:106.5}),false,"fifth body .6 is not above its prior-10 mean body 1.15");
 bothSides(...pair,b=>set(b,-1,{open:104.15}),true,"control: fifth open just beyond the third reaction close");
 bothSides(...pair,b=>set(b,-1,{open:104.1}),false,"fifth open equals the third reaction close");
 bothSides(...pair,b=>set(b,-2,{open:104.65}),true,"control: third reaction body .55 is short");
 bothSides(...pair,b=>set(b,-2,{open:105,high:105.1}),false,"third reaction body .9 is not short");
 bothSides(...pair,b=>set(b,-4,{open:106.15,high:106.2,low:105.9,close:105.95}),true,"control: first reaction close below the first close");
 bothSides(...pair,b=>set(b,-4,{open:106.15,high:106.2,low:106,close:106.05}),false,"first reaction close beyond the first close");
 const smallReactions=(b:CatalogueCandle[])=>{
  set(b,-4,{open:105.6,high:105.8,low:105.2,close:105.3});set(b,-3,{open:105.3,high:105.5,low:104.9,close:105});
  set(b,-2,{open:105,high:105.2,low:104.6,close:104.7});set(b,-1,{open:104.8});
 };
 bothSides(...pair,smallReactions,true,"control: .3 reaction bodies after a long first body");
 bothSides(...pair,b=>{smallReactions(b);set(b,-5,{open:105});},false,"first body 1 equals its prior-10 mean body");
});
test("Mat Hold: one-predicate near misses",()=>{
 const id="mat_hold";
 oneSide(id,b=>{set(b,-4,{open:106.5});set(b,-3,{open:106.45,high:106.6,close:105.9});},true,"control: second reaction top below the first reaction open");
 oneSide(id,b=>{set(b,-4,{open:106.5});set(b,-3,{open:106.5,high:106.6,close:105.9});},false,"second reaction top equals the first reaction open");
 oneSide(id,b=>{set(b,-2,{open:106.15,high:106.3,close:105.7});set(b,-1,{open:105.8});},true,"control: third reaction top below the second");
 oneSide(id,b=>{set(b,-2,{open:106.2,high:106.3,close:105.7});set(b,-1,{open:105.8});},false,"third reaction top equals the second reaction top");
 oneSide(id,b=>set(b,-2,{open:104.6,high:104.7,low:104,close:104.05}),true,"control: reaction bottom just inside the upper half of the first body");
 oneSide(id,b=>set(b,-2,{open:104.5,high:104.7,low:103.9,close:103.95}),false,"reaction bottom just below the first body's midpoint");
 oneSide(id,b=>set(b,-3,{close:105.95}),true,"control: reaction bottom just below the first close");
 oneSide(id,b=>set(b,-3,{close:106}),false,"reaction bottom equals the first close");
 oneSide(id,b=>set(b,-1,{open:105.45,low:105.4}),true,"control: fifth open just above the last reaction close");
 oneSide(id,b=>set(b,-1,{open:105.4,low:105.4}),false,"fifth open equals the last reaction close");
 oneSide(id,b=>set(b,-4,{open:106.5,low:105.9,close:106.05}),true,"control: first reaction body just above the first close");
 oneSide(id,b=>set(b,-4,{open:106.5,low:105.9,close:106}),false,"first reaction body touches the first close");
 oneSide(id,b=>set(b,-2,{open:105.45}),true,"control: a .05 third reaction body is short");
 oneSide(id,b=>set(b,-2,{open:105.4}),false,"a zero-body reaction is not a short body");
 const smallReactions=(b:CatalogueCandle[])=>{
  set(b,-4,{open:106.5,high:106.6,low:106.1,close:106.2});set(b,-3,{open:106.1,high:106.2,low:105.6,close:105.8});
  set(b,-2,{open:106,high:106.05,low:105.6,close:105.7});set(b,-1,{open:105.8});
 };
 oneSide(id,smallReactions,true,"control: .3 reaction bodies after a long first body");
 oneSide(id,b=>{smallReactions(b);set(b,-5,{open:105});},false,"first body 1 equals its prior-10 mean body");
});
test("Three-Line Strike: one-predicate near misses",()=>{
 const pair=["bullish_three_line_strike","bearish_three_line_strike"] as const;
 bothSides(...pair,b=>set(b,-2,{open:106.55}),true,"control: third open inside the second body plus .25 of its prior mean range");
 bothSides(...pair,b=>set(b,-2,{open:106.7}),false,"third open beyond the second body plus .25 of its prior mean range");
 bothSides(...pair,b=>set(b,-3,{open:104.624}),true,"control: second open just inside .25 of the first candle's prior mean range");
 bothSides(...pair,b=>{set(b,-3,{high:104.2,close:104.05});set(b,-2,{open:104.5,low:104.4});},true,"control: second close just beyond the first close");
 bothSides(...pair,b=>{set(b,-3,{high:104.2,close:104});set(b,-2,{open:104.5,low:104.4});},false,"second close equals the first close");
});
test("Gap Three Methods: one-predicate near misses",()=>{
 const pair=["upside_gap_three_methods","downside_gap_three_methods"] as const;
 bothSides(...pair,b=>set(b,-1,{open:106.05}),true,"control: third open just inside the second body");
 bothSides(...pair,b=>set(b,-1,{open:106}),false,"third open equals the second open");
 bothSides(...pair,b=>set(b,-1,{close:102.6,low:102.3}),true,"control: third close just inside the first body");
 bothSides(...pair,b=>set(b,-1,{close:102.4,low:102.3}),false,"third close over-fills beyond the first open");
 bothSides(...pair,b=>set(b,-1,{close:104.95}),true,"control: third close just inside the first close");
 bothSides(...pair,b=>set(b,-1,{close:105}),false,"third close equals the first close");
});
test("Side-by-Side White Lines: one-predicate near misses and tolerance boundaries",()=>{
 const upId="upside_gap_side_by_side_white_lines",downId="downside_gap_side_by_side_white_lines";
 oneSide(upId,b=>set(b,-1,{open:105.62}),true,"control: opens .12 apart, inside .05 of the mean range (.127)");
 oneSide(upId,b=>set(b,-1,{open:105.63}),false,"opens .13 apart exceed .127");
 oneSide(upId,b=>set(b,-1,{close:106.42}),true,"control: body difference .63 is inside .25 of the mean range (.635)");
 oneSide(upId,b=>set(b,-1,{close:106.41}),false,"body difference .64 exceeds .635");
 oneSide(upId,b=>{set(b,-2,{open:104.55,low:104.4});set(b,-1,{open:104.52,low:104.4});},true,"control: both bodies just above the first body");
 oneSide(upId,b=>{set(b,-2,{open:104.55,low:104.4});set(b,-1,{open:104.45,low:104.4});},false,"third body dips into the first body");
 oneSide(upId,b=>{set(b,-2,{open:104.45,low:104.4});set(b,-1,{open:104.55,low:104.4});},false,"second body dips into the first body");
 const pair={open:107.05,high:108.8,low:106.9,close:108.6};
 oneSide(upId,b=>{set(b,-2,{open:107,high:108.7,low:106.8,close:108.5});set(b,-1,pair);},true,"control: white middle candle");
 oneSide(upId,b=>{set(b,-2,{open:107,high:107.2,low:105.3,close:105.5});set(b,-1,pair);},false,"black middle candle with a matching open and length");
 oneSide(downId,b=>{set(b,-2,{close:99.55,high:99.6});set(b,-1,{close:99.45,high:99.5});},false,"second body reaches into the first body");
 oneSide(downId,b=>{set(b,-2,{close:99.45,high:99.5});set(b,-1,{close:99.55,high:99.6});},false,"third body reaches into the first body");
});
test("Identical Three Crows: one-predicate near misses and tolerance boundaries",()=>{
 const id="identical_three_crows";
 oneSide(id,b=>set(b,-1,{open:141.13}),true,"control: third open .13 from the second close, inside .05 of the mean range (.1345)");
 oneSide(id,b=>set(b,-1,{open:141.14}),false,"third open .14 from the second close exceeds .1345");
 oneSide(id,b=>set(b,-2,{low:140.75}),true,"control: second lower shadow .25 is below .269");
 oneSide(id,b=>set(b,-2,{low:140.72}),false,"second lower shadow .28 exceeds .269");
 oneSide(id,b=>set(b,-1,{low:136.73}),true,"control: third lower shadow .27 is below .288");
 oneSide(id,b=>set(b,-1,{low:136.7}),false,"third lower shadow .3 exceeds .288");
 oneSide(id,b=>set(b,-1,{open:141.12,high:141.2,low:140.9,close:140.95}),true,"control: third close just below the second close");
 oneSide(id,b=>set(b,-1,{open:141.12,high:141.2,low:140.9,close:141}),false,"third close equals the second close");
});
test("Two Crows and Upside Gap Two Crows: one-predicate near misses",()=>{
 oneSide("two_crows",b=>set(b,-1,{close:105.5}),true,"control: third close inside a long first body");
 oneSide("two_crows",b=>{set(b,-1,{close:105.5});set(b,-3,{open:105});},false,"first body 1 equals its prior-10 mean body");
 oneSide("two_crows",b=>set(b,-1,{open:106.55}),true,"control: third open just inside the second body");
 oneSide("two_crows",b=>set(b,-1,{open:106.5}),false,"third open equals the second close");
 oneSide("two_crows",b=>set(b,-1,{close:102.05,low:101.9}),true,"control: third close just above the first open");
 oneSide("two_crows",b=>set(b,-1,{close:102,low:101.7}),false,"third close equals the first open");
 oneSide("two_crows",b=>set(b,-1,{close:105.95}),true,"control: third close just below the first close");
 oneSide("two_crows",b=>set(b,-1,{close:106}),false,"third close equals the first close");
 const id="upside_gap_two_crows";
 oneSide(id,b=>{set(b,-2,{open:107.2,high:107.5});set(b,-1,{open:107.5,high:107.6});},true,"control: second body .6 is short");
 oneSide(id,b=>{set(b,-2,{open:107.4,high:107.5});set(b,-1,{open:107.5,high:107.6});},false,"second body .8 is not short");
 oneSide(id,b=>set(b,-1,{open:107.05}),true,"control: third open just above the second open");
 oneSide(id,b=>set(b,-1,{open:107}),false,"third open equals the second open");
});
test("Stick Sandwich: tolerance boundary, reference index and third colour",()=>{
 const id="stick_sandwich";
 oneSide(id,b=>set(b,-1,{close:99.62}),true,"control: closes .12 apart");
 oneSide(id,b=>set(b,-1,{close:99.63}),false,"closes .13 apart exceed .05 of the first candle's prior mean range (.125)");
 oneSide(id,b=>set(b,-1,{close:99.6248}),true,"control: .1248 is inside .125, so the tolerance uses the first candle's prior range");
 oneSide(id,b=>set(b,-1,{open:99.4,low:99.3}),false,"white third candle");
});
test("Unique Three-River: one-predicate near misses",()=>{
 const id="unique_three_river_bottom";
 oneSide(id,b=>set(b,-2,{close:99.55}),true,"control: second close just above the first close");
 oneSide(id,b=>set(b,-2,{close:99.5}),false,"second close equals the first close");
 oneSide(id,b=>set(b,-2,{open:103,high:103.2}),true,"control: second open may equal the first open");
 oneSide(id,b=>set(b,-2,{low:99.25}),true,"control: second low just below the first low");
 oneSide(id,b=>set(b,-2,{low:99.3}),false,"second low equals the first low");
 oneSide(id,b=>set(b,-2,{open:100.5}),true,"control: a smaller second body after a long first body");
 oneSide(id,b=>{set(b,-2,{open:100.5});set(b,-3,{open:100.5});},false,"first body 1 equals its prior-10 mean body");
});
test("Three Stars in the South: one-predicate near misses",()=>{
 const id="three_stars_in_the_south";
 oneSide(id,b=>set(b,-3,{low:96.9}),true,"control: first lower shadow 2.6 exceeds its body 2.5");
 oneSide(id,b=>set(b,-3,{low:97}),false,"first lower shadow equals its body");
 oneSide(id,b=>set(b,-2,{open:100.9,high:101.2}),true,"control: second body 2.4 is smaller than the first");
 oneSide(id,b=>set(b,-2,{open:101,high:101.2}),false,"second body equals the first body");
 oneSide(id,b=>set(b,-2,{open:99.55}),true,"control: second open just above the first close");
 oneSide(id,b=>set(b,-2,{open:99.5}),false,"second open equals the first close");
 oneSide(id,b=>{set(b,-3,{high:102});set(b,-2,{open:102,high:102.1,close:99.6});},true,"control: second open at the first high");
 oneSide(id,b=>{set(b,-3,{high:102});set(b,-2,{open:102.05,high:102.1,close:99.6});},false,"second open above the first high");
 const heldLow=(low:number)=>(b:CatalogueCandle[])=>{set(b,-2,{open:101,high:101.2,low,close:99.85});set(b,-1,{open:99.8,high:99.82,low:99.58,close:99.6});};
 oneSide(id,heldLow(99.45),true,"control: second low just below the first close");
 oneSide(id,heldLow(99.5),false,"second low equals the first close");
 oneSide(id,b=>set(b,-2,{low:95}),true,"control: second low may equal the first low");
 oneSide(id,b=>set(b,-1,{high:98.89}),true,"control: third upper shadow .29 is below .1 of its prior mean range (.304)");
 oneSide(id,b=>set(b,-1,{high:98.91}),false,"third upper shadow .31 exceeds .304");
 oneSide(id,b=>set(b,-1,{low:97.81}),true,"control: third lower shadow .29 is below .304");
 oneSide(id,b=>set(b,-1,{low:97.79}),false,"third lower shadow .31 exceeds .304");
 oneSide(id,b=>set(b,-1,{open:98.7,high:98.75}),true,"control: third body .6 is short");
 oneSide(id,b=>set(b,-1,{open:98.8,high:98.85}),false,"third body .7 is not short");
 oneSide(id,b=>set(b,-1,{open:98,high:98.05,low:97.51,close:97.55}),true,"control: third low just above the second low");
 oneSide(id,b=>set(b,-1,{open:98,high:98.05,low:97.5,close:97.55}),false,"third low equals the second low");
 const small=(b:CatalogueCandle[])=>{set(b,-2,{open:100.2,close:99.3});set(b,-1,{open:98.5,high:98.55});};
 oneSide(id,small,true,"control: a .9 second body after a long first body");
 oneSide(id,b=>{small(b);set(b,-3,{open:100.5});},false,"first body 1 equals its prior-10 mean body");
});
test("Ladder Bottom: one-predicate near misses",()=>{
 const id="ladder_bottom";
 oneSide(id,b=>set(b,-3,{open:99.9,high:100.1}),true,"control: third open just below the second open");
 oneSide(id,b=>set(b,-3,{open:100,high:100.2}),false,"third open equals the second open");
 oneSide(id,b=>set(b,-4,{close:99.45}),true,"control: second close just below the first close");
 oneSide(id,b=>set(b,-4,{close:99.5}),false,"second close equals the first close");
 oneSide(id,b=>set(b,-3,{close:97.95}),true,"control: third close just below the second close");
 oneSide(id,b=>set(b,-3,{close:98}),false,"third close equals the second close");
 oneSide(id,b=>set(b,-2,{high:97.05}),true,"control: fourth upper shadow .25 exceeds .1 of its prior mean range (.247)");
 oneSide(id,b=>set(b,-2,{high:97.045}),false,"fourth upper shadow .245 is below .247");
 oneSide(id,b=>set(b,-2,{open:95.8,close:96.8}),false,"white fourth candle");
});
const WINDOW_IDS=[["bullish_three_line_strike","bearish_three_line_strike",4],["rising_three_methods","falling_three_methods",5],["mat_hold",null,5],["ladder_bottom",null,5]] as const;
test("4- and 5-candle windows refuse a gap right after the first formation candle",()=>{
 for(const [upId,downId,size] of WINDOW_IDS)for(const id of [upId,downId]){
  if(id===null)continue;
  const bars=fixture(id);for(const b of bars.slice(-size+1)){b.time+=300;b.closeTime+=300;}
  assert.ok(!has(bars,id),`${id}: gap after the first formation candle`);
 }
});
test("4- and 5-candle trend windows end before the first formation candle",()=>{
 /** Closes chosen so the five bars before the formation show no trend, while the same window
  * shifted one or two bars into the formation would. Body 1 and range 2.5 keep every prior mean. */
 const withPrefix=(id:string,closes:readonly number[])=>{
  const b=fixture(id),start=12-closes.length;
  for(let k=0;k<12;k++){const close=k<start?102:closes[k-start]!;Object.assign(b[k]!,{open:close-1,high:close+.75,low:close-1.75,close});}
  return b;
 };
 const rising=[104,101,101.5,102,102.5],falling=[94,102,101.5,101,100.5];
 for(const [upId,downId] of WINDOW_IDS){
  const closes=upId==="ladder_bottom"?falling:rising,b=withPrefix(upId,closes);
  assert.ok(!has(b,upId),`${upId}: formation bars are not trend context`);
  if(downId!==null)assert.ok(!has(mirror(b),downId),`${downId}: formation bars are not trend context`);
 }
});
/** Round-3 pins. Each near miss below changes one published criterion of a passing control.
 * Colour misses swap a candle's open and close where every other rule is symmetric in that swap,
 * so colour is the only criterion that changes. */
const flip=(b:CatalogueCandle[],at:number)=>{const x=b.at(at)!;[x.open,x.close]=[x.close,x.open];};
/** The same formation with fewer prefix bars: the prior-5 trend survives, chosen prior-10 means do not. */
const shortHistory=(id:string,keep:number,mutate:(b:CatalogueCandle[])=>void=()=>{})=>{const b=fixture(id);mutate(b);return observed(b.slice(12-keep).map(({open,high,low,close})=>({open,high,low,close})));};
test("Three Stars in the South: colour, third-high and shadow-basis near misses",()=>{
 const id="three_stars_in_the_south";
 const lowSecond=(b:CatalogueCandle[])=>set(b,-2,{open:102.1,high:102.2,low:97.5,close:99.7});
 oneSide(id,lowSecond,true,"control: second body sits above both first-body edges");
 oneSide(id,b=>{lowSecond(b);flip(b,-3);},false,"white first candle");
 const smallSecond=(b:CatalogueCandle[])=>set(b,-2,{open:100.5,close:99.6});
 oneSide(id,smallSecond,true,"control: second body .9 above the first close");
 oneSide(id,b=>{smallSecond(b);flip(b,-2);},false,"white second candle");
 oneSide(id,b=>flip(b,-1),false,"white third candle");
 oneSide(id,b=>set(b,-1,{open:100.65,high:100.69,low:100.25,close:100.3}),true,"control: third high just below the second high");
 oneSide(id,b=>set(b,-1,{open:100.65,high:100.7,low:100.25,close:100.3}),false,"third high equals the second high");
 // Second lower shadow uses the second candle's prior-10 mean range (.297), not the third's (.32).
 const deepSecond=(lower:number)=>(b:CatalogueCandle[])=>{set(b,-2,{open:100.5,high:103,low:98.5-lower,close:98.5});set(b,-1,{open:98.9,high:98.95,low:98.35,close:98.4});};
 oneSide(id,deepSecond(.3),true,"control: second lower shadow .3 exceeds .297 although it is below .32");
 oneSide(id,deepSecond(.29),false,"second lower shadow .29 is below .297");
 // Third shadows use the third candle's prior-10 mean range (.304), not the second's (.297).
 oneSide(id,b=>set(b,-1,{high:98.9}),true,"control: third upper shadow .3 is below .304 although it exceeds .297");
 oneSide(id,b=>set(b,-1,{low:97.8}),true,"control: third lower shadow .3 is below .304 although it exceeds .297");
});
test("Rising/Falling Three Methods: every candle colour, r1 and r2 containment, exact half-mean boundary",()=>{
 const pair=["rising_three_methods","falling_three_methods"] as const;
 /** Reactions near the first low, so each candle's open and close both satisfy every price relation. */
 const low=(b:CatalogueCandle[])=>{
  set(b,-5,{open:102,high:106.2,low:100,close:106});set(b,-4,{open:102.3,high:102.4,low:101.6,close:101.8});
  set(b,-3,{open:101.7,high:101.8,low:101.1,close:101.3});set(b,-2,{open:101.2,high:101.4,low:100.6,close:100.8});
  set(b,-1,{open:106.1,high:108.2,low:106,close:108});
 };
 bothSides(...pair,low,true,"control: reactions near the first low");
 for(const [at,label] of [[-5,"first"],[-4,"first reaction"],[-3,"second reaction"],[-2,"third reaction"],[-1,"fifth"]] as const)
  bothSides(...pair,b=>{low(b);flip(b,at);},false,`${label} candle has the other colour`);
 bothSides(...pair,b=>set(b,-4,{open:106.2,high:106.4,low:105.9,close:106}),true,"control: first reaction top equals the first high");
 bothSides(...pair,b=>set(b,-4,{open:106.25,high:106.4,low:105.9,close:106}),false,"first reaction body above the first high");
 const tightHigh=(open:number)=>(b:CatalogueCandle[])=>{
  set(b,-5,{high:106.05});set(b,-4,{open:105.9,high:106,low:105.5,close:105.6});set(b,-3,{open,high:106.2,low:105.3,close:105.55});
  set(b,-2,{open:105.4,high:105.5,low:104.9,close:105.1});set(b,-1,{open:105.2,low:105.1});
 };
 bothSides(...pair,tightHigh(106.05),true,"control: second reaction top equals the first high");
 bothSides(...pair,tightHigh(106.1),false,"second reaction body above the first high");
 bothSides(...pair,b=>set(b,-4,{close:104.96}),true,"control: first reaction body .64 is below half its prior mean body (.65)");
 bothSides(...pair,b=>set(b,-4,{close:104.95}),false,"first reaction body .65 equals half its prior mean body");
 // Mirror image of a rising shape after a rise: white first, black first reaction, white reactions, white fifth.
 const mixed=(b:CatalogueCandle[])=>{
  set(b,-5,{open:106,high:106.2,low:101.8,close:102});set(b,-4,{open:101.85,high:102.05,low:101.8,close:102});
  set(b,-3,{open:102,high:102.05,low:101.85,close:101.95});set(b,-2,{open:101.95,high:102,low:101.8,close:101.9});
  set(b,-1,{open:104.5,high:104.7,low:102.9,close:103});
 };
 const m=fixture(pair[0]);mixed(m);
 assert.equal(has(mirror(m),pair[1]),false,"falling_three_methods (mirror): a rising-shape colour sequence after a decline");
});
test("Three Methods first body is long against the ten candles before it, not a window that includes it",()=>{
 const pair=["rising_three_methods","falling_three_methods"] as const;
 const small=(b:CatalogueCandle[])=>{
  set(b,-4,{open:105.6,high:105.8,low:105.2,close:105.3});set(b,-3,{open:105.3,high:105.5,low:104.9,close:105});
  set(b,-2,{open:105,high:105.2,low:104.6,close:104.7});set(b,-1,{open:104.8});set(b,-5,{open:104.8});
 };
 bothSides(...pair,small,true,"control: first body 1.2 exceeds its prior-10 mean body 1");
 // Bar 2 is the oldest bar of the first candle's window and of no later candle's window.
 bothSides(...pair,b=>{small(b);set(b,2,{open:79,low:78.25});},false,"first body 1.2 is below its prior-10 mean body 1.4");
});
test("Mat Hold: reaction highs, rising shape and short histories",()=>{
 const id="mat_hold";
 for(const at of [-3,-2]){
  oneSide(id,b=>{set(b,at,{high:108.5});set(b,-1,{high:108.7,close:108.6});},true,`control: fifth close above a raised reaction high at ${at}`);
  oneSide(id,b=>{set(b,at,{high:108.5});set(b,-1,{high:108.6,close:108.4});},false,`fifth close below the raised reaction high at ${at}`);
 }
 const falling=(b:CatalogueCandle[])=>{
  set(b,-5,{open:106,high:106.2,low:101.8,close:102});set(b,-4,{open:102.3,high:102.7,low:102.2,close:102.6});
  set(b,-3,{open:101.5,high:102,low:101.4,close:101.9});set(b,-2,{open:101.2,high:101.7,low:101.1,close:101.6});
  set(b,-1,{open:104.5,high:104.6,low:102.9,close:103});
 };
 oneSide(id,falling,false,"black first, white reactions and black fifth after a rise");
 assert.equal(has(shortHistory(id,9),id),false,"mat_hold: first candle without a prior-10 mean body");
 assert.equal(has(shortHistory(id,12),id),true,"mat_hold: control, full history");
});
test("Three Methods: a first candle without a prior-10 mean body is never long",()=>{
 for(const id of ["rising_three_methods","falling_three_methods"]){
  assert.equal(has(shortHistory(id,12),id),true,`${id}: control, full history`);
  assert.equal(has(shortHistory(id,9),id),false,`${id}: nine prior bars`);
 }
});
test("Side-by-Side White Lines: black third, open-tolerance basis and boundary, short history",()=>{
 const upId="upside_gap_side_by_side_white_lines";
 oneSide(upId,b=>set(b,-1,{open:105.55,high:106.6,low:105.4,close:106.5}),true,"control: white third, body .95");
 oneSide(upId,b=>set(b,-1,{open:105.55,high:105.7,low:104.55,close:104.6}),false,"black third with the same open and body length");
 // .05 of the middle candle's prior-10 mean range is .127; the third candle's would be .124 and the first's .125.
 oneSide(upId,b=>set(b,-1,{open:105.626}),true,"control: opens .126 apart");
 oneSide(upId,b=>set(b,-1,{open:105.627}),true,"control: opens exactly .127 apart");
 const equal=(b:CatalogueCandle[])=>set(b,-1,{open:105.5,high:107.3,low:105.4,close:107});
 assert.equal(has(shortHistory(upId,12,equal),upId),true,"control: identical opens and bodies, full history");
 assert.equal(has(shortHistory(upId,8,equal),upId),false,"identical opens and bodies without a prior-10 mean range");
});
test("Identical Three Crows: candle colours, falling second close and the second-open basis",()=>{
 const id="identical_three_crows";
 const thinFirst=(b:CatalogueCandle[])=>set(b,-3,{open:145.05,high:145.2,low:144.85,close:145});
 oneSide(id,thinFirst,true,"control: a thin black first candle");
 oneSide(id,b=>{thinFirst(b);flip(b,-3);},false,"white first candle");
 const thinSecond=(b:CatalogueCandle[])=>{set(b,-2,{open:144.95,high:145,low:144.7,close:144.9});set(b,-1,{open:144.95,high:145,low:140.8,close:141});};
 oneSide(id,thinSecond,true,"control: a thin black second candle");
 oneSide(id,b=>{thinSecond(b);flip(b,-2);},false,"white second candle");
 const thinThird=(b:CatalogueCandle[])=>set(b,-1,{open:140.95,high:141,low:140.7,close:140.9});
 oneSide(id,thinThird,true,"control: a thin black third candle");
 oneSide(id,b=>{thinThird(b);flip(b,-1);},false,"white third candle");
 const second=(close:number)=>(b:CatalogueCandle[])=>{set(b,-2,{open:145.1,high:145.2,low:144.9,close});set(b,-1,{open:145,high:145.1,low:140.8,close:141});};
 oneSide(id,second(144.98),true,"control: second close just below the first close");
 oneSide(id,second(145),false,"second close equals the first close");
 // The second open uses the first candle's prior-10 mean range (.125), not the second's (.1345).
 oneSide(id,b=>set(b,-2,{open:145.12}),true,"control: second open .12 from the first close");
 oneSide(id,b=>set(b,-2,{open:145.13}),false,"second open .13 from the first close exceeds .125");
});
test("Upside Gap Two Crows: first and middle colours",()=>{
 const id="upside_gap_two_crows";
 oneSide(id,b=>flip(b,-3),false,"black first candle");
 oneSide(id,b=>flip(b,-2),false,"white middle candle");
});
test("Stick Sandwich: first colour and short history",()=>{
 const id="stick_sandwich";
 oneSide(id,b=>set(b,-3,{open:100,high:100.1,low:98.9,close:99.5}),true,"control: black first candle");
 oneSide(id,b=>set(b,-3,{open:99,high:100.1,low:98.9,close:99.5}),false,"white first candle with the same close");
 const equal=(b:CatalogueCandle[])=>set(b,-1,{close:99.5});
 assert.equal(has(shortHistory(id,12,equal),id),true,"control: identical closes, full history");
 assert.equal(has(shortHistory(id,9,equal),id),false,"identical closes without the first candle's prior-10 mean range");
});
test("Unique Three-River: middle and third colours",()=>{
 const id="unique_three_river_bottom";
 oneSide(id,b=>flip(b,-2),false,"white middle candle");
 oneSide(id,b=>flip(b,-1),false,"black third candle");
});
test("Ladder Bottom: every candle colour and short history",()=>{
 const id="ladder_bottom";
 const clear=(b:CatalogueCandle[])=>{
  set(b,-5,{open:101.5,high:101.7,low:100.2,close:100.5});set(b,-4,{open:99.2,high:99.4,low:98.6,close:98.8});
  set(b,-3,{open:97.8,high:98,low:96.3,close:96.5});set(b,-1,{open:98,high:99.2,low:97.9,close:99});
 };
 oneSide(id,clear,true,"control: each candle's open and close both satisfy every price relation");
 for(const [at,label] of [[-5,"first"],[-4,"second"],[-3,"third"],[-2,"fourth"],[-1,"fifth"]] as const)
  oneSide(id,b=>{clear(b);flip(b,at);},false,`${label} candle has the other colour`);
 assert.equal(has(shortHistory(id,12),id),true,"control: full history");
 assert.equal(has(shortHistory(id,6),id),false,"fourth candle without a prior-10 mean range");
});
test("Three-Line Strike: every candle colour, the third-open basis and short history",()=>{
 const pair=["bullish_three_line_strike","bearish_three_line_strike"] as const;
 bothSides(...pair,b=>flip(b,-4),false,"first candle has the other colour");
 const thinSecond=(b:CatalogueCandle[])=>set(b,-3,{open:104.1,high:104.7,low:103.9,close:104.6});
 bothSides(...pair,thinSecond,true,"control: a thin second candle inside the open tolerance");
 bothSides(...pair,b=>{thinSecond(b);flip(b,-3);},false,"second candle has the other colour");
 const thinThird=(b:CatalogueCandle[])=>set(b,-2,{open:106.1,high:106.7,low:105.9,close:106.5});
 bothSides(...pair,thinThird,true,"control: a thin third candle inside the open tolerance");
 bothSides(...pair,b=>{thinThird(b);flip(b,-2);},false,"third candle has the other colour");
 const reversed=(b:CatalogueCandle[])=>{
  set(b,-4,{open:108,high:108.2,low:101.8,close:102});set(b,-3,{open:104,high:104.2,low:102.8,close:103});
  set(b,-2,{open:104.5,high:104.7,low:103.4,close:103.5});set(b,-1,{open:104,high:107.5,low:103.9,close:107.4});
 };
 bothSides(...pair,reversed,false,"three opposite-colour candles with progressing closes, then a strike of the other colour");
 // The third open uses the second candle's prior-10 mean range (.6225), not the third's (.645).
 bothSides(...pair,b=>set(b,-2,{open:106.62}),true,"control: third open .62 above the second body");
 bothSides(...pair,b=>set(b,-2,{open:106.63}),false,"third open .63 above the second body exceeds .6225");
 for(const id of pair){
  const flipSide=(b:CatalogueCandle[])=>id===pair[1]?mirror(b):b;
  assert.equal(has(flipSide(shortHistory(pair[0],12)),id),true,`${id}: control, full history`);
  assert.equal(has(flipSide(shortHistory(pair[0],9)),id),false,`${id}: first candle without a prior-10 mean range`);
 }
});
test("4- and 5-candle trend windows are exactly the five bars before the first formation candle",()=>{
 const withPrefix=(id:string,closes:readonly number[])=>{
  const b=fixture(id),start=12-closes.length;
  for(let k=0;k<12;k++){const close=k<start?102:closes[k-start]!;Object.assign(b[k]!,{open:close-1,high:close+.75,low:close-1.75,close});}
  return b;
 };
 // The last five prefix closes trend; the window one bar earlier (104 then four of them) does not.
 const rising=[104,102,102.5,103,103.5,104],falling=[96,102,101.5,101,100.5,100];
 for(const [upId,downId] of WINDOW_IDS){
  const b=withPrefix(upId,upId==="ladder_bottom"?falling:rising);
  assert.ok(has(b,upId),`${upId}: trend in the five bars just before the formation`);
  if(downId!==null)assert.ok(has(mirror(b),downId),`${downId}: trend in the five bars just before the formation`);
 }
});
