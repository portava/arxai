// Task #652 — Strategy Intelligence Upgrade: OFFLINE pure fixture suite.
//
// Locks the HARD BOUNDARY for the shared Market Intelligence Layer: the six
// "Truth" modules (Pivot / Direction / Entry / OrderFlow / Timing / Confluence)
// plus the composing MarketIntelligenceSnapshot + StrategyVerdict are CHILD
// INPUTS / DISPLAY-ONLY reads. They may raise/lower display quality, confidence
// (within caps), wording and conditional-vs-confirmed labels — but they can NEVER
// independently produce an execution permission, override an unconfirmed feed,
// override candle-sufficiency / RR / timing gates, or touch live execution.
//
// No DB, no live providers — every verdict is built deterministically from
// fixtures + the caller's already-decided display facts, so the suite runs in the
// offline `ci` lane. Wired as
// `pnpm --filter @workspace/api-server run test:market-intelligence`.
//
// Run: node --import tsx --test src/lib/data/chart/__qa__/marketIntelligence.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  resolvePivotTruth,
  computeClassicPivots,
  EMPTY_PIVOT_REACTION,
  type PivotTruthInput,
  type PivotDisplayContext,
  resolveDirectionTruth,
  type DirectionTruthInput,
  type DirectionDisplayContext,
  resolveEntryTruth,
  type EntryTruthInput,
  type EntryDisplayContext,
  resolveOrderFlowTruth,
  type OrderFlowTruthInput,
  type OrderFlowDisplayContext,
  resolveTimingTruth,
  type TimingTruthInput,
  type TimingDisplayContext,
  resolveConfluence,
  type ConfluenceTruthInput,
  type ConfluenceDisplayContext,
  composeMarketIntelligenceSnapshot,
  deriveStrategyVerdict,
  type ComposeSnapshotInput,
  type IntelligenceFeedTruth,
  type IntelligenceRiskContext,
  type IntelligenceMode,
  type MarketIntelligenceSnapshot,
} from "@workspace/domain/market";

// ── Shared display contexts (the most permissive caller state — live-confirmed) ─
const liveDisplay = {
  feedConfirmed: true,
  feedStale: false,
  sufficiencyAllowsSetup: true,
  chartReadConfidenceLow: false,
};

function pivotDisp(over: Partial<PivotDisplayContext> = {}): PivotDisplayContext {
  return { ...liveDisplay, ...over };
}
function dirDisp(over: Partial<DirectionDisplayContext> = {}): DirectionDisplayContext {
  return { ...liveDisplay, ...over };
}
function entryDisp(over: Partial<EntryDisplayContext> = {}): EntryDisplayContext {
  return { ...liveDisplay, timingApproved: true, ...over };
}
function ofDisp(over: Partial<OrderFlowDisplayContext> = {}): OrderFlowDisplayContext {
  return { ...liveDisplay, ...over };
}
function timingDisp(over: Partial<TimingDisplayContext> = {}): TimingDisplayContext {
  return { ...liveDisplay, ...over };
}
function confDisp(over: Partial<ConfluenceDisplayContext> = {}): ConfluenceDisplayContext {
  return { ...liveDisplay, ...over };
}

// Classic pivots from {high:110, low:90, close:100}: P=100, R1=110, R2=120,
// R3=130, S1=90, S2=80, S3=70. Used across the pivot + composition fixtures.
const PRIOR = { high: 110, low: 90, close: 100 };

// ── 1. Classic pivot math is the textbook floor-trader formula ───────────────
test("1: classic pivot math matches the floor-trader formula", () => {
  const lv = computeClassicPivots(PRIOR);
  assert.equal(lv.pivot, 100);
  assert.equal(lv.r1, 110);
  assert.equal(lv.s1, 90);
  assert.equal(lv.r2, 120);
  assert.equal(lv.s2, 80);
  assert.equal(lv.r3, 130);
  assert.equal(lv.s3, 70);
});

