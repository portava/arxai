// Task #649 — Trendline Truth learning loop: DB-backed fixture suite.
//
// Locks the DB-persistence half of the learning loop: outcome logging updates the
// per-user reliability report, synthetic stats aggregate SEPARATELY from forex /
// indices, resolution is FAIL-CLOSED (elapsed time alone never grades a row),
// re-detection is idempotent and never overwrites a locked snapshot, and the
// runtime is WIRED (applyTrendlineLearning records the live detection AND nudges
// confidence — bounded by BOTH the hard cap and the display ceiling).
//
// Imports `@workspace/db`, so it CANNOT live in the offline `ci` lane — it runs in
// `ci:integration` via INTEGRATION_LANE_TESTS. Uses NEGATIVE synthetic userIds so
// it never touches a real user's rows, and cleans up in `finally`.
//
// Run (needs DATABASE_URL):
//   node --import tsx --test src/lib/data/chart/__qa__/trendlineOutcomeLearning.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, trendlineOutcomesTable } from "@workspace/db";
import {
  recordTrendlineDetection,
  resolveTrendlineOutcome,
  buildTrendlineReliability,
} from "../trendlineOutcomeService.js";
import {
  resolveTrendlineTruth,
  TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
  type ActiveTrendline,
  type TrendlineContext,
  type TrendlineDisplayContext,
} from "@workspace/domain/market";
import { applyTrendlineLearning } from "../../../assistant/trendlineLearningRuntime.js";

const FOREX_USER = -918_617_101; // synthetic, never a real user
const SYNTH_USER = -918_617_102;
const WIRE_USER = -918_617_103; // runtime-wiring test

async function cleanup(): Promise<void> {
  await db.delete(trendlineOutcomesTable).where(eq(trendlineOutcomesTable.userId, FOREX_USER));
  await db.delete(trendlineOutcomesTable).where(eq(trendlineOutcomesTable.userId, SYNTH_USER));
  await db.delete(trendlineOutcomesTable).where(eq(trendlineOutcomesTable.userId, WIRE_USER));
}

// ── 16. Outcome logging updates reliability stats ────────────────────────────
test("recording detections + resolving them updates the reliability report", async () => {
  try {
    await cleanup();

    // Record 6 forex detections and resolve them as WINS.
    for (let i = 0; i < 6; i++) {
      await recordTrendlineDetection({
        userId: FOREX_USER,
        outcomeId: `fx-${i}`,
        symbol: "EURUSD",
        assetClass: "forex",
        isSynthetic: false,
        timeframe: "1h",
        trendlineId: "ascending_support",
        trendlineName: "Ascending Support",
        bias: "bullish",
        statusAtDetection: "confirmed",
        confidenceAtDetection: 80,
        feedStatusAtDetection: "LIVE",
      });
      const resolved = await resolveTrendlineOutcome({
        userId: FOREX_USER,
        outcomeId: `fx-${i}`,
        outcome: "WIN",
        realizedR: 2,
        mfeR: 2.5,
        maeR: -0.5,
      });
      assert.ok(resolved, "resolution returns the updated row");
      assert.equal(resolved!.locked, true, "resolution locks the snapshot");
    }

    const { forexIndices, synthetic } = await buildTrendlineReliability(FOREX_USER);
    assert.equal(forexIndices.resolvedCount, 6);
    assert.equal(forexIndices.overall.wins, 6);
    assert.equal(forexIndices.overall.winRate, 1);
    assert.notEqual(forexIndices.reliabilityScore, null);
    // This user logged nothing synthetic.
    assert.equal(synthetic.resolvedCount, 0);
  } finally {
    await cleanup();
  }
});

