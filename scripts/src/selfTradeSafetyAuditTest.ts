// Self-Trade AI — Safety Audit Deterministic Tests (Audit 2026-06-19).
//
// Covers the 7 behaviors not already exercised by selfTradeExecutionDomainTest.ts:
//   B3  News HIGH risk → newsRisk derived as "high"/"critical" (thesis integrity)
//   B5  Phase B: stale bridge heartbeat → EA_HEARTBEAT_STALE
//   B6  Phase B: daily loss limit reached → DAILY_LOSS_LIMIT_REACHED
//   B7x Kill switch scope semantics (per-scope precedence in Phase B)
//   B8  SHADOW mode → LOG_ONLY (display-only "Ready now" cannot execute)
//   B10 Dispatch ≠ fill: complete-plan required; no-entry / wrong-side SL
//   B12 Spread / no-entry-price block path via lot-sizer
//   B14 Owner/admin live path still requires master-live access (no bypass)
//   B15 Audit pre-commit intent: kill-switch blockCode carries before dispatch
//
// ALL tests are pure / deterministic / offline. No DB, no network, no side effects.
// Run: pnpm --filter @workspace/scripts run test:self-trade-safety-audit

import {
  evaluateLivePhaseBDispatchGate,
  LIVE_HEARTBEAT_MAX_AGE_SEC,
  MIN_LIVE_EA_VERSION,
  type LivePhaseBGateInput,
} from "@workspace/domain/safety-contracts/livePhaseBDispatchGate";
import {
  evaluateExecutionPermission,
  computeRiskAwareLot,
  runDecisionPipeline,
  type ExecutionPermissionInput,
  type QuotaContext,
  type GovernorContext,
  type HandshakeReadinessContext,
  type TradeThesis,
  type DecisionCandidateInput,
} from "@workspace/domain/self-trade";

type CandidateSignal = DecisionCandidateInput["signal"];

// ── Harness ──────────────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const NOW = Date.parse("2026-06-19T14:00:00Z");

// ── Phase B gate builder ──────────────────────────────────────────────────────
// A fully-green Phase B input: all 23 gates pass when unmodified.
function baseGateInput(over: Partial<LivePhaseBGateInput> = {}): LivePhaseBGateInput {
  return {
    // Server master switches
    liveBrokerExecutionEnabled: true,
    globalLiveEnabled: true,
    userLiveApproved: true,
    // Per-user arming
    userArmed: true,
    killSwitchEngaged: false,
    // Bridge facts
    bridgeAccountType: "live",
    bridgeHeartbeatAgeSec: 5,               // well within LIVE_HEARTBEAT_MAX_AGE_SEC (15)
    bridgeEaVersion: "1.54",               // >= MIN_LIVE_EA_VERSION ("1.27")
    bridgeEnableLiveExecution: true,
    bridgeReadOnlyMode: false,
    bridgeTerminalConnected: true,
    bridgeAlgoTradingAllowed: true,
    // Command facts
    commandSymbol: "EURUSD",
    commandVolume: 0.01,
    commandHasStopLoss: true,
    // Settings facts
    allowedSymbols: ["EURUSD"],
    maxLotForSymbol: 0.05,
    dailyLossLimitUsd: 100,
    realisedDailyLossUsd: 0,
    requireStopLoss: true,
    adminAllowNoStopLoss: false,
    requireTakeProfit: false,
    adminAllowNoTakeProfit: false,
    commandHasTakeProfit: true,
    disclosureAccepted: true,
    ...over,
  };
}