// ── 2. Pivot bias is a LEAN, never a permission (no execution field) ─────────
test("2: above-pivot is a bullish LEAN with no execution field", () => {
  const input: PivotTruthInput = {
    pivotSourceTimeframe: "daily",
    prior: PRIOR,
    currentPrice: 105,
    atr: 1,
    reaction: EMPTY_PIVOT_REACTION,
    exhaustionExtended: false,
  };
  const v = resolvePivotTruth(input, pivotDisp());
  assert.equal(v.pivotBias, "bullish");
  // downgrade-only edge nudge stays bounded
  assert.ok(v.scannerTruthImpact.edgeAdjustment <= 10);
  assert.ok(v.scannerTruthImpact.edgeAdjustment >= -25);
  assert.ok(!("allowExecution" in v));
  assert.ok(!("readyNow" in v));
});

// ── 3. Pivot rejection vs breakout is confirmation-gated ─────────────────────
test("3: a wick (no close) is not a breakout; a real close is 'breaking'", () => {
  const base: PivotTruthInput = {
    pivotSourceTimeframe: "daily",
    prior: PRIOR,
    currentPrice: 110.2,
    atr: 1,
    reaction: { ...EMPTY_PIVOT_REACTION },
    exhaustionExtended: false,
  };
  const wick = resolvePivotTruth(base, pivotDisp());
  assert.notEqual(wick.reactionStatus, "breaking");
  assert.equal(wick.scannerTruthImpact.supportive, false);

  const broke = resolvePivotTruth(
    { ...base, reaction: { ...EMPTY_PIVOT_REACTION, closedBeyondLevel: true, momentumConfirmed: true, followThrough: true } },
    pivotDisp(),
  );
  assert.equal(broke.reactionStatus, "breaking");
  assert.equal(broke.scannerTruthImpact.supportive, true);
});

// ── 4. A confirmed breakout cannot nudge up on an unconfirmed feed ───────────
test("4: pivot breakout is context-only (no nudge) when the feed is not confirmed", () => {
  const v = resolvePivotTruth(
    {
      pivotSourceTimeframe: "daily",
      prior: PRIOR,
      currentPrice: 110.2,
      atr: 1,
      reaction: { ...EMPTY_PIVOT_REACTION, closedBeyondLevel: true, momentumConfirmed: true, followThrough: true },
      exhaustionExtended: false,
    },
    pivotDisp({ feedConfirmed: false }),
  );
  assert.equal(v.scannerTruthImpact.supportive, false);
  assert.equal(v.scannerTruthImpact.contextOnly, true);
});

