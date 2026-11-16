import assert from "node:assert/strict";
import { test } from "node:test";
import { capSelectedMarketByTruth } from "../selectedMarketTruthCap.js";
import { recordStateCandleWindow } from "../../data/chart/stateCandleWindow.js";
import type { SelectedMarketResult } from "../selectedMarket.js";
import type { SymbolTruthSnapshot } from "../../truth/symbolTruthSnapshot.js";
import type { EleanorChartContext } from "../../data/chart/eleanorChartContext.js";
const now=Date.parse("2026-11-05T08:01:10Z"),stamp="2026-11-05T08:01:00.000Z";
const evidence={symbol:"V75",timeframe:"M1",source:"deriv",sourceIdentity:"a".repeat(64),lastClosedCandleAt:stamp};
function fixtures(){
 const selected={ok:true,symbol:"V75",timeframe:"M1",marketEvidence:evidence,generatedAt:new Date(now).toISOString(),dataState:"LIVE_CONFIRMED",readWithheldReason:null,
 highlights:{bias:"BUY",confidenceLabel:"High",confidenceScore:82,entryZone:{low:200,high:202},suggestedStop:190,suggestedTakeProfit:220},explanation:{cautions:[],disclaimer:"Read only"}} as unknown as SelectedMarketResult;
 const truth={symbol:"V75",timeframe:"M1",generatedAt:new Date(now).toISOString(),validUntil:new Date(now+20000).toISOString(),data:{state:"LIVE_CONFIRMED",source:"deriv",sourceIdentity:evidence.sourceIdentity,lastCandleAt:stamp},levels:{withheld:false,withheldReason:null,entryFrom:100,entryTo:102,stopLoss:98,takeProfit:[110]},verdict:{bestAction:"BUY",bestActionText:"Buy",headline:"Canonical estimated setup",evidenceFor:[],evidenceAgainst:[]}} as unknown as SymbolTruthSnapshot;
 const context={basis:"VERIFIED",sufficiency:{canShowTradeSetup:true},state:{}} as EleanorChartContext;
 recordStateCandleWindow(context.state,[],evidence);
 return {selected,truth,context};
}
test("eligible current bound setup uses canonical geometry and never invents calibrated confidence",()=>{
 const {selected,truth,context}=fixtures();const out=capSelectedMarketByTruth(selected,truth,context,now) as SelectedMarketResult;
 assert.equal(out.levelsWithheld,false);assert.equal(out.highlights.bias,"BUY");assert.deepEqual(out.highlights.entryZone,{low:100,high:102});assert.equal(out.highlights.confidenceScore,null);
});
for(const scenario of ["structural only","withheld canonical levels","watch verdict","wrong source","wrong timeframe","expired","invalid geometry","missing context"]){
 test(`${scenario} cannot publish directional trade geometry`,()=>{
  const {selected,truth,context}=fixtures();
  if(scenario==="structural only")context.basis="PARTIAL";
  if(scenario==="withheld canonical levels")truth.levels.withheld=true;
  if(scenario==="watch verdict")truth.verdict.bestAction="WATCH_ONLY";
  if(scenario==="wrong source")selected.marketEvidence={...evidence,sourceIdentity:"b".repeat(64)};
  if(scenario==="wrong timeframe")selected.timeframe="M5";
  if(scenario==="expired")truth.validUntil=new Date(now-1).toISOString();
  if(scenario==="invalid geometry")truth.levels.stopLoss=104;
  const out=capSelectedMarketByTruth(selected,truth,scenario==="missing context"?null:context,now) as SelectedMarketResult;
  assert.equal(out.levelsWithheld,true);assert.equal(out.highlights.bias,"WAIT");assert.equal(out.highlights.entryZone,null);assert.equal(out.highlights.suggestedStop,null);assert.equal(out.highlights.suggestedTakeProfit,null);assert.equal(out.highlights.confidenceScore,null);
  assert.ok(out.readWithheldReason);assert.doesNotMatch(JSON.stringify(out.explanation),/200|202|220/);
 });
}
