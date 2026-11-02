import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveTimingTruth, resolveGoldTiming, buildMarketIntelligenceDisplay, type TimingTruthInput } from "@workspace/domain/market";
import { buildMarketIntelligenceSnapshot } from "../marketIntelligenceService.js";
import type { RubyChartContext } from "../rubyChartContext.js";

const display = {feedConfirmed:true,feedStale:false,sufficiencyAllowsSetup:true,chartReadConfidenceLow:false};
const timing = (over: Partial<TimingTruthInput> = {}): TimingTruthInput => ({session:"unknown" as TimingTruthInput["session"],candleState:"closed_confirmed",volatilityState:"normal",marketPhase:"trend",signalAge:0,maxSignalAge:5,distanceFromTriggerAtr:0,newsImminent:false,spreadWide:false,lowLiquidity:false,cooldownActive:false,intrabarScalpAllowed:false,retestRequired:false,...over});
function context(assetClass = "forex", closeTime: string | null = "2024-01-01T14:00:00.000Z"): RubyChartContext {
 return {timeframe:"M15",basis:"VERIFIED",confidentReadAllowed:true,liveDelayed:false,hasFormingCandle:false,closedBarsCount:200,sufficiency:{canShowTradeSetup:true},feedStatus:{source:"mt5_broker"},candles:[],htfCandles:[],htfTimeframe:null,htfFeedStatus:null,
 state:{symbol:"EURUSD",displaySymbol:"EURUSD",stale:false,assetClass,candleStats:{lastClose:101,atr:2,avgRange:3,body:1,changeAbs:1,direction:"up"},marketUnderstanding:{trend:{direction:"bullish",higherTimeframeBias:"unknown",regime:"trending",populated:true},levels:{nearestSupport:null,nearestResistance:null},candleIntent:{dominantPressure:"balanced",latestIntent:"unknown"}},fastFlags:{momentumBurst:false,nearRecentHigh:false,nearRecentLow:false},setupState:{direction:"none",hasActiveSetup:false,ageBars:null,expiresInBars:null,invalidationPrice:null,stage:"none"},latestClosedCandle:closeTime===null?null:{closeTime,timeBasisEvidence:{kind:"unavailable",basis:"BROKER_SERVER",authority:null}}}} as unknown as RubyChartContext;
}
for (const closeTime of [null,"invalid","2024-01-01T09:00:00.000Z","2024-01-01T14:00:00.000Z","2024-01-01T18:00:00.000Z"]) {
 test(`no session calendar/UTC evidence cannot become a named session (${closeTime})`,()=>{
  const result=buildMarketIntelligenceSnapshot(context("forex",closeTime));assert.ok(result);
  assert.equal(result.snapshot.timing.session,"unknown");
  assert.equal(result.snapshot.timing.timingStatus,"unverified");
  assert.equal(result.snapshot.timing.timingApproved,false);
  assert.equal(result.snapshot.timing.scannerTruthImpact.supportive,false);
  assert.equal(result.snapshot.timing.confidence,0);
  const badge=buildMarketIntelligenceDisplay(result.snapshot,result.verdict).badges.find(b=>b.key==="timing");
  assert.equal(badge?.label,"Session unverified");assert.notEqual(badge?.tone,"positive");
  assert.match(badge?.detail??"",/session.*unverified/i);
 });
}
test("synthetic continuous is retained only for the exact synthetic asset class",()=>{
 const actual=buildMarketIntelligenceSnapshot(context("synthetic"));assert.ok(actual);assert.equal(actual.snapshot.timing.session,"synthetic_continuous");
 const misleading=buildMarketIntelligenceSnapshot(context("not_synthetic"));assert.ok(misleading);assert.equal(misleading.snapshot.timing.session,"unknown");
});
test("unknown session cannot add a supportive timing score or claim a bad feed",()=>{
 const result=resolveTimingTruth(timing(),display);assert.equal(result.timingStatus,"unverified");assert.equal(result.timingApproved,false);assert.equal(result.confidence,0);assert.equal(result.quality,"none");assert.equal(result.scannerTruthImpact.edgeAdjustment,0);assert.equal(result.scannerTruthImpact.supportive,false);assert.match(result.rubyExplanation,/session.*unverified/i);assert.doesNotMatch(result.rubyExplanation,/Feed is not live-confirmed/);
});
for(const [field,status] of [["newsImminent","news_blocked"],["spreadWide","spread_blocked"],["retestRequired","wait_for_retest"]] as const){
 test(`unknown session retains observed ${status} condition`,()=>{const result=resolveTimingTruth(timing({[field]:true}),display);assert.equal(result.timingStatus,status);assert.equal(result.timingApproved,false);assert.equal(result.confidence,0);assert.match(result.warnings.join(" "),/session.*unverified/i);});
}
test("known caller-supplied session keeps its existing scoped behavior",()=>{const result=resolveTimingTruth(timing({session:"london"}),display);assert.equal(result.timingStatus,"good");assert.equal(result.timingApproved,true);assert.equal(result.scannerTruthImpact.supportive,true);});
for(const session of ["unknown","synthetic_continuous"] as const){
 test(`gold does not substitute New York for ${session}`,()=>{const result=resolveGoldTiming({session:session as TimingTruthInput["session"],asianCandles:[],recentCandles:[],candleState:"closed_confirmed",volatilityState:"NORMAL",newsWindowActive:false,spreadWide:false,feedConfirmed:true,feedStale:false,sufficiencyAllowsSetup:true});assert.equal(result.session,"unknown");assert.equal(result.timingStatus,"unverified");assert.equal(result.timingApproved,false);assert.equal(result.confidence,0);});
}

for (const session of [undefined, null, "unsupported", "LONDON"]) {
 test(`missing or unrecognized runtime session cannot grant timing support (${session})`,()=>{
  const result=resolveTimingTruth(timing({session:session as TimingTruthInput["session"]}),display);
  assert.equal(result.session,"unknown");assert.equal(result.timingApproved,false);assert.equal(result.confidence,0);assert.equal(result.scannerTruthImpact.supportive,false);
 });
}
