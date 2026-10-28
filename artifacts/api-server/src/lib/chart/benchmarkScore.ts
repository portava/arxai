// Chart Brain v2 — Task 6: Benchmark scoring service (SLOW BRAIN, read-only).
//
// Aggregates ONLY real, already-recorded data — immutable decision receipts,
// appended outcomes/reviews, and persisted agent-governance traces — into 15
// benchmark scores plus trend, weak areas, recent failed reads, recent
// successful no-trades, and speed/feed warnings.
//
// HARD RULE — no fabricated scores. A score is a real number only when there is
// enough real evidence (>= MIN_SAMPLE rows feeding it); otherwise it returns
// `score: null` with an honest "insufficient data" note. Nothing here places,
// modifies, or closes a trade, and it never touches the live path.

import {
  db,
  chartDecisionReceiptsTable,
  chartDecisionOutcomesTable,
  agentGovernanceTracesTable,
} from "@workspace/db";
import { desc, gte } from "drizzle-orm";
import { logger } from "../logger.js";

const MIN_SAMPLE = 3; // below this a score is "insufficient data" (null)
const WINDOW_DAYS = 30;
// Row caps per query. Each query asks for one row more than its cap so a
// window that holds more rows than were read is reported, not hidden.
const RECEIPT_CAP = 2000;
const OUTCOME_CAP = 4000;
const TRACE_CAP = 2000;
const TREND_DAYS = 14;
// Speed budgets (ms). A read is "slow" when state build OR governance runtime
// exceeds these. Deliberately generous — these are honest soft warnings, not
// gates.
const STATE_BUILD_BUDGET_MS = 250;
const GOV_RUNTIME_BUDGET_MS = 400;

export type BenchmarkScoreKey =
  | "feed_truth"
  | "reliability"
  | "speed"
  | "structure_read"
  | "timing"
  | "risk_detection"
  | "scalp_accuracy"
  | "entry_quality"
  | "exit_realism"
  | "agent_agreement"
  | "ruby_explanation_quality"
  | "no_trade_discipline"
  | "review_learning"
  | "similar_setup_usefulness"
  | "overall";

export interface BenchmarkScore {
  key: BenchmarkScoreKey;
  label: string;
  /** 0–100, or null when there is not enough real evidence. */
  score: number | null;
  /** How many real rows fed this score. */
  sampleSize: number;
  /** Honest one-liner (what was measured / why null). */
  note: string;
}

export interface BenchmarkTrendPoint {
  date: string; // YYYY-MM-DD
  reads: number;
  resolved: number;
  winRate: number | null; // wins / (wins+losses)
}

export interface BenchmarkRecentRead {
  receiptId: string;
  userId: number;
  symbol: string;
  timeframe: string;
  intent: string | null;
  direction: string | null;
  outcome: string | null;
  qualityLabel: string | null;
  createdAt: string;
}

export interface BenchmarkResult {
  generatedAt: string;
  windowDays: number;
  totalReceipts: number;
  totalOutcomes: number;
  totalReviews: number;
  totalTraces: number;
  scores: BenchmarkScore[];
  trend: BenchmarkTrendPoint[];
  weakAreas: BenchmarkScore[];
  recentFailedReads: BenchmarkRecentRead[];
  recentSuccessfulNoTrades: BenchmarkRecentRead[];
  warnings: string[];
}

const LABELS: Record<BenchmarkScoreKey, string> = {
  feed_truth: "Feed Truth",
  reliability: "Reliability",
  speed: "Speed",
  structure_read: "Structure Read",
  timing: "Timing",
  risk_detection: "Risk Detection",
  scalp_accuracy: "Scalp Accuracy",
  entry_quality: "Entry Quality",
  exit_realism: "Exit Realism",
  agent_agreement: "Agent Agreement",
  ruby_explanation_quality: "Ruby Explanation Quality",
  no_trade_discipline: "No-Trade Discipline",
  review_learning: "Review / Learning",
  similar_setup_usefulness: "Similar-Setup Usefulness",
  overall: "Overall",
};

// ── helpers ─────────────────────────────────────────────────────────────────

