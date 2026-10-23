// AACI Core Intelligence Engine (Task #230) — PURE domain unit tests.
//
// Verifies the honesty + safety contracts of the AACI 2.0 domain engine:
//  1. HARD_GATE is binary: all-true → pass(value 1, no failures); any false →
//     fail(value 0) with clean machine codes + plain-English user messages.
//  2. resolveRecommendedAction only ever ADDS caution: position mismatch →
//     RECONCILE_SYSTEM; hard-gate fail escalates by reason; expired signal →
//     WAIT_FOR_CONFIRMATION; critical conflict → WATCH_ONLY; clean+high → ALLOW.
//  3. computeMasterScore stays within 0–100 and collapses to 0 when HARD_GATE=0.
//  4. detectConflictsAndCohesion flags genuine cross-system disagreement and
//     position mismatch; agreeing/unknown inputs are NOT conflicts (fail-open).
//  5. computeEdgeDecay = e^(-age/halfLife): fresh→~1/EARLY; far past half-lives
//     → EXPIRED/TOO_SLOW; negative/non-finite age treated as fresh.
//  6. Fail-open: an empty-ish snapshot never throws and yields bounded, neutral
//     scores rather than fabricated confidence.
//  7. No internal UPPER_SNAKE token leaks into ANY user-facing message string.
//
// Pure & deterministic (now/age passed in). No DB, no IO.
//
// Run: pnpm --filter @workspace/scripts run test:aaci

import {
  buildAaciHardGateFactors,
  buildScoreBreakdown,
  classifySpeedState,
  computeEdgeDecay,
  computeFreshness,
  computeMasterScore,
  computeSpeedValidity,
  detectConflictsAndCohesion,
  evaluateAaciHardGate,
  isSignalExpired,
  resolveRecommendedAction,
  aaciRecommendedActionLabel,
  AACI_RECOMMENDED_ACTIONS,
  type AaciHardGateFailure,
  type AaciLatencyRecord,
  type AaciSharedTruthSnapshot,
} from "@workspace/domain/aaci";

let failures = 0;
function check(name: string, cond: boolean) {
  if (cond) {
    console.log(`  PASS  ${name}`);
  } else {
    console.error(`  FAIL  ${name}`);
    failures++;
  }
}

// User-facing strings must never contain an internal UPPER_SNAKE token.
const TOKEN_RE = /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/;
function assertNoTokens(label: string, s: string) {
  check(`${label}: no internal token in "${s.slice(0, 60)}…"`, !TOKEN_RE.test(s));
}

// Minimal snapshot factory. Defaults are deliberately sparse so individual
// tests can layer in only the fields they exercise.
function makeSnapshot(
  over: Partial<AaciSharedTruthSnapshot> = {},
): AaciSharedTruthSnapshot {
  return {
    snapshotId: "snap-test",
    timestamp: new Date(0).toISOString(),
    user: { userId: "u-1", role: "user" },
    symbolContext: {},
    account: {},
    bridge: { status: "connected" },
    positions: { openCount: 0 },
    ...over,
  };
}

// ── 1. HARD_GATE binary behaviour ───────────────────────────────────────────
{
  const allTrue = buildAaciHardGateFactors({
    securityHandshakePass: true,
    permission: true,
    funded: true,
    active: true,
    autonomyAllowed: true,
    riskPass: true,
    lossLimitPass: true,
    bridgeReady: true,
    feedFresh: true,
    symbolTradable: true,
    allocationAvailable: true,
    executionRouteReady: true,
    auditReady: true,
  });
  const pass = evaluateAaciHardGate(allTrue);
  check("hardGate: all-true passes", pass.pass === true);
  check("hardGate: all-true value=1", pass.value === 1);
  check("hardGate: all-true has no failures", pass.failures.length === 0);

  // buildAaciHardGateFactors fail-opens missing factors to false.
  const empty = buildAaciHardGateFactors({});
  const blocked = evaluateAaciHardGate(empty);
  check("hardGate: empty/unknown does NOT silently pass", blocked.pass === false);
  check("hardGate: empty value=0", blocked.value === 0);
  check("hardGate: empty surfaces every failure", blocked.failures.length === 13);

  // Each failure has a clean code + plain-English (token-free) user message.
  blocked.failures.forEach((f: AaciHardGateFailure) => {
    check(`hardGate failure has code`, typeof f.code === "string" && f.code.length > 0);
    assertNoTokens("hardGate userMessage", f.userMessage);
  });

  // A single missing factor blocks and reports exactly that factor.
  const oneMissing = buildAaciHardGateFactors({
    securityHandshakePass: true,
    permission: true,
    funded: true,
    active: true,
    autonomyAllowed: true,
    riskPass: true,
    lossLimitPass: true,
    bridgeReady: true,
    feedFresh: false, // stale feed
    symbolTradable: true,
    allocationAvailable: true,
    executionRouteReady: true,
    auditReady: true,
  });
  const feedBlocked = evaluateAaciHardGate(oneMissing);
  check("hardGate: single false blocks", feedBlocked.pass === false);
  check(
    "hardGate: single false reports FEED_STALE only",
    feedBlocked.failures.length === 1 && feedBlocked.failures[0]!.code === "FEED_STALE",
  );
}

