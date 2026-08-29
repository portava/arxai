// ARX Scanner Truth — computeFinalRead data-source & chart-confirmation caps.
//
// Proves the truth principle "Scanner must never show confidence the system
// cannot prove" at the read-assembly boundary. computeFinalRead may degrade a
// read for non-live data or missing chart confirmation, but can NEVER raise
// it. PURE unit test — no DB, no IO.
//
// Run: pnpm --filter @workspace/scripts run test:scanner-truth-caps

import {
  computeFinalRead,
  type ScannerOpportunity,
} from "../../artifacts/api-server/src/lib/marketScanner.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { failures += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

// Minimal clean, actionable opportunity: strong technicals, no news/history
// conflict, LIVE feed, chart confirmed → the ONLY shape allowed to be HIGH.
function baseOpp(over: Partial<ScannerOpportunity> = {}): ScannerOpportunity {
  // Build a fully-typed base FIRST so a newly-added required field on
  // ScannerOpportunity fails here as a clear "missing property" error rather
  // than being masked by the `...over` Partial spread into a confusing
  // `T | undefined` mismatch (see Task #421 build breakage).
  const base: ScannerOpportunity = {
    symbol: "EURUSD", timeframe: "M15",
    bias: "BULLISH" as ScannerOpportunity["bias"],
    recommendedAction: "BUY" as ScannerOpportunity["recommendedAction"],
    setupType: "TREND_CONTINUATION",
    signalStrength: 88, // dual-emit alias — always equals confidenceScore
    confidenceScore: 88, riskScore: 20, entrySniperScore: 80,
    riskRewardRatio: 2.5,
    reasonForTrade: "clean trend", reasonToAvoid: "",
    rulesPassed: ["trend"], rulesFailed: [],
    statusBadge: "STRONG" as ScannerOpportunity["statusBadge"],
    opportunity: { score: 88 } as ScannerOpportunity["opportunity"],
    entry: 1.1, stopLoss: 1.09, takeProfit: 1.12,
    generatedAt: new Date().toISOString(),
    dataSource: "LIVE_FEED",
    approvedTop250: true,
    dataStatus: "live",
    selectable: true,
    tradeable: true,
    disabledReason: null,
    chartConfirmed: true,
    // Both feeds present, aligned, no news risk → the only shape computeFinalRead
    // allows to reach HIGH confidence. Truth caps below can only LOWER this.
    historicalContext: {
      available: true, bias: "BULLISH", confidence: "HIGH", sampleSize: 40,
      winRate: 62, avgMovePct: 0.8, worstDrawdownPct: 0.4,
      alignsWithScanner: true, note: "",
    },
    newsContext: {
      riskLevel: "none", bias: "bullish", timing: "quiet", recommendation: "proceed_with_caution",
      headlineCount: 0, headlinesConnected: true, upcomingEventTitle: null,
      minutesUntilEvent: null, warning: "", alignsWithScanner: true,
    },
  };
  return { ...base, ...over };
}

// 1. The clean, live, chart-confirmed baseline CAN be HIGH + TRADE_WATCH.
{
  const r = computeFinalRead(baseOpp());
  check("live + chart-confirmed + clean → HIGH / TRADE_WATCH",
    r.confidence === "HIGH" && r.label === "TRADE_WATCH",
    `confidence=${r.confidence} label=${r.label}`);
}

// 2. SIMULATOR source → never HIGH, never actionable.
{
  const r = computeFinalRead(baseOpp({ dataSource: "SIMULATOR" }));
  check("SIMULATOR → confidence LOW, not TRADE_WATCH",
    r.confidence === "LOW" && r.label !== "TRADE_WATCH",
    `confidence=${r.confidence} label=${r.label}`);
}

// 3. AWAITING_FEED → capped, not actionable.
{
  const r = computeFinalRead(baseOpp({ dataSource: "AWAITING_FEED" }));
  check("AWAITING_FEED → confidence != HIGH, not TRADE_WATCH",
    r.confidence !== "HIGH" && r.label !== "TRADE_WATCH",
    `confidence=${r.confidence} label=${r.label}`);
}

// 4. HISTORY_READY_AWAITING_LIVE_TICK → capped, not actionable.
{
  const r = computeFinalRead(baseOpp({ dataSource: "HISTORY_READY_AWAITING_LIVE_TICK" }));
  check("HISTORY_READY_AWAITING_LIVE_TICK → not HIGH, not TRADE_WATCH",
    r.confidence !== "HIGH" && r.label !== "TRADE_WATCH",
    `confidence=${r.confidence} label=${r.label}`);
}

// 5. Live feed but chart NOT confirmed → downgraded from actionable.
{
  const r = computeFinalRead(baseOpp({ chartConfirmed: false }));
  check("live + chart NOT confirmed → not TRADE_WATCH (wait for confirmation)",
    r.label === "WAIT_FOR_CONFIRMATION",
    `label=${r.label}`);
  check("chart-not-confirmed reason surfaced in plain copy",
    r.reasons.some((x) => /chart confirmation/i.test(x)),
    `reasons=${JSON.stringify(r.reasons)}`);
}

// 6. chartConfirmed undefined is treated as NOT confirmed (fail-safe).
{
  const o = baseOpp(); delete (o as { chartConfirmed?: boolean }).chartConfirmed;
  const r = computeFinalRead(o);
  check("chartConfirmed undefined → fail-safe, not TRADE_WATCH",
    r.label !== "TRADE_WATCH",
    `label=${r.label}`);
}

// 7. The caps NEVER raise: an already-NO_TRADE read stays NO_TRADE on a clean
//    live row (caps are one-directional).
{
  const r = computeFinalRead(baseOpp({ statusBadge: "REJECTED_BY_RISK" as ScannerOpportunity["statusBadge"] }));
  check("caps never raise — risk-rejected stays NO_TRADE",
    r.label === "NO_TRADE",
    `label=${r.label}`);
}

// 8. No internal/source tokens leak into user-facing reasons.
{
  const r = computeFinalRead(baseOpp({ dataSource: "SIMULATOR" }));
  const leaked = r.reasons.some((x) =>
    /SIMULATOR|LIVE_FEED|AWAITING_FEED|HISTORY_READY|TRADE_WATCH|chartConfirmed/.test(x));
  check("no raw internal tokens in user-facing reasons", !leaked,
    `reasons=${JSON.stringify(r.reasons)}`);
}

{
  const r = computeFinalRead(baseOpp({ dataSource: "LIVE_DELAYED" }));
  check("LIVE_DELAYED → confidence LOW, not TRADE_WATCH",
    r.confidence === "LOW" && r.label !== "TRADE_WATCH",
    `confidence=${r.confidence} label=${r.label}`);
  check("LIVE_DELAYED honest delayed copy, distinct from awaiting/simulator",
    r.reasons.some((x) => /latest candle is delayed/i.test(x))
      && !r.reasons.some((x) => /simulated data|waiting for verified live/i.test(x)),
    `reasons=${JSON.stringify(r.reasons)}`);
  const leaked = r.reasons.some((x) =>
    /SIMULATOR|LIVE_FEED|AWAITING_FEED|HISTORY_READY|LIVE_DELAYED|TRADE_WATCH|chartConfirmed/.test(x));
  check("LIVE_DELAYED leaks no raw internal tokens", !leaked,
    `reasons=${JSON.stringify(r.reasons)}`);
}

console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
process.exit(failures > 0 ? 1 : 0);