/** Build a real-number score from a numerator/denominator with honest gating. */
function ratioScore(
  key: BenchmarkScoreKey,
  numerator: number,
  denominator: number,
  measuredNote: string,
): BenchmarkScore {
  if (denominator < MIN_SAMPLE) {
    return {
      key,
      label: LABELS[key],
      score: null,
      sampleSize: denominator,
      note: `Insufficient data (need ≥${MIN_SAMPLE}, have ${denominator}).`,
    };
  }
  const score = Math.round((numerator / denominator) * 100);
  return {
    key,
    label: LABELS[key],
    score: Math.max(0, Math.min(100, score)),
    sampleSize: denominator,
    note: measuredNote,
  };
}

function dayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

interface SnapshotView {
  stale: boolean | null;
  aiUsable: boolean | null;
  truthState: string | null;
  stateBuildMs: number | null;
}

/**
 * Feed/speed facts recorded on a receipt. They live in the receipt's
 * chartTruthSnapshot (truthState / stale / aiUsable; see decisionReceipts.ts);
 * intelligenceSnapshot holds none of them. No snapshot records the state-build
 * time today, so stateBuildMs is null unless a receipt carries speedState.
 */
function readSnapshot(raw: unknown): SnapshotView {
  const s = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const speed = (s["speedState"] && typeof s["speedState"] === "object"
    ? s["speedState"]
    : {}) as Record<string, unknown>;
  return {
    stale: typeof s["stale"] === "boolean" ? (s["stale"] as boolean) : null,
    aiUsable: typeof s["aiUsable"] === "boolean" ? (s["aiUsable"] as boolean) : null,
    truthState: typeof s["truthState"] === "string" ? (s["truthState"] as string) : null,
    stateBuildMs:
      typeof speed["stateBuildMs"] === "number" ? (speed["stateBuildMs"] as number) : null,
  };
}

// Receipts store the trade-readiness grade (ChartQualityLabel: A+ | A | B | C |
// D | F | unrated). "unrated" means no grade was given, so it is not counted.
const GOOD_QUALITY = new Set(["A+", "A"]);
const UNRATED_QUALITY = "unrated";

// The risk sentence (marketSentenceEngine sentenceRisk) is stored on EVERY
// receipt, including its all-clear line "Risk looks normal for this read — …".
// Only its warning forms ("Risk is high / too high / elevated / moderate …")
// count as a flag; any other text earns no credit.
const RISK_WARNING_SENTENCE = /^Risk is (?:high|too high|elevated|moderate)\b/;
export function riskSentenceIsWarning(text: string | null | undefined): boolean {
  return typeof text === "string" && RISK_WARNING_SENTENCE.test(text.trim());
}

/** A dimension the stored data cannot measure: null, with the reason. */
function notMeasured(key: BenchmarkScoreKey, note: string): BenchmarkScore {
  return { key, label: LABELS[key], score: null, sampleSize: 0, note };
}
const SCALP_INTENTS = new Set(["is-this-a-scalp"]);
const HIGH_CONF = 65;

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Compute the Chart Brain benchmark across all users (admin surface). The caller
 * MUST enforce admin access — this function performs no role check itself.
 * On a storage error it THROWS: an unreadable window is "could not be loaded",
 * never an empty "no activity" scorecard. The route turns the throw into an
 * error response, which the dashboard shows as "Could not load benchmark".
 */