// ── 19 (DB). Synthetic stats tracked separately from forex/indices ──────────
test("synthetic outcomes aggregate separately from forex/indices", async () => {
  try {
    await cleanup();

    // One forex WIN.
    await recordTrendlineDetection({
      userId: SYNTH_USER,
      outcomeId: "fx-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      trendlineId: "descending_resistance",
      trendlineName: "Descending Resistance",
      bias: "bearish",
      statusAtDetection: "confirmed",
    });
    await resolveTrendlineOutcome({ userId: SYNTH_USER, outcomeId: "fx-1", outcome: "WIN", realizedR: 1 });

    // One synthetic LOSS.
    await recordTrendlineDetection({
      userId: SYNTH_USER,
      outcomeId: "syn-1",
      symbol: "Volatility 75 Index",
      isSynthetic: true,
      timeframe: "1h",
      trendlineId: "descending_resistance",
      trendlineName: "Descending Resistance",
      bias: "bearish",
      statusAtDetection: "confirmed",
    });
    await resolveTrendlineOutcome({ userId: SYNTH_USER, outcomeId: "syn-1", outcome: "LOSS", realizedR: -1 });

    const { forexIndices, synthetic } = await buildTrendlineReliability(SYNTH_USER);
    assert.equal(forexIndices.market, "forex_indices");
    assert.equal(synthetic.market, "synthetic");
    assert.equal(forexIndices.resolvedCount, 1);
    assert.equal(forexIndices.overall.wins, 1);
    assert.equal(synthetic.resolvedCount, 1);
    assert.equal(synthetic.overall.losses, 1);
    assert.equal(synthetic.overall.wins, 0);
  } finally {
    await cleanup();
  }
});

// ── Fail-closed resolution: elapsed time alone never grades an outcome ───────
test("resolveTrendlineOutcome refuses a non-evidence grade (fail-closed)", async () => {
  try {
    await cleanup();
    await recordTrendlineDetection({
      userId: FOREX_USER,
      outcomeId: "pending-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      trendlineId: "ascending_support",
      trendlineName: "Ascending Support",
      bias: "bullish",
      statusAtDetection: "forming",
    });
    await assert.rejects(
      () => resolveTrendlineOutcome({ userId: FOREX_USER, outcomeId: "pending-1", outcome: "EXPIRED" }),
      /not an evidence grade/i,
    );
    // The row must remain unresolved + unlocked. Select by (userId, outcomeId) so
    // a stray row for the same synthetic user can never alias this check.
    const [row] = await db
      .select()
      .from(trendlineOutcomesTable)
      .where(and(eq(trendlineOutcomesTable.userId, FOREX_USER), eq(trendlineOutcomesTable.outcomeId, "pending-1")));
    assert.equal(row!.outcome, "PENDING");
    assert.equal(row!.locked, false);
  } finally {
    await cleanup();
  }
});

// ── Idempotent record: a locked snapshot is never overwritten by re-detection ─
test("recordTrendlineDetection is idempotent and never overwrites a locked snapshot", async () => {
  try {
    await cleanup();
    await recordTrendlineDetection({
      userId: FOREX_USER,
      outcomeId: "lock-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      trendlineId: "ascending_support",
      trendlineName: "Ascending Support",
      bias: "bullish",
      statusAtDetection: "forming",
      confidenceAtDetection: 50,
    });
    await resolveTrendlineOutcome({ userId: FOREX_USER, outcomeId: "lock-1", outcome: "WIN", realizedR: 1 });

    // Re-detect the SAME observation with different at-detection facts.
    await recordTrendlineDetection({
      userId: FOREX_USER,
      outcomeId: "lock-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      trendlineId: "ascending_support",
      trendlineName: "Ascending Support",
      bias: "bullish",
      statusAtDetection: "confirmed",
      confidenceAtDetection: 99,
    });

    const rows = await db
      .select()
      .from(trendlineOutcomesTable)
      .where(and(eq(trendlineOutcomesTable.userId, FOREX_USER), eq(trendlineOutcomesTable.outcomeId, "lock-1")));
    assert.equal(rows.length, 1, "still a single row (idempotent on (userId, outcomeId))");
    // Locked snapshot retained its original at-detection values.
    assert.equal(rows[0]!.statusAtDetection, "forming");
    assert.equal(rows[0]!.confidenceAtDetection, 50);
    assert.equal(rows[0]!.outcome, "WIN");
  } finally {
    await cleanup();
  }
});

// ── Runtime wiring: applyTrendlineLearning records + nudges within the ceiling ─

function wireTl(over: Partial<ActiveTrendline> = {}): ActiveTrendline {
  return {
    id: "ascending_support",
    name: "Ascending Support",
    category: "trend_support",
    bias: "bullish",
    status: "confirmed",
    confidence: 70,
    quality: "high",
    touchCount: 3,
    slope: 0.01,
    currentLevel: 1.1,
    levels: { confirmation: 1.105, invalidation: 1.09, targets: [1.13] },
    keyPoints: [
      { index: 10, price: 1.09, role: "anchor" },
      { index: 20, price: 1.095, role: "touch" },
      { index: 30, price: 1.1, role: "touch" },
    ],
    rationale: ["Three rising lows"],
    failureModes: ["A close below the line invalidates the read"],
    minCandles: 20,
    falseBreakoutRisk: "medium",
    ...over,
  };
}

