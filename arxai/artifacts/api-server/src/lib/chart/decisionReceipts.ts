// Chart Brain v2 — Task 5: immutable decision receipts (Slow Brain).
//
// Every OFFICIAL Ruby read / chart trade plan creates ONE immutable receipt that
// captures exactly what the chart + intelligence layers said at decision time.
// The original row is written ONCE and NEVER mutated or deleted by this service —
// there is deliberately no update/delete path. Later OUTCOME and REVIEW records
// are APPENDED to the separate `chart_decision_outcomes` table.
//
// Strictly per-user: every user-facing read is scoped by userId. The admin
// history read is the only cross-user read and is gated by the caller (requireAdmin).
// Receipt creation is non-blocking by construction: it only runs on an explicit
// official-read endpoint (never on the live execution / candle-render path) and
// fails open (returns null) so a DB hiccup never breaks the read.

import { randomUUID } from "node:crypto";
import {
  db,
  chartDecisionReceiptsTable,
  chartDecisionOutcomesTable,
} from "@workspace/db";
import type {
  ChartDecisionReceipt,
  ChartDecisionOutcome,
  NewChartDecisionReceipt,
} from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../logger.js";
import type { ChartIntelligenceState } from "../data/chart/chartIntelligence.js";
import type { RubyDraftReadResult } from "../assistant/rubyDraftRead.js";
import {
  buildSetupFingerprint,
  type ChartSetupFingerprint,
} from "./setupFingerprint.js";

export type ReceiptSource =
  | "ruby_draft_read"
  | "ruby_explain_signal"
  | "chart_read"
  | "chart_trade_plan";

export type ReceiptOutcomeKind = "OUTCOME" | "REVIEW";

export type ReceiptOutcomeVerdict =
  | "WIN"
  | "LOSS"
  | "BREAKEVEN"
  | "NO_TRADE_CORRECT"
  | "NO_TRADE_MISSED"
  | "EXPIRED"
  | "UNKNOWN";

const TF_MINUTES: Record<string, number> = {
  M1: 1,
  M5: 5,
  M15: 15,
  M30: 30,
  H1: 60,
  H4: 240,
  D1: 1440,
};

function sentence(
  state: ChartIntelligenceState,
  key: keyof ChartIntelligenceState["marketSentences"],
): string | null {
  try {
    const s = state.marketSentences[key];
    if (typeof s === "object" && s != null && "text" in s) {
      const text = (s as { text?: unknown }).text;
      return typeof text === "string" && text.length > 0 ? text : null;
    }
  } catch {
    /* ignore */
  }
  return null;
}

function computeExpiresAt(state: ChartIntelligenceState): Date | null {
  try {
    const bars = state.setupState.expiresInBars;
    const mins = TF_MINUTES[state.timeframe];
    if (bars == null || bars <= 0 || mins == null) return null;
    return new Date(Date.now() + bars * mins * 60_000);
  } catch {
    return null;
  }
}

export interface ReceiptCreateArgs {
  userId: number;
  state: ChartIntelligenceState;
  draftRead: RubyDraftReadResult;
  source: ReceiptSource;
  intent?: string | null;
  /** Optional explicit trade direction (e.g. from a chart trade plan). */
  direction?: "BUY" | "SELL" | "NEUTRAL" | null;
}

export interface DecisionReceiptView {
  receiptId: string;
  symbol: string;
  displaySymbol: string | null;
  timeframe: string;
  source: string;
  intent: string | null;
  direction: string | null;
  tradeType: string | null;
  marketSentence: string | null;
  setupStage: string | null;
  setupFreshness: string | null;
  readinessScore: number | null;
  qualityLabel: string | null;
  vetoed: boolean;
  agentConsensusStance: string | null;
  agentConflict: boolean;
  courtResult: string | null;
  riskWarning: string | null;
  rubyFinalRead: string | null;
  confidenceScore: number | null;
  confidenceLabel: string | null;
  whatWouldChange: string | null;
  invalidation: string | null;
  expiresAt: string | null;
  keyLevels: unknown;
  agentVotes: unknown;
  confidenceBreakdown: unknown;
  fingerprint: ChartSetupFingerprint;
  chartTruthSnapshot: unknown;
  intelligenceSnapshot: unknown;
  createdAt: string;
}

