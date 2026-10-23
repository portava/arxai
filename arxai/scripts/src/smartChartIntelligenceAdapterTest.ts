// SmartChartIntelligence adapter — pure unit tests.
//
// Verifies the read-only adapter unifies existing chart-intelligence outputs
// WITHOUT inventing data and WITHOUT weakening the chart-truth gate. No DB, no
// IO, no broker access — the adapter is a pure function over context.
//
// Run: pnpm --filter @workspace/scripts run test:smart-chart-intelligence

import {
  buildSmartChartIntelligence,
  type SmartChartExternalContext,
} from "../../artifacts/api-server/src/lib/data/chart/smartChartIntelligence.js";
import type { RubyChartContext } from "../../artifacts/api-server/src/lib/data/chart/rubyChartContext.js";
import type { ChartIntelligenceState } from "../../artifacts/api-server/src/lib/data/chart/chartIntelligence.js";
import type { ChartGateOutput } from "../../artifacts/api-server/src/lib/data/chart/chartGateOutput.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { failures += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

// ── Fixture builders (mirrors the `as unknown as` pattern used by the existing
//    chartBrainBenchmarkTest — only the fields the adapter reads are populated).

function makeGate(over: Partial<ChartGateOutput> = {}): ChartGateOutput {
  return {
    chartTruthScore: 92,
    chartReadScore: 81,
    truthLabel: "Verified",
    readLabel: "Good read",
    confidentReadAllowed: true,
    scannerConfirmAllowed: true,
    selfTradeChartAllowed: true,
    candlestickModeAllowed: true,
    autonomousChartActionAllowed: true,
    tradeConfirmationAllowed: true,
    blockedReasons: [],
    primaryBlockReason: null,
    note: "",
    ...over,
  };
}

function makeState(over: Record<string, unknown> = {}): ChartIntelligenceState {
  // Only the subset the adapter reads is populated. Cast via unknown — the same
  // convention the existing chart tests use for partial state fixtures.
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    candleStats: { barsAnalyzed: 120 },
    marketUnderstanding: {
      populated: true,
      note: "Buyers defending support; structure constructive.",
      trend: { populated: true, direction: "bullish", regime: "trending", strength: 70, slope: 0.4, higherTimeframeBias: "bullish", note: "" },
      levels: {
        populated: true,
        levels: [
          { kind: "support", price: 1.0900, personality: "defended", touchCount: 3, rejectionCount: 2, breakCount: 0, retestCount: 1, strengthScore: 70, weaknessScore: 10, trapScore: 5, distancePct: -0.2 },
          { kind: "resistance", price: 1.0960, personality: "fresh", touchCount: 1, rejectionCount: 1, breakCount: 0, retestCount: 0, strengthScore: 60, weaknessScore: 20, trapScore: 10, distancePct: 0.3 },
        ],
        nearestSupport: null, nearestResistance: null, eventsRemembered: 4, note: "",
      },
      candleIntent: { populated: true, latestIntent: "pushing", dominantPressure: "buyers", signals: [], note: "Buyers in control." },
      timeframeAgreement: { } ,
      evidence: { },
      readiness: { populated: true, score: 78, quality: "B", gates: [], vetoed: false, vetoReason: null, note: "" },
    },
    setupState: {
      populated: true, hasActiveSetup: true, stage: "confirmation_needed",
      tradeType: "intraday", direction: "bullish", freshness: 80, decayScore: 25,
      ageBars: 3, expiresInBars: 6, invalidationCondition: "close below 1.0890",
      invalidationPrice: 1.0890, note: "",
    },
    decisionState: { populated: true, bias: "bullish", quality: "B", actionability: "watch", vetoed: false, decision: null, note: "" },
    marketSentences: {
      populated: true,
      market: { key: "market", label: "Market", text: "Price is holding support after an impulse; buyers defending.", tone: "positive" },
      bestNextAction: { key: "next", label: "Next", text: "Wait for a clean retest hold before entry.", tone: "neutral" },
      proving: { key: "p", label: "", text: "", tone: "neutral" },
      failedToProve: { key: "f", label: "", text: "", tone: "neutral" },
      risk: { key: "r", label: "", text: "", tone: "neutral" },
      entryTiming: { key: "e", label: "", text: "", tone: "neutral" },
      scalp: { key: "s", label: "", text: "", tone: "neutral" },
      whatWouldChange: { key: "w", label: "", text: "", tone: "neutral" },
      whatInvalidates: { key: "i", label: "", text: "", tone: "neutral" },
      signalFreshness: { key: "sf", label: "", text: "", tone: "neutral" },
      note: "",
    },
    ...over,
  } as unknown as ChartIntelligenceState;
}

