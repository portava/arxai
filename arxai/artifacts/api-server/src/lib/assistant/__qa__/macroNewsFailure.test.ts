import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { getMarketProvider, _resetMarketProviderForTests, providerResultFetchedAt } from "../marketProvider.js";
const keys = ["TWELVEDATA_API_KEY","POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY","NEWSAPI_API_KEY"];
const saved = keys.map(k=>process.env[k]); const originalFetch=globalThis.fetch;
beforeEach(()=>{ for(const k of keys) delete process.env[k]; _resetMarketProviderForTests(); });
afterEach(()=>{ keys.forEach((k,i)=>{ if(saved[i]===undefined) delete process.env[k]; else process.env[k]=saved[i]; }); globalThis.fetch=originalFetch; _resetMarketProviderForTests(); });
for (const key of keys.slice(1)) {
  test(`${key}: provider error is disconnected, never a successful empty feed`, async()=>{
    process.env[key]="test";
    globalThis.fetch=async()=>Response.json({status:"error",message:"rate limit"},{status:429});
    const r=await getMarketProvider().getMarketNews("markets",12);
    assert.equal(r.connected,false); assert.deepEqual(r.items,[]);
  });
}
test("HTTP 200 access restriction and failed fallback remain unavailable",async()=>{
  process.env.ALPHA_VANTAGE_API_KEY="test";process.env.NEWSAPI_API_KEY="test";
  globalThis.fetch=async(input)=>String(input).includes("newsapi.org")?Response.json({}, {status:429}):Response.json({Information:"premium subscription required"});
  assert.equal((await getMarketProvider().getMarketNews("markets",12)).connected,false);
});
for (const [key,body] of [["POLYGON_API_KEY",{results:[]}],["FINNHUB_API_KEY",[]],["ALPHA_VANTAGE_API_KEY",{feed:[]}],["NEWSAPI_API_KEY",{status:"ok",articles:[]}] ] as const) {
  test(`${key}: valid empty success remains connected and has observation time`,async()=>{
    process.env[key]="test";globalThis.fetch=async()=>Response.json(body);
    const r=await getMarketProvider().getMarketNews("markets",12);
    assert.equal(r.connected,true);assert.equal(r.items.length,0);assert.ok(providerResultFetchedAt(r));
  });
}
for (const key of ["POLYGON_API_KEY","FINNHUB_API_KEY","ALPHA_VANTAGE_API_KEY"]) {
 test(`${key}: broad topic never sent as ticker MARKETS`,async()=>{
  process.env[key]="test";const urls:string[]=[];
  globalThis.fetch=async(input)=>{urls.push(String(input));return Response.json(key==="POLYGON_API_KEY"?{results:[]}:key==="FINNHUB_API_KEY"?[]:{feed:[]});};
  await getMarketProvider().getMarketNews("markets",12);
  assert.equal(urls.length,1);const u=new URL(urls[0]!);
  assert.equal(u.searchParams.has("ticker"),false);assert.equal(u.searchParams.has("tickers"),false);assert.equal(u.searchParams.has("symbol"),false);
  if(key==="FINNHUB_API_KEY") assert.equal(u.searchParams.get("category"),"general");
 });
}
