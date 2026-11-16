import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import {createGdeltNewsClient,normalizeGdeltNews,gdeltQuery} from "../gdeltNews.js";
import {getMarketProvider,_resetMarketProviderForTests,providerResultFetchedAt} from "../marketProvider.js";
const now=Date.parse("2026-11-05T14:00:00Z");
const article={title:"Central bank holds interest rates",url:"https://example.com/news",seendate:"20261105T134500Z",domain:"wrong.example"};
test("GDELT retains first-seen evidence without inventing publication time",()=>{
 const [a]=normalizeGdeltNews({articles:[article,{...article,url:article.url+'#duplicate'}]},now);
 assert.equal(a?.publishedAt,"");assert.equal(a?.observedAt,"2026-11-05T13:45:00.000Z");assert.equal(a?.timeBasis,"provider_first_seen");assert.equal(a?.source,"example.com");
 assert.equal(normalizeGdeltNews({articles:[article,article]},now).length,1);
});
test("GDELT rejects malformed payload, bad URL, future and stale timestamps",()=>{
 for(const payload of [{}, {articles:"bad"},{articles:[{...article,url:"javascript:alert(1)"}]},{articles:[{...article,seendate:"20261106T134500Z"}]},{articles:[{...article,seendate:"20261101T134500Z"}]}]) assert.throws(()=>normalizeGdeltNews(payload,now));
 assert.deepEqual(normalizeGdeltNews({articles:[]},now),[]);
});
test("query bounds operators and maps broad market news to economic topics",()=>{
 assert.match(gdeltQuery("markets"),/central bank/);assert.doesNotMatch(gdeltQuery('AAPL" domain:bad'),/domain:/);
});
test("success is shared and cached with original fetch time; cache expires",async()=>{
 let calls=0,at=now;let release!:()=>void;const wait=new Promise<void>(r=>release=r);
 const client=createGdeltNewsClient(async()=>{calls++;await wait;return Response.json({articles:[article]});},()=>at);
 const a=client("markets",12),b=client("markets",12);release();const [one,two]=await Promise.all([a,b]);
 assert.equal(calls,1);assert.equal(one,two);at+=60_000;assert.equal((await client("markets",12)).fetchedAt,one.fetchedAt);assert.equal(calls,1);
 at+=300_000;await client("markets",12);assert.equal(calls,2);
});
test("429 backs off globally and never becomes connected empty",async()=>{
 let calls=0,at=now;const client=createGdeltNewsClient(async()=>{calls++;return new Response('',{status:429,headers:{'retry-after':'900'}});},()=>at);
 assert.equal((await client("markets")).connected,false);at+=600_000;assert.equal((await client("AAPL")).error,"GDELT_BACKOFF");assert.equal(calls,1);at+=300_001;await client("markets");assert.equal(calls,2);
});
test("HTTP 200 non-JSON failure stays disconnected",async()=>{
 const client=createGdeltNewsClient(async()=>new Response('Your query was too short'),()=>now);
 assert.equal((await client('markets')).connected,false);
});
const originalFetch=globalThis.fetch;const saved=process.env.ARX_GDELT_ENABLED;
afterEach(()=>{globalThis.fetch=originalFetch;if(saved===undefined)delete process.env.ARX_GDELT_ENABLED;else process.env.ARX_GDELT_ENABLED=saved;_resetMarketProviderForTests();});
test("enabled adapter is used by market provider and preserves payload observation",async()=>{
 process.env.ARX_GDELT_ENABLED='true';_resetMarketProviderForTests();
 const current=new Date().toISOString().replace(/[-:]/g,'').replace(/\.\d{3}Z$/,'Z');
 globalThis.fetch=async()=>Response.json({articles:[{...article,seendate:current}]});
 const result=await getMarketProvider().getMarketNews('markets',12);assert.equal(result.provider,'gdelt');assert.equal(result.connected,true);assert.ok(providerResultFetchedAt(result));assert.equal(result.items[0]?.publishedAt,'');
});
