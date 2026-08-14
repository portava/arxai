// Chart Brain v2 — Task 6: benchmark + annotations + AI-alerts regression suite.
//
// Pins the inviolable behavior of the three Task-6 deliverables:
//
//   A. BENCHMARK (admin-only, cross-user aggregation; REAL data only):
//      1. Always 15 scores incl `overall`; every score is null OR a real 0–100.
//      2. HONEST NULL contract: a non-null score is backed by ≥ MIN_SAMPLE real
//         rows; a null score says so (insufficient / no activity) — never a
//         fabricated number.
//      3. windowDays is clamped to [1,90].
//      4. Real receipts/outcomes flow into the totals (delta is exact, capped at
//         the query limit) — the dashboard counts real rows, never invents them.
//      5. recentFailedReads / recentSuccessfulNoTrades carry only real receiptIds.
//
//   B. ANNOTATIONS (per-user, SOFT-delete):
//      6. create → active in list; dismiss → excluded by default, present with
//         includeDismissed (soft-delete honored, never hard-deleted).
//      7. isolation: user B cannot dismiss or see user A's annotation.
//      8. listActivePriceAlerts returns only the user's active PRICE_ALERTs.
//
//   C. AI-AWARE ALERTS (transition-driven, role-aware, deduped, expiring; NEVER
//      trades):
//      9. setup-ready transition fires once; an identical re-scan is silent
//         (no-spam at the transition layer).
//     10. INVESTOR role suppresses the trade-oriented ready alert.
//     11. risk veto ON fires; veto OFF clears the same alert.
//     12. a price-alert annotation past its expiry is soft-dismissed, not fired.
//     13. a price-alert crossing fires once and marks the annotation triggered.
//
// SAFETY: this suite only touches additive chart_* / user_alerts rows under
// synthetic NEGATIVE test user ids. It places / modifies / closes NOTHING, never
// reaches the live pipeline, kill switch, 16-gate evaluator, or any broker/EA
// surface, and cleans up exactly the rows it created (scoped to the synthetic
// ids) at the end.

import { randomUUID } from "node:crypto";
import {
  db,
  chartDecisionReceiptsTable,
  chartDecisionOutcomesTable,
  chartAnnotationsTable,
  chartAlertStateTable,
  userAlertsTable,
  type NewChartDecisionReceipt,
} from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";
import { computeChartBrainBenchmark } from "../../artifacts/api-server/src/lib/chart/benchmarkScore.js";
import { appendReceiptOutcome } from "../../artifacts/api-server/src/lib/chart/decisionReceipts.js";
import {
  createAnnotation,
  listAnnotations,
  dismissAnnotation,
  listActivePriceAlerts,
} from "../../artifacts/api-server/src/lib/chart/chartAnnotations.js";
import { scanChartAlerts } from "../../artifacts/api-server/src/lib/chart/aiAlerts.js";
import type { ChartIntelligenceState } from "../../artifacts/api-server/src/lib/data/chart/chartIntelligence.js";

// Synthetic, isolated test identities (negative ids never collide with real users).
const USER_A = -178_001;
const USER_B = -178_002;
const USER_INV = -178_003;
const TEST_USERS = [USER_A, USER_B, USER_INV];

const MIN_SAMPLE = 3; // mirrors benchmarkScore's honesty floor
const BENCHMARK_RECEIPT_CAP = 2000; // mirrors the aggregation query .limit()
const BENCHMARK_OUTCOME_CAP = 4000;

type CaseResult = { name: string; ok: boolean; detail?: string };
const results: CaseResult[] = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function insertReceipt(
  userId: number,
  over: Partial<NewChartDecisionReceipt> = {},
): Promise<string> {
  const receiptId = randomUUID();
  const row: NewChartDecisionReceipt = {
    receiptId,
    userId,
    symbol: "EURUSD",
    timeframe: "M5",
    source: "chart_read",
    intent: "analyze",
    direction: "BUY",
    tradeType: "scalp",
    setupStage: "READY",
    setupFreshness: "fresh",
    readinessScore: 80,
    qualityLabel: "A",
    fpRegime: "trending",
    fpHtfBias: "bullish",
    fpLevelType: "support",
    fpStage: "READY",
    fpReadinessBucket: "high",
    fingerprint: { symbol: "EURUSD", timeframe: "M5", direction: "BUY" } as unknown as Record<
      string,
      unknown
    >,
    ...over,
  };
  await db.insert(chartDecisionReceiptsTable).values(row);
  return receiptId;
}