function buildReceiptRow(args: ReceiptCreateArgs): {
  row: NewChartDecisionReceipt;
  fingerprint: ChartSetupFingerprint;
} {
  const { userId, state, draftRead, source, intent } = args;
  const fingerprint = buildSetupFingerprint(state, {
    direction: args.direction ?? undefined,
  });

  const levels = (() => {
    try {
      return (state.marketUnderstanding.levels.levels ?? []).map((l) => ({
        kind: l.kind,
        price: l.price,
        personality: l.personality,
        distancePct: l.distancePct,
      }));
    } catch {
      return [];
    }
  })();

  const agentVotes = (() => {
    try {
      return state.agentConsensus.populated
        ? state.agentConsensus.agents.map((a) => ({ name: a.name, stance: a.stance }))
        : [];
    } catch {
      return [];
    }
  })();

  const confidenceBreakdown = (() => {
    try {
      return (state.marketUnderstanding.readiness.gates ?? []).map((g) => ({
        key: g.key,
        label: g.label,
        passed: g.passed,
        score: g.score,
      }));
    } catch {
      return [];
    }
  })();

  const chartTruthSnapshot = (() => {
    try {
      return {
        truthState: state.truthState,
        stale: state.stale,
        aiUsable: state.aiUsable,
        assetClass: state.assetClass,
        candleStats: state.candleStats,
        latestClosedCandle: state.latestClosedCandle,
      };
    } catch {
      return {};
    }
  })();

  const intelligenceSnapshot = (() => {
    try {
      return {
        bias: state.decisionState.bias,
        actionability: state.decisionState.actionability,
        quality: state.decisionState.quality,
        vetoed: state.decisionState.vetoed,
        regime: state.marketUnderstanding.trend.regime,
        trendDirection: state.marketUnderstanding.trend.direction,
        htfBias: state.marketUnderstanding.trend.higherTimeframeBias,
        setupStage: state.setupState.stage,
        setupFreshness: state.setupState.freshness,
        readiness: state.marketUnderstanding.readiness.score,
        lastUpdated: state.lastUpdated,
      };
    } catch {
      return {};
    }
  })();

  const courtResult = (() => {
    try {
      if (state.agentConsensus.protective) return "PROTECTIVE_LOWERED";
      if (state.agentConsensus.conflict) return "CONFLICT";
      if (state.agentConsensus.populated) return "NO_CONFLICT";
      return null;
    } catch {
      return null;
    }
  })();

  const row: NewChartDecisionReceipt = {
    receiptId: randomUUID(),
    userId,
    symbol: state.symbol,
    displaySymbol: state.displaySymbol ?? null,
    timeframe: state.timeframe,
    source,
    intent: intent ?? draftRead.intent ?? null,
    direction: fingerprint.direction,
    tradeType: fingerprint.tradeType,
    marketSentence: sentence(state, "market") ?? draftRead.headline ?? null,
    setupStage: fingerprint.stage,
    setupFreshness: fingerprint.freshnessBucket,
    readinessScore: draftRead.confidenceScore ?? fingerprint.readinessScore ?? null,
    qualityLabel: fingerprint.qualityLabel,
    vetoed: (() => {
      try {
        return state.decisionState.vetoed;
      } catch {
        return false;
      }
    })(),
    agentConsensusStance: fingerprint.agentAgreement,
    agentConflict: (() => {
      try {
        return state.agentConsensus.conflict;
      } catch {
        return false;
      }
    })(),
    courtResult,
    riskWarning: sentence(state, "risk"),
    rubyFinalRead: draftRead.headline ?? null,
    confidenceScore: draftRead.confidenceScore ?? null,
    confidenceLabel: draftRead.confidenceLabel ?? null,
    whatWouldChange: sentence(state, "whatWouldChange"),
    invalidation:
      sentence(state, "whatInvalidates") ??
      (() => {
        try {
          return state.setupState.invalidationCondition;
        } catch {
          return null;
        }
      })(),
    expiresAt: computeExpiresAt(state),
    fpRegime: fingerprint.regime,
    fpHtfBias: fingerprint.htfBias,
    fpLevelType: fingerprint.levelType,
    fpStage: fingerprint.stage,
    fpReadinessBucket: fingerprint.readinessBucket,
    chartTruthSnapshot,
    intelligenceSnapshot,
    keyLevels: levels,
    agentVotes,
    confidenceBreakdown,
    fingerprint: fingerprint as unknown as Record<string, unknown>,
  };
  return { row, fingerprint };
}

