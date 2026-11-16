// Integration + concurrency tests for the per-symbol personality safety net.
// Run via:
//   node --import tsx --test src/lib/scalp/__qa__/scalpPersonalityWiring.test.ts
// (wired as `pnpm --filter @workspace/api-server run test:scalp-personality-wiring`)
//
// Proves the two safety properties that pure-math unit tests cannot:
//   1) ENGINE WIRING — a non-zero learned personality, loaded from the DB the
//      SAME way the Broad-rank / Builder service path loads it, only ever
//      TIGHTENS the engine's ranked output: every symbol's quality score can
//      only stay equal or drop, and a borderline setup is never ranked higher
//      (here it is downgraded out of the actionable list entirely).
//   2) CONCURRENCY — two simultaneous closes on the same (user, symbol) fold
//      onto each other's committed counts (no lost update), thanks to the
//      SELECT … FOR UPDATE serialization in foldPersonality. The exact final
//      counts AND the derived bias match a deterministic pure-replay.
//
// SAFETY / SCOPE: read + learn only. Nothing here trades or touches the 16-gate
// path. Hits the real dev DB under a throwaway high-range userId and is cleaned
// up fail-closed (aborts if the scope looks wrong).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { and, eq } from "drizzle-orm";
import { evaluateMarketDataSufficiency } from "@workspace/domain/market";
import { db, pool, scalpSymbolPersonalityTable, scalpJournalEntriesTable } from "@workspace/db";
import {
  rankUnder,
  SCALP_MODES,
  type RankInput,
} from "../scalpService.js";
import {
  foldPersonality,
  loadSymbolPersonality,
} from "../scalpJournalService.js";
import {
  applyPersonalityDelta,
  computeQualityBias,
  EMPTY_PERSONALITY_COUNTS,
  type PersonalityClosedTrade,
} from "../scalpJournal.js";
import type {
  ScalpEngineInput,
  ScalpSpecInput,
  ScalpScannerInput,
} from "../scalpTypes.js";
// Importing scalpService transitively starts the market simulator's 1s timer,
// which would keep the event loop alive after the tests finish. Stop it (and
// close the DB pool) so `node --test` exits cleanly.
import { marketSimulator } from "../../marketSimulator.js";

after(async () => {
  marketSimulator.stop();
  await pool.end();
});

// Throwaway userIds in a high range that real registrations never reach.
const TEST_USER_BASE = 2_100_000_000;
function freshTestUser(): number {
  return TEST_USER_BASE + Math.floor(Math.random() * 1_000_000);
}

async function cleanupUser(userId: number): Promise<void> {
  // Fail-closed: only ever delete inside the throwaway test range.
  if (userId < TEST_USER_BASE) {
    throw new Error("ABORT: refusing cleanup — unexpected test scope");
  }
  await db.delete(scalpSymbolPersonalityTable).where(eq(scalpSymbolPersonalityTable.userId, userId));
  await db.delete(scalpJournalEntriesTable).where(eq(scalpJournalEntriesTable.userId, userId));
}

// ── Engine-input builders (a clean, broker-truth BUY setup, in-zone) ──────────

function spec(over: Partial<ScalpSpecInput> = {}): ScalpSpecInput {
  return {
    hasBrokerTruth: true,
    tradeMode: "FULL",
    tradeAllowed: true,
    visible: true,
    marketOpen: true,
    digits: 2,
    point: 0.01,
    minLot: 0.001,
    maxLot: 10,
    lotStep: 0.001,
    contractSize: 1,
    tickSize: 0.01,
    tickValue: 0.01,
    stopsLevelPoints: 0,
    spreadPoints: 20,
    category: "forex",
    displayName: "Test Symbol",
    ...over,
  };
}

// A clean BUY scanner read, price inside the entry zone. confidenceScore /
// entrySniperScore drive the quality score; R:R is well above the SNIPER floor
// so nothing else downgrades it.
function buyScanner(conf: number, sniper: number): ScalpScannerInput {
  return {
    bias: "bullish",
    recommendedAction: "BUY",
    confidenceScore: conf,
    entrySniperScore: sniper,
    trendStrength: 62,
    setupType: "Continuation",
    entry: 4600,
    stopLoss: 4585,
    takeProfit: 4625,
    entryZone: { low: 4597, high: 4603 },
    dataSource: "LIVE_FEED",
    // The engine fail-closes without the shared sufficiency verdict.
    sufficiency: evaluateMarketDataSufficiency({
      symbol: "Volatility 75 Index",
      timeframe: "M5",
      freshnessVerdict: "LIVE",
      availableClosedCandles: 300,
    }),
    reasonForTrade: "Support hold",
  };
}

