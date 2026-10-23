// Task #617 — Pattern Truth learning loop: DB-backed fixture suite.
//
// Locks scenario 16 (outcome logging updates reliability stats) and the
// DB-persistence half of scenario 19 (synthetic stats tracked separately), plus
// the fail-closed resolution rule (elapsed time alone never grades an outcome)
// and snapshot-lock immutability.
//
// Imports `@workspace/db`, so it CANNOT live in the offline `ci` lane — it runs
// in `ci:integration` via INTEGRATION_LANE_TESTS. Uses NEGATIVE synthetic
// userIds so it never touches a real user's rows, and cleans up in `finally`.
//
// Run (needs DATABASE_URL):
//   node --import tsx --test src/lib/data/chart/__qa__/patternOutcomeLearning.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { db, patternOutcomesTable } from "@workspace/db";
import {
  recordPatternDetection,
  resolvePatternOutcome,
  buildPatternReliability,
} from "../patternOutcomeService.js";
import {
  resolvePatternTruth,
  MAX_CONFIDENCE_ADJUSTMENT,
  type DetectedPattern,
  type PatternContext,
  type PatternDisplayContext,
} from "@workspace/domain/market";
import { applyPatternLearning } from "../../../assistant/patternLearningRuntime.js";

const FOREX_USER = -918_617_001; // synthetic, never a real user
const SYNTH_USER = -918_617_002;
const WIRE_USER = -918_617_003; // Gap C runtime-wiring test

async function cleanup(): Promise<void> {
  await db.delete(patternOutcomesTable).where(eq(patternOutcomesTable.userId, FOREX_USER));
  await db.delete(patternOutcomesTable).where(eq(patternOutcomesTable.userId, SYNTH_USER));
  await db.delete(patternOutcomesTable).where(eq(patternOutcomesTable.userId, WIRE_USER));
}

