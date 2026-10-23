// Task #408 — Self-trade simulator containment (domain pipeline).
//
// Proves the inviolable contract: simulated / non-live market data can never
// produce an executable (APPROVED) self-trade decision. The data_feed gate must
// hard-BLOCK any simulated source, and `isSimulatedDataSource` must recognise
// every simulator tag the scanner can emit. A genuine LIVE_FEED signal is used
// as the control to show the gate is not blocking everything indiscriminately.
//
// Pure, no IO. Run: tsx ./src/task408SimulatorContainmentTest.ts

import {
  runDecisionPipeline,
  isSimulatedDataSource,
  type QuotaContext,
  type GovernorContext,
  type HandshakeReadinessContext,
  type DecisionCandidateInput,
} from "@workspace/domain/self-trade";
import {
  buildRubyMarketEdge,
  type SignalEngineInput,
  type SignalScannerInput,
  type SignalCandle,
} from "@workspace/domain/signal-intelligence";

export {};

let failures = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (ok) {
    console.log(`  PASS  ${name}`);
  } else {
    failures++;
    console.error(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-06-09T12:00:00Z");

function okQuota(): QuotaContext {
  return {
    dailyMinTrades: 3,
    effectiveMaxTrades: 5,
    tradesTakenToday: 1,
    remainingToMax: 4,
    belowDailyMinimum: true,
    baseReached: false,
    hardCapReached: false,
  };
}
function okGovernor(): GovernorContext {
  return { status: "PAPER_ALLOWED", hardBlocks: [] };
}
function okHandshake(): HandshakeReadinessContext {
  return { ready: true, degraded: [], blocked: [] };
}

function risingCandles(n: number): SignalCandle[] {
  const out: SignalCandle[] = [];
  let base = 1.1;
  for (let i = 0; i < n; i++) {
    const open = base;
    const close = base + 0.001;
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
  entry: 1.12,
  stopLoss: 1.115,
  takeProfit: 1.132,
  entryZone: { from: 1.119, to: 1.121 },
  reasonForTrade: "higher highs and higher lows",
  reasonToAvoid: null,
};

function signalInput(overrides: Partial<SignalEngineInput> = {}): SignalEngineInput {
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    timeframe: "M5",
    assetClass: "forex",
    candles: risingCandles(40),
    currentPrice: 1.12,
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

function candidate(dataSource: string, over: Partial<DecisionCandidateInput> = {}): DecisionCandidateInput {
  const signal = buildRubyMarketEdge(signalInput({ dataSource }));
  return {
    agentId: 1,
    agentKey: "qa-agent",
    agentRankWeight: 1,
    symbol: "EURUSD",
    timeframe: "M5",
    symbolAllowed: true,
    maxSpreadPoints: null,
    signal,
    htfSignals: [],
    currentPrice: 1.12,
    newsRisk: "none",
    execution: { liveSpreadPoints: null, heartbeatAgeSeconds: 3, bridgeConnected: true },
    quota: okQuota(),
    funding: { availableFunds: 10000, allocatedFunds: 0 },
    governor: okGovernor(),
    handshake: okHandshake(),
    killEngaged: false,
    now: NOW,
    ...over,
  };
}

// ── 1. isSimulatedDataSource recognises the simulator tag ────────────────────
check("simulator-tag-recognised", isSimulatedDataSource("SIMULATOR"), "SIMULATOR must be simulated");
check("simulator-tag-case-space", isSimulatedDataSource("  simulator  "), "trim+lowercase must match");
check("live-tag-not-simulated", !isSimulatedDataSource("LIVE_FEED"), "LIVE_FEED must NOT be simulated");
check("awaiting-tag-not-simulated", !isSimulatedDataSource("AWAITING_FEED"), "AWAITING_FEED must NOT be simulated");

// ── 2. Simulated source HARD-BLOCKS the pipeline (never APPROVED) ─────────────
const simDecision = runDecisionPipeline(candidate("SIMULATOR"));
check(
  "simulator-pipeline-blocked",
  simDecision.outcome === "BLOCKED",
  `expected BLOCKED, got ${simDecision.outcome}`,
);
check(
  "simulator-pipeline-not-approved",
  simDecision.outcome !== "APPROVED" && simDecision.outcome !== "APPROVED_REDUCED",
  `simulated data must never be executable, got ${simDecision.outcome}`,
);
const simDataFeed = simDecision.checks.find((c) => c.key === "data_feed");
check(
  "simulator-data-feed-fail-blocking",
  !!simDataFeed && simDataFeed.status === "FAIL" && simDataFeed.blocking === true,
  `data_feed check must FAIL+blocking, got ${JSON.stringify(simDataFeed)}`,
);

// ── 3. Control: a clean LIVE_FEED signal passes the data_feed gate ───────────
const liveDecision = runDecisionPipeline(candidate("LIVE_FEED"));
const liveDataFeed = liveDecision.checks.find((c) => c.key === "data_feed");
check(
  "live-data-feed-passes",
  !!liveDataFeed && liveDataFeed.status === "PASS",
  `LIVE_FEED data_feed must PASS, got ${JSON.stringify(liveDataFeed)}`,
);
check(
  "live-not-hard-blocked-by-feed",
  liveDecision.outcome !== "BLOCKED" ||
    !liveDecision.checks.some((c) => c.key === "data_feed" && c.status === "FAIL"),
  `LIVE_FEED must not be hard-blocked by the data feed gate, verdict=${liveDecision.outcome}`,
);

// ── 4. Allowlisted live sources must NOT be hard-blocked by the feed gate ─────
// Guards against future over-blocking: only simulated sources are refused.
for (const liveSource of ["MT5_BROKER", "DERIV"]) {
  const d = runDecisionPipeline(candidate(liveSource));
  const feed = d.checks.find((c) => c.key === "data_feed");
  check(
    `live-source-${liveSource}-feed-not-failing`,
    !feed || feed.status !== "FAIL",
    `${liveSource} must not FAIL the data_feed gate, got ${JSON.stringify(feed)}`,
  );
  check(
    `live-source-${liveSource}-not-simulated`,
    !isSimulatedDataSource(liveSource),
    `${liveSource} must not be classified simulated`,
  );
}

if (failures > 0) {
  console.error(`\nTask #408 simulator-containment: ${failures} FAILED`);
  process.exit(1);
}
console.log("\nTask #408 simulator-containment: all checks passed");
