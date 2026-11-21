import {test} from "node:test";
import assert from "node:assert/strict";
import {parseCompanyFacts,parseSubmissions,createSecResearchClient} from "../secResearch.js";
const now=Date.parse("2026-11-17T12:00:00Z");
const fact=(val:number,over:Record<string,unknown>={})=>({val,start:"2026-04-01",end:"2026-06-30",filed:"2026-07-30",form:"10-Q",accn:"0000000001-26-000001",...over});
const payload={cik:1,facts:{"us-gaap":{Revenues:{units:{USD:[fact(200),fact(100,{start:"2025-04-01",end:"2025-06-30",filed:"2025-07-30"}),fact(999,{filed:"2026-12-01"})]}},NetIncomeLoss:{units:{USD:[fact(20)]}},OperatingIncomeLoss:{units:{USD:[fact(50,{start:"2026-01-01"})]}}}}};
test("SEC metrics select past-only matching periods; no YTD margin mixing",()=>{
 const r=parseCompanyFacts(payload,"2026-11-17");assert.equal(r.metrics.revenue,200);assert.equal(r.metrics.revenueGrowthPct,100);
 assert.equal(r.metrics.netMarginPct,10);assert.equal(r.metrics.operatingMarginPct,null);assert.equal(r.metrics.dilutedEps,null);
});
test("SEC filing links are scoped to CIK and reject unsafe filenames",()=>{
 const r=parseSubmissions({filings:{recent:{accessionNumber:["0000000001-26-000001","0000000001-26-000002"],form:["8-K","10-Q"],filingDate:["2026-11-01","2026-11-02"],primaryDocument:["report.htm","../../bad"]}}},"1","2026-11-17");
 assert.equal(r.length,1);assert.match(r[0].url,/edgar\/data\/1\/000000000126000001\/report.htm$/);
});
test("missing contact identity performs no request",async()=>{
 let calls=0;const client=createSecResearchClient(async()=>{calls++;throw new Error();},()=>now,()=>"");
 assert.equal((await client("1")).status,"NOT_CONFIGURED");assert.equal(calls,0);
});
test("wrong CIK and HTTP failures cannot look like available filings",async()=>{
 const client=createSecResearchClient(async()=>Response.json({cik:2}),()=>now,()=>"Research contact@valid.test");
 assert.equal((await client("1")).status,"UNAVAILABLE");
});
test("submission-only filer returns public provenance and caches the original fetch",async()=>{
 let calls=0,at=now;
 const client=createSecResearchClient(async()=>{calls++;return Response.json({cik:1,name:"Fund",filings:{recent:{accessionNumber:["0000000001-26-000001"],form:["13F-HR"],filingDate:["2026-11-01"],primaryDocument:["filing.htm"]}}});},()=>at,()=>"Research contact@valid.test");
 const a=await client("1");at+=5000;const b=await client("1");assert.equal(calls,1);assert.equal(a.fetchedAt,b.fetchedAt);
 assert.equal(a.authority.executionAllowed,false);assert.equal(a.fundamentals,null);
});