// ── 16. Outcome logging updates reliability stats ────────────────────────────
test("16: recording detections + resolving them updates the reliability report", async () => {
  try {
    await cleanup();

    // Record 6 forex detections and resolve them as WINS.
    for (let i = 0; i < 6; i++) {
      await recordPatternDetection({
        userId: FOREX_USER,
        outcomeId: `fx-${i}`,
        symbol: "EURUSD",
        assetClass: "forex",
        isSynthetic: false,
        timeframe: "1h",
        patternId: "head_and_shoulders",
        patternName: "Head & Shoulders",
        bias: "bearish",
        statusAtDetection: "confirmed",
        confidenceAtDetection: 80,
        feedStatusAtDetection: "LIVE",
      });
      const resolved = await resolvePatternOutcome({
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

    const { forexIndices, synthetic } = await buildPatternReliability(FOREX_USER);
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
test("19-db: synthetic outcomes aggregate separately from forex/indices", async () => {
  try {
    await cleanup();

    // One forex WIN.
    await recordPatternDetection({
      userId: SYNTH_USER,
      outcomeId: "fx-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      patternId: "double_bottom",
      patternName: "Double Bottom",
      bias: "bullish",
      statusAtDetection: "confirmed",
    });
    await resolvePatternOutcome({ userId: SYNTH_USER, outcomeId: "fx-1", outcome: "WIN", realizedR: 1 });

    // One synthetic LOSS.
    await recordPatternDetection({
      userId: SYNTH_USER,
      outcomeId: "syn-1",
      symbol: "Volatility 75 Index",
      isSynthetic: true,
      timeframe: "1h",
      patternId: "double_bottom",
      patternName: "Double Bottom",
      bias: "bullish",
      statusAtDetection: "confirmed",
    });
    await resolvePatternOutcome({ userId: SYNTH_USER, outcomeId: "syn-1", outcome: "LOSS", realizedR: -1 });

    const { forexIndices, synthetic } = await buildPatternReliability(SYNTH_USER);
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
test("resolvePatternOutcome refuses a non-evidence grade (fail-closed)", async () => {
  try {
    await cleanup();
    await recordPatternDetection({
      userId: FOREX_USER,
      outcomeId: "pending-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      patternId: "bull_flag",
      patternName: "Bull Flag",
      bias: "bullish",
      statusAtDetection: "forming",
    });
    await assert.rejects(
      () => resolvePatternOutcome({ userId: FOREX_USER, outcomeId: "pending-1", outcome: "EXPIRED" }),
      /not an evidence grade/i,
    );
    // The row must remain unresolved + unlocked. Select by (userId, outcomeId)
    // so a stray row for the same synthetic user can never alias this check.
    const [row] = await db
      .select()
      .from(patternOutcomesTable)
      .where(and(eq(patternOutcomesTable.userId, FOREX_USER), eq(patternOutcomesTable.outcomeId, "pending-1")));
    assert.equal(row!.outcome, "PENDING");
    assert.equal(row!.locked, false);
  } finally {
    await cleanup();
  }
});

// ── Idempotent record: a locked snapshot is never overwritten by re-detection ─
test("recordPatternDetection is idempotent and never overwrites a locked snapshot", async () => {
  try {
    await cleanup();
    await recordPatternDetection({
      userId: FOREX_USER,
      outcomeId: "lock-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      patternId: "head_and_shoulders",
      patternName: "Head & Shoulders",
      bias: "bearish",
      statusAtDetection: "forming",
      confidenceAtDetection: 50,
    });
    await resolvePatternOutcome({ userId: FOREX_USER, outcomeId: "lock-1", outcome: "WIN", realizedR: 1 });

    // Re-detect the SAME observation with different at-detection facts.
    await recordPatternDetection({
      userId: FOREX_USER,
      outcomeId: "lock-1",
      symbol: "EURUSD",
      isSynthetic: false,
      timeframe: "1h",
      patternId: "head_and_shoulders",
      patternName: "Head & Shoulders",
      bias: "bearish",
      statusAtDetection: "confirmed",
      confidenceAtDetection: 99,
    });

    const rows = await db
      .select()
      .from(patternOutcomesTable)
      .where(and(eq(patternOutcomesTable.userId, FOREX_USER), eq(patternOutcomesTable.outcomeId, "lock-1")));
    assert.equal(rows.length, 1, "still a single row (idempotent on (userId, outcomeId))");
    // Locked snapshot retained its original at-detection values.
    assert.equal(rows[0]!.statusAtDetection, "forming");
    assert.equal(rows[0]!.confidenceAtDetection, 50);
    assert.equal(rows[0]!.outcome, "WIN");
  } finally {
    await cleanup();
  }
});

// ── Gap C. The learning loop is WIRED: applyPatternLearning records the live
// detection AND nudges confidence — bounded by the hard cap AND the display
// ceiling, never above either. ───────────────────────────────────────────────

function wirePattern(over: Partial<DetectedPattern> = {}): DetectedPattern {
  return {
    id: "double_bottom",
    name: "Double Bottom",
    category: "reversal",
    bias: "bullish",
    status: "confirmed",
    confidence: 70,
    quality: "high",
    levels: { confirmation: 1.105, invalidation: 1.09, targets: [1.13] },
    keyPoints: [],
    rationale: ["Two equal lows", "Neckline reclaimed"],
    failureModes: ["Neckline break can fail"],
    minCandles: 30,
    entryTiming: "clean",
    falseBreakoutRisk: "medium",
    ...over,
  };
}

function wireCtx(over: Partial<PatternContext> = {}): PatternContext {
  return {
    trend: "bullish",
    nearSupportResistance: false,
    distanceToSrAtr: null,
    momentumAligned: true,
    volatilityAtr: 0.001,
    ...over,
  };
}

function wireDisp(over: Partial<PatternDisplayContext> = {}): PatternDisplayContext {
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
      .from(patternOutcomesTable)
      .where(eq(patternOutcomesTable.userId, userId));
    if (rows.some((row) => re.test(row.outcomeId))) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
}

test("Gap C: applyPatternLearning records the detection AND nudges within the ceiling", async () => {
  try {
    await cleanup();

    // Seed an all-WIN forex history so the user carries a POSITIVE reliability
    // edge (a non-zero positive confidence adjustment).
    for (let i = 0; i < 8; i++) {
      await recordPatternDetection({
        userId: WIRE_USER,
        outcomeId: `seed-${i}`,
        symbol: "EURUSD",
        isSynthetic: false,
        timeframe: "1h",
        patternId: "double_bottom",
        patternName: "Double Bottom",
        bias: "bullish",
        statusAtDetection: "confirmed",
      });
      await resolvePatternOutcome({
        userId: WIRE_USER,
        outcomeId: `seed-${i}`,
        outcome: "WIN",
        realizedR: 2,
        mfeR: 2.5,
        maeR: -0.4,
      });
    }

    const { forexIndices } = await buildPatternReliability(WIRE_USER);
    assert.notEqual(forexIndices.reliabilityScore, null, "history yields a reliability score");
    assert.ok(forexIndices.rubyConfidenceAdjustment > 0, "all-win history nudges confidence up");

    // A real confirmed verdict (the pure contract is the source of the ceiling).
    const verdict = resolvePatternTruth([wirePattern()], wireCtx(), wireDisp());
    assert.ok(verdict.dominantPattern, "fixture produces a dominant pattern");
    const ceiling = verdict.scannerTruthImpact.confidenceCeiling;

    const learning = await applyPatternLearning({
      userId: WIRE_USER,
      symbol: "EURUSD",
      timeframe: "1h",
      verdict,
    });
    assert.ok(learning, "a positive-edge user gets a learning result");
    assert.equal(learning!.marketClass, "forex_indices", "forex symbol uses the forex bucket");
    assert.ok(
      Math.abs(learning!.confidenceAdjustment) <= MAX_CONFIDENCE_ADJUSTMENT,
      "nudge is bounded by the hard cap",
    );
    assert.ok(learning!.adjustedConfidence <= ceiling, "adjusted confidence never exceeds the ceiling");
    assert.ok(learning!.adjustedConfidence >= 0, "adjusted confidence never goes negative");

    // HARD CAP proof: a verdict whose confidence is ALREADY at the ceiling can
    // never be pushed above it by a positive reliability nudge.
    const atCeiling = { ...verdict, confidence: ceiling };
    const clamped = await applyPatternLearning({
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
    const recorded = await pollForOutcomeRow(WIRE_USER, /^pat:EURUSD:1h:double_bottom:/);
    assert.ok(recorded, "applyPatternLearning recorded the live detection observation");
  } finally {
    await cleanup();
  }
});

test("Gap C: records EVERY detected pattern; distinct detections never collapse, repeats stay idempotent", async () => {
  try {
    await cleanup();

    // Three detections in ONE read: two share the SAME pattern id but have
    // DIFFERENT geometry (must NOT collapse into one row), plus a third of a
    // different pattern (proves non-dominant patterns are recorded too).
    const pA = wirePattern({
      id: "double_bottom",
      levels: { confirmation: 1.105, invalidation: 1.09, targets: [1.13] },
      keyPoints: [
        { index: 10, price: 1.09, role: "first_bottom" },
        { index: 20, price: 1.091, role: "second_bottom" },
      ],
    });
    const pB = wirePattern({
      id: "double_bottom", // SAME id, DIFFERENT geometry → distinct instance
      levels: { confirmation: 1.205, invalidation: 1.19, targets: [1.23] },
      keyPoints: [
        { index: 12, price: 1.19, role: "first_bottom" },
        { index: 22, price: 1.191, role: "second_bottom" },
      ],
    });
    const pC = wirePattern({
      id: "bull_flag",
      category: "continuation",
      bias: "bullish",
      levels: { confirmation: 1.305, invalidation: 1.29, targets: [1.33] },
      keyPoints: [{ index: 5, price: 1.3, role: "flag_break" }],
    });

    const verdict = resolvePatternTruth([pA, pB, pC], wireCtx(), wireDisp());
    assert.equal(verdict.detectedPatterns.length, 3, "all three patterns survive into the verdict");

    // Record once, then AGAIN with the identical verdict — the second call must
    // refresh (upsert) the same rows, never duplicate them.
    await applyPatternLearning({ userId: WIRE_USER, symbol: "EURUSD", timeframe: "1h", verdict });
    await applyPatternLearning({ userId: WIRE_USER, symbol: "EURUSD", timeframe: "1h", verdict });

    let patRows: { outcomeId: string; patternId: string }[] = [];
    for (let i = 0; i < 40; i++) {
      const rows = await db
        .select()
        .from(patternOutcomesTable)
        .where(eq(patternOutcomesTable.userId, WIRE_USER));
      patRows = rows
        .filter((row) => /^pat:EURUSD:1h:/.test(row.outcomeId))
        .map((row) => ({ outcomeId: row.outcomeId, patternId: row.patternId }));
      if (patRows.length >= 3) break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }

    const distinctIds = new Set(patRows.map((row) => row.outcomeId));
    assert.equal(
      distinctIds.size,
      3,
      "3 distinct detection instances recorded (same-id different-geometry NOT collapsed)",
    );
    assert.equal(
      patRows.length,
      distinctIds.size,
      "recording the identical verdict twice does not duplicate rows (idempotent upsert)",
    );
    assert.ok(
      patRows.some((row) => row.patternId === "bull_flag"),
      "the non-dominant pattern was also recorded (not only the dominant one)",
    );
    assert.equal(
      patRows.filter((row) => row.patternId === "double_bottom").length,
      2,
      "both same-id detections persist as separate rows",
    );
  } finally {
    await cleanup();
  }
});

test("Gap C: a null userId records NOTHING and returns no adjustment", async () => {
  const verdict = resolvePatternTruth([wirePattern()], wireCtx(), wireDisp());
  const result = await applyPatternLearning({
    userId: null,
    symbol: "EURUSD",
    timeframe: "1h",
    verdict,
  });
  assert.equal(result, null, "no user => no learning result (per-user isolation)");
});