function makeCtx(gate: ChartGateOutput, state: ChartIntelligenceState, over: Partial<RubyChartContext> = {}): RubyChartContext {
  return {
    symbol: "EURUSD",
    displaySymbol: "EUR/USD",
    timeframe: "M5",
    basis: gate.confidentReadAllowed ? "VERIFIED" : "SYNCING",
    confidentReadAllowed: gate.confidentReadAllowed,
    hasFormingCandle: false,
    closedBarsCount: 120,
    limitedHistory: false,
    trustLine: gate.confidentReadAllowed
      ? "Verified M5 candles · Live feed · Mirror synced · AACI verified"
      : "M5 candles syncing · Feed stale · Mirror degraded · AACI unverified",
    blockReason: gate.confidentReadAllowed ? null : "Chart data is syncing. Ruby will read once candles are verified.",
    aaciChartHandshakeOverall: gate.confidentReadAllowed ? "PASS" : "FAIL",
    gateOutput: gate,
    state,
    candles: [],
    htfCandles: [],
    ...over,
  } as unknown as RubyChartContext;
}

const NOW = 1_700_000_000_000;
const baseExternal: SmartChartExternalContext = { now: NOW, intelligenceId: "sci_test" };

// 1. Chart Truth pass + strong outputs → verified, directional, levels present.
{
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  check("truth pass → chartReadAllowed true", out.chartReadAllowed === true);
  check("truth pass → status verified", out.chartTruthStatus === "verified", out.chartTruthStatus);
  check("truth pass → directional bias", out.bias === "bullish", out.bias);
  check("truth pass → confidence numeric", typeof out.confidence === "number", String(out.confidence));
  check("truth pass → keyLevels present", !!out.keyLevels && out.keyLevels.support.length > 0);
  check("truth pass → candleStory present", !!out.candleStory && out.candleStory.summary.length > 0);
  check("truth pass → marketStage mapped", out.marketStage === "retest", out.marketStage);
}

// 2. Chart Truth fail → read blocked, no bias, no confidence, capped action.
{
  const gate = makeGate({ confidentReadAllowed: false, truthLabel: "Degraded", primaryBlockReason: "candles syncing" });
  const out = buildSmartChartIntelligence(makeCtx(gate, makeState()), baseExternal);
  check("truth fail → chartReadAllowed false", out.chartReadAllowed === false);
  check("truth fail → status blocked", out.chartTruthStatus === "blocked", out.chartTruthStatus);
  check("truth fail → bias unknown", out.bias === "unknown", out.bias);
  check("truth fail → confidence null", out.confidence === null, String(out.confidence));
  check("truth fail → bestAction non-actionable", out.bestAction === "watch_only", out.bestAction);
  check("truth fail → no keyLevels", out.keyLevels === undefined);
  check("truth fail → no candleStory", out.candleStory === undefined);
  check("truth fail → data line explains syncing", /sync/i.test(out.dataConfidenceLine), out.dataConfidenceLine);
}

// 3. Broad flow stub → not_verified + listed unavailable (never invented).
{
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  check("broadFlow not_verified by default", out.broadFlow?.status === "not_verified" && out.broadFlow?.verified === false, JSON.stringify(out.broadFlow));
  check("broadFlow listed in unavailableInputs", out.unavailableInputs.includes("broadFlow"));
}