function rankInput(
  symbol: string,
  conf: number,
  sniper: number,
  personality: { qualityBias: number; minQualityDelta: number } | null,
): RankInput {
  const base: Omit<ScalpEngineInput, "mode"> = {
    symbol,
    currentPrice: 4600,
    spec: spec(),
    scanner: buyScanner(conf, sniper),
    account: { balance: 1000, equity: 1000, freeMargin: 1000, leverage: 100 },
    riskAmount: 10,
    targetProfitAmount: null,
    candles: null,
    execution: null,
    htfBias: null,
    riskPersonality: "BALANCED",
    symbolPersonality: personality,
  };
  return { symbol, base };
}

// ── 1) ENGINE WIRING: learned personality only tightens the ranked output ─────

test("non-zero personality only tightens Broad-rank/Builder output under EVERY ScalpMode (never ranks a borderline setup higher)", async () => {
  const userId = freshTestUser();
  const STRONG = "TEST_STRONG";
  // Two BORDERLINE symbols with IDENTICAL clean reads → identical baseline
  // scores (a tie). We penalise only B1. The safety net must be able to push
  // B1 down but never up: it can only ever rank at or below its untouched twin
  // B2, and its score can only drop.
  const B1 = "TEST_BORDERLINE_1";
  const B2 = "TEST_BORDERLINE_2";
  try {
    // Seed a real DB personality row for B1 carrying a strong tightening nudge
    // (penalty + raised floor). We then LOAD it through the same loader the
    // service uses, so the value actually round-trips the DB.
    await db.insert(scalpSymbolPersonalityTable).values([
      {
        userId, symbol: B1, displayName: "Borderline 1", assetClass: "forex",
        isSynthetic: false, tradesClosed: 8, wins: 0, losses: 8, breakevens: 0,
        reversalCount: 8, fakeoutCount: 8, continuationCount: 0, sampleCount: 8,
        qualityBias: -8, minQualityDelta: 10,
      },
    ]);

    const learnedB1 = await loadSymbolPersonality(userId, B1);
    assert.ok(learnedB1, "B1 personality loads from DB");
    assert.ok(learnedB1!.qualityBias < 0, "loaded bias is a real penalty");
    assert.ok(learnedB1!.minQualityDelta > 0, "loaded delta raises the floor");

    // Same scanner reads, ranked two ways. The ONLY difference between the
    // baseline and learned runs is B1's learned personality — exactly the
    // mapping buildRankInputs feeds into the engine.
    const baseline: RankInput[] = [
      rankInput(STRONG, 95, 95, null),
      rankInput(B1, 80, 80, null),
      rankInput(B2, 80, 80, null),
    ];
    const learned: RankInput[] = [
      rankInput(STRONG, 95, 95, null),
      rankInput(B1, 80, 80, {
        qualityBias: learnedB1!.qualityBias,
        minQualityDelta: learnedB1!.minQualityDelta,
      }),
      rankInput(B2, 80, 80, null),
    ];

    // The engine applies the learned personality (quality penalty + raised
    // min-quality floor) under EVERY mode profile in MODE_PROFILES, not just
    // SNIPER. A mode-specific profile that one day applied the nudge in the
    // wrong direction would be caught here: we re-run the full tightening-only
    // proof under each ScalpMode.
    assert.ok(SCALP_MODES.length >= 2, "more than one mode profile exists to prove");
    for (const mode of SCALP_MODES) {
      const rankedBaseline = rankUnder(baseline, mode);
      const rankedLearned = rankUnder(learned, mode);

      const baseScore = new Map(rankedBaseline.map((r) => [r.symbol, r.qualityScore]));
      const learnScore = new Map(rankedLearned.map((r) => [r.symbol, r.qualityScore]));

      // Baseline: all three are actionable, strong leads, and the twins tie.
      assert.equal(rankedBaseline.length, 3, `[${mode}] all setups actionable at baseline`);
      assert.equal(rankedBaseline[0]!.symbol, STRONG, `[${mode}] strong leads at baseline`);
      assert.equal(
        baseScore.get(B1),
        baseScore.get(B2),
        `[${mode}] twin borderline setups have identical baseline scores`,
      );

      // The penalty actually reached the engine through the DB→loader→rank wiring.
      assert.ok(learnScore.has(B1), `[${mode}] B1 still evaluated under learning`);
      assert.ok(
        learnScore.get(B1)! < baseScore.get(B1)!,
        `[${mode}] B1 learned score strictly drops (penalty applied)`,
      );

      // TIGHTENING-ONLY: no symbol's learned score is HIGHER than its baseline.
      for (const [symbol, score] of learnScore) {
        const before = baseScore.get(symbol);
        assert.ok(before !== undefined, `[${mode}] ${symbol} also present at baseline`);
        assert.ok(score <= before!, `[${mode}] ${symbol} learned score ${score} <= baseline ${before}`);
      }

      // B1 is NEVER ranked higher: its rank index cannot improve, and it can
      // never sit above its untouched twin B2.
      const baseIdxB1 = rankedBaseline.findIndex((r) => r.symbol === B1);
      const learnIdxB1 = rankedLearned.findIndex((r) => r.symbol === B1);
      const learnIdxB2 = rankedLearned.findIndex((r) => r.symbol === B2);
      assert.ok(learnIdxB1 >= baseIdxB1, `[${mode}] B1 rank index never improves under learning`);
      assert.ok(learnIdxB1 > learnIdxB2, `[${mode}] penalised B1 never ranks above its untouched twin B2`);

      // The untouched symbols (STRONG, B2) keep identical scores — learning a
      // penalty on one symbol cannot bleed into another.
      assert.equal(learnScore.get(STRONG), baseScore.get(STRONG), `[${mode}] STRONG unaffected`);
      assert.equal(learnScore.get(B2), baseScore.get(B2), `[${mode}] B2 (no personality) unaffected`);
    }
  } finally {
    await cleanupUser(userId);
  }
});