export async function computeChartBrainBenchmark(opts?: {
  windowDays?: number;
}): Promise<BenchmarkResult> {
  const windowDays = Math.min(Math.max(opts?.windowDays ?? WINDOW_DAYS, 1), 90);
  const since = new Date(Date.now() - windowDays * 24 * 60 * 60 * 1000);
  const generatedAt = new Date().toISOString();

  const empty = (): BenchmarkResult => ({
    generatedAt,
    windowDays,
    totalReceipts: 0,
    totalOutcomes: 0,
    totalReviews: 0,
    totalTraces: 0,
    scores: (Object.keys(LABELS) as BenchmarkScoreKey[]).map((key) => ({
      key,
      label: LABELS[key],
      score: null,
      sampleSize: 0,
      note: `No chart-brain reads recorded in the last ${windowDays} days.`,
    })),
    trend: [],
    weakAreas: [],
    recentFailedReads: [],
    recentSuccessfulNoTrades: [],
    warnings: [],
  });

  let receipts: (typeof chartDecisionReceiptsTable.$inferSelect)[];
  let outcomes: (typeof chartDecisionOutcomesTable.$inferSelect)[];
  let traces: (typeof agentGovernanceTracesTable.$inferSelect)[];
  try {
    [receipts, outcomes, traces] = await Promise.all([
      db
        .select()
        .from(chartDecisionReceiptsTable)
        .where(gte(chartDecisionReceiptsTable.createdAt, since))
        .orderBy(desc(chartDecisionReceiptsTable.createdAt))
        .limit(RECEIPT_CAP + 1),
      db
        .select()
        .from(chartDecisionOutcomesTable)
        .where(gte(chartDecisionOutcomesTable.createdAt, since))
        .orderBy(desc(chartDecisionOutcomesTable.createdAt))
        .limit(OUTCOME_CAP + 1),
      db
        .select()
        .from(agentGovernanceTracesTable)
        .where(gte(agentGovernanceTracesTable.createdAt, since))
        .orderBy(desc(agentGovernanceTracesTable.createdAt))
        .limit(TRACE_CAP + 1),
    ]);
  } catch (err) {
    logger.warn({ err }, "benchmarkScore: aggregation query failed");
    throw new Error(
      "Chart Brain benchmark could not be loaded: the receipts, outcomes or governance traces could not be read.",
      { cause: err },
    );
  }

  // Coverage: say plainly when a window holds more rows than were read, so a
  // capped count is never shown as the window's total.
  const coverageWarnings: string[] = [];
  if (receipts.length > RECEIPT_CAP) {
    receipts = receipts.slice(0, RECEIPT_CAP);
    coverageWarnings.push(
      `This ${windowDays}-day window holds more than ${RECEIPT_CAP} receipts; only the newest ${RECEIPT_CAP} were read, so the Receipts total and every score cover those ${RECEIPT_CAP} only.`,
    );
  }
  if (outcomes.length > OUTCOME_CAP) {
    outcomes = outcomes.slice(0, OUTCOME_CAP);
    coverageWarnings.push(
      `This ${windowDays}-day window holds more than ${OUTCOME_CAP} outcomes and reviews; only the newest ${OUTCOME_CAP} were read, so older results are missing from the totals and scores.`,
    );
  }
  if (traces.length > TRACE_CAP) {
    traces = traces.slice(0, TRACE_CAP);
    coverageWarnings.push(
      `This ${windowDays}-day window holds more than ${TRACE_CAP} governance traces; only the newest ${TRACE_CAP} were read, so the Gov. traces total and the speed score cover those ${TRACE_CAP} only.`,
    );
  }

  if (receipts.length === 0) {
    const e = empty();
    e.totalTraces = traces.length;
    e.warnings = coverageWarnings;
    return e;
  }

  // Latest OUTCOME (objective verdict) + REVIEW presence per receipt.
  const verdictByReceipt = new Map<string, string>(); // receiptRef -> outcome
  const plQualityByReceipt = new Map<string, string>();
  const reviewedReceipts = new Set<string>();
  let totalReviews = 0;
  for (const o of outcomes) {
    if (o.kind === "REVIEW") {
      reviewedReceipts.add(o.receiptRef);
      totalReviews++;
      continue;
    }
    // OUTCOME — keep the most recent (outcomes already sorted desc by createdAt).
    if (!verdictByReceipt.has(o.receiptRef) && o.outcome) {
      verdictByReceipt.set(o.receiptRef, o.outcome);
      if (o.plQuality) plQualityByReceipt.set(o.receiptRef, o.plQuality);
    }
  }
  const totalOutcomes = verdictByReceipt.size;

  // ── 1. Feed truth — clean (aiUsable && !stale) reads ──────────────────────
  let feedClean = 0;
  let feedKnown = 0;
  let slowReads = 0;
  let speedKnown = 0;
  for (const r of receipts) {
    const snap = readSnapshot(r.chartTruthSnapshot);
    if (snap.aiUsable !== null || snap.stale !== null) {
      feedKnown++;
      if (snap.aiUsable === true && snap.stale !== true) feedClean++;
    }
    if (snap.stateBuildMs !== null) {
      speedKnown++;
      if (snap.stateBuildMs > STATE_BUILD_BUDGET_MS) slowReads++;
    }
  }

  // ── 3. Speed — governance runtime + state-build within budget ─────────────
  let slowGov = 0;
  for (const t of traces) {
    if (t.totalGovernanceRuntimeMs > GOV_RUNTIME_BUDGET_MS) slowGov++;
  }
  const speedDen = speedKnown + traces.length;
  const speedFast = speedKnown - slowReads + (traces.length - slowGov);

  // ── outcome partitions ────────────────────────────────────────────────────
  let wins = 0;
  let losses = 0;
  let breakeven = 0;
  let noTradeCorrect = 0;
  let noTradeMissed = 0;
  let plKnown = 0;
  let plResolved = 0;
  // risk detection: of bad results (LOSS / NO_TRADE_MISSED), how many were
  // flagged by a risk warning / veto at decision time.
  let badResults = 0;
  let badResultsFlagged = 0;
  // entry quality: high-confidence trade entries that won.
  let highConfTrades = 0;
  let highConfWins = 0;
  // timing: trade receipts whose setup stage was a real trigger/entry stage.
  let tradeReceipts = 0;
  let timelyTrades = 0;
  // scalp: scalp-intent receipts with a resolved trade verdict.
  let scalpResolved = 0;
  let scalpWins = 0;

  const receiptById = new Map<string, typeof chartDecisionReceiptsTable.$inferSelect>();
  for (const r of receipts) receiptById.set(r.receiptId, r);

  for (const r of receipts) {
    const verdict = verdictByReceipt.get(r.receiptId) ?? null;
    const isTrade =
      r.source === "chart_trade_plan" ||
      r.direction === "BUY" ||
      r.direction === "SELL";
    if (isTrade) {
      tradeReceipts++;
      if (r.setupStage === "trigger" || r.setupStage === "entry_valid") timelyTrades++;
    }
    if (verdict) {
      if (verdict === "WIN") wins++;
      else if (verdict === "LOSS") losses++;
      else if (verdict === "BREAKEVEN") breakeven++;
      else if (verdict === "NO_TRADE_CORRECT") noTradeCorrect++;
      else if (verdict === "NO_TRADE_MISSED") noTradeMissed++;

      const pq = plQualityByReceipt.get(r.receiptId);
      if (verdict === "WIN" || verdict === "LOSS" || verdict === "BREAKEVEN") {
        plResolved++;
        if (pq === "KNOWN") plKnown++;
      }

      if (verdict === "LOSS" || verdict === "NO_TRADE_MISSED") {
        badResults++;
        if (r.vetoed === true || riskSentenceIsWarning(r.riskWarning)) {
          badResultsFlagged++;
        }
      }

      if ((verdict === "WIN" || verdict === "LOSS") && (r.confidenceScore ?? 0) >= HIGH_CONF) {
        highConfTrades++;
        if (verdict === "WIN") highConfWins++;
      }

      if (SCALP_INTENTS.has(r.intent ?? "") || r.tradeType === "scalp") {
        if (verdict === "WIN" || verdict === "LOSS") {
          scalpResolved++;
          if (verdict === "WIN") scalpWins++;
        }
      }
    }
  }
  const tradeResolved = wins + losses + breakeven;

  // ── 4. Structure read — share of graded reads rated A+ or A ───────────────
  let qualityKnown = 0;
  let qualityGood = 0;
  for (const r of receipts) {
    const q = r.qualityLabel?.trim();
    if (q && q !== UNRATED_QUALITY) {
      qualityKnown++;
      if (GOOD_QUALITY.has(q)) qualityGood++;
    }
  }

  // ── 10. Agent agreement — only reads where agents were consulted ──────────
  // courtResult is null when no specialist agent influenced the read; such a
  // read has agentConflict=false by default, which is not agreement.
  const consulted = receipts.filter((r) => r.courtResult != null);
  const agentAgree = consulted.filter((r) => r.agentConflict !== true).length;
  const notConsulted = receipts.length - consulted.length;
  const notConsultedNote =
    notConsulted > 0 ? ` ${notConsulted} of ${receipts.length} reads had no agents consulted and are not counted.` : "";
  const agentAgreement = ratioScore(
    "agent_agreement",
    agentAgree,
    consulted.length,
    `${agentAgree}/${consulted.length} reads where specialist agents were consulted had them in agreement.${notConsultedNote}`,
  );
  if (agentAgreement.score === null) agentAgreement.note += notConsultedNote;

  // ── 11. Ruby explanation quality — not measured ───────────────────────────
  // No explanation is graded. Every read stores a headline and a
  // what-would-change line, so their presence says nothing about quality.

  // ── 14. Similar-setup usefulness — reads with prior matching history ───────
  // History availability proxy: a read is "supported" when at least one EARLIER
  // receipt shared its (fpRegime, fpStage, direction) fingerprint key.
  const fpSeen = new Map<string, number>();
  // receipts are desc by createdAt — walk oldest→newest so "earlier" is correct.
  const chrono = [...receipts].reverse();
  let fpSupported = 0;
  let fpEligible = 0;
  for (const r of chrono) {
    const fpKey = `${r.fpRegime ?? "?"}|${r.fpStage ?? "?"}|${r.direction ?? "?"}`;
    const prior = fpSeen.get(fpKey) ?? 0;
    fpEligible++;
    if (prior > 0) fpSupported++;
    fpSeen.set(fpKey, prior + 1);
  }

  const scores: BenchmarkScore[] = [
    ratioScore(
      "feed_truth",
      feedClean,
      feedKnown,
      `${feedClean}/${feedKnown} reads were on a clean, AI-usable feed (from each receipt's chart-truth snapshot).`,
    ),
    ratioScore(
      "reliability",
      wins,
      wins + losses,
      `${wins}/${wins + losses} resolved trades won.`,
    ),
    ratioScore(
      "speed",
      speedFast,
      speedDen,
      speedKnown === 0
        ? `${speedFast}/${speedDen} governance runs finished within ${GOV_RUNTIME_BUDGET_MS}ms. Read build times are not recorded on receipts, so reads are not counted.`
        : `${speedFast}/${speedDen} within budget: ${speedKnown - slowReads}/${speedKnown} reads built within ${STATE_BUILD_BUDGET_MS}ms and ${traces.length - slowGov}/${traces.length} governance runs finished within ${GOV_RUNTIME_BUDGET_MS}ms.`,
    ),
    ratioScore(
      "structure_read",
      qualityGood,
      qualityKnown,
      `${qualityGood}/${qualityKnown} graded reads were rated A+ or A by the trade-readiness grader.`,
    ),
    ratioScore(
      "timing",
      timelyTrades,
      tradeReceipts,
      `${timelyTrades}/${tradeReceipts} trade reads at a real trigger/entry stage.`,
    ),
    ratioScore(
      "risk_detection",
      badResultsFlagged,
      badResults,
      `${badResultsFlagged}/${badResults} losing or missed reads were vetoed or carried a risk warning at decision time.`,
    ),
    ratioScore(
      "scalp_accuracy",
      scalpWins,
      scalpResolved,
      `${scalpWins}/${scalpResolved} resolved scalp reads won.`,
    ),
    ratioScore(
      "entry_quality",
      highConfWins,
      highConfTrades,
      `${highConfWins}/${highConfTrades} high-confidence entries won.`,
    ),
    // P/L quality is whatever the user sent with POST …/outcome; nothing checks
    // it against broker fills, so it cannot earn points as "broker-known".
    notMeasured(
      "exit_realism",
      `Not measured: P/L quality on outcomes is entered by the user and not checked against broker fills. ${plKnown} of ${plResolved} resolved trades were reported by the user as having known P/L.`,
    ),
    agentAgreement,
    notMeasured(
      "ruby_explanation_quality",
      "Not measured: Ruby's explanations are not graded. Every read stores a headline and a what-would-change line, so their presence says nothing about quality.",
    ),
    ratioScore(
      "no_trade_discipline",
      noTradeCorrect,
      noTradeCorrect + noTradeMissed,
      `${noTradeCorrect}/${noTradeCorrect + noTradeMissed} no-trade calls were correct.`,
    ),
    ratioScore(
      "review_learning",
      reviewedReceipts.size,
      receipts.length,
      `${reviewedReceipts.size}/${receipts.length} reads were reviewed for learning.`,
    ),
    ratioScore(
      "similar_setup_usefulness",
      fpSupported,
      fpEligible,
      `${fpSupported}/${fpEligible} reads had prior matching setup history.`,
    ),
  ];

  // ── 15. Overall — mean of the available (non-null) scores ─────────────────
  const real = scores.filter((s) => s.score !== null).map((s) => s.score as number);
  const overall: BenchmarkScore =
    real.length >= 3
      ? {
          key: "overall",
          label: LABELS.overall,
          score: Math.round(real.reduce((a, b) => a + b, 0) / real.length),
          sampleSize: real.length,
          note: `Mean of ${real.length} measured dimensions.`,
        }
      : {
          key: "overall",
          label: LABELS.overall,
          score: null,
          sampleSize: real.length,
          note: `Insufficient measured dimensions (need ≥3, have ${real.length}).`,
        };
  scores.push(overall);

  // ── trend (last TREND_DAYS days) ──────────────────────────────────────────
  const trendMap = new Map<string, { reads: number; w: number; l: number }>();
  const trendSince = new Date(Date.now() - TREND_DAYS * 24 * 60 * 60 * 1000);
  for (const r of receipts) {
    if (r.createdAt < trendSince) continue;
    const k = dayKey(r.createdAt);
    const cur = trendMap.get(k) ?? { reads: 0, w: 0, l: 0 };
    cur.reads++;
    const v = verdictByReceipt.get(r.receiptId);
    if (v === "WIN") cur.w++;
    else if (v === "LOSS") cur.l++;
    trendMap.set(k, cur);
  }
  const trend: BenchmarkTrendPoint[] = [...trendMap.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([date, v]) => ({
      date,
      reads: v.reads,
      resolved: v.w + v.l,
      winRate: v.w + v.l > 0 ? Math.round((v.w / (v.w + v.l)) * 100) : null,
    }));

  // ── weak areas — measured scores below 60, weakest first ──────────────────
  const weakAreas = scores
    .filter((s) => s.key !== "overall" && s.score !== null && (s.score as number) < 60)
    .sort((a, b) => (a.score as number) - (b.score as number));

  // ── recent failed reads & successful no-trades ────────────────────────────
  const toRecent = (r: typeof chartDecisionReceiptsTable.$inferSelect): BenchmarkRecentRead => ({
    receiptId: r.receiptId,
    userId: r.userId,
    symbol: r.symbol,
    timeframe: r.timeframe,
    intent: r.intent,
    direction: r.direction,
    outcome: verdictByReceipt.get(r.receiptId) ?? null,
    qualityLabel: r.qualityLabel,
    createdAt: r.createdAt.toISOString(),
  });
  const recentFailedReads: BenchmarkRecentRead[] = [];
  const recentSuccessfulNoTrades: BenchmarkRecentRead[] = [];
  for (const r of receipts) {
    const v = verdictByReceipt.get(r.receiptId);
    if ((v === "LOSS" || v === "NO_TRADE_MISSED") && recentFailedReads.length < 10) {
      recentFailedReads.push(toRecent(r));
    } else if (v === "NO_TRADE_CORRECT" && recentSuccessfulNoTrades.length < 10) {
      recentSuccessfulNoTrades.push(toRecent(r));
    }
  }

  // ── coverage / speed / feed warnings (honest, evidence-backed) ───────────
  const warnings: string[] = [...coverageWarnings];
  if (feedKnown >= MIN_SAMPLE) {
    const stalePct = Math.round(((feedKnown - feedClean) / feedKnown) * 100);
    if (stalePct >= 25) {
      warnings.push(`${stalePct}% of recent reads ran on a stale or unusable feed.`);
    }
  }
  if (speedKnown >= MIN_SAMPLE && slowReads > 0) {
    const slowPct = Math.round((slowReads / speedKnown) * 100);
    if (slowPct >= 20) {
      warnings.push(`${slowPct}% of reads exceeded the ${STATE_BUILD_BUDGET_MS}ms state-build budget.`);
    }
  }
  if (traces.length >= MIN_SAMPLE && slowGov > 0) {
    const slowGovPct = Math.round((slowGov / traces.length) * 100);
    if (slowGovPct >= 20) {
      warnings.push(`${slowGovPct}% of governance runs exceeded ${GOV_RUNTIME_BUDGET_MS}ms.`);
    }
  }

  return {
    generatedAt,
    windowDays,
    totalReceipts: receipts.length,
    totalOutcomes,
    totalReviews,
    totalTraces: traces.length,
    scores,
    trend,
    weakAreas,
    recentFailedReads,
    recentSuccessfulNoTrades,
    warnings,
  };
}
