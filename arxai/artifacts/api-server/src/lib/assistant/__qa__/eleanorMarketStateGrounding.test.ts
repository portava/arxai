import { test } from "node:test";
import assert from "node:assert/strict";
import { checkClaims } from "../grounding/claimsChecker.js";
import { verifyAnswer, ClaimGate, VERIFIER_NOTICES } from "../grounding/runtimeVerifier.js";
import { buildEvidenceIndex, type ToolOutput } from "../grounding/evidence.js";
const blocked: ToolOutput[] = [{name:"getFinalTradeRead",result:{symbol:"EURUSD",timeframe:"H1",direction:"SELL",recommendedAction:"WAIT",feedStatus:{stale:true,isLive:false},chartVerified:false}}];
const allowed: ToolOutput[] = [{name:"readChartStructure",result:{symbol:"EURUSD",timeframe:"H1",bias:"BULLISH",recommendedAction:"BUY",feedStatus:{isLive:true},chartVerified:true}}];
const kind = "UNSUPPORTED_MARKET_STATE";

test("withholds contradictory direction, live-feed and verification assertions without numbers", () => {
  const text = "EURUSD is a confirmed BUY setup. The feed is live and the chart is verified.";
  const result = verifyAnswer(text, blocked);
  assert.equal(result.findings.filter(f=>f.kind===kind).length,3);
  assert.ok(result.text.includes(VERIFIER_NOTICES.UNSUPPORTED_MARKET_STATE));
  assert.ok(!result.text.includes("confirmed BUY"));
  assert.ok(!result.text.includes("feed is live"));
  assert.ok(!result.text.includes("chart is verified"));
  assert.match(result.findings[0]!.detail,/getFinalTradeRead.direction=SELL/);
});
test("supports matching structured facts and does not confuse bearish direction with a WAIT action", () => {
  assert.equal(verifyAnswer("EURUSD is bullish. The feed is live. The chart is verified.", allowed).findings.length,0);
  assert.equal(verifyAnswer("EURUSD is bearish. Entry should wait.", blocked).findings.length,0);
  assert.equal(verifyAnswer("EURUSD is a confirmed SELL setup.", blocked).findings[0]?.kind,kind);
});
test("reads the actual nested chart-read wire fields without treating a display tier as verification", () => {
  const wire: ToolOutput[] = [{name:"readChartStructure",result:{symbol:"EURUSD",timeframe:"H1",feedUnconfirmed:false,
    chartRead:{symbol:"EURUSD",timeframe:"H1",bias:"BULLISH",basis:"VERIFIED",tradeHealthFreshness:"LIVE_CONFIRMED",readLayer:"FULL",canShowLiveTradeSetup:true}}}];
  assert.equal(verifyAnswer("EURUSD is bullish. The feed is live. The chart is verified.",wire).findings.length,0);
  const structural:ToolOutput[]=[{name:"readChartStructure",result:{symbol:"EURUSD",timeframe:"H1",feedUnconfirmed:true,
    chartRead:{bias:"BULLISH",basis:"PARTIAL",tradeHealthFreshness:"HISTORICAL_ONLY",readLayer:"STRUCTURAL_ONLY",liveSetupWithheld:true,canShowLiveTradeSetup:false}}}];
  assert.equal(verifyAnswer("EURUSD is bullish.",structural).findings.length,0);
  assert.equal(verifyAnswer("EURUSD is a confirmed BUY setup. The feed is live. The chart is verified.",structural).findings.filter(f=>f.kind===kind).length,3);
  assert.equal(verifyAnswer("The chart is verified.",[{name:"readChartStructure",result:{symbol:"EURUSD",readLayer:"FULL"}}]).findings[0]?.kind,kind);
});
test("missing and unknown fields never establish current state, and news text is not authority", () => {
  for (const evidence of [[],[{name:"readChartStructure",result:{symbol:"EURUSD",bias:"UNKNOWN",feedStatus:{freshness:"UNKNOWN"},chartReadBasis:"UNKNOWN"}}],
    [{name:"getMarketNews",result:{symbol:"EURUSD",direction:"BUY",isLive:true,chartVerified:true}}],
    [{name:"readChartStructure",result:{symbol:"EURUSD",news:{bias:"BULLISH",isLive:true,chartVerified:true}}}]] as ToolOutput[][]) {
    const result=verifyAnswer("EURUSD is bullish. The feed is live. The chart is verified.",evidence);
    assert.equal(result.findings.filter(f=>f.kind===kind).length,3);
  }
  assert.equal(verifyAnswer("The feed is live.",[{name:"getMarketSnapshot",result:{symbol:"EURUSD",stale:false}}]).findings[0]?.kind,kind);
});
test("binds state evidence to the instrument and timeframe, refusing ambiguous unqualified reads", () => {
  const mixed:ToolOutput[]=[{name:"getMarketScannerOpportunities",result:{opportunities:[{symbol:"EURUSD",timeframe:"H1",bias:"BEARISH"},{symbol:"GBPUSD",timeframe:"H1",bias:"BULLISH"},{symbol:"EURUSD",timeframe:"M5",bias:"BULLISH"}]}}];
  assert.equal(verifyAnswer("EURUSD H1 is bearish.",mixed).findings.length,0);
  for (const text of ["EURUSD H1 is bullish.","AUDUSD is bullish.","The trend is bullish."]) assert.equal(verifyAnswer(text,mixed).findings[0]?.kind,kind,text);
});
test("preserves negation, conditional scenarios, questions and reported/example quotations", () => {
  const examples=["EURUSD is not bullish.","The feed is not live and the chart is not verified.",
    "I cannot confirm that the chart is verified.","It is not true that the feed is live.","I don't know whether EURUSD is bullish.",
    "If EURUSD is bullish, wait for confirmation.","The feed is live only if the checks pass.",
    "Suppose EURUSD is bullish.","The chart is verified?",'You said "EURUSD is a confirmed BUY setup."',
    'The phrase "the feed is live" requires evidence.', 'For example: "the chart is verified."'];
  for (const text of examples) assert.equal(verifyAnswer(text,blocked).findings.length,0,text);
  assert.equal(verifyAnswer("The feed is not stale, but the chart is verified.",blocked).findings[0]?.kind,kind);
  assert.equal(verifyAnswer('The feed is live.',blocked).findings[0]?.kind,kind);
});
test("streaming gate catches the same unsupported fact across delta boundaries", () => {
  const gate=new ClaimGate(buildEvidenceIndex(blocked));
  let output="";for(const fragment of ["EURUSD is a con","firmed BUY setup", ". ","The feed is ","live."]) output+=gate.push(fragment);
  output+=gate.end();
  assert.equal(gate.findings.filter(f=>f.kind===kind).length,2);
  assert.ok(!output.includes("confirmed BUY"));assert.ok(!output.includes("feed is live"));
  assert.equal(checkClaims("EURUSD is bullish.",blocked).grounded,false);
});