// Minimal Chart Intelligence State fixture — only the fields read by the
// alert scanner's snapshotOf() matter; the rest are cast away (test-only).
function state(over: {
  symbol?: string;
  actionability?: ChartIntelligenceState["decisionState"]["actionability"];
  stage?: string;
  vetoed?: boolean;
  conflict?: boolean;
  feedBad?: boolean;
  lastClose?: number | null;
}): ChartIntelligenceState {
  const symbol = over.symbol ?? "EURUSD";
  return {
    symbol,
    displaySymbol: symbol,
    timeframe: "M5",
    aiUsable: over.feedBad ? false : true,
    stale: over.feedBad ? true : false,
    setupState: { stage: over.stage ?? "forming" },
    decisionState: {
      actionability: over.actionability ?? "watch",
      vetoed: over.vetoed ?? false,
    },
    agentConsensus: { conflict: over.conflict ?? false },
    candleStats: { lastClose: over.lastClose ?? 1.1 },
  } as unknown as ChartIntelligenceState;
}

async function cleanup() {
  await db.delete(userAlertsTable).where(inArray(userAlertsTable.userId, TEST_USERS));
  await db
    .delete(chartAlertStateTable)
    .where(inArray(chartAlertStateTable.userId, TEST_USERS));
  await db
    .delete(chartAnnotationsTable)
    .where(inArray(chartAnnotationsTable.userId, TEST_USERS));
  await db
    .delete(chartDecisionOutcomesTable)
    .where(inArray(chartDecisionOutcomesTable.userId, TEST_USERS));
  await db
    .delete(chartDecisionReceiptsTable)
    .where(inArray(chartDecisionReceiptsTable.userId, TEST_USERS));
}