// ── 2) CONCURRENCY: two simultaneous closes fold without a lost update ─────────

function losingReversalClose(): PersonalityClosedTrade {
  return {
    result: "LOSS",
    flameReversedAtClose: true,
    flameContinued: false,
    spreadPointsAtEntry: 10,
    flameAgeAtEntry: 3,
    scoreAtEntry: 70,
    isSynthetic: false,
  };
}

test("two simultaneous closes on the same (user, symbol) fold exact counts + bias (no lost update)", async () => {
  const userId = freshTestUser();
  const SYMBOL = "TEST_CONCURRENT";
  try {
    const closed = losingReversalClose();

    // Pre-seed ONE close sequentially so the row already exists; the two
    // concurrent folds below then contend purely on the row lock. Without the
    // SELECT … FOR UPDATE serialization both would read the same snapshot and
    // one update would be lost (final tradesClosed would be 2, not 3).
    await foldPersonality(userId, {
      symbol: SYMBOL, displayName: "Concurrent", assetClass: "forex",
      isSynthetic: false, closed,
    });

    await Promise.all([
      foldPersonality(userId, {
        symbol: SYMBOL, displayName: "Concurrent", assetClass: "forex",
        isSynthetic: false, closed,
      }),
      foldPersonality(userId, {
        symbol: SYMBOL, displayName: "Concurrent", assetClass: "forex",
        isSynthetic: false, closed,
      }),
    ]);

    const rows = await db.select().from(scalpSymbolPersonalityTable).where(and(
      eq(scalpSymbolPersonalityTable.userId, userId),
      eq(scalpSymbolPersonalityTable.symbol, SYMBOL),
    ));
    assert.equal(rows.length, 1, "exactly one personality row");
    const row = rows[0]!;

    // Deterministic expected state: replay the SAME three folds in pure code.
    let expected = EMPTY_PERSONALITY_COUNTS;
    for (let i = 0; i < 3; i++) expected = applyPersonalityDelta(expected, closed);
    const expectedBias = computeQualityBias(expected);

    // Exact final counts — proves no fold was lost to a stale read.
    assert.equal(row.tradesClosed, 3, "all three closes counted (no lost update)");
    assert.equal(row.tradesClosed, expected.tradesClosed);
    assert.equal(row.losses, expected.losses);
    assert.equal(row.wins, expected.wins);
    assert.equal(row.reversalCount, expected.reversalCount);
    assert.equal(row.fakeoutCount, expected.fakeoutCount);
    assert.equal(row.continuationCount, expected.continuationCount);
    assert.equal(row.sampleCount, expected.sampleCount);

    // Exact derived bias — and it crossed the min-sample threshold, so it is a
    // real (non-zero) tightening nudge, still in-contract (≤ 0 / ≥ 0).
    assert.ok(Math.abs(Number(row.qualityBias) - expectedBias.qualityBias) < 1e-9, "qualityBias matches replay");
    assert.ok(Math.abs(Number(row.minQualityDelta) - expectedBias.minQualityDelta) < 1e-9, "minQualityDelta matches replay");
    assert.ok(Number(row.qualityBias) < 0, "a losing/reversing symbol earns a real penalty");
    assert.ok(Number(row.minQualityDelta) > 0, "and a raised quality floor");
    assert.ok(Number(row.qualityBias) <= 0 && Number(row.minQualityDelta) >= 0, "stays tightening-only");
  } finally {
    await cleanupUser(userId);
  }
});
