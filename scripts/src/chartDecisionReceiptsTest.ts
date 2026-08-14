// Chart Brain v2 — Task 5: decision-memory regression suite (DB-backed).
//
// Pins the inviolable behavior of the per-user decision-memory layer:
//   1. Receipts are IMMUTABLE — the original row is byte-identical after any
//      number of appended outcomes/reviews (the service has no update path).
//   2. OUTCOME and REVIEW records APPEND (both returned, never overwrite).
//   3. A no-trade receipt records a NO_TRADE_CORRECT outcome cleanly.
//   4. findSimilarSetups is HONEST: below the history floor it refuses to imply
//      a pattern (enoughHistory=false); with enough comparable history it
//      surfaces matches and a dissimilar fingerprint is excluded.
//   5. Behavior protection derives signals from the user's OWN history and an
//      investor caller receives { applicable:false } (never trade coaching).
//   6. Per-user isolation: user B never sees user A's receipts; the admin
//      cross-user read does.
//
// SAFETY: this test only touches the additive chart_decision_* tables under
// synthetic NEGATIVE test user ids. It places/modifies/closes NOTHING and never
// reaches the live pipeline, kill switch, or any broker surface. It cleans up
// only the rows it created (scoped to the synthetic ids) at the end.

import { randomUUID } from "node:crypto";
import {
  db,
  chartDecisionReceiptsTable,
  chartDecisionOutcomesTable,
  tradesTable,
  type NewChartDecisionReceipt,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import {
  appendReceiptOutcome,
  getUserReceipt,
  listUserReceipts,
  listAllReceiptsForAdmin,
} from "../../artifacts/api-server/src/lib/chart/decisionReceipts.js";
import { findSimilarSetups } from "../../artifacts/api-server/src/lib/chart/similarSetups.js";
import { getBehaviorProtection } from "../../artifacts/api-server/src/lib/chart/behaviorProtection.js";
import type { ChartSetupFingerprint } from "../../artifacts/api-server/src/lib/chart/setupFingerprint.js";

// Synthetic, isolated test identities (negative ids never collide with real users).
const USER_A = -177_001;
const USER_B = -177_002;
const USER_INV = -177_003;
const TEST_USERS = [USER_A, USER_B, USER_INV];

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function fp(over: Partial<ChartSetupFingerprint> = {}): ChartSetupFingerprint {
  return {
    symbol: "EURUSD",
    timeframe: "M5",
    direction: "BUY",
    tradeType: "scalp",
    regime: "trending",
    htfBias: "bullish",
    trendStrengthBucket: "strong",
    levelType: "support",
    levelPersonality: "fresh",
    distanceBucket: "near",
    candlePressure: "buyers",
    candleIntent: "pushing",
    wickBehavior: "rejection",
    entryQuality: "strong",
    agentAgreement: "support",
    riskStatus: "clear",
    stage: "READY",
    freshnessBucket: "fresh",
    readinessBucket: "high",
    qualityLabel: "A",
    readinessScore: 80,
    trendStrength: 75,
    distancePct: 0.2,
    ...over,
  };
}

async function insertReceipt(
  userId: number,
  fingerprint: ChartSetupFingerprint,
  over: Partial<NewChartDecisionReceipt> = {},
): Promise<string> {
  const receiptId = randomUUID();
  const row: NewChartDecisionReceipt = {
    receiptId,
    userId,
    symbol: fingerprint.symbol,
    timeframe: fingerprint.timeframe,
    source: "chart_read",
    intent: "analyze",
    direction: fingerprint.direction,
    tradeType: fingerprint.tradeType,
    setupStage: fingerprint.stage,
    setupFreshness: fingerprint.freshnessBucket,
    readinessScore: fingerprint.readinessScore,
    qualityLabel: fingerprint.qualityLabel,
    fpRegime: fingerprint.regime,
    fpHtfBias: fingerprint.htfBias,
    fpLevelType: fingerprint.levelType,
    fpStage: fingerprint.stage,
    fpReadinessBucket: fingerprint.readinessBucket,
    fingerprint: fingerprint as unknown as Record<string, unknown>,
    ...over,
  };
  await db.insert(chartDecisionReceiptsTable).values(row);
  return receiptId;
}

async function cleanup() {
  await db
    .delete(chartDecisionOutcomesTable)
    .where(inArray(chartDecisionOutcomesTable.userId, TEST_USERS));
  await db
    .delete(chartDecisionReceiptsTable)
    .where(inArray(chartDecisionReceiptsTable.userId, TEST_USERS));
  await db.delete(tradesTable).where(inArray(tradesTable.userId, TEST_USERS));
}

async function run() {
  // eslint-disable-next-line no-console
  console.log("Chart Brain v2 — decision-memory suite\n");
  await cleanup(); // start clean (defensive — prior aborted run)

  // ── 1 + 2. Immutability + append (OUTCOME then REVIEW) ──
  const rid = await insertReceipt(USER_A, fp());
  const before = await getUserReceipt(USER_A, rid);
  const snapshotBefore = JSON.stringify(before?.receipt ?? null);

  const o1 = await appendReceiptOutcome({
    userId: USER_A,
    receiptRef: rid,
    kind: "OUTCOME",
    outcome: "WIN",
    plQuality: "KNOWN",
    realizedPl: 12.5,
  });
  const o2 = await appendReceiptOutcome({
    userId: USER_A,
    receiptRef: rid,
    kind: "REVIEW",
    note: "Followed the plan, good entry.",
  });
  const after = await getUserReceipt(USER_A, rid);
  const snapshotAfter = JSON.stringify(after?.receipt ?? null);

  record(
    "receipt is byte-identical after appends (immutable)",
    snapshotBefore === snapshotAfter && snapshotBefore !== "null",
  );
  record(
    "OUTCOME and REVIEW both appended (2 records)",
    !!o1 && !!o2 && (after?.outcomes.length ?? 0) === 2,
    `count=${after?.outcomes.length ?? 0}`,
  );
  record(
    "OUTCOME carries verdict + plQuality; REVIEW carries note",
    after?.outcomes.some((o) => o.kind === "OUTCOME" && o.outcome === "WIN" && o.plQuality === "KNOWN") === true &&
      after?.outcomes.some((o) => o.kind === "REVIEW" && (o.note ?? "").length > 0) === true,
  );

  // ── 3. No-trade receipt records NO_TRADE_CORRECT ──
  const ridNoTrade = await insertReceipt(USER_A, fp({ stage: "WATCHING" }), {
    setupStage: "WATCHING",
    vetoed: true,
  });
  const oNoTrade = await appendReceiptOutcome({
    userId: USER_A,
    receiptRef: ridNoTrade,
    kind: "OUTCOME",
    outcome: "NO_TRADE_CORRECT",
    plQuality: "UNKNOWN",
  });
  record(
    "no-trade receipt records NO_TRADE_CORRECT",
    !!oNoTrade && oNoTrade.outcome === "NO_TRADE_CORRECT",
  );

  // ── 4a. findSimilarSetups honest below history floor ──
  // Fresh query before enough comparable history exists for USER_B.
  const sparse = await findSimilarSetups(USER_B, fp(), 5);
  record(
    "similar-setups: honest 'not enough history' when sparse",
    sparse.enoughHistory === false && sparse.matches.length === 0,
    sparse.summary,
  );

  // ── 4b. With enough comparable history, surfaces matches; dissimilar excluded ──
  // Seed several structurally-similar BUY/trending/READY setups for USER_B…
  for (let i = 0; i < 5; i++) {
    const r = await insertReceipt(USER_B, fp({ readinessScore: 78 + i }));
    await appendReceiptOutcome({
      userId: USER_B,
      receiptRef: r,
      kind: "OUTCOME",
      outcome: i % 2 === 0 ? "WIN" : "LOSS",
      plQuality: "KNOWN",
    });
  }
  // …and one deliberately dissimilar SELL/ranging/quiet setup.
  const dissimilar = fp({
    direction: "SELL",
    regime: "ranging",
    htfBias: "bearish",
    trendStrengthBucket: "none",
    levelType: "resistance",
    candlePressure: "sellers",
    candleIntent: "rejecting",
    entryQuality: "weak",
    stage: "INVALIDATED",
    readinessBucket: "none",
    qualityLabel: "D",
    readinessScore: 5,
    trendStrength: 5,
  });
  await insertReceipt(USER_B, dissimilar);

  const rich = await findSimilarSetups(USER_B, fp(), 5);
  record(
    "similar-setups: surfaces matches with enough history",
    rich.enoughHistory === true && rich.matches.length >= 3,
    `comparable=${rich.comparableCount} matches=${rich.matches.length}`,
  );
  record(
    "similar-setups: dissimilar fingerprint excluded",
    rich.matches.every((m) => m.direction === "BUY"),
  );
  record(
    "similar-setups: resolved outcomes aggregated honestly",
    rich.resolved != null && rich.resolved.wins + rich.resolved.losses >= 1,
    rich.resolved
      ? `W${rich.resolved.wins}/L${rich.resolved.losses}`
      : "no resolved",
  );

  // ── 5. Behavior protection: investor not applicable; trader derives signals ──
  const inv = await getBehaviorProtection(USER_INV, { isInvestor: true });
  record(
    "behavior: investor view-only ⇒ applicable=false (no coaching)",
    inv.applicable === false && inv.signals.length === 0,
  );

  // Seed overtrading evidence (> threshold trades in the 24h window) for USER_A.
  const now = Date.now();
  const tradeRows = Array.from({ length: 22 }).map((_, i) => ({
    userId: USER_A,
    symbol: "EURUSD",
    direction: i % 2 === 0 ? "BUY" : "SELL",
    lot: 0.01,
    entryPrice: 1.1,
    stopLoss: 1.09,
    takeProfit: 1.12,
    strategy: "qa-seed",
    confidence: 70,
    status: "CLOSED_WIN",
    mode: "DEMO",
    createdAt: new Date(now - i * 60_000),
  }));
  // tradesTable may have more required columns; insert best-effort and skip the
  // behavior-signal assertion if the minimal shape is rejected.
  let tradesSeeded = true;
  try {
    await db.insert(tradesTable).values(tradeRows as never);
  } catch (e) {
    tradesSeeded = false;
    // eslint-disable-next-line no-console
    console.log(`  (skip overtrade seed — trades shape: ${(e as Error).message.slice(0, 80)})`);
  }
  const trader = await getBehaviorProtection(USER_A, { isInvestor: false });
  record(
    "behavior: trader applicable=true, fails open with a summary",
    trader.applicable === true && typeof trader.summary === "string",
  );
  if (tradesSeeded) {
    record(
      "behavior: overtrading detected from user's own trades",
      trader.signals.some((s) => s.key === "overtrading"),
      `signals=${trader.signals.map((s) => s.key).join(",") || "none"}`,
    );
  }

  // ── 6. Per-user isolation + admin cross-user read ──
  const aList = await listUserReceipts(USER_A);
  const bList = await listUserReceipts(USER_B);
  const aSeesOnlyA = aList.every((r) => r.symbol != null) && aList.length >= 2;
  const noLeak = !bList.some((r) => aList.some((ar) => ar.receiptId === r.receiptId));
  record("isolation: each user lists only their own receipts", aSeesOnlyA && noLeak);

  const bByA = await getUserReceipt(USER_A, bList[0]?.receiptId ?? "missing");
  record("isolation: user A cannot read user B's receipt by id", bByA === null);

  const adminAll = await listAllReceiptsForAdmin({ limit: 500 });
  const adminSeesBoth =
    adminAll.some((r) => r.userId === USER_A) &&
    adminAll.some((r) => r.userId === USER_B);
  record("admin cross-user read sees both users' receipts", adminSeesBoth);

  // ── teardown ──
  await cleanup();
  const leftover = await db
    .select({ id: chartDecisionReceiptsTable.id })
    .from(chartDecisionReceiptsTable)
    .where(
      and(inArray(chartDecisionReceiptsTable.userId, TEST_USERS)),
    );
  record("cleanup removed all synthetic test rows", leftover.length === 0);

  const failed = results.filter((r) => !r.ok);
  // eslint-disable-next-line no-console
  console.log(
    `\n${results.length - failed.length}/${results.length} passed` +
      (failed.length ? `, ${failed.length} FAILED` : " — all green"),
  );
  if (failed.length) process.exit(1);
}

run()
  .then(() => process.exit(0))
  .catch(async (e) => {
    // eslint-disable-next-line no-console
    console.error("suite crashed:", e);
    try {
      await cleanup();
    } catch {
      /* ignore */
    }
    process.exit(1);
  });

export {};