function toView(r: ChartDecisionReceipt): DecisionReceiptView {
  return {
    receiptId: r.receiptId,
    symbol: r.symbol,
    displaySymbol: r.displaySymbol,
    timeframe: r.timeframe,
    source: r.source,
    intent: r.intent,
    direction: r.direction,
    tradeType: r.tradeType,
    marketSentence: r.marketSentence,
    setupStage: r.setupStage,
    setupFreshness: r.setupFreshness,
    readinessScore: r.readinessScore,
    qualityLabel: r.qualityLabel,
    vetoed: r.vetoed,
    agentConsensusStance: r.agentConsensusStance,
    agentConflict: r.agentConflict,
    courtResult: r.courtResult,
    riskWarning: r.riskWarning,
    rubyFinalRead: r.rubyFinalRead,
    confidenceScore: r.confidenceScore,
    confidenceLabel: r.confidenceLabel,
    whatWouldChange: r.whatWouldChange,
    invalidation: r.invalidation,
    expiresAt: r.expiresAt ? r.expiresAt.toISOString() : null,
    keyLevels: r.keyLevels,
    agentVotes: r.agentVotes,
    confidenceBreakdown: r.confidenceBreakdown,
    fingerprint: r.fingerprint as unknown as ChartSetupFingerprint,
    chartTruthSnapshot: r.chartTruthSnapshot,
    intelligenceSnapshot: r.intelligenceSnapshot,
    createdAt: r.createdAt.toISOString(),
  };
}

/**
 * Create an immutable decision receipt. Returns the persisted row, or null on
 * failure (fail-open). Never mutates an existing receipt.
 */
export async function createDecisionReceipt(
  args: ReceiptCreateArgs,
): Promise<ChartDecisionReceipt | null> {
  try {
    const { row } = buildReceiptRow(args);
    const [inserted] = await db
      .insert(chartDecisionReceiptsTable)
      .values(row)
      .returning();
    return inserted ?? null;
  } catch (err) {
    logger.warn(
      { err, userId: args.userId, symbol: args.state?.symbol },
      "decisionReceipts: receipt creation failed (ignored)",
    );
    return null;
  }
}

export interface OutcomeView {
  id: number;
  receiptRef: string;
  kind: string;
  outcome: string | null;
  plQuality: string | null;
  realizedPl: number | null;
  note: string | null;
  evidence: unknown;
  createdAt: string;
}

function toOutcomeView(o: ChartDecisionOutcome): OutcomeView {
  return {
    id: o.id,
    receiptRef: o.receiptRef,
    kind: o.kind,
    outcome: o.outcome,
    plQuality: o.plQuality,
    realizedPl: o.realizedPl,
    note: o.note,
    evidence: o.evidence,
    createdAt: o.createdAt.toISOString(),
  };
}