// ── 2. Recommended action only ADDS caution ─────────────────────────────────
{
  const noConflict = detectConflictsAndCohesion(makeSnapshot());

  // Position mismatch dominates everything → reconcile first.
  const mismatch = detectConflictsAndCohesion(
    makeSnapshot({ positions: { openCount: 1, mt5OpenCount: 1, appOpenCount: 0 } }),
  );
  check("conflicts: count mismatch sets positionMismatch", mismatch.positionMismatch === true);
  check(
    "action: position mismatch → RECONCILE_SYSTEM (even with passing gate)",
    resolveRecommendedAction({
      hardGatePass: true,
      hardGateFailureCodes: [],
      finalScore: 95,
      cohesion: mismatch,
      speedState: "EARLY",
      signalExpired: false,
    }) === "RECONCILE_SYSTEM",
  );

  // Hard-gate fail escalates by reason.
  check(
    "action: FEED_STALE gate fail → WATCH_ONLY",
    resolveRecommendedAction({
      hardGatePass: false,
      hardGateFailureCodes: ["FEED_STALE"],
      finalScore: 90,
      cohesion: noConflict,
      speedState: "EARLY",
      signalExpired: false,
    }) === "WATCH_ONLY",
  );
  check(
    "action: AUDIT_UNAVAILABLE gate fail → ALERT_ADMIN",
    resolveRecommendedAction({
      hardGatePass: false,
      hardGateFailureCodes: ["AUDIT_UNAVAILABLE"],
      finalScore: 90,
      cohesion: noConflict,
      speedState: "EARLY",
      signalExpired: false,
    }) === "ALERT_ADMIN",
  );
  check(
    "action: generic gate fail → BLOCK",
    resolveRecommendedAction({
      hardGatePass: false,
      hardGateFailureCodes: ["PERMISSION_MISSING"],
      finalScore: 90,
      cohesion: noConflict,
      speedState: "EARLY",
      signalExpired: false,
    }) === "BLOCK",
  );

  // Expired signal → wait for fresh confirmation even on a passing gate.
  check(
    "action: expired signal → WAIT_FOR_CONFIRMATION",
    resolveRecommendedAction({
      hardGatePass: true,
      hardGateFailureCodes: [],
      finalScore: 90,
      cohesion: noConflict,
      speedState: "EXPIRED",
      signalExpired: true,
    }) === "WAIT_FOR_CONFIRMATION",
  );

  // Clean, fresh, high score → ALLOW; banded down by score otherwise.
  check(
    "action: clean + high score → ALLOW",
    resolveRecommendedAction({
      hardGatePass: true,
      hardGateFailureCodes: [],
      finalScore: 85,
      cohesion: noConflict,
      speedState: "EARLY",
      signalExpired: false,
    }) === "ALLOW",
  );
  check(
    "action: clean + low score → WATCH_ONLY",
    resolveRecommendedAction({
      hardGatePass: true,
      hardGateFailureCodes: [],
      finalScore: 40,
      cohesion: noConflict,
      speedState: "EARLY",
      signalExpired: false,
    }) === "WATCH_ONLY",
  );
}