// ── 5. Honest empty when pivots cannot be computed ───────────────────────────
test("5: pivot is honest-empty (neutral, none) when no levels/price", () => {
  const v = resolvePivotTruth(
    {
      pivotSourceTimeframe: "daily",
      prior: null,
      precomputedLevels: null,
      currentPrice: null,
      atr: null,
      reaction: EMPTY_PIVOT_REACTION,
      exhaustionExtended: false,
    },
    pivotDisp(),
  );
  assert.equal(v.pivotBias, "neutral");
  assert.equal(v.quality, "none");
  assert.equal(v.confidence, 0);
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 6. Direction conflict (HTF vs LTF) caps confidence and never goes directional ─
test("6: HTF/LTF conflict sets conflict, caps confidence, and is not buy/sell", () => {
  const input: DirectionTruthInput = {
    htfDirection: "bullish",
    ltfDirection: "bearish",
    trendlineBias: "neutral",
    pivotBias: "neutral",
    patternBias: "neutral",
    patternForming: false,
    orderFlowBias: "neutral",
    midRange: false,
    atMajorLevel: false,
    newsRisk: false,
    volatilityExtreme: false,
    invalidationLevel: null,
  };
  const v = resolveDirectionTruth(input, dirDisp());
  assert.equal(v.conflict, true);
  assert.ok(v.directionConfidence <= 45);
  assert.notEqual(v.scalpDirection, "buy");
  assert.notEqual(v.scalpDirection, "sell");
});

// ── 7. Aligned HTF/LTF yields a directional scalp lean ───────────────────────
test("7: aligned timeframes + support yield a directional buy lean (still display)", () => {
  const v = resolveDirectionTruth(
    {
      htfDirection: "bullish",
      ltfDirection: "bullish",
      trendlineBias: "bullish",
      pivotBias: "bullish",
      patternBias: "bullish",
      patternForming: false,
      orderFlowBias: "bullish",
      midRange: false,
      atMajorLevel: false,
      newsRisk: false,
      volatilityExtreme: false,
      invalidationLevel: 108,
    },
    dirDisp(),
  );
  assert.equal(v.scalpDirection, "buy");
  assert.equal(v.conflict, false);
  assert.ok(!("allowExecution" in v));
});

// ── 8. Entry: a wick-only poke is NOT a confirmed candidate ──────────────────
test("8: wick-only beyond the trigger stays waiting_confirmation, never confirmed", () => {
  const v = resolveEntryTruth(
    {
      entryType: "pivot_breakout",
      direction: "buy",
      proposedEntryPrice: 110.2,
      entryZone: null,
      confirmationTrigger: 110,
      invalidationTrigger: 108,
      stopLossLevel: 108,
      targetLevels: [116],
      closedBeyondTrigger: false,
      wickOnlyBeyondTrigger: true,
      levelFailed: false,
      triggerDistanceAtr: 0.2,
      alreadyMoved: false,
      minimumRR: 1.5,
    },
    entryDisp(),
  );
  assert.equal(v.entryStatus, "waiting_confirmation");
  assert.equal(v.scannerTruthImpact.labelHint, "wick_only_unconfirmed");
  assert.notEqual(v.entryStatus, "confirmed_candidate");
});

// ── 9. Entry: a real close beyond the trigger is a confirmed candidate ───────
test("9: a real close beyond the trigger is a confirmed candidate (display only)", () => {
  const v = resolveEntryTruth(
    {
      entryType: "pivot_breakout",
      direction: "buy",
      proposedEntryPrice: 110.2,
      entryZone: null,
      confirmationTrigger: 110,
      invalidationTrigger: 108,
      stopLossLevel: 108,
      targetLevels: [116],
      closedBeyondTrigger: true,
      wickOnlyBeyondTrigger: false,
      levelFailed: false,
      triggerDistanceAtr: 0.2,
      alreadyMoved: false,
      minimumRR: 1.5,
    },
    entryDisp(),
  );
  assert.equal(v.entryStatus, "confirmed_candidate");
  assert.ok((v.currentRR ?? 0) >= 1.5);
  assert.ok(!("allowExecution" in v));
});

// ── 10. Entry: price ran too far from the trigger → too_late chase ───────────
test("10: a trigger distance beyond the chase threshold is too_late", () => {
  const v = resolveEntryTruth(
    {
      entryType: "breakout",
      direction: "buy",
      proposedEntryPrice: 113,
      entryZone: null,
      confirmationTrigger: 110,
      invalidationTrigger: 108,
      stopLossLevel: 108,
      targetLevels: [116],
      closedBeyondTrigger: true,
      wickOnlyBeyondTrigger: false,
      levelFailed: false,
      triggerDistanceAtr: 2,
      alreadyMoved: false,
      minimumRR: 1.5,
    },
    entryDisp(),
  );
  assert.equal(v.entryStatus, "too_late");
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 11. Order flow tier fallback: proxy when no true data (honestly labeled) ──
test("11: order flow falls back to proxy and is honestly labeled (capped)", () => {
  const v = resolveOrderFlowTruth(
    {
      setupDirection: "buy",
      trueData: null,
      proxyData: {
        bodyPressure: 1,
        volumeSpike: true,
        momentumImpulse: 1,
        rejectionCandle: false,
        liquiditySweep: { detected: false, side: null, reclaimed: false },
      },
      spreadCondition: "normal",
      volumeCondition: "high",
      atKeyLevel: true,
    },
    ofDisp(),
  );
  assert.equal(v.dataTier, "proxy_order_flow");
  assert.equal(v.isProxy, true);
  assert.ok(v.scannerTruthImpact.confidenceCeiling <= 55);
  assert.equal(v.scannerTruthImpact.supportive, false);
});

// ── 12. Order flow unavailable → honest unknown, never fabricated pressure ───
test("12: no usable order-flow data reads as unavailable/unknown, not fabricated", () => {
  const v = resolveOrderFlowTruth(
    {
      setupDirection: "buy",
      trueData: null,
      proxyData: null,
      spreadCondition: "unknown",
      volumeCondition: "unknown",
      atKeyLevel: false,
    },
    ofDisp(),
  );
  assert.equal(v.dataTier, "unavailable");
  assert.equal(v.supportsDirection, "unknown");
  assert.equal(v.pressure, "unknown");
  assert.equal(v.isProxy, false);
});

// ── 13. Order flow contradiction caps confidence ─────────────────────────────
test("13: true order flow contradicting the setup caps confidence", () => {
  const v = resolveOrderFlowTruth(
    {
      setupDirection: "buy",
      trueData: {
        bidAskImbalance: -1,
        delta: -100,
        cumulativeDelta: -200,
        aggressiveBuyRatio: 0.1,
        absorptionDetected: false,
        icebergDetected: false,
      },
      proxyData: null,
      spreadCondition: "normal",
      volumeCondition: "high",
      atKeyLevel: false,
    },
    ofDisp(),
  );
  assert.equal(v.supportsDirection, "no");
  assert.ok(v.scannerTruthImpact.confidenceCeiling <= 30);
});

// ── 14. Timing: a still-forming candle waits for the close ───────────────────
test("14: a forming candle is wait_for_close and not approved", () => {
  const v = resolveTimingTruth(
    {
      session: "london",
      candleState: "forming",
      volatilityState: "normal",
      marketPhase: "trend",
      signalAge: 1,
      maxSignalAge: 5,
      distanceFromTriggerAtr: 0.2,
      newsImminent: false,
      spreadWide: false,
      lowLiquidity: false,
      cooldownActive: false,
      intrabarScalpAllowed: false,
      retestRequired: false,
    },
    timingDisp(),
  );
  assert.equal(v.timingStatus, "wait_for_close");
  assert.equal(v.timingApproved, false);
});

// ── 15. Timing: an aged-out signal is late ───────────────────────────────────
test("15: a signal older than maxSignalAge is late", () => {
  const v = resolveTimingTruth(
    {
      session: "london",
      candleState: "closed_confirmed",
      volatilityState: "normal",
      marketPhase: "trend",
      signalAge: 10,
      maxSignalAge: 5,
      distanceFromTriggerAtr: 0.2,
      newsImminent: false,
      spreadWide: false,
      lowLiquidity: false,
      cooldownActive: false,
      intrabarScalpAllowed: false,
      retestRequired: false,
    },
    timingDisp(),
  );
  assert.equal(v.timingStatus, "late");
  assert.equal(v.timingApproved, false);
});

// ── 16. Timing: news / spread / liquidity blocks take precedence ─────────────
test("16: news/spread/low-liquidity block timing regardless of a clean candle", () => {
  const base: TimingTruthInput = {
    session: "london",
    candleState: "closed_confirmed",
    volatilityState: "normal",
    marketPhase: "trend",
    signalAge: 1,
    maxSignalAge: 5,
    distanceFromTriggerAtr: 0.2,
    newsImminent: false,
    spreadWide: false,
    lowLiquidity: false,
    cooldownActive: false,
    intrabarScalpAllowed: false,
    retestRequired: false,
  };
  assert.equal(resolveTimingTruth({ ...base, newsImminent: true }, timingDisp()).timingStatus, "news_blocked");
  assert.equal(resolveTimingTruth({ ...base, spreadWide: true }, timingDisp()).timingStatus, "spread_blocked");
  assert.equal(resolveTimingTruth({ ...base, lowLiquidity: true }, timingDisp()).timingStatus, "low_liquidity");
});

// ── 17. Confluence cannot bypass feed truth ──────────────────────────────────
test("17: fully-aligned factors stay context-only when the feed is not confirmed", () => {
  const input: ConfluenceTruthInput = {
    factors: {
      direction: "aligned",
      pivot: "aligned",
      support_resistance: "aligned",
      trendline: "aligned",
      pattern: "aligned",
      order_flow: "aligned",
      timing: "aligned",
      risk_reward: "aligned",
    },
    hardCaps: {
      rrAcceptable: true,
      directionConflict: false,
      orderFlowContradicts: false,
      timingLateOrExhausted: false,
      timingBlocked: false,
    },
    reliability: { backtestWinRate: null, forwardWinRate: null, backtestSamples: null, forwardSamples: null },
  };
  const v = resolveConfluence(input, confDisp({ feedConfirmed: false }));
  assert.notEqual(v.finalAction, "ready_candidate");
  assert.ok(v.score <= 35);
  assert.equal(v.scannerTruthImpact.labelHint, "context_only");
});

// ── 18. Reliability lifts CONFIDENCE only — never the score→action path ───────
test("18: backtest/forward reliability raises confidence but never creates ready_candidate", () => {
  const factors = {
    direction: "aligned",
    pivot: "aligned",
    support_resistance: "aligned",
    trendline: "neutral",
    pattern: "neutral",
    order_flow: "aligned",
    timing: "aligned",
    risk_reward: "neutral",
  } as const;
  const hardCaps = {
    rrAcceptable: true,
    directionConflict: false,
    orderFlowContradicts: false,
    timingLateOrExhausted: false,
    timingBlocked: false,
  };
  const noRel = resolveConfluence(
    { factors: { ...factors }, hardCaps, reliability: { backtestWinRate: null, forwardWinRate: null, backtestSamples: null, forwardSamples: null } },
    confDisp(),
  );
  const hiRel = resolveConfluence(
    { factors: { ...factors }, hardCaps, reliability: { backtestWinRate: 0.95, forwardWinRate: 0.95, backtestSamples: 200, forwardSamples: 100 } },
    confDisp(),
  );
  // Same structure score + same action; reliability only moved confidence.
  assert.equal(noRel.score, hiRel.score);
  assert.equal(noRel.finalAction, hiRel.finalAction);
  assert.notEqual(hiRel.finalAction, "ready_candidate");
  assert.ok(hiRel.confidence > noRel.confidence);
});

// ── Composition fixtures: build a fully-aligned bullish live snapshot ─────────
function feed(over: Partial<IntelligenceFeedTruth> = {}): IntelligenceFeedTruth {
  return {
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    candleCount: 300,
    minimumRequiredCandles: 60,
    ...over,
  };
}

function risk(over: Partial<IntelligenceRiskContext> = {}): IntelligenceRiskContext {
  return { rrAcceptable: true, currentRR: 2.64, minimumRR: 1.5, targetRoom: "enough_room", ...over };
}

function alignedBullishInput(mode: IntelligenceMode): ComposeSnapshotInput {
  const direction = resolveDirectionTruth(
    {
      htfDirection: "bullish",
      ltfDirection: "bullish",
      trendlineBias: "bullish",
      pivotBias: "bullish",
      patternBias: "bullish",
      patternForming: false,
      orderFlowBias: "bullish",
      midRange: false,
      atMajorLevel: false,
      newsRisk: false,
      volatilityExtreme: false,
      invalidationLevel: 108,
    },
    dirDisp(),
  );
  const pivot = resolvePivotTruth(
    {
      pivotSourceTimeframe: "daily",
      prior: PRIOR,
      currentPrice: 110.2,
      atr: 1,
      reaction: { ...EMPTY_PIVOT_REACTION, closedBeyondLevel: true, momentumConfirmed: true, followThrough: true },
      exhaustionExtended: false,
    },
    pivotDisp(),
  );
  const entry = resolveEntryTruth(
    {
      entryType: "pivot_breakout",
      direction: "buy",
      proposedEntryPrice: 110.2,
      entryZone: null,
      confirmationTrigger: 110,
      invalidationTrigger: 108,
      stopLossLevel: 108,
      targetLevels: [116],
      closedBeyondTrigger: true,
      wickOnlyBeyondTrigger: false,
      levelFailed: false,
      triggerDistanceAtr: 0.2,
      alreadyMoved: false,
      minimumRR: 1.5,
    },
    entryDisp(),
  );
  const orderFlow = resolveOrderFlowTruth(
    {
      setupDirection: "buy",
      trueData: {
        bidAskImbalance: 1,
        delta: 100,
        cumulativeDelta: 200,
        aggressiveBuyRatio: 0.8,
        absorptionDetected: false,
        icebergDetected: false,
      },
      proxyData: null,
      spreadCondition: "normal",
      volumeCondition: "high",
      atKeyLevel: true,
    },
    ofDisp(),
  );
  const timing = resolveTimingTruth(
    {
      session: "london",
      candleState: "closed_confirmed",
      volatilityState: "normal",
      marketPhase: "trend",
      signalAge: 1,
      maxSignalAge: 5,
      distanceFromTriggerAtr: 0.2,
      newsImminent: false,
      spreadWide: false,
      lowLiquidity: false,
      cooldownActive: false,
      intrabarScalpAllowed: false,
      retestRequired: false,
    },
    timingDisp(),
  );
  return {
    symbol: "EURUSD",
    timeframe: "M15",
    asOf: "2026-06-20T12:00:00.000Z",
    mode,
    feed: feed(),
    direction,
    pivot,
    entry,
    orderFlow,
    timing,
    pattern: null,
    trendline: null,
    risk: risk(),
    reliability: { backtestWinRate: null, forwardWinRate: null, backtestSamples: null, forwardSamples: null },
  };
}

// ── 19. A fully-aligned live read CAN reach ready_candidate (still display) ───
test("19: a fully-aligned live read composes to a ready_candidate verdict (display only)", () => {
  const snap = composeMarketIntelligenceSnapshot(alignedBullishInput("live_read"));
  assert.equal(snap.finalBias, "bullish");
  assert.equal(snap.confluence.finalAction, "ready_candidate");
  const verdict = deriveStrategyVerdict(snap);
  assert.equal(verdict.readiness, "ready_candidate");
});

// ── 20. Backtest/forward modes can NEVER reach ready_candidate ───────────────
test("20: identical inputs in backtest/forward mode cap readiness at conditional", () => {
  for (const mode of ["backtest", "forward_test"] as const) {
    const snap = composeMarketIntelligenceSnapshot(alignedBullishInput(mode));
    const verdict = deriveStrategyVerdict(snap);
    assert.notEqual(verdict.readiness, "ready_candidate");
    assert.equal(verdict.readiness, "conditional");
  }
});

// ── 21. The snapshot + verdict carry NO execution-permission field anywhere ──
test("21: composed snapshot/verdict expose no execution-permission field (structural)", () => {
  const snap = composeMarketIntelligenceSnapshot(alignedBullishInput("live_read"));
  const verdict = deriveStrategyVerdict(snap);

  const FORBIDDEN_EXACT = new Set([
    "allowexecution",
    "canexecute",
    "readynow",
    "commandexecutionallowed",
    "alloworderexecution",
    "brokerdispatch",
    "killswitch",
    "tradepermission",
    "executionauthority",
    "livelocked",
    "cantrade",
    "mayexecute",
    "executionallowed",
  ]);
  const FORBIDDEN_SUBSTR = ["execut", "broker", "killswitch", "dispatch", "cantrade"];

  function scan(node: unknown, path: string): void {
    if (node == null || typeof node !== "object") return;
    for (const key of Object.keys(node as Record<string, unknown>)) {
      const lk = key.toLowerCase();
      assert.ok(!FORBIDDEN_EXACT.has(lk), `forbidden execution-permission key '${key}' at ${path}`);
      for (const sub of FORBIDDEN_SUBSTR) {
        assert.ok(!lk.includes(sub), `key '${key}' at ${path} matches forbidden substring '${sub}'`);
      }
      scan((node as Record<string, unknown>)[key], `${path}.${key}`);
    }
  }
  scan(snap, "snapshot");
  scan(verdict, "verdict");
});

// ── 22. Composition is deterministic (pure) ──────────────────────────────────
test("22: identical inputs compose to an identical snapshot (pure)", () => {
  const a = composeMarketIntelligenceSnapshot(alignedBullishInput("live_read"));
  const b = composeMarketIntelligenceSnapshot(alignedBullishInput("live_read"));
  assert.deepEqual(a, b);
});

// ── 23. Direction conflict in compose surfaces a conflict bias, never ready ──
test("23: a direction conflict downgrades the composed read away from ready_candidate", () => {
  const base = alignedBullishInput("live_read");
  const conflicted: ComposeSnapshotInput = {
    ...base,
    direction: resolveDirectionTruth(
      {
        htfDirection: "bullish",
        ltfDirection: "bearish",
        trendlineBias: "neutral",
        pivotBias: "neutral",
        patternBias: "neutral",
        patternForming: false,
        orderFlowBias: "neutral",
        midRange: false,
        atMajorLevel: false,
        newsRisk: false,
        volatilityExtreme: false,
        invalidationLevel: null,
      },
      dirDisp(),
    ),
  };
  const snap: MarketIntelligenceSnapshot = composeMarketIntelligenceSnapshot(conflicted);
  assert.equal(snap.finalBias, "conflict");
  assert.notEqual(snap.confluence.finalAction, "ready_candidate");
  assert.notEqual(deriveStrategyVerdict(snap).readiness, "ready_candidate");
});
