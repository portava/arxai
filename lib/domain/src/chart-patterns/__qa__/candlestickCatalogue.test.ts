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
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.id)).size,71);
 assert.equal(new Set(CANDLE_DEFINITIONS.map(d=>d.family)).size,19);
});
test("owner coverage preserves all 104 entries and never advertises a missing catalogue implementation",()=>{
 const coverage=JSON.parse(readFileSync(new URL("../../../../../docs/SMART_CHART_CANDLE_COVERAGE.json",import.meta.url),"utf8"));
 assert.equal(coverage.entries.length,104);
 const catalogue=coverage.entries.filter((r:{status:string})=>r.status==="IMPLEMENTED_EXPLICIT_ARX_VARIANT");
 assert.deepEqual(catalogue.map((r:{definitionId:string})=>r.definitionId).sort(),CANDLE_DEFINITIONS.map(d=>d.id).sort());
 const pending=coverage.entries.filter((r:{definitionId:unknown})=>r.definitionId===null);
 assert.equal(pending.length,30);
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
