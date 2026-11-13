import {test} from "node:test";
import assert from "node:assert/strict";
import {fitCalibration} from "@workspace/domain/calibration";
import {evaluateProspective,prospectiveHash,validateProspectivePlan} from "../prospectiveEvaluation.js";
import {fixturePlan,fixtureReceipts,REGISTERED} from "./prospectiveFixtures.js";
const end=Date.parse("2030-01-05T00:00:00Z");
test("registered frozen calibration comparison exposes improvement only after fixed deadline and grants no authority",()=>{
 const plan=fixturePlan(),rows=fixtureReceipts(plan);
 const early=evaluateProspective(plan,REGISTERED,rows,Date.parse(plan.labelDeadline)-1);
 assert.equal(early.status,"COLLECTING");assert.equal(early.candidateBrier,null);assert.equal(early.resolved,null);
 const report=evaluateProspective(plan,REGISTERED,rows,end);
 assert.equal(report.status,"CALIBRATION_IMPROVED");assert.equal(report.resolved,100);
 assert.ok(report.improvementLowerBound!>0.23);assert.equal(report.liveAllowed,false);assert.equal(report.autoPromotionAllowed,false);
});
test("equal or worse frozen calibrators do not pass",()=>{
 for(const probability of [0.5,0.1]){
 const plan=fixturePlan();plan.candidate.fit=fitCalibration(Array.from({length:100},(_,i)=>({score:50,outcome:i<probability*100?1 as const:0 as const})));
 assert.equal(evaluateProspective(plan,REGISTERED,fixtureReceipts(plan),end).status,"NO_IMPROVEMENT");
 }
});
test("retrospective registration, post-registration fitting and weaker thresholds are refused",()=>{
 for(const change of [
 (p:ReturnType<typeof fixturePlan>)=>{p.collectionStart=REGISTERED;},
 (p:ReturnType<typeof fixturePlan>)=>{p.candidate.fittedAt=REGISTERED;},
 (p:ReturnType<typeof fixturePlan>)=>{p.baseline.dataTo=REGISTERED;},
 (p:ReturnType<typeof fixturePlan>)=>{p.minSample=99;},
 (p:ReturnType<typeof fixturePlan>)=>{p.minImprovement=0;},
 (p:ReturnType<typeof fixturePlan>)=>{p.candidate.fit.baseRate=NaN;},
 ]) {const p=fixturePlan();change(p);assert.throws(()=>validateProspectivePlan(p,REGISTERED));}
});
test("unresolved, duplicate, deleted and mutated evidence cannot improve coverage by omission",()=>{
 for(const kind of ["pending","duplicate","deletion","mutation"]){
 const p=fixturePlan(),rows=fixtureReceipts(p);
 if(kind==="pending") rows.splice(1,1);
 else if(kind==="duplicate") rows.push(structuredClone(rows[0]));
 else rows.push({...rows[0],phase:kind});
 const r=evaluateProspective(p,REGISTERED,rows,end);assert.equal(r.status,"REFUSED",kind);assert.equal(r.candidateBrier,null);
 }
});
test("backfilled, pre-known, late or unsupported labels are refused",()=>{
 for(const change of [
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[0].payload.created_at=REGISTERED;},
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[0].payload.outcome_status="WIN";},
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[1].payload.resolved_at=rows[0].observedAt;},
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[1].observedAt="2030-01-05T00:00:00Z";},
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[1].payload.evidence={method:"synthetic"};},
 (rows:ReturnType<typeof fixtureReceipts>)=>{rows[0].payload.confidence_score=Infinity;},
 ]) {const p=fixturePlan(),rows=fixtureReceipts(p);change(rows);assert.equal(evaluateProspective(p,REGISTERED,rows,end).status,"REFUSED");}
});
test("duplicate upstream predictions and concentrated collection cannot inflate sample size",()=>{
 const p=fixturePlan(),rows=fixtureReceipts(p);rows[0].payload.scanner_signal_id="same";rows[2].payload.scanner_signal_id="same";
 assert.ok(evaluateProspective(p,REGISTERED,rows,end).reasons.includes("DUPLICATE_PREDICTION_IDENTITY"));
 const clustered=fixtureReceipts(p);for(const row of clustered) if(row.phase==="prediction") {row.observedAt=rows[0].observedAt;row.payload.created_at=row.observedAt;row.payload.locked_at=row.observedAt;}
 assert.ok(evaluateProspective(p,REGISTERED,clustered,end).reasons.includes("INSUFFICIENT_TEMPORAL_COVERAGE"));
});
test("canonical plan and receipt hashes identify the exact compared evidence",()=>{
 const p=fixturePlan(),rows=fixtureReceipts(p);const report=evaluateProspective(p,REGISTERED,rows,end);
 assert.equal(report.planHash,prospectiveHash(JSON.parse(JSON.stringify(p))));
 rows[0].payload.confidence_score=51;assert.notEqual(evaluateProspective(p,REGISTERED,rows,end).receiptHash,report.receiptHash);
});
test("closed-trade labels require matching measured sign and identity; method names alone are insufficient",()=>{
 const p=fixturePlan();
 const valid=fixtureReceipts(p);valid[1].payload={outcome_status:"WIN",resolved_at:valid[1].observedAt,evidence:{method:"closed_trade"},pnl_r:1,trade_id:11};
 assert.equal(evaluateProspective(p,REGISTERED,valid,end).status,"CALIBRATION_IMPROVED");
 for(const bad of [{pnl_r:-1},{pnl_r:NaN},{trade_id:0},{evidence:{method:"observed_move"}}]){
 const rows=structuredClone(valid);rows[1].payload={...rows[1].payload,...bad};
 assert.ok(evaluateProspective(p,REGISTERED,rows,end).reasons.includes("UNSUPPORTED_OR_UNVERIFIED_LABEL"));
 }
});