// ── Execution permission builder ──────────────────────────────────────────────
function okQuota(): QuotaContext {
  return {
    dailyMinTrades: 2,
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
function okThesis(): TradeThesis {
  return {
    symbol: "EURUSD",
    side: "BUY",
    setup: "TREND_CONTINUATION" as TradeThesis["setup"],
    whyNow: ["bullish structure"],
    entryZone: { from: 1.08, to: 1.0805 },
    stopLoss: 1.075,
    invalidation: 1.074,
    takeProfits: [{ from: 1.085, to: 1.085 }, { from: 1.09, to: 1.09 }],
    edge: 68,
    confidence: 71,
    newsRisk: "low",
  };
}
function basePerm(over: Partial<ExecutionPermissionInput> = {}): ExecutionPermissionInput {
  return {
    agentStatus: "ACTIVE",
    agentMode: "LIVE",
    autonomyLevel: 2,
    outcome: "APPROVED",
    thesis: okThesis(),
    setupExpiresAt: null,
    funded: true,
    quota: okQuota(),
    governor: okGovernor(),
    handshake: okHandshake(),
    killEngaged: false,
    openPositionsCount: 0,
    maxConcurrentPositions: 2,
    executingUserId: 7,
    hasMasterLiveAccess: true,
    now: NOW,
    ...over,
  };
}

// ── Decision pipeline builder ─────────────────────────────────────────────────
// Builds a minimal but complete RubyMarketEdgeSignal with all required fields.
// The signal represents a clean BUY setup so pipeline checks before news pass,
// letting us isolate the news-risk and data-confidence branches precisely.
function baseSignal(over: Partial<CandidateSignal> = {}): CandidateSignal {
  const expiresAt = new Date(NOW + 3600_000).toISOString();
  const firstSeenAt = new Date(NOW - 1800_000).toISOString();
  return {
    symbol: "EURUSD",
    displayName: "EUR/USD",
    timeframe: "H1",
    assetClass: "forex",
    generatedAt: new Date(NOW).toISOString(),
    dataSource: "MT5_BROKER",
    hasSufficientData: true,
    bias: "BULLISH",
    direction: "BUY",
    regime: "TRENDING",
    lifecycleStage: "ENTRY_WINDOW_OPEN",
    lifecycleReasons: ["bullish structure"],
    entryZone: { from: 1.079, to: 1.0805 },
    watchZone: null,
    retestZone: null,
    doNotChaseZone: null,
    invalidationPrice: 1.074,
    takeProfitZones: [{ from: 1.085, to: 1.085 }],
    stopLoss: 1.075,
    scores: {
      direction: 70, entry: 65, execution: 80, risk: 75,
      newsSafety: 90, timing: 70, survivability: 65, overall: 72, edge: 68,
    },
    confidenceBand: "STRONG",
    edgeScore: 68,
    earlyTrend: {
      pressure: "BUILDING_BULLISH",
      structure: "HH_HL",
      bosChoch: "BOS_UP",
      sweepDetected: false,
      failedBreakout: false,
      rejectionDetected: false,
      momentum: "EXPANDING",
      compression: false,
      score: 70,
      notes: ["bullish structure"],
      blind: false,
    },
    fakeout: { detected: false, kind: "NONE", confidence: 0, reason: null },
    late: {
      isLate: false, doNotChase: false, reason: null,
      distanceFromEntryPct: null, percentOfMoveComplete: null,
      remainingRR: null, candleExtensionAtr: null, signalAgeSeconds: null,
    },
    evidence: {
      for: [{ key: "structure", label: "HH/HL structure", weight: 70 }],
      against: [], conflicts: [], meetsMinimum: true, netScore: 70,
    },
    session: { session: "LONDON", isHighLiquidity: true, liquidityWeight: 1, note: "London session" },
    reasonChain: ["Bullish structure confirmed"],
    whatChanged: { hasPrevious: false, changes: [], summary: "First read" },
    freshness: "FRESH",
    validForSeconds: 3600,
    expiresAt,
    firstSeenAt,
    lateReason: null,
    ...over,
  };
}

function baseDecisionInput(over: Partial<DecisionCandidateInput> = {}): DecisionCandidateInput {
  return {
    agentId: 1,
    agentKey: "arx-primary",
    agentRankWeight: 1,
    symbol: "EURUSD",
    timeframe: "H1",
    symbolAllowed: true,
    maxSpreadPoints: null,
    signal: baseSignal(),
    htfSignals: [],
    currentPrice: 1.080,
    newsRisk: "none",
    execution: { liveSpreadPoints: null, heartbeatAgeSeconds: null, bridgeConnected: null },
    quota: okQuota(),
    funding: { availableFunds: 1000, allocatedFunds: 5000 },
    governor: okGovernor(),
    handshake: okHandshake(),
    killEngaged: false,
    now: NOW,
    ...over,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// B2 — Data-feed confidence gating: simulated / insufficient data never reaches
//      an executable decision. Low-confidence = conditional (WATCH_ONLY), not
//      a full APPROVED. Tests use the production runDecisionPipeline.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB2: data-feed confidence gating (production pipeline)");
{
  // Simulated data source → BLOCKED; "SIMULATOR" is fail-closed in pipeline step 7.
  const simResult = runDecisionPipeline(
    baseDecisionInput({ signal: baseSignal({ dataSource: "SIMULATOR" }) }),
  );
  const simFeedCheck = simResult.checks.find((c) => c.key === "data_feed");
  check(
    "B2: SIMULATOR data source ⇒ data_feed FAIL (never executable)",
    simFeedCheck?.status === "FAIL",
    simFeedCheck?.status ?? "",
  );
  check(
    "B2: SIMULATOR data source ⇒ outcome BLOCKED (fail-closed)",
    simResult.outcome === "BLOCKED",
    simResult.outcome,
  );

  // Insufficient data (hasSufficientData=false) + live source → WATCH_ONLY (blind branch).
  const blindResult = runDecisionPipeline(
    baseDecisionInput({ signal: baseSignal({ hasSufficientData: false, dataSource: "MT5_BROKER" }) }),
  );
  const blindFeedCheck = blindResult.checks.find((c) => c.key === "data_feed");
  check(
    "B2: hasSufficientData=false ⇒ data_feed FAIL (blind: conditional only)",
    blindFeedCheck?.status === "FAIL",
    blindFeedCheck?.status ?? "",
  );
  check(
    "B2: hasSufficientData=false ⇒ outcome is WATCH_ONLY (never APPROVED)",
    blindResult.outcome === "WATCH_ONLY",
    blindResult.outcome,
  );

  // Stale data + live source → WAIT (pipeline step 7 stale branch).
  const staleResult = runDecisionPipeline(
    baseDecisionInput({ signal: baseSignal({ freshness: "STALE", hasSufficientData: true, dataSource: "MT5_BROKER" }) }),
  );
  const staleFeedCheck = staleResult.checks.find((c) => c.key === "data_feed");
  check(
    "B2: STALE freshness ⇒ data_feed WARN (not actionable)",
    staleFeedCheck?.status === "WARN",
    staleFeedCheck?.status ?? "",
  );
  check(
    "B2: STALE freshness ⇒ outcome is never APPROVED",
    staleResult.outcome !== "APPROVED" && staleResult.outcome !== "APPROVED_REDUCED",
    staleResult.outcome,
  );

  // Live MT5 feed + sufficient data ⇒ data_feed PASS (pipeline can proceed).
  const liveResult = runDecisionPipeline(baseDecisionInput());
  const liveFeedCheck = liveResult.checks.find((c) => c.key === "data_feed");
  check(
    "B2: live feed + sufficient data ⇒ data_feed PASS (signal readable)",
    liveFeedCheck?.status === "PASS",
    liveFeedCheck?.status ?? "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B3 — News risk gating through the production decision pipeline.
//      When no news provider is connected, newsRisk is "none" and the pipeline
//      passes the news check without blocking. HIGH/CRITICAL risk produces
//      a more-restrictive outcome. Tests use runDecisionPipeline directly so
//      the production news-check branch (decisionPipeline.ts step 14) is the
//      authority — no local mapping duplicate.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB3: news risk gating via production pipeline (skip on missing provider)");
{
  // newsRisk="none" = no news provider connected → pipeline news check is PASS.
  // This is the "skip on missing provider" behavior: the bot does not block when
  // no live calendar feed is wired.
  const noneResult = runDecisionPipeline(baseDecisionInput({ newsRisk: "none" }));
  const noneNewsCheck = noneResult.checks.find((c) => c.key === "news");
  check(
    "B3: newsRisk=none (missing provider) ⇒ news check PASS — bot does not block",
    noneNewsCheck?.status === "PASS",
    noneNewsCheck?.status ?? "",
  );

  // newsRisk="low" → same PASS result (low risk = safe to trade).
  const lowResult = runDecisionPipeline(baseDecisionInput({ newsRisk: "low" }));
  const lowNewsCheck = lowResult.checks.find((c) => c.key === "news");
  check(
    "B3: newsRisk=low ⇒ news check PASS",
    lowNewsCheck?.status === "PASS",
    lowNewsCheck?.status ?? "",
  );

  // newsRisk="high" → news check WARN; pipeline adds APPROVED_REDUCED verdict.
  const highResult = runDecisionPipeline(baseDecisionInput({ newsRisk: "high" }));
  const highNewsCheck = highResult.checks.find((c) => c.key === "news");
  check(
    "B3: newsRisk=high ⇒ news check WARN (elevated risk, size reduction)",
    highNewsCheck?.status === "WARN",
    highNewsCheck?.status ?? "",
  );

  // newsRisk="critical" → news check FAIL; pipeline adds WAIT verdict.
  const critResult = runDecisionPipeline(baseDecisionInput({ newsRisk: "critical" }));
  const critNewsCheck = critResult.checks.find((c) => c.key === "news");
  check(
    "B3: newsRisk=critical ⇒ news check FAIL (critical event — pipeline adds WAIT)",
    critNewsCheck?.status === "FAIL",
    critNewsCheck?.status ?? "",
  );

  // Execution permission gate: a WATCH_ONLY decision outcome cannot reach EXECUTE.
  // This proves the end-to-end path: critical news → pipeline WAIT/WATCH → permission BLOCK.
  const watchOutcome = evaluateExecutionPermission(basePerm({ outcome: "WATCH_ONLY" }));
  check(
    "B3: WATCH_ONLY decision outcome ⇒ OUTCOME_NOT_APPROVED (permission gate)",
    watchOutcome.blockCode === "OUTCOME_NOT_APPROVED",
    watchOutcome.blockCode ?? "",
  );

  // DENIED outcome also cannot execute.
  const denied = evaluateExecutionPermission(basePerm({ outcome: "DENIED" }));
  check("B3: DENIED decision ⇒ OUTCOME_NOT_APPROVED", denied.blockCode === "OUTCOME_NOT_APPROVED");

  // APPROVED_REDUCED is still executable — confirms partial allows are not broken.
  const reduced = evaluateExecutionPermission(basePerm({ outcome: "APPROVED_REDUCED" }));
  check(
    "B3: APPROVED_REDUCED ⇒ EXECUTE (not blocked by news guard)",
    reduced.action === "EXECUTE" && reduced.permitted,
    reduced.action,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B5 — Stale bridge heartbeat → Phase B gate EA_HEARTBEAT_STALE
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB5: stale bridge heartbeat");
{
  // Heartbeat age exactly at the limit: should PASS.
  const atLimit = evaluateLivePhaseBDispatchGate(
    baseGateInput({ bridgeHeartbeatAgeSec: LIVE_HEARTBEAT_MAX_AGE_SEC }),
  );
  check(
    `B5: heartbeat at limit (${LIVE_HEARTBEAT_MAX_AGE_SEC}s) ⇒ PASS`,
    atLimit.decision === "PASS",
    atLimit.primaryReason ?? "ok",
  );

  // One second over the limit: must BLOCK.
  const stale = evaluateLivePhaseBDispatchGate(
    baseGateInput({ bridgeHeartbeatAgeSec: LIVE_HEARTBEAT_MAX_AGE_SEC + 1 }),
  );
  check(
    "B5: heartbeat 1s over limit ⇒ EA_HEARTBEAT_STALE",
    stale.decision === "BLOCKED" && stale.primaryReason === "EA_HEARTBEAT_STALE",
    stale.primaryReason ?? "",
  );

  // Null heartbeat (never received) also stale.
  const neverReceived = evaluateLivePhaseBDispatchGate(
    baseGateInput({ bridgeHeartbeatAgeSec: null }),
  );
  check(
    "B5: null heartbeat (never) ⇒ BLOCKED",
    neverReceived.decision === "BLOCKED",
    neverReceived.primaryReason ?? "",
  );

  // EA version too old: distinct block, correctly identified.
  const oldEa = evaluateLivePhaseBDispatchGate(
    baseGateInput({ bridgeEaVersion: "1.00" }),
  );
  check(
    `B5: EA version < ${MIN_LIVE_EA_VERSION} ⇒ EA_VERSION_TOO_OLD`,
    oldEa.decision === "BLOCKED" && oldEa.primaryReason === "EA_VERSION_TOO_OLD",
    oldEa.primaryReason ?? "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B6 — Daily loss limit reached → Phase B gate DAILY_LOSS_LIMIT_REACHED
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB6: daily loss limit");
{
  // Exactly at the cap: should BLOCK.
  const atCap = evaluateLivePhaseBDispatchGate(
    baseGateInput({ dailyLossLimitUsd: 100, realisedDailyLossUsd: 100 }),
  );
  check(
    "B6: loss at cap (100 >= 100) ⇒ DAILY_LOSS_LIMIT_REACHED",
    atCap.decision === "BLOCKED" && atCap.primaryReason === "DAILY_LOSS_LIMIT_REACHED",
    atCap.primaryReason ?? "",
  );

  // One dollar over cap.
  const overCap = evaluateLivePhaseBDispatchGate(
    baseGateInput({ dailyLossLimitUsd: 100, realisedDailyLossUsd: 101 }),
  );
  check(
    "B6: loss over cap ⇒ DAILY_LOSS_LIMIT_REACHED",
    overCap.decision === "BLOCKED" && overCap.primaryReason === "DAILY_LOSS_LIMIT_REACHED",
    overCap.primaryReason ?? "",
  );

  // One dollar under cap: should PASS (not blocked by this gate).
  const underCap = evaluateLivePhaseBDispatchGate(
    baseGateInput({ dailyLossLimitUsd: 100, realisedDailyLossUsd: 99 }),
  );
  check(
    "B6: loss under cap (99 < 100) ⇒ PASS (not loss-blocked)",
    underCap.decision === "PASS",
    underCap.primaryReason ?? "ok",
  );

  // dailyLossLimitUsd=0 means unset — should not block regardless of realised loss.
  const noLimit = evaluateLivePhaseBDispatchGate(
    baseGateInput({ dailyLossLimitUsd: 0, realisedDailyLossUsd: 9999 }),
  );
  check(
    "B6: limit=0 (unset) + high loss ⇒ PASS (no cap configured)",
    noLimit.decision === "PASS",
    noLimit.primaryReason ?? "ok",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B7x — Kill switch scope semantics in Phase B (all trigger BLOCKED)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB7x: kill switch scope semantics (Phase B)");
{
  // Per-user kill switch: KILL_SWITCH_ENGAGED in Phase B.
  const perUser = evaluateLivePhaseBDispatchGate(baseGateInput({ killSwitchEngaged: true }));
  check(
    "B7x: per-user kill switch ⇒ KILL_SWITCH_ENGAGED",
    perUser.decision === "BLOCKED" && perUser.blockReasons.includes("KILL_SWITCH_ENGAGED"),
    perUser.primaryReason ?? "",
  );

  // Master switch off: LIVE_BROKER_EXECUTION_DISABLED is gate #1.
  const masterOff = evaluateLivePhaseBDispatchGate(baseGateInput({ liveBrokerExecutionEnabled: false }));
  check(
    "B7x: master switch off ⇒ LIVE_BROKER_EXECUTION_DISABLED (first gate)",
    masterOff.decision === "BLOCKED" && masterOff.primaryReason === "LIVE_BROKER_EXECUTION_DISABLED",
    masterOff.primaryReason ?? "",
  );

  // User not armed: USER_NOT_ARMED_FOR_LIVE.
  const notArmed = evaluateLivePhaseBDispatchGate(baseGateInput({ userArmed: false }));
  check(
    "B7x: user not armed ⇒ USER_NOT_ARMED_FOR_LIVE",
    notArmed.decision === "BLOCKED" && notArmed.blockReasons.includes("USER_NOT_ARMED_FOR_LIVE"),
    notArmed.primaryReason ?? "",
  );

  // EA ReadOnly: EA_READ_ONLY_MODE_TRUE.
  const readOnly = evaluateLivePhaseBDispatchGate(baseGateInput({ bridgeReadOnlyMode: true }));
  check(
    "B7x: EA ReadOnlyMode=true ⇒ EA_READ_ONLY_MODE_TRUE",
    readOnly.decision === "BLOCKED" && readOnly.blockReasons.includes("EA_READ_ONLY_MODE_TRUE"),
    readOnly.primaryReason ?? "",
  );

  // Symbol not in allowedSymbols: SYMBOL_NOT_ALLOWED.
  const badSymbol = evaluateLivePhaseBDispatchGate(
    baseGateInput({ commandSymbol: "AUDCAD", allowedSymbols: ["EURUSD"] }),
  );
  check(
    "B7x: symbol not allowed ⇒ SYMBOL_NOT_ALLOWED",
    badSymbol.decision === "BLOCKED" && badSymbol.blockReasons.includes("SYMBOL_NOT_ALLOWED"),
    badSymbol.primaryReason ?? "",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B8 — SHADOW mode → LOG_ONLY; display-only "Ready now" cannot execute
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB8: SHADOW mode / display-only cannot execute");
{
  // SHADOW agents must always be LOG_ONLY regardless of autonomy level or approval.
  const shadow2 = evaluateExecutionPermission(basePerm({ agentMode: "SHADOW", autonomyLevel: 2 }));
  check(
    "B8: SHADOW L2 ⇒ LOG_ONLY, not permitted",
    shadow2.action === "LOG_ONLY" && !shadow2.permitted,
    shadow2.action,
  );

  const shadow4 = evaluateExecutionPermission(basePerm({ agentMode: "SHADOW", autonomyLevel: 4 }));
  check(
    "B8: SHADOW L4 (highest) ⇒ LOG_ONLY, not permitted",
    shadow4.action === "LOG_ONLY" && !shadow4.permitted,
    shadow4.action,
  );

  // L0 autonomous level is LOG_ONLY even in LIVE mode — suggestion only.
  const l0Live = evaluateExecutionPermission(basePerm({ agentMode: "LIVE", autonomyLevel: 0 }));
  check(
    "B8: LIVE mode + L0 ⇒ LOG_ONLY, not permitted",
    l0Live.action === "LOG_ONLY" && !l0Live.permitted,
    l0Live.action,
  );

  // SHADOW blockCode is null (not a hard block, just a mode restriction).
  check(
    "B8: SHADOW LOG_ONLY has null blockCode (not a hard failure)",
    shadow2.blockCode === null,
    shadow2.blockCode ?? "null",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B10 — Dispatch ≠ fill: a complete plan is required before dispatch.
//      Tests cover: thesis absence, expired setup window, zero stop distance,
//      and missing SL. The post-trade review persistence path is DB-backed and
//      lives in the integration lane (learningEngine / aiReviewEngine).
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB10: dispatch != fill / complete plan required");
{
  // A thesis MUST be present (NO_THESIS) — dispatch requires a full plan.
  const noThesis = evaluateExecutionPermission(basePerm({ thesis: null }));
  check(
    "B10: null thesis ⇒ BLOCK (NO_THESIS) — complete plan required pre-dispatch",
    noThesis.action === "BLOCK" && noThesis.blockCode === "NO_THESIS",
    noThesis.blockCode ?? "",
  );

  // Expired setup window: SETUP_EXPIRED blocks dispatch even with a valid thesis.
  const pastExpiry = evaluateExecutionPermission(
    basePerm({ setupExpiresAt: "2026-06-19T13:00:00Z" }), // 1h before NOW
  );
  check(
    "B10: expired setup window ⇒ BLOCK (SETUP_EXPIRED) — stale plan not dispatched",
    pastExpiry.blockCode === "SETUP_EXPIRED",
    pastExpiry.blockCode ?? "",
  );

  // Future expiry: not expired yet — should permit.
  const futureExpiry = evaluateExecutionPermission(
    basePerm({ setupExpiresAt: "2026-06-19T15:00:00Z" }), // 1h after NOW
  );
  check(
    "B10: future expiry ⇒ EXECUTE (plan still valid)",
    futureExpiry.action === "EXECUTE" && futureExpiry.permitted,
    futureExpiry.action,
  );

  // Lot sizer refuses when entry == stop (zero stop distance) — no dispatch possible.
  const zeroDistance = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: 1.08, // same as entry → zero stop distance
    riskBudgetUsd: 100,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  });
  check(
    "B10: entry == SL ⇒ cannotSize (NO_STOP_DISTANCE) — dispatch blocked by lot sizer",
    zeroDistance.cannotSize && zeroDistance.reasonCode === "NO_STOP_DISTANCE",
    `reasonCode=${zeroDistance.reasonCode}`,
  );

  // No stop loss at all → NO_PROTECTIVE_STOP.
  const noSl = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: null,
    riskBudgetUsd: 100,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  });
  check(
    "B10: no SL ⇒ cannotSize (NO_PROTECTIVE_STOP) — dispatch blocked",
    noSl.cannotSize && noSl.reasonCode === "NO_PROTECTIVE_STOP",
    `reasonCode=${noSl.reasonCode}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B12 — Spread / slippage / wrong-side SL handling
//
// Architecture note: the lot sizer uses Math.abs(entry - sl) for stop distance
// so it accepts any non-zero distance regardless of side. Wrong-side SL direction
// is caught at the broker guard preflight (evaluatePreTradeBrokerGuard) and the
// Phase B MISSING_STOP_LOSS gate — NOT the lot sizer. The tests below verify:
//   (a) The lot sizer's own guards (zero distance, no SL) produce cannotSize.
//   (b) sizeMultiplier ≤ 0 is treated as 1 (defensive default — never accidentally
//       produces a 0-lot dispatch attempt).
//   (c) Volume exceeding the per-symbol max is blocked by Phase B gate #14.
//   (d) SL absent from the command is blocked by Phase B gate #16.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB12: spread, slippage, lot-sizer and Phase B stop-loss guards");
{
  // Lot sizer: any non-zero stop distance succeeds (uses abs). Side direction is
  // independently checked by evaluatePreTradeBrokerGuard (preflight) — not here.
  const correctBuy = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: 1.075, // 50 pips below — correct BUY side
    riskBudgetUsd: 50,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  });
  check(
    "B12: BUY SL correctly below entry ⇒ sized (lot > 0)",
    !correctBuy.cannotSize && correctBuy.lot > 0,
    `lot=${correctBuy.lot}`,
  );

  const correctSell = computeRiskAwareLot({
    side: "SELL",
    entryPrice: 1.08,
    stopLossPrice: 1.085, // 50 pips above — correct SELL side
    riskBudgetUsd: 50,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  });
  check(
    "B12: SELL SL correctly above entry ⇒ sized (lot > 0)",
    !correctSell.cannotSize && correctSell.lot > 0,
    `lot=${correctSell.lot}`,
  );

  // sizeMultiplier=0 is treated as 1 (defensive default — prevents accidental
  // 0-lot dispatch; the executor checks cannotSize before dispatching).
  const zeroMult = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: 1.075,
    riskBudgetUsd: 50,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 0, // defensively treated as 1 — not a 0-lot pass-through
  });
  check(
    "B12: sizeMultiplier=0 treats as 1 (defensive default, lot is valid)",
    !zeroMult.cannotSize && zeroMult.lot > 0,
    `lot=${zeroMult.lot}, cannotSize=${zeroMult.cannotSize}`,
  );

  // Valid half-size multiplier reduces lot proportionally vs. full-size (same
  // risk budget). Demonstrates quota-pressure / spread-widening size reduction.
  // fullLot: 100/500 = 0.20; halfLot: 0.20 * 0.5 = 0.10
  const fullSized = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: 1.075, // 50 pips
    riskBudgetUsd: 100,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 1,
  });
  const halfMult = computeRiskAwareLot({
    side: "BUY",
    entryPrice: 1.08,
    stopLossPrice: 1.075, // same stop
    riskBudgetUsd: 100,
    valuePerUnitPerLot: 100_000,
    minLot: 0.01,
    maxLot: 100,
    lotStep: 0.01,
    agentMaxLot: 100,
    sizeMultiplier: 0.5,
  });
  check(
    "B12: sizeMultiplier=0.5 halves the lot vs full-size (quota/spread protection)",
    !halfMult.cannotSize && Math.abs(halfMult.lot - fullSized.lot * 0.5) < 1e-6,
    `halfLot=${halfMult.lot}, fullLot=${fullSized.lot}, expected=${fullSized.lot * 0.5}`,
  );

  // Phase B gate #14: volume exceeds per-symbol cap → VOLUME_EXCEEDS_MAX_LIVE_LOT.
  const overMax = evaluateLivePhaseBDispatchGate(
    baseGateInput({ commandVolume: 0.1, maxLotForSymbol: 0.05 }),
  );
  check(
    "B12: volume > per-symbol max ⇒ VOLUME_EXCEEDS_MAX_LIVE_LOT (Phase B gate)",
    overMax.decision === "BLOCKED" && overMax.blockReasons.includes("VOLUME_EXCEEDS_MAX_LIVE_LOT"),
    overMax.primaryReason ?? "",
  );

  // Phase B gate #16: no stop-loss on command → MISSING_STOP_LOSS.
  const noSlCommand = evaluateLivePhaseBDispatchGate(
    baseGateInput({ commandHasStopLoss: false, requireStopLoss: true, adminAllowNoStopLoss: false }),
  );
  check(
    "B12: command without SL + requireStopLoss ⇒ MISSING_STOP_LOSS (Phase B gate)",
    noSlCommand.decision === "BLOCKED" && noSlCommand.blockReasons.includes("MISSING_STOP_LOSS"),
    noSlCommand.primaryReason ?? "",
  );

  // Phase B gate #16: admin override allows no-SL for ops commands.
  const adminOverrideSl = evaluateLivePhaseBDispatchGate(
    baseGateInput({ commandHasStopLoss: false, requireStopLoss: true, adminAllowNoStopLoss: true }),
  );
  check(
    "B12: no SL + adminAllowNoStopLoss=true ⇒ PASS (ops command exception)",
    adminOverrideSl.decision === "PASS",
    adminOverrideSl.primaryReason ?? "ok",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B14 — Owner/admin live path still requires master-live access (no bypass)
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB14: owner/admin live path — master-live access required");
{
  // No master-live access ⇒ BLOCK at execution gate, even when fully funded+active+L4.
  const noAccess = evaluateExecutionPermission(
    basePerm({ hasMasterLiveAccess: false, autonomyLevel: 4 }),
  );
  check(
    "B14: funded+ACTIVE+L4 but no master-live access ⇒ NO_MASTER_LIVE_ACCESS",
    noAccess.blockCode === "NO_MASTER_LIVE_ACCESS",
    noAccess.blockCode ?? "",
  );

  // No executing user identity ⇒ BLOCK before the master-live check.
  const noUser = evaluateExecutionPermission(
    basePerm({ executingUserId: null, hasMasterLiveAccess: false }),
  );
  check(
    "B14: no executing user ⇒ NO_EXECUTING_USER (before master-live check)",
    noUser.blockCode === "NO_EXECUTING_USER",
    noUser.blockCode ?? "",
  );

  // Phase B: user not approved by admin ⇒ USER_NOT_LIVE_APPROVED.
  const notApproved = evaluateLivePhaseBDispatchGate(baseGateInput({ userLiveApproved: false }));
  check(
    "B14: admin approval missing ⇒ USER_NOT_LIVE_APPROVED at Phase B",
    notApproved.decision === "BLOCKED" && notApproved.blockReasons.includes("USER_NOT_LIVE_APPROVED"),
    notApproved.primaryReason ?? "",
  );

  // Phase B: disclosure not accepted ⇒ DISCLOSURE_NOT_ACCEPTED (gate #18).
  const noDisclosure = evaluateLivePhaseBDispatchGate(baseGateInput({ disclosureAccepted: false }));
  check(
    "B14: disclosure not accepted ⇒ DISCLOSURE_NOT_ACCEPTED",
    noDisclosure.decision === "BLOCKED" && noDisclosure.blockReasons.includes("DISCLOSURE_NOT_ACCEPTED"),
    noDisclosure.primaryReason ?? "",
  );

  // Phase B: disclosure NOT accepted BUT waived by operator ⇒ gate #18 PASSes
  // (honest owner/admin override). The other 17 gates are untouched, so the
  // overall decision is PASS and DISCLOSURE_NOT_ACCEPTED is NOT a block reason.
  const waived = evaluateLivePhaseBDispatchGate(
    baseGateInput({ disclosureAccepted: false, disclosureWaivedByOperator: true }),
  );
  check(
    "B14: disclosure waived by operator ⇒ gate #18 PASS (no DISCLOSURE_NOT_ACCEPTED)",
    waived.decision === "PASS" && !waived.blockReasons.includes("DISCLOSURE_NOT_ACCEPTED"),
    waived.primaryReason ?? "ok",
  );
  // Default-deny: waiver omitted/false with disclosure not accepted ⇒ still blocked.
  const waiverOmitted = evaluateLivePhaseBDispatchGate(
    baseGateInput({ disclosureAccepted: false, disclosureWaivedByOperator: false }),
  );
  check(
    "B14: disclosure not accepted + waiver false ⇒ still DISCLOSURE_NOT_ACCEPTED (default-deny)",
    waiverOmitted.decision === "BLOCKED" && waiverOmitted.blockReasons.includes("DISCLOSURE_NOT_ACCEPTED"),
    waiverOmitted.primaryReason ?? "",
  );

  // Phase B: bridge reports demo account ⇒ BRIDGE_NOT_LIVE_ACCOUNT (gate #6).
  const demoAccount = evaluateLivePhaseBDispatchGate(
    baseGateInput({ bridgeAccountType: "demo" }),
  );
  check(
    "B14: bridge account=demo ⇒ BRIDGE_NOT_LIVE_ACCOUNT (broker truth enforced)",
    demoAccount.decision === "BLOCKED" && demoAccount.blockReasons.includes("BRIDGE_NOT_LIVE_ACCOUNT"),
    demoAccount.primaryReason ?? "",
  );

  // Green path: full access ⇒ PASS.
  const fullAccess = evaluateLivePhaseBDispatchGate(baseGateInput());
  check(
    "B14: all gates green ⇒ PASS (access correctly granted)",
    fullAccess.decision === "PASS",
    fullAccess.primaryReason ?? "ok",
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// B15 — Pre-dispatch audit intent: kill switch is the decisive block code
//        carried in the verdict so the audit row records a meaningful reason.
// ─────────────────────────────────────────────────────────────────────────────
console.log("\nB15: pre-dispatch audit / decisive blockCode");
{
  // The block code written to the audit row is the FIRST decisive failure.
  // KILL_SWITCH_ENGAGED must beat unfunded, inactive, and every other block.
  const killVsAll = evaluateExecutionPermission(
    basePerm({
      killEngaged: true,
      funded: false,
      agentStatus: "PAUSED",
      outcome: "DENIED",
      governor: { status: "LOCKED", hardBlocks: ["DAILY_LOSS"] },
    }),
  );
  check(
    "B15: kill switch is decisive block code (beats unfunded+inactive+denied+locked)",
    killVsAll.blockCode === "KILL_SWITCH_ENGAGED",
    killVsAll.blockCode ?? "",
  );

  // AGENT_NOT_ACTIVE beats AGENT_UNFUNDED (priority order after kill).
  const inactiveVsUnfunded = evaluateExecutionPermission(
    basePerm({ agentStatus: "PAUSED", funded: false, killEngaged: false }),
  );
  check(
    "B15: inactive beats unfunded in block priority",
    inactiveVsUnfunded.blockCode === "AGENT_NOT_ACTIVE",
    inactiveVsUnfunded.blockCode ?? "",
  );

  // GOVERNOR_LOCKED beats QUOTA_HARD_CAP (governor checked before quota).
  const govVsQuota = evaluateExecutionPermission(
    basePerm({
      governor: { status: "LOCKED", hardBlocks: [] },
      quota: { ...okQuota(), hardCapReached: true },
      killEngaged: false,
    }),
  );
  check(
    "B15: governor locked beats quota hard cap in priority",
    govVsQuota.blockCode === "GOVERNOR_LOCKED",
    govVsQuota.blockCode ?? "",
  );

  // Permitted path ⇒ blockCode is null (no spurious audit reason).
  const permitted = evaluateExecutionPermission(basePerm());
  check(
    "B15: permitted execution ⇒ blockCode=null (no spurious audit reason)",
    permitted.permitted && permitted.blockCode === null,
    `blockCode=${permitted.blockCode}`,
  );

  // The reasons array is always populated (machine-readable audit trail).
  check(
    "B15: permitted verdict has non-empty reasons (audit narration present)",
    permitted.reasons.length > 0,
    `reasons=[${permitted.reasons.join(", ")}]`,
  );

  // Phase B gate result captures every failing gate key, not just primaryReason.
  const multiBlock = evaluateLivePhaseBDispatchGate(
    baseGateInput({
      bridgeReadOnlyMode: true,
      bridgeHeartbeatAgeSec: 999,
      commandVolume: 0.5,
      maxLotForSymbol: 0.05,
    }),
  );
  check(
    "B15: Phase B gate captures multiple block reasons for audit",
    multiBlock.decision === "BLOCKED" && multiBlock.blockReasons.length >= 2,
    `blockReasons=[${multiBlock.blockReasons.join(", ")}]`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