function wireCtx(over: Partial<TrendlineContext> = {}): TrendlineContext {
  return {
    trend: "bullish",
    nearSupportResistance: false,
    distanceToSrAtr: null,
    momentumAligned: true,
    volatilityAtr: 0.001,
    ...over,
  };
}

function wireDisp(over: Partial<TrendlineDisplayContext> = {}): TrendlineDisplayContext {
  return {
    feedConfirmed: true,
    feedStale: false,
    sufficiencyAllowsSetup: true,
    chartReadConfidenceLow: false,
    ...over,
  };
}

async function pollForOutcomeRow(userId: number, re: RegExp, tries = 40): Promise<boolean> {
  for (let i = 0; i < tries; i++) {
    const rows = await db
      .select()
      .from(trendlineOutcomesTable)
      .where(eq(trendlineOutcomesTable.userId, userId));
    if (rows.some((row) => re.test(row.outcomeId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("applyTrendlineLearning records the detection AND nudges within the ceiling", async () => {
  try {
    await cleanup();

    // Seed an all-WIN forex history so the user carries a POSITIVE reliability
    // edge (a non-zero positive confidence adjustment).
    for (let i = 0; i < 8; i++) {
      await recordTrendlineDetection({
        userId: WIRE_USER,
        outcomeId: `seed-${i}`,
        symbol: "EURUSD",
        isSynthetic: false,
        timeframe: "1h",
        trendlineId: "ascending_support",
        trendlineName: "Ascending Support",
        bias: "bullish",
        statusAtDetection: "confirmed",
      });
      await resolveTrendlineOutcome({
        userId: WIRE_USER,
        outcomeId: `seed-${i}`,
        outcome: "WIN",
        realizedR: 2,
        mfeR: 2.5,
        maeR: -0.4,
      });
    }

    const { forexIndices } = await buildTrendlineReliability(WIRE_USER);
    assert.notEqual(forexIndices.reliabilityScore, null, "history yields a reliability score");
    assert.ok(forexIndices.rubyConfidenceAdjustment > 0, "all-win history nudges confidence up");

    // A real confirmed verdict (the pure contract is the source of the ceiling).
    const verdict = resolveTrendlineTruth([wireTl()], wireCtx(), wireDisp());
    assert.ok(verdict.dominantTrendline, "fixture produces a dominant trendline");
    const ceiling = verdict.scannerTruthImpact.confidenceCeiling;

    const learning = await applyTrendlineLearning({
      userId: WIRE_USER,
      symbol: "EURUSD",
      timeframe: "1h",
      verdict,
    });
    assert.ok(learning, "a positive-edge user gets a learning result");
    assert.equal(learning!.marketClass, "forex_indices", "forex symbol uses the forex bucket");
    assert.ok(
      Math.abs(learning!.confidenceAdjustment) <= TRENDLINE_MAX_CONFIDENCE_ADJUSTMENT,
      "nudge is bounded by the hard cap",
    );
    assert.ok(learning!.adjustedConfidence <= ceiling, "adjusted confidence never exceeds the ceiling");
    assert.ok(learning!.adjustedConfidence >= 0, "adjusted confidence never goes negative");

    // HARD CAP proof: a verdict whose confidence is ALREADY at the ceiling can
    // never be pushed above it by a positive reliability nudge.
    const atCeiling = { ...verdict, confidence: ceiling };
    const clamped = await applyTrendlineLearning({
      userId: WIRE_USER,
      symbol: "EURUSD",
      timeframe: "1h",
      verdict: atCeiling,
    });
    assert.ok(clamped, "still returns a result at the ceiling");
    assert.equal(
      clamped!.adjustedConfidence,
      ceiling,
      "a positive nudge cannot push confidence above the display ceiling",
    );

    // The detection was RECORDED (fire-and-forget) — poll briefly for the row.
    const recorded = await pollForOutcomeRow(WIRE_USER, /^tl:EURUSD:1h:ascending_support:/);
    assert.ok(recorded, "applyTrendlineLearning recorded the live detection observation");
  } finally {
    await cleanup();
  }
});

test("a null userId records NOTHING and returns no adjustment", async () => {
  const verdict = resolveTrendlineTruth([wireTl()], wireCtx(), wireDisp());
  const result = await applyTrendlineLearning({
    userId: null,
    symbol: "EURUSD",
    timeframe: "1h",
    verdict,
  });
  assert.equal(result, null, "no user => no learning result (per-user isolation)");
});