/** Per-user single-receipt read with its appended outcomes/reviews. */
export async function getUserReceipt(
  userId: number,
  receiptId: string,
): Promise<{ receipt: DecisionReceiptView; outcomes: OutcomeView[] } | null> {
  const [r] = await db
    .select()
    .from(chartDecisionReceiptsTable)
    .where(
      and(
        eq(chartDecisionReceiptsTable.userId, userId),
        eq(chartDecisionReceiptsTable.receiptId, receiptId),
      ),
    )
    .limit(1);
  if (!r) return null;
  const outcomes = await db
    .select()
    .from(chartDecisionOutcomesTable)
    .where(
      and(
        eq(chartDecisionOutcomesTable.userId, userId),
        eq(chartDecisionOutcomesTable.receiptRef, receiptId),
      ),
    )
    .orderBy(desc(chartDecisionOutcomesTable.createdAt));
  return { receipt: toView(r), outcomes: outcomes.map(toOutcomeView) };
}

/** Per-user receipt history (most recent first). */
export async function listUserReceipts(
  userId: number,
  opts?: { symbol?: string; limit?: number },
): Promise<DecisionReceiptView[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200);
  const filters = [eq(chartDecisionReceiptsTable.userId, userId)];
  if (opts?.symbol) filters.push(eq(chartDecisionReceiptsTable.symbol, opts.symbol));
  const rows = await db
    .select()
    .from(chartDecisionReceiptsTable)
    .where(and(...filters))
    .orderBy(desc(chartDecisionReceiptsTable.createdAt))
    .limit(limit);
  return rows.map(toView);
}

/**
 * Admin/history read across ALL users. The caller MUST enforce admin access
 * (requireAdmin); this function performs no role check itself.
 */
export async function listAllReceiptsForAdmin(opts?: {
  symbol?: string;
  userId?: number;
  limit?: number;
}): Promise<(DecisionReceiptView & { userId: number })[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  const filters = [];
  if (opts?.symbol) filters.push(eq(chartDecisionReceiptsTable.symbol, opts.symbol));
  if (opts?.userId != null) {
    filters.push(eq(chartDecisionReceiptsTable.userId, opts.userId));
  }
  const q = db.select().from(chartDecisionReceiptsTable);
  const rows = await (filters.length > 0 ? q.where(and(...filters)) : q)
    .orderBy(desc(chartDecisionReceiptsTable.createdAt))
    .limit(limit);
  return rows.map((r) => ({ ...toView(r), userId: r.userId }));
}

export interface AppendOutcomeArgs {
  userId: number;
  receiptRef: string;
  kind: ReceiptOutcomeKind;
  outcome?: ReceiptOutcomeVerdict | null;
  plQuality?: "KNOWN" | "ESTIMATED" | "UNKNOWN" | null;
  realizedPl?: number | null;
  note?: string | null;
  evidence?: Record<string, unknown>;
}

/**
 * Append an OUTCOME or REVIEW to a receipt. The original receipt is never
 * touched. Verifies the receipt exists and belongs to the user before
 * appending (per-user isolation). Returns the appended row, or null when the
 * receipt is not found / not owned by the user.
 */
export async function appendReceiptOutcome(
  args: AppendOutcomeArgs,
): Promise<OutcomeView | null> {
  const [r] = await db
    .select({ id: chartDecisionReceiptsTable.id })
    .from(chartDecisionReceiptsTable)
    .where(
      and(
        eq(chartDecisionReceiptsTable.userId, args.userId),
        eq(chartDecisionReceiptsTable.receiptId, args.receiptRef),
      ),
    )
    .limit(1);
  if (!r) return null;
  const [inserted] = await db
    .insert(chartDecisionOutcomesTable)
    .values({
      receiptRef: args.receiptRef,
      userId: args.userId,
      kind: args.kind,
      outcome: args.outcome ?? null,
      plQuality: args.plQuality ?? null,
      realizedPl: args.realizedPl ?? null,
      note: args.note ?? null,
      evidence: args.evidence ?? {},
    })
    .returning();
  return inserted ? toOutcomeView(inserted) : null;
}