// 4. Missing heat/news/scanner → unavailable fields, not invented.
{
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  check("scanner unavailable", out.scannerAgreement?.status === "unavailable");
  check("timing not verified", out.timingBrain?.verified === false);
  check("news not verified", out.newsContext?.verified === false);
  check("all three in unavailableInputs",
    ["scannerAgreement", "timingBrain", "newsContext"].every((k) => out.unavailableInputs.includes(k)));
}

// 5. Open position missing → hasOpenPosition false, verified false, safe.
{
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  check("open position safe-empty", out.openPositionContext?.hasOpenPosition === false && out.openPositionContext?.verified === false);
  check("open position in unavailableInputs", out.unavailableInputs.includes("openPositionContext"));
}

// 6. Risk/AACI/Security blocked → tradeActionAllowed false.
{
  const ext: SmartChartExternalContext = {
    ...baseExternal,
    riskAaciSecurity: { riskStatus: "blocked", aaciStatus: "synced", securityStatus: "ok", tradeActionAllowed: false, blockedReason: "Risk limit reached." },
  };
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), ext);
  check("risk blocked → tradeActionAllowed false", out.riskAaciSecurity?.tradeActionAllowed === false);
  check("risk blocked → not in unavailableInputs (was supplied)", !out.unavailableInputs.includes("riskAaciSecurity"));
}

// 7. Weak Chart Read but truth high → still allowed, action is wait/watch, not trade_now.
{
  const gate = makeGate({ chartReadScore: 58, readLabel: "No trade" });
  const state = makeState({
    setupState: { populated: true, hasActiveSetup: false, stage: "stale", tradeType: "intraday", direction: "bullish", freshness: 20, decayScore: 90, ageBars: 20, expiresInBars: 0, invalidationCondition: null, invalidationPrice: null, note: "" },
  });
  const out = buildSmartChartIntelligence(makeCtx(gate, state), baseExternal);
  check("weak read but truth high → still allowed", out.chartReadAllowed === true);
  check("weak read → low chartReadScore preserved", out.chartReadScore === 58, String(out.chartReadScore));
  check("weak/stale read → action is wait/watch/avoid, not trade_now",
    ["wait_for_pullback", "watch_only", "avoid"].includes(out.bestAction), out.bestAction);
  check("stale setup → edge expired", out.speedEdge?.edgeStatus === "expired", String(out.speedEdge?.edgeStatus));
}

// 8. Adapter does not mutate its inputs.
{
  const gate = makeGate();
  const state = makeState();
  const ctx = makeCtx(gate, state);
  const snapshot = JSON.stringify({ gate, trustLine: ctx.trustLine, basis: ctx.basis });
  buildSmartChartIntelligence(ctx, baseExternal);
  check("inputs not mutated", JSON.stringify({ gate, trustLine: ctx.trustLine, basis: ctx.basis }) === snapshot);
}

// 9. Data confidence line is user-safe — no backend/internal tokens.
{
  const blocked = buildSmartChartIntelligence(makeCtx(makeGate({ confidentReadAllowed: false }), makeState()), baseExternal);
  const ok = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  const leak = (s: string) => /confidentReadAllowed|gateOutput|ChartIntelligenceState|scannerConfirmAllowed|primaryBlockReason|undefined|null/.test(s);
  check("blocked data line user-safe", !leak(blocked.dataConfidenceLine), blocked.dataConfidenceLine);
  check("ok data line user-safe", !leak(ok.dataConfidenceLine), ok.dataConfidenceLine);
}

// 10. unavailableInputs is populated correctly (exactly the omitted inputs).
{
  const out = buildSmartChartIntelligence(makeCtx(makeGate(), makeState()), baseExternal);
  const expected = ["scannerAgreement", "timingBrain", "newsContext", "broadFlow", "openPositionContext", "riskAaciSecurity"].sort();
  check("unavailableInputs == all omitted external inputs",
    JSON.stringify([...out.unavailableInputs].sort()) === JSON.stringify(expected),
    JSON.stringify(out.unavailableInputs));
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
if (failures > 0) process.exit(1);
