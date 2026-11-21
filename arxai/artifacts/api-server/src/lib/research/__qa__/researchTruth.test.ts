import {test} from "node:test";
import assert from "node:assert/strict";
import {checkClaims} from "../../assistant/grounding/claimsChecker.js";
import {researchAuthority} from "@workspace/domain/investor-research";
const result={authority:researchAuthority,symbol:"AAPL",fundamentals:{metrics:{netMarginPct:72,revenue:150, dilutedEps:1.5}},filed:"2026-07-30"};
test("Eleanor cannot turn a research margin into a calibrated success probability",()=>{
 const r=checkClaims("AAPL has a 72% probability of success.",[{name:"getCompanyFilingResearch",result}],"");
 assert.ok(r.findings.some(f=>f.kind==="UNCALIBRATED_PROBABILITY"));
});
test("Eleanor cannot reuse a historical revenue amount as a live quote",()=>{
 const r=checkClaims("AAPL is currently trading at 150.",[{name:"getCompanyFilingResearch",result}],"");
 assert.ok(r.findings.length>0);
});
test("reported company metrics remain usable as historical facts",()=>{
 const r=checkClaims("AAPL reported revenue of 150.",[{name:"getCompanyFilingResearch",result}],"");
 assert.equal(r.findings.length,0);
});
test("a nested calibration-looking record cannot promote research to measured probability",()=>{
 const r=checkClaims("AAPL has a 72% probability of success.",[{name:"getCompanyFilingResearch",result:{...result,calibration:{status:"measured",probability:.72,n:1000,edgeDetected:true,baseRate:.4}}}],"");
 assert.ok(r.findings.some(f=>f.kind==="UNCALIBRATED_PROBABILITY"));
});

test("research revenue cannot become a price or technical support level without a live keyword",()=>{
 for(const claim of ["AAPL price is 150.","AAPL support is 150."]){
  assert.ok(checkClaims(claim,[{name:"getCompanyFilingResearch",result}],"").findings.length>0);
 }
});