// ── 3. Master score bounds + hard-gate collapse ─────────────────────────────
{
  const now = 10_000;
  const snapshot = makeSnapshot({
    timestamp: new Date(now).toISOString(),
    scanner: { bias: "buy", score: 80, lastUpdated: new Date(now).toISOString() },
    smartChart: {
      bias: "bullish",
      structureScore: 75,
      lastUpdated: new Date(now).toISOString(),
      lastCandleTime: new Date(now).toISOString(),
    },
    bridge: { status: "connected", heartbeatAgeMs: 500, executionRouteReady: true },
    account: { mode: "demo", lastUpdated: new Date(now).toISOString() },
    positions: { openCount: 0, mt5OpenCount: 0, appOpenCount: 0, lastUpdated: new Date(now).toISOString() },
    risk: { hardPass: true, marginHealth: 90, dailyLossHit: false, lastUpdated: new Date(now).toISOString() },
  });
  const freshness = computeFreshness(snapshot, now);
  const cohesion = detectConflictsAndCohesion(snapshot);
  const latency: AaciLatencyRecord[] = [
    { benchmark: "marketFeedSpeed", latencyMs: 200, budgetMs: 1_000, recordedAt: new Date(now).toISOString() },
  ];
  const edge = computeEdgeDecay(0, "m15_setup");
  const breakdown = buildScoreBreakdown({
    snapshot,
    freshness,
    cohesion,
    latencyRecords: latency,
    speedValidity: computeSpeedValidity(edge.edgeDecay, 1),
  });

  const passScore = computeMasterScore(breakdown, 1);
  check("score: master score within 0–100", passScore >= 0 && passScore <= 100);
  check("score: healthy snapshot yields positive score", passScore > 0);

  const gateZero = computeMasterScore(breakdown, 0);
  check("score: HARD_GATE=0 collapses final score to 0", gateZero === 0);

  // All sub-scores are bounded 0–100.
  const subs = [
    breakdown.dataFreshnessScore,
    breakdown.graphCohesionScore,
    breakdown.riskAlignmentScore,
    breakdown.marketTruthScore,
    breakdown.speedLatencyScore,
    breakdown.executionReadinessScore,
    breakdown.dataQualityScore,
    breakdown.uiConsistencyScore,
    breakdown.explainabilityScore,
  ];
  check("score: all sub-scores within 0–100", subs.every((s) => s >= 0 && s <= 100));
  // Validity factors are 0–1 multipliers.
  const factors = [
    breakdown.speedValidity,
    breakdown.uncertaintyConfidence,
    breakdown.dataLineageTrust,
    breakdown.selfLearningIntegrity,
    breakdown.penalty,
  ];
  check("score: validity factors within 0–1", factors.every((f) => f >= 0 && f <= 1));
}

// ── 4. Conflict detection vs fail-open ──────────────────────────────────────
{
  // Genuine opposite committed biases conflict.
  const opposed = detectConflictsAndCohesion(
    makeSnapshot({
      scanner: { bias: "buy" },
      smartChart: { bias: "bearish" },
    }),
  );
  check(
    "conflicts: opposed scanner/chart bias detected",
    opposed.conflicts.some((c) => c.code === "SCANNER_CHART_DISAGREE"),
  );
  check("conflicts: a conflict lowers G below 100", opposed.score < 100);

  // Agreeing biases are NOT a conflict.
  const agree = detectConflictsAndCohesion(
    makeSnapshot({ scanner: { bias: "buy" }, smartChart: { bias: "bullish" } }),
  );
  check("conflicts: agreeing biases produce no disagreement", agree.conflicts.length === 0);
  check("conflicts: full agreement keeps G at 100", agree.score === 100);

  // Unknown / neutral inputs are fail-open (no fabricated conflict).
  const unknown = detectConflictsAndCohesion(makeSnapshot({ scanner: { bias: "neutral" } }));
  check("conflicts: neutral/unknown is fail-open (no conflict)", unknown.conflicts.length === 0);

  // Conflict detail strings are admin-facing diagnostics; G is bounded 0–100.
  check("conflicts: G stays within 0–100", opposed.score >= 0 && opposed.score <= 100);
}

// ── 5. Edge decay / speed validity ──────────────────────────────────────────
{
  const fresh = computeEdgeDecay(0, "m15_setup");
  check("edgeDecay: fresh signal ≈ 1", fresh.edgeDecay > 0.99 && fresh.edgeDecay <= 1);
  check("edgeDecay: fresh signal speedState EARLY", fresh.speedState === "EARLY");

  // The "half-life" is the decay time-constant τ: at age=τ, e^(-1) ≈ 0.368.
  const oneTau = computeEdgeDecay(12 * 60_000, "m15_setup");
  check("edgeDecay: one time-constant ≈ e^-1 (0.368)", oneTau.edgeDecay > 0.34 && oneTau.edgeDecay < 0.40);

  const wayPast = computeEdgeDecay(12 * 60_000 * 6, "m15_setup");
  check("edgeDecay: 6 half-lives → ~0", wayPast.edgeDecay < 0.05);
  check("edgeDecay: 6 half-lives → TOO_SLOW_TO_EXECUTE", wayPast.speedState === "TOO_SLOW_TO_EXECUTE");
  check("edgeDecay: 6 half-lives is expired", isSignalExpired(wayPast.speedState) === true);

  // Negative / non-finite age treated as fresh (never fabricates decay).
  const negative = computeEdgeDecay(-5_000, "m5_pullback");
  check("edgeDecay: negative age treated as fresh", negative.edgeDecay > 0.99);
  const nan = computeEdgeDecay(Number.NaN, "m5_pullback");
  check("edgeDecay: NaN age treated as fresh", nan.edgeDecay > 0.99);

  // Speed validity is the clamped product of edge decay × exec-speed confidence.
  check("speedValidity: bounded 0–1", computeSpeedValidity(0.5, 0.5) === 0.25);
  check("speedValidity: clamps over-1 inputs", computeSpeedValidity(2, 2) === 1);

  // classifySpeedState boundary sanity.
  check("speedState: 0 half-lives → EARLY", classifySpeedState(0, 1_000) === "EARLY");
  check("speedState: zero half-life → EXPIRED", classifySpeedState(1, 0) === "EXPIRED");
}