async function run() {
  // eslint-disable-next-line no-console
  console.log("Chart Brain v2 — Task 6 benchmark/annotations/alerts suite\n");
  await cleanup(); // start clean (defensive — prior aborted run)

  // ════════════════════════ A. BENCHMARK ════════════════════════
  const base = await computeChartBrainBenchmark();
  const keys = base.scores.map((s) => String(s.key));
  const expectedKeys = [
    "feed_truth",
    "reliability",
    "speed",
    "structure_read",
    "timing",
    "risk_detection",
    "scalp_accuracy",
    "entry_quality",
    "exit_realism",
    "agent_agreement",
    "ruby_explanation_quality",
    "no_trade_discipline",
    "review_learning",
    "similar_setup_usefulness",
    "overall",
  ];
  record(
    "benchmark: exactly 15 scores incl every expected key + overall",
    base.scores.length === 15 && expectedKeys.every((k) => keys.includes(k)),
    `keys=${keys.length}`,
  );
  record(
    "benchmark: every score is null OR a real 0–100 number",
    base.scores.every(
      (s) =>
        s.score === null ||
        (typeof s.score === "number" && s.score >= 0 && s.score <= 100),
    ),
  );
  record(
    "benchmark: HONEST NULL — every non-null score backed by ≥ MIN_SAMPLE rows",
    base.scores.every((s) => s.score === null || s.sampleSize >= MIN_SAMPLE),
  );
  record(
    "benchmark: every null score declares insufficient / no activity (no silent zero)",
    base.scores.every(
      (s) => s.score !== null || /insufficient|no chart-brain activity|need ≥/i.test(s.note),
    ),
  );

  // windowDays clamp
  const clampHi = await computeChartBrainBenchmark({ windowDays: 1000 });
  const clampLo = await computeChartBrainBenchmark({ windowDays: 0 });
  record(
    "benchmark: windowDays clamped to [1,90]",
    clampHi.windowDays === 90 && clampLo.windowDays === 1,
    `hi=${clampHi.windowDays} lo=${clampLo.windowDays}`,
  );

  // Real-data delta: insert K receipts + M outcomes, recompute, totals move by
  // the exact amount (capped at the query limit). Proves real rows are counted,
  // never fabricated.
  const K = 6;
  const insertedReceiptIds: string[] = [];
  for (let i = 0; i < K; i++) {
    const verdict =
      i === 0 ? "LOSS" : i === 1 ? "NO_TRADE_CORRECT" : i % 2 === 0 ? "WIN" : "LOSS";
    const rid = await insertReceipt(USER_A, {
      setupStage: verdict === "NO_TRADE_CORRECT" ? "WATCHING" : "READY",
    });
    insertedReceiptIds.push(rid);
    await appendReceiptOutcome({
      userId: USER_A,
      receiptRef: rid,
      kind: "OUTCOME",
      outcome: verdict,
      plQuality: verdict === "WIN" || verdict === "LOSS" ? "KNOWN" : "UNKNOWN",
      realizedPl: verdict === "WIN" ? 10 : verdict === "LOSS" ? -8 : undefined,
    });
  }
  const after = await computeChartBrainBenchmark();
  const expReceipts = Math.min(base.totalReceipts + K, BENCHMARK_RECEIPT_CAP);
  const expOutcomes = Math.min(base.totalOutcomes + K, BENCHMARK_OUTCOME_CAP);
  record(
    "benchmark: real receipts counted (exact delta, capped at query limit)",
    after.totalReceipts === expReceipts,
    `base=${base.totalReceipts} +${K} → ${after.totalReceipts} (exp ${expReceipts})`,
  );
  record(
    "benchmark: real outcomes counted (exact delta, capped at query limit)",
    after.totalOutcomes === expOutcomes,
    `base=${base.totalOutcomes} +${K} → ${after.totalOutcomes} (exp ${expOutcomes})`,
  );
  record(
    "benchmark: recent failed/no-trade lists carry only real receiptIds",
    [...after.recentFailedReads, ...after.recentSuccessfulNoTrades].every(
      (r) => typeof r.receiptId === "string" && r.receiptId.length > 0,
    ),
  );
  // The honesty contract must STILL hold after real data lands.
  record(
    "benchmark: honest-null contract holds after real data lands",
    after.scores.every((s) => s.score === null || s.sampleSize >= MIN_SAMPLE) &&
      after.scores.every(
        (s) =>
          s.score === null ||
          (typeof s.score === "number" && s.score >= 0 && s.score <= 100),
      ),
  );

  // ════════════════════════ B. ANNOTATIONS ════════════════════════
  const supRow = await createAnnotation({
    userId: USER_A,
    symbol: "EURUSD",
    kind: "SUPPORT",
    price: 1.085,
    note: "demand zone",
  });
  record("annotations: create returns a row", !!supRow);

  const activeList = await listAnnotations(USER_A, { symbol: "EURUSD" });
  record(
    "annotations: created mark appears active in list",
    activeList.some((a) => a.id === supRow?.id && a.status === "active"),
  );

  const dismissed = supRow ? await dismissAnnotation(USER_A, supRow.id) : false;
  const afterDismissDefault = await listAnnotations(USER_A, { symbol: "EURUSD" });
  const afterDismissIncl = await listAnnotations(USER_A, {
    symbol: "EURUSD",
    includeDismissed: true,
  });
  record(
    "annotations: SOFT-delete — excluded by default, present with includeDismissed",
    dismissed &&
      !afterDismissDefault.some((a) => a.id === supRow?.id) &&
      afterDismissIncl.some((a) => a.id === supRow?.id && a.status === "dismissed"),
  );

  // isolation
  const aRow = await createAnnotation({
    userId: USER_A,
    symbol: "GBPUSD",
    kind: "RESISTANCE",
    price: 1.27,
  });
  const bDismissA = aRow ? await dismissAnnotation(USER_B, aRow.id) : true;
  const bList = await listAnnotations(USER_B, {});
  record(
    "annotations: isolation — user B cannot dismiss or see user A's row",
    bDismissA === false && !bList.some((a) => a.id === aRow?.id),
  );

  // active price alerts only
  await createAnnotation({
    userId: USER_A,
    symbol: "EURUSD",
    kind: "PRICE_ALERT",
    direction: "above",
    price: 1.2,
  });
  const activeAlerts = await listActivePriceAlerts(USER_A, "EURUSD");
  record(
    "annotations: listActivePriceAlerts returns only active PRICE_ALERTs",
    activeAlerts.length === 1 &&
      activeAlerts.every((a) => a.kind === "PRICE_ALERT" && a.status === "active"),
    `count=${activeAlerts.length}`,
  );

  // ════════════════════════ C. AI-AWARE ALERTS ════════════════════════
  // 9. ready transition fires once; identical re-scan is silent.
  const ready1 = await scanChartAlerts(USER_B, "USER", state({ actionability: "ready" }));
  const ready2 = await scanChartAlerts(USER_B, "USER", state({ actionability: "ready" }));
  record(
    "alerts: setup-ready fires on transition",
    ready1.evaluated &&
      ready1.fired.some((f) => f.alertType.startsWith("chart_setup_ready:")),
    `fired=${ready1.fired.map((f) => f.alertType).join(",") || "none"}`,
  );
  record(
    "alerts: identical re-scan is silent (no-spam at transition layer)",
    ready2.fired.every((f) => !f.alertType.startsWith("chart_setup_ready:")),
  );

  // 10. INVESTOR suppresses the trade-oriented ready alert.
  const inv = await scanChartAlerts(
    USER_INV,
    "INVESTOR",
    state({ actionability: "ready" }),
  );
  record(
    "alerts: INVESTOR role suppresses the ready alert",
    inv.fired.every((f) => !f.alertType.startsWith("chart_setup_ready:")),
  );

  // 11. risk veto ON fires; OFF clears.
  const vetoOn = await scanChartAlerts(USER_A, "USER", state({ vetoed: true }));
  const vetoOff = await scanChartAlerts(USER_A, "USER", state({ vetoed: false }));
  record(
    "alerts: risk veto ON fires chart_risk_veto",
    vetoOn.fired.some((f) => f.alertType.startsWith("chart_risk_veto:")),
  );
  record(
    "alerts: risk veto OFF clears chart_risk_veto",
    vetoOff.cleared.some((c) => c.startsWith("chart_risk_veto:")),
    `cleared=${vetoOff.cleared.join(",") || "none"}`,
  );

  // 12. expired price-alert annotation is soft-dismissed, not fired.
  const expired = await createAnnotation({
    userId: USER_INV,
    symbol: "USDJPY",
    kind: "PRICE_ALERT",
    direction: "above",
    price: 150,
    expiresAt: new Date(Date.now() - 60_000),
  });
  const expScan = await scanChartAlerts(
    USER_INV,
    "INVESTOR",
    state({ symbol: "USDJPY", lastClose: 151 }), // would cross, but it is expired
  );
  // re-fetch the row's status (must be soft-dismissed by the scan)
  const expRowAfter = expired
    ? await listAnnotations(USER_INV, { symbol: "USDJPY", includeDismissed: true })
    : [];
  record(
    "alerts: expired price-alert is soft-dismissed, never fired",
    expScan.fired.every((f) => !f.alertType.startsWith("chart_price_alert:")) &&
      expRowAfter.some((a) => a.id === expired?.id && a.status === "dismissed"),
  );

  // 13. price-alert crossing fires once and marks the annotation triggered.
  const cross = await createAnnotation({
    userId: USER_A,
    symbol: "AUDUSD",
    kind: "PRICE_ALERT",
    direction: "above",
    price: 0.65,
  });
  const crossScan = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "AUDUSD", lastClose: 0.66 }), // first scan already on the alerting side
  );
  const crossRowAfter = cross
    ? await listAnnotations(USER_A, { symbol: "AUDUSD", includeDismissed: true })
    : [];
  record(
    "alerts: price-alert crossing fires once and marks annotation triggered",
    crossScan.fired.some((f) => f.alertType === `chart_price_alert:${cross?.id}`) &&
      crossRowAfter.some((a) => a.id === cross?.id && a.status === "triggered"),
  );

  // ── 14. watchlist → active (triggered) fires chart_setup_active ──────────
  await scanChartAlerts(USER_A, "USER", state({ symbol: "NZDUSD", stage: "watchlist" }));
  const active2 = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "NZDUSD", stage: "trigger" }),
  );
  record(
    "alerts: watchlist→active fires chart_setup_active",
    active2.fired.some((f) => f.alertType.startsWith("chart_setup_active:")),
    `fired=${active2.fired.map((f) => f.alertType).join(",") || "none"}`,
  );

  // ── 15. retest hold fires chart_retest_hold (trigger → confirmation_needed) ─
  await scanChartAlerts(USER_A, "USER", state({ symbol: "EURJPY", stage: "trigger" }));
  const retest = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "EURJPY", stage: "confirmation_needed" }),
  );
  record(
    "alerts: confirmation reached fires chart_retest_hold",
    retest.fired.some((f) => f.alertType.startsWith("chart_retest_hold:")),
  );

  // ── 16. stale vs invalid are DISTINCT alerts (split) ─────────────────────
  await scanChartAlerts(USER_A, "USER", state({ symbol: "CADJPY", stage: "trigger" }));
  const staleScan = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "CADJPY", stage: "stale" }),
  );
  const invalidScan = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "CADJPY", stage: "invalid" }),
  );
  record(
    "alerts: stale fires chart_setup_stale (not invalid)",
    staleScan.fired.some((f) => f.alertType.startsWith("chart_setup_stale:")) &&
      staleScan.fired.every((f) => !f.alertType.startsWith("chart_setup_invalid:")),
  );
  record(
    "alerts: invalid fires chart_setup_invalid distinctly (and clears stale)",
    invalidScan.fired.some((f) => f.alertType.startsWith("chart_setup_invalid:")) &&
      invalidScan.cleared.some((c) => c.startsWith("chart_setup_stale:")),
  );

  // ── 17. no-trade stand-aside cleared ─────────────────────────────────────
  await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "CHFJPY", actionability: "stand_aside" }),
  );
  const noTradeClear = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "CHFJPY", actionability: "watch" }),
  );
  record(
    "alerts: stand-aside cleared fires chart_no_trade_cleared",
    noTradeClear.fired.some((f) => f.alertType.startsWith("chart_no_trade_cleared:")),
  );

  // ── 18. conflict → agreement (clears conflict + fires agreement) ─────────
  await scanChartAlerts(USER_A, "USER", state({ symbol: "GBPJPY", conflict: true }));
  const agree = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "GBPJPY", conflict: false }),
  );
  record(
    "alerts: conflict→agreement clears conflict and fires chart_agent_agreement",
    agree.cleared.some((c) => c.startsWith("chart_agent_conflict:")) &&
      agree.fired.some((f) => f.alertType.startsWith("chart_agent_agreement:")),
  );

  // ── 19. scalp flame ignite (honest flame signal only) ────────────────────
  const flameSig = (
    stage: string,
    entryTiming: string,
  ): NonNullable<Parameters<typeof scanChartAlerts>[3]> => ({
    flame: { stage: stage as never, entryTiming: entryTiming as never, blind: false },
  });
  const flameIgnite = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "XAUUSD" }),
    flameSig("IGNITING", "CLEAN"),
  );
  record(
    "alerts: flame ignite fires chart_scalp_flame",
    flameIgnite.fired.some((f) => f.alertType.startsWith("chart_scalp_flame:")),
  );

  // ── 20 + 21. entry late, then entry timing clean again ───────────────────
  await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "GBPAUD" }),
    flameSig("ACTIVE", "CLEAN"),
  );
  const late = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "GBPAUD" }),
    flameSig("ACTIVE", "LATE"),
  );
  const cleanAgain = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "GBPAUD" }),
    flameSig("ACTIVE", "CLEAN"),
  );
  record(
    "alerts: late entry fires chart_scalp_late",
    late.fired.some((f) => f.alertType.startsWith("chart_scalp_late:")),
  );
  record(
    "alerts: timing recovered fires chart_entry_clean",
    cleanAgain.fired.some((f) => f.alertType.startsWith("chart_entry_clean:")),
  );

  // ── 22. blind flame fires NOTHING (honest insufficient read) ─────────────
  const blindFlame = await scanChartAlerts(USER_A, "USER", state({ symbol: "USDCHF" }), {
    flame: { stage: "IGNITING" as never, entryTiming: "CLEAN" as never, blind: true },
  });
  record(
    "alerts: blind flame read fires no flame alert",
    blindFlame.fired.every((f) => !f.alertType.startsWith("chart_scalp_")),
  );

  // ── 23. open-position danger near stop; clears when price recovers ────────
  const dangerPos = { id: 9001, side: "BUY" as const, entry: 1.0, sl: 0.99, tp: 1.02 };
  const danger = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "EURGBP", lastClose: 0.992 }),
    { openPositions: [dangerPos] },
  );
  const dangerClear = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "EURGBP", lastClose: 1.0 }),
    { openPositions: [dangerPos] },
  );
  record(
    "alerts: open position near stop fires chart_trade_danger",
    danger.fired.some((f) => f.alertType === `chart_trade_danger:EURGBP:${dangerPos.id}`),
  );
  record(
    "alerts: position danger clears when price recovers",
    dangerClear.cleared.some((c) => c === `chart_trade_danger:EURGBP:${dangerPos.id}`),
  );

  // ── 24. open-position partial-TP zone ────────────────────────────────────
  const tpPos = { id: 9002, side: "BUY" as const, entry: 1.0, sl: 0.99, tp: 1.02 };
  const partial = await scanChartAlerts(
    USER_A,
    "USER",
    state({ symbol: "EURCHF", lastClose: 1.0175 }),
    { openPositions: [tpPos] },
  );
  record(
    "alerts: position in target zone fires chart_partial_tp",
    partial.fired.some((f) => f.alertType === `chart_partial_tp:EURCHF:${tpPos.id}`),
  );

  // ── 25. ROLE MATRIX — investor gets ONLY feed-degraded, never any trade
  //        alert, even when every trade-oriented condition is present at once
  //        AND a price-alert annotation would cross.
  await createAnnotation({
    userId: USER_INV,
    symbol: "INVMTX",
    kind: "PRICE_ALERT",
    direction: "above",
    price: 0.5, // lastClose (0.9925) is already above → would cross for a user
  });
  const invMatrix = await scanChartAlerts(
    USER_INV,
    "INVESTOR",
    state({
      symbol: "INVMTX",
      stage: "trigger",
      actionability: "ready",
      vetoed: true,
      conflict: true,
      feedBad: true,
      lastClose: 0.9925,
    }),
    {
      flame: { stage: "IGNITING" as never, entryTiming: "LATE" as never, blind: false },
      openPositions: [{ id: 9003, side: "BUY", entry: 1.0, sl: 0.99, tp: 1.02 }],
    },
  );
  const TRADE_PREFIXES = [
    "chart_setup_ready:",
    "chart_setup_active:",
    "chart_retest_hold:",
    "chart_setup_stale:",
    "chart_setup_invalid:",
    "chart_no_trade_cleared:",
    "chart_risk_veto:",
    "chart_agent_conflict:",
    "chart_agent_agreement:",
    "chart_scalp_",
    "chart_entry_clean:",
    "chart_trade_danger:",
    "chart_partial_tp:",
    "chart_price_alert:",
  ];
  record(
    "alerts: ROLE MATRIX — investor receives ONLY chart_feed_stale, zero trade alerts",
    invMatrix.fired.some((f) => f.alertType.startsWith("chart_feed_stale:")) &&
      invMatrix.fired.every(
        (f) => !TRADE_PREFIXES.some((p) => f.alertType.startsWith(p)),
      ),
    `fired=${invMatrix.fired.map((f) => f.alertType).join(",") || "none"}`,
  );

  // Alerts are informational rows only — every fired alert persisted with the
  // chart_brain source and NONE carries any execution/trade capability.
  const persisted = await db
    .select()
    .from(userAlertsTable)
    .where(inArray(userAlertsTable.userId, TEST_USERS));
  record(
    "alerts: persisted as informational notifications (source=chart_brain, never trade)",
    persisted.length > 0 && persisted.every((a) => a.source === "chart_brain"),
    `rows=${persisted.length}`,
  );

  // ════════════════════════ teardown ════════════════════════
  await cleanup();
  const leftoverAnn = await db
    .select({ id: chartAnnotationsTable.id })
    .from(chartAnnotationsTable)
    .where(and(inArray(chartAnnotationsTable.userId, TEST_USERS)));
  const leftoverAlerts = await db
    .select({ id: userAlertsTable.id })
    .from(userAlertsTable)
    .where(inArray(userAlertsTable.userId, TEST_USERS));
  const leftoverReceipts = await db
    .select({ id: chartDecisionReceiptsTable.id })
    .from(chartDecisionReceiptsTable)
    .where(inArray(chartDecisionReceiptsTable.userId, TEST_USERS));
  record(
    "cleanup removed all synthetic test rows",
    leftoverAnn.length === 0 &&
      leftoverAlerts.length === 0 &&
      leftoverReceipts.length === 0,
  );

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
