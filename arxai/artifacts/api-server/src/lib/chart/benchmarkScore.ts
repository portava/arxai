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

const GOOD_QUALITY = new Set(["clean", "high", "strong", "good", "prime"]);
const SCALP_INTENTS = new Set(["is-this-a-scalp"]);
const HIGH_CONF = 65;

// ── main ────────────────────────────────────────────────────────────────────

/**
 * Compute the Chart Brain benchmark across all users (admin surface). The caller
 * MUST enforce admin access — this function performs no role check itself.
 * Fail-open: on any storage error it returns an honest empty result rather than
 * throwing, so the dashboard degrades to "no data yet" instead of erroring.
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
      note: "No chart-brain activity recorded yet.",
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
        .limit(2000),
      db
        .select()
        .from(chartDecisionOutcomesTable)
        .where(gte(chartDecisionOutcomesTable.createdAt, since))
        .orderBy(desc(chartDecisionOutcomesTable.createdAt))
        .limit(4000),
      db
        .select()
        .from(agentGovernanceTracesTable)
        .where(gte(agentGovernanceTracesTable.createdAt, since))
        .orderBy(desc(agentGovernanceTracesTable.createdAt))
        .limit(2000),
    ]);
  } catch (err) {
    logger.warn({ err }, "benchmarkScore: aggregation query failed (fail-open empty)");
    return empty();
  }

  if (receipts.length === 0) {
    const e = empty();
    e.totalTraces = traces.length;
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
    const snap = readSnapshot(r.intelligenceSnapshot);
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
        if (r.vetoed || (r.riskWarning && r.riskWarning.trim().length > 0)) {
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

  // ── 4. Structure read — share of reads with a good quality label ──────────
  let qualityKnown = 0;
  let qualityGood = 0;
  for (const r of receipts) {
    if (r.qualityLabel) {
      qualityKnown++;
      if (GOOD_QUALITY.has(r.qualityLabel.toLowerCase())) qualityGood++;
    }
  }

  // ── 10. Agent agreement — receipts with no agent conflict ─────────────────
  const agentAgree = receipts.filter((r) => !r.agentConflict).length;

  // ── 11. Ruby explanation quality — complete explanations ──────────────────
  let rubyComplete = 0;
  for (const r of receipts) {
    const hasRead = !!(r.rubyFinalRead && r.rubyFinalRead.trim().length > 0);
    const hasContext =
      !!(r.whatWouldChange && r.whatWouldChange.trim()) ||
      !!(r.invalidation && r.invalidation.trim());
    if (hasRead && hasContext) rubyComplete++;
  }

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
      `${feedClean}/${feedKnown} reads on a clean, AI-usable feed.`,
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
      `${speedFast}/${speedDen} reads/governance runs within speed budget.`,
    ),
    ratioScore(
      "structure_read",
      qualityGood,
      qualityKnown,
      `${qualityGood}/${qualityKnown} reads had a clean structure quality.`,
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
      `${badResultsFlagged}/${badResults} losing/missed reads were pre-flagged by risk.`,
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
    ratioScore(
      "exit_realism",
      plKnown,
      plResolved,
      `${plKnown}/${plResolved} resolved trades had broker-known P/L.`,
    ),
    ratioScore(
      "agent_agreement",
      agentAgree,
      receipts.length,
      `${agentAgree}/${receipts.length} reads had agents in agreement.`,
    ),
    ratioScore(
      "ruby_explanation_quality",
      rubyComplete,
      receipts.length,
      `${rubyComplete}/${receipts.length} reads had a complete Ruby explanation.`,
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

  // ── speed / feed warnings (honest, evidence-backed) ───────────────────────
  const warnings: string[] = [];
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