// ── 6. Fail-open on an empty-ish snapshot (never throws / never fabricates) ──
{
  const now = 0;
  const bare = makeSnapshot({
    bridge: { status: "unknown" },
    unavailableSystems: ["Scanner", "SmartChart", "Ruby", "MarketTimingBrain", "EconomicCalendar", "RiskGovernor"],
  });
  let threw = false;
  let finalScore = -1;
  try {
    const freshness = computeFreshness(bare, now);
    const cohesion = detectConflictsAndCohesion(bare);
    const breakdown = buildScoreBreakdown({
      snapshot: bare,
      freshness,
      cohesion,
      latencyRecords: [],
      speedValidity: 1,
    });
    finalScore = computeMasterScore(breakdown, 1);
    check("failopen: empty snapshot has no fabricated conflicts", cohesion.conflicts.length === 0);
    check("failopen: freshness score within 0–100", freshness.score >= 0 && freshness.score <= 100);
  } catch {
    threw = true;
  }
  check("failopen: empty snapshot never throws", threw === false);
  check("failopen: empty snapshot score within 0–100", finalScore >= 0 && finalScore <= 100);
}

// ── Non-admin advisory read degrades to calm caution, not PERMISSION/ADMIN ──
// Regression guard: a regular authenticated user (no per-user broker/bridge
// context wired) must NOT hard-fail with PERMISSION_MISSING, and an unknown
// (not-yet-wired) bridge must NOT escalate to ALERT_ADMIN — it should surface
// the calmer WATCH_ONLY. This mirrors composeHardGateFactors' defaults:
// permission true for an authenticated advisory caller, executionRouteReady
// true when the bridge is merely unknown, bridgeReady false (not connected).
{
  const factors = buildAaciHardGateFactors({
    securityHandshakePass: true, // advisory caller; handshake only gates sensitive flows
    permission: true, // authenticated advisory caller; real gate is downstream
    funded: true,
    active: true,
    autonomyAllowed: true,
    riskPass: true,
    lossLimitPass: true,
    bridgeReady: false, // bridge not connected (status "unknown")
    feedFresh: true,
    symbolTradable: true,
    allocationAvailable: true,
    executionRouteReady: true, // unknown bridge ≠ route fault → no ALERT_ADMIN
    auditReady: true,
  });
  const gate = evaluateAaciHardGate(factors);
  const codes = gate.failures.map((f) => f.code);
  check("nonadmin: no PERMISSION_MISSING for authenticated user", !codes.includes("PERMISSION_MISSING"));
  check("nonadmin: unknown bridge does not trip EXECUTION_ROUTE_UNAVAILABLE", !codes.includes("EXECUTION_ROUTE_UNAVAILABLE"));
  check("nonadmin: unknown bridge trips BRIDGE_NOT_READY", codes.includes("BRIDGE_NOT_READY"));
  const action = resolveRecommendedAction({
    hardGatePass: gate.pass,
    hardGateFailureCodes: codes,
    finalScore: 0,
    cohesion: detectConflictsAndCohesion(makeSnapshot()),
    speedState: "ON_TIME",
    signalExpired: false,
  });
  check("nonadmin: unwired bridge yields WATCH_ONLY (not ALERT_ADMIN/BLOCK)", action === "WATCH_ONLY");
}

// ── Recommended-action labels (user-facing copy, token-free) ────────────────
// Every action must map to a non-empty, plain-English label with no internal
// UPPER_SNAKE token — this is the field surfaced to regular users.
{
  for (const action of AACI_RECOMMENDED_ACTIONS) {
    const label = aaciRecommendedActionLabel(action);
    check(`label: ${action} → non-empty`, label.length > 0);
    assertNoTokens(`label[${action}]`, label);
    check(`label: ${action} differs from raw enum`, label !== action);
  }
}

if (failures > 0) {
  console.error(`\naaci-engine: ${failures} FAILED`);
  process.exit(1);
} else {
  console.log("\naaci-engine: all checks passed");
}

export {};
