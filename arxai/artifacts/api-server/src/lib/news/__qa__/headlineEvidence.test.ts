import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { normalizeHeadlineEvidence } from "../headlineEvidence.js";
const now = Date.parse("2026-11-17T04:00:00Z");
const base = {headline:"Rates surge",source:"publisher",url:"https://example.com/news",publishedAt:"2026-11-17T03:00:00Z"};
test("deduplicates tracking links and sorts actual publication times", () => {
 const result = normalizeHeadlineEvidence([base,{...base,url:base.url+"?utm_source=rss#top"},{...base,url:"https://example.com/later",publishedAt:"2026-11-17T03:30:00Z"}],now);
 assert.equal(result.length,2); assert.equal(result[0].url,"https://example.com/later");
 assert.equal(result[0].verification,"headline_only");
});
test("first-seen evidence is retained without manufacturing publication time", () => {
 const [item] = normalizeHeadlineEvidence([{...base,timeBasis:"provider_first_seen",observedAt:base.publishedAt}],now);
 assert.equal(item.publishedAt,""); assert.equal(item.observedAt,"2026-11-17T03:00:00.000Z");
});
test("rejects stale, future, undated and unsafe links", () => {
 const items = ["2026-11-14T03:00:00Z","2026-11-17T05:00:00Z","","bad"].map(publishedAt=>({...base,publishedAt}));
 items.push({...base,url:"javascript:alert(1)"},{...base,url:"https://user:secret@example.com"});
 assert.deepEqual(normalizeHeadlineEvidence(items,now),[]);
});
mock.module("../../assistant/marketProvider.js",{namedExports:{getMarketProvider:()=>({getMarketNews:async()=>({connected:true,provider:"fixture",items:[{...base,publishedAt:new Date().toISOString(),headline:"Prices surge rally soar bullish"}]})})}});
mock.module("../economicCalendarProvider.js",{namedExports:{getEconomicCalendar:async()=>({connected:true,provider:"fixture",status:"empty",events:[],providerState:"connected"})}});
test("production intelligence never promotes headline words to direction", async()=>{
 const {getNewsIntelligence}=await import("../newsIntelligenceService.js");
 const pack=await getNewsIntelligence("EURUSD");
 assert.equal(pack.bias,"unclear");assert.equal(pack.recentHeadlines.length,1);
 assert.equal(pack.recentHeadlines[0].verification,"headline_only");
 assert.match(pack.safetyNote,/unverified leads/);
});
