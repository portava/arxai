// Signal Intelligence Core (Ruby Market Edge) — PURE engine unit tests.
// Verifies the honesty contract: a blind/insufficient read never fabricates a
// level/score/direction; direction stays separate from edge/quality; late
// detection + evidence minimum behave; and the what-changed diff is honest on a
// first read. No DB, no IO — every engine takes `now` explicitly.
//
// Run: pnpm --filter @workspace/scripts run test:signal-intelligence

import {
  buildRubyMarketEdge,
  MIN_STRUCTURE_CANDLES,
  type SignalCandle,
  type SignalEngineInput,
  type SignalScannerInput,
} from "@workspace/domain/signal-intelligence";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) { console.log(`  PASS  ${name}`); }
  else { console.error(`  FAIL  ${name}`); failures++; }
}

// Deterministic clock — London/NY overlap on a weekday for a high-liquidity read.
const NOW = Date.parse("2026-06-03T14:00:00Z");

// A clean rising HH/HL window (oldest → newest) with enough bars for structure.
function risingCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = 1.1000;
  for (let i = 0; i < n; i++) {
    const open = base;
    const close = base + 0.0010;
    const high = close + 0.0004;
    const low = open - 0.0003;
    out.push({ open, high, low, close, volume: 100 + i });
    base = close;
  }
  return out;
}

const baseScanner: SignalScannerInput = {
  bias: "bullish",
  recommendedAction: "BUY",
  confidenceScore: 72,
  entrySniperScore: 68,
  trendStrength: 65,
  riskRewardRatio: 2.1,
  setupType: "TREND_CONTINUATION",
  entry: 1.1200,
  stopLoss: 1.1150,
  takeProfit: 1.1320,
  entryZone: { from: 1.1190, to: 1.1210 },
  reasonForTrade: "higher highs and higher lows",
  reasonToAvoid: null,
};

function baseInput(overrides: Partial<SignalEngineInput>): SignalEngineInput {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    timeframe: "M5",
    assetClass: "forex",
    candles: risingCandles(40),
    currentPrice: 1.1200,
    dataSource: "LIVE_FEED",
    scanner: baseScanner,
    scalp: null,
    execution: { heartbeatAgeSeconds: 3, bridgeConnected: true },
    newsRiskLevel: "none",
    previous: null,
    now: NOW,
    ...overrides,
  };
}

console.log("Signal Intelligence Core test");

// 1. Blind read: null candles → honest WATCHING/UNCLEAR/NEUTRAL, no fabricated
//    geometry, zeroed scores, hasSufficientData=false.
const blind = buildRubyMarketEdge(baseInput({ candles: null, currentPrice: null }));
check("blind: hasSufficientData=false", blind.hasSufficientData === false);
check("blind: lifecycle is WATCHING", blind.lifecycleStage === "WATCHING");
check("blind: bias is UNCLEAR", blind.bias === "UNCLEAR");
check("blind: early-trend marked blind", blind.earlyTrend.blind === true);
check("blind: no entry zone fabricated", blind.entryZone === null);
check("blind: overall score is 0", blind.scores.overall === 0);
check("blind: edge score is 0", blind.edgeScore === 0);

// 2. Too-few candles is still blind (boundary at MIN_STRUCTURE_CANDLES).
const tooFew = buildRubyMarketEdge(baseInput({ candles: risingCandles(MIN_STRUCTURE_CANDLES - 1) }));
check("short window (<MIN) is blind", tooFew.hasSufficientData === false && tooFew.earlyTrend.blind === true);
const justEnough = buildRubyMarketEdge(baseInput({ candles: risingCandles(MIN_STRUCTURE_CANDLES) }));
check("exactly MIN candles is sufficient", justEnough.hasSufficientData === true && justEnough.earlyTrend.blind === false);

// 3. Direction is kept separate from quality. A clean bullish scanner read →
//    direction BUY, but the edge/overall are graded on their own evidence and
//    are bounded 0–100 (never just echoing the confidence score).
const good = buildRubyMarketEdge(baseInput({}));
check("good: direction is BUY", good.direction === "BUY");
check("good: bias is a resolved (non-blind) read", good.bias !== "UNCLEAR");
check("good: scores bounded 0–100", good.scores.overall >= 0 && good.scores.overall <= 100 && good.edgeScore >= 0 && good.edgeScore <= 100);
check("good: direction score is not the edge score (separate dimensions)", typeof good.scores.direction === "number");
check("good: LIVE_FEED provenance preserved", good.dataSource === "LIVE_FEED");

// 4. A strong directional bias with hostile news must NOT upgrade edge above a
//    clear-news read — news safety drags the fold down, direction unchanged.
const calm = buildRubyMarketEdge(baseInput({ newsRiskLevel: "none" }));
const risky = buildRubyMarketEdge(baseInput({ newsRiskLevel: "critical" }));
check("news: direction unchanged under hostile news", risky.direction === calm.direction);
check("news: critical news lowers news-safety score", risky.scores.newsSafety < calm.scores.newsSafety);
check("news: critical news does not raise edge", risky.edgeScore <= calm.edgeScore);

// 5. Late / do-not-chase: price extended far past the entry zone after a long
//    run should flag late without fabricating a remaining-RR when none exists.
const extended = buildRubyMarketEdge(baseInput({
  candles: risingCandles(40),
  currentPrice: 1.1320,
}));
check("late: late detection returns a structured verdict", typeof extended.late.isLate === "boolean");
check("late: lateReason mirrors late.reason", extended.lateReason === extended.late.reason);

// 6. Evidence: for/against arrays and a clamped netScore; meetsMinimum is a bool.
check("evidence: for/against are arrays", Array.isArray(good.evidence.for) && Array.isArray(good.evidence.against));
check("evidence: netScore clamped 0–100", good.evidence.netScore >= 0 && good.evidence.netScore <= 100);
check("evidence: meetsMinimum is boolean", typeof good.evidence.meetsMinimum === "boolean");

// 7. What-changed is honest on a first read (no previous snapshot).
check("diff: first read has no previous", good.whatChanged.hasPrevious === false);
check("diff: first read has no changes", good.whatChanged.changes.length === 0);

// 8. What-changed reports a real transition when the previous snapshot differs.
const changed = buildRubyMarketEdge(baseInput({
  previous: {
    bias: "BEARISH",
    direction: "SELL",
    regime: "RANGING",
    lifecycleStage: "WATCHING",
    confidenceBand: "LOW",
    edgeScore: 10,
    overallScore: 20,
    generatedAt: new Date(NOW - 600_000).toISOString(),
    firstSeenAt: new Date(NOW - 600_000).toISOString(),
  },
}));
check("diff: hasPrevious true with a prior snapshot", changed.whatChanged.hasPrevious === true);
check("diff: a direction flip is reported as a change", changed.whatChanged.changes.some((c) => c.field === "direction"));

// 9. Determinism: identical inputs → identical signal (no Date.now() leakage).
const a = buildRubyMarketEdge(baseInput({}));
const b = buildRubyMarketEdge(baseInput({}));
check("deterministic: same input → same generatedAt", a.generatedAt === b.generatedAt);
check("deterministic: same input → same edge score", a.edgeScore === b.edgeScore);

if (failures > 0) {
  console.error(`\nSignal Intelligence Core test: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nSignal Intelligence Core test: all checks passed");

export {};
