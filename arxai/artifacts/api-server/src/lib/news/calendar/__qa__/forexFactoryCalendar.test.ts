import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { normalizeForexFactoryCalendar, isForexFactorySelected, fetchForexFactoryCalendar, __resetForexFactoryForTests, forexFactoryRefreshNote } from "../forexFactoryProvider.js";
const NOW=Date.parse("2026-11-05T13:00:00Z");
const row={title:"Official Bank Rate",country:"GBP",date:"2026-11-05T07:00:00-05:00",impact:"High",forecast:"4.00%",previous:"3.75%"};
test("source schedule preserves values, UTC offset and affected currencies without inventing actuals",()=>{
 const [e]=normalizeForexFactoryCalendar([row],NOW);
 assert.equal(e!.eventTimeUtc,"2026-11-05T12:00:00.000Z");assert.equal(e!.impact,"high");assert.equal(e!.actual,null);assert.equal(e!.revised,null);
 assert.equal(e!.forecast,"4.00%");assert.equal(e!.previous,"3.75%");assert.ok(e!.affectedSymbols.includes("GBPUSD"));assert.ok(!e!.affectedSymbols.includes("V75"));
});
test("missing values stay null; source duplicates are removed",()=>{
 const events=normalizeForexFactoryCalendar([{...row,forecast:"",previous:""},{...row,forecast:"",previous:""}],NOW);
 assert.equal(events.length,1);assert.equal(events[0]!.forecast,null);assert.equal(events[0]!.previous,null);
});
test("stale week, invalid payload, unknown impact and timestamps without offsets fail closed",()=>{
 for(const payload of [[],{},[{...row,date:"2026-10-29T07:00:00-04:00"}],[{...row,date:"2026-11-05T07:00:00"}],[{...row,impact:"mystery"}]]) assert.throws(()=>normalizeForexFactoryCalendar(payload,NOW));
});
test("holidays are not misrepresented as precisely timed releases",()=>assert.deepEqual(normalizeForexFactoryCalendar([{...row,impact:"Holiday"}],NOW),[]));
test("explicit provider selections are respected",()=>{
 assert.equal(isForexFactorySelected({}),true);assert.equal(isForexFactorySelected({ECONOMIC_CALENDAR_PROVIDER:"forex_factory"}),true);
 assert.equal(isForexFactorySelected({ECONOMIC_CALENDAR_PROVIDER:"trading_economics"}),false);assert.equal(isForexFactorySelected({ECONOMIC_CALENDAR_PROVIDER:"none"}),false);
});


beforeEach(()=>__resetForexFactoryForTests());
test("429 refresh uses bounded genuine cache, retains its time and backs off",async()=>{
 let calls=0;const fetcher=async()=>{calls++;return calls===1?{ok:true,status:200,text:async()=>JSON.stringify([row])}:{ok:false,status:429,text:async()=>""};};
 const first=await fetchForexFactoryCalendar({nowMs:NOW,daysAhead:7,fetcher});
 const later=await fetchForexFactoryCalendar({nowMs:NOW+11*60000,daysAhead:7,fetcher});
 assert.equal(calls,2);assert.equal(later[0]!.lastUpdatedAt,first[0]!.lastUpdatedAt);assert.equal(later[0]!.freshness,"DELAYED");assert.match(forexFactoryRefreshNote()!,/429/);
 await fetchForexFactoryCalendar({nowMs:NOW+12*60000,daysAhead:7,fetcher});assert.equal(calls,2);
 await assert.rejects(fetchForexFactoryCalendar({nowMs:NOW+61*60000,daysAhead:7,fetcher}),/429/);
});
test("a failed first fetch stays unavailable and repeated reads respect backoff",async()=>{
 let calls=0;const fetcher=async()=>{calls++;return {ok:false,status:429,retryAfterMs:1200000,text:async()=>""};};
 await assert.rejects(fetchForexFactoryCalendar({nowMs:NOW,daysAhead:7,fetcher}));
 await assert.rejects(fetchForexFactoryCalendar({nowMs:NOW+60000,daysAhead:7,fetcher}));assert.equal(calls,1);
});
test("concurrent horizons share one source fetch without sharing the wrong event window",async()=>{
 let calls=0;const fetcher=async()=>{calls++;return {ok:true,status:200,text:async()=>JSON.stringify([row,{...row,title:"Employment",country:"USD",date:"2026-11-06T08:30:00-05:00"}])};};
 const [one,two]=await Promise.all([fetchForexFactoryCalendar({nowMs:NOW,daysAhead:1,fetcher}),fetchForexFactoryCalendar({nowMs:NOW,daysAhead:2,fetcher})]);
 assert.equal(calls,1);assert.equal(one.length,1);assert.equal(two.length,2);
});
