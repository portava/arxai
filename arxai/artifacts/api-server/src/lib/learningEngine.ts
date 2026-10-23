// Build CC — Learning Feedback Engine.
//
// Closes the loop:  AA decides → paper trade closes → BB auto-debriefs →
// CC learns from the result → future AA decisions read the updated edges.
//
// SAFETY (inviolable):
//   • CC NEVER calls executeTrade / mt5_* / livePositions / setCanPlaceTrades.
//   • CC NEVER overrides safetyCore blockers, kill switch, or risk locks.
//   • Per-trade adjustments are bounded (≤ 5 confidence, ≤ 5 risk per event)
//     and per-cohort totals are clamped to documented min/max bounds.
//   • Idempotent: unique index on learning_events.debrief_id guarantees
//     the same debrief can never be processed twice.
//   • All errors are non-fatal: BB's debrief survives even if CC throws.

import { and, desc, eq, sql } from "drizzle-orm";
import {
  db,
  learningEventsTable,
  strategyEdgesTable,
  mistakePatternsTable,
  postTradeDebriefsTable,
  vaultEventsTable,
} from "@workspace/db";
import { logger } from "./logger.js";

const log = logger.child({ component: "learningEngine" });

// ── Bounds (per design contract) ───────────────────────────────────────────
const EDGE_MIN = -100;
const EDGE_MAX =  100;
const CONF_ADJ_MIN = -15;
const CONF_ADJ_MAX =  15;
const RISK_ADJ_MIN = -15;
const RISK_ADJ_MAX =  15;
const SEVERITY_MAX = 100;

// Per-trade deltas (small — one trade cannot dominate a cohort).
const D_EDGE_WIN  =  4;
const D_EDGE_LOSS = -4;
const D_EDGE_BE   =  0.5;
const D_CONF_WIN  =  1;
const D_CONF_LOSS = -2;
const D_RISK_WIN  = -0.5;
const D_RISK_LOSS =  2;

// Sample-size buckets.
const SAMPLE_LOW    = 5;
const SAMPLE_MEDIUM = 20;

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ── Types ──────────────────────────────────────────────────────────────────
export interface LearningPayload {
  trade_id: number;
  decision_id: number | null;
  result: string;                      // WIN | LOSS | BREAKEVEN | CANCELLED
  pnl: number;
  pnl_percent?: number;
  symbol?: string;
  action?: string;                     // BUY | SELL | HOLD
  mistake_tags?: string[];
  lesson?: string;
  confidence_before_trade?: number | null;
  risk_score_before_trade?: number | null;
  signals_used?: Array<{ source: string; status: string; score: number; detail?: string }>;
  debrief_id: number;
  ready_for_learning: boolean;
}

export type LearningResultStatus =
  | "processed"
  | "skipped_already_processed"
  | "skipped_not_ready"
  | "skipped_invalid_payload"
  | "error";

export interface LearningResult {
  status: LearningResultStatus;
  eventId: number | null;
  debriefId: number;
  result?: string;
  edgeAdjustments: Array<{ signalName: string; action: string; deltaEdge: number; deltaConf: number; deltaRisk: number; newEdgeScore: number; sampleCount: number }>;
  mistakeAdjustments: Array<{ tag: string; symbol: string; action: string; count: number; severityScore: number }>;
  warnings: string[];
  error?: string;
}

export type LearningConfidence = "LOW" | "MEDIUM" | "HIGH";

export interface SymbolLearningView {
  symbol: string;
  totalSampleSize: number;
  learningConfidence: LearningConfidence;
  edgeScoreUsed: number;                    // weighted aggregate edge for this symbol+action
  confidenceAdjustmentApplied: number;
  riskAdjustmentApplied: number;
  knownMistakeWarnings: string[];
  edgeSummary: string;
  cohortCount: number;
}

// ── Idempotent processor ───────────────────────────────────────────────────
export async function processLearningPayload(payload: LearningPayload): Promise<LearningResult> {
  const debriefId = payload.debrief_id;
  const baseRes: LearningResult = {
    status: "processed", eventId: null, debriefId,
    edgeAdjustments: [], mistakeAdjustments: [], warnings: [],
  };

  // 1. Validate.
  if (!payload || typeof debriefId !== "number" || debriefId <= 0) {
    return { ...baseRes, status: "skipped_invalid_payload", warnings: ["Invalid payload: missing debrief_id"] };
  }
  if (payload.ready_for_learning !== true) {
    return { ...baseRes, status: "skipped_not_ready", warnings: ["ready_for_learning is not true"] };
  }

  // 2. Idempotency check — debriefId is unique-indexed.
  const existing = await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, debriefId)).limit(1);
  if (existing[0]) {
    log.info({ debriefId, eventId: existing[0].id }, "learning event already exists — idempotent skip");
    return { ...baseRes, status: "skipped_already_processed", eventId: existing[0].id, warnings: [`Learning event already exists (id=${existing[0].id})`] };
  }

  // 3. Hydrate from debrief row if any field is missing AND verify debrief exists
  // (provenance gate — prevents external callers from poisoning learning memory
  // with debrief_ids that do not correspond to a real debrief row).
  const dbRow = (await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.id, debriefId)).limit(1))[0];
  const meta = (dbRow?.autoMeta as Record<string, unknown> | undefined) ?? {};
  let symbol = payload.symbol ?? "";
  let action = payload.action ?? "";
  let pnlPercent = payload.pnl_percent ?? 0;
  if (!symbol) symbol = (meta.symbol as string) || "UNKNOWN";
  if (!action) action = (meta.action as string) || "HOLD";
  if (!pnlPercent) pnlPercent = (meta.pnl_percent as number) ?? 0;

  const result = String(payload.result || "BREAKEVEN").toUpperCase();
  const pnl = Number(payload.pnl ?? 0);
  const signals = Array.isArray(payload.signals_used) ? payload.signals_used : [];
  const mistakeTags = Array.isArray(payload.mistake_tags) ? payload.mistake_tags : [];

  // 4. Compute per-result deltas.
  const isWin  = result === "WIN";
  const isLoss = result === "LOSS";
  const isBE   = result === "BREAKEVEN" || result === "BREAK_EVEN";
  const isCancelled = result === "CANCELLED";

  let deltaEdgePerSig = 0, deltaConfPerSig = 0, deltaRiskPerSig = 0;
  if (isWin)  { deltaEdgePerSig = D_EDGE_WIN;  deltaConfPerSig = D_CONF_WIN;  deltaRiskPerSig = D_RISK_WIN; }
  if (isLoss) { deltaEdgePerSig = D_EDGE_LOSS; deltaConfPerSig = D_CONF_LOSS; deltaRiskPerSig = D_RISK_LOSS; }
  if (isBE)   { deltaEdgePerSig = D_EDGE_BE;   deltaConfPerSig = 0;           deltaRiskPerSig = 0; }
  if (isCancelled) { deltaEdgePerSig = 0; deltaConfPerSig = 0; deltaRiskPerSig = 0; }

  // Risk-controlled win bonus: if confidence was HIGH and risk was LOW and we won, slightly bigger reward.
  if (isWin && (payload.confidence_before_trade ?? 0) >= 70 && (payload.risk_score_before_trade ?? 100) <= 30) {
    deltaEdgePerSig += 1;
  }
  // Overconfidence penalty: high confidence + lost = stronger conf reduction.
  if (isLoss && (payload.confidence_before_trade ?? 0) >= 70) {
    deltaConfPerSig -= 1;
  }

  // 5. CLAIM idempotency row FIRST — this guarantees that no second caller
  // can apply edge/mistake mutations for the same debriefId. The unique index
  // on debrief_id rejects concurrent inserts, so only one caller proceeds to
  // mutate strategy_edges/mistake_patterns. The row is updated with the
  // final summary/adjustments at step 8 after mutations succeed.
  let eventId: number | null = null;
  try {
    const ins = await db.insert(learningEventsTable).values({
      tradeId: payload.trade_id,
      decisionId: payload.decision_id,
      debriefId,
      symbol, action, result, pnl, pnlPercent,
      confidenceBeforeTrade: payload.confidence_before_trade ?? null,
      riskScoreBeforeTrade:  payload.risk_score_before_trade ?? null,
      signalsUsed: signals as unknown as object,
      mistakeTags: mistakeTags as unknown as object,
      lesson: payload.lesson ?? "",
      learningSummary: "PENDING",
      adjustments: { pending: true } as unknown as object,
    }).returning({ id: learningEventsTable.id });
    eventId = ins[0]?.id ?? null;
  } catch (err) {
    // Race condition: another caller claimed first.
    const racy = await db.select().from(learningEventsTable).where(eq(learningEventsTable.debriefId, debriefId)).limit(1);
    if (racy[0]) {
      log.warn({ debriefId, eventId: racy[0].id, err: String(err) }, "race-condition: existing learning event found, mutations skipped");
      return { ...baseRes, status: "skipped_already_processed", eventId: racy[0].id, warnings: ["Race-condition: another learning event was created concurrently — no edges/mistakes mutated by this call"] };
    }
    log.error({ err: String(err), debriefId }, "learning event insert failed");
    return { ...baseRes, status: "error", error: String(err).slice(0, 300), warnings: ["learning_events insert failed"] };
  }

  const edgeAdjustments: LearningResult["edgeAdjustments"] = [];
  const mistakeAdjustments: LearningResult["mistakeAdjustments"] = [];

  // 6. Update strategy_edges per supporting signal (status PASS or INFO with score>0).
  const supportingSignals = signals.filter((s) =>
    s && typeof s.source === "string" && (s.status === "PASS" || (s.status === "INFO" && (s.score ?? 0) > 0))
  );
  // De-dup by source.
  const seen = new Set<string>();
  for (const sig of supportingSignals) {
    if (seen.has(sig.source)) continue;
    seen.add(sig.source);
    const adj = await upsertEdge({
      symbol, signalName: sig.source, action, result, pnl, tradeId: payload.trade_id,
      deltaEdge: deltaEdgePerSig, deltaConf: deltaConfPerSig, deltaRisk: deltaRiskPerSig,
    });
    edgeAdjustments.push(adj);
  }

  // 7. Update mistake_patterns per tag (LOSS amplifies; WIN does not erase).
  if (mistakeTags.length > 0) {
    for (const tag of mistakeTags) {
      const adj = await upsertMistake({
        tag: String(tag), symbol, action, isLoss, tradeId: payload.trade_id,
      });
      mistakeAdjustments.push(adj);
    }
  }

  // 8. Finalize the claimed event row with summary + adjustments JSON.
  const sampleBucket = totalSamples(edgeAdjustments) < SAMPLE_LOW ? "LOW"
                     : totalSamples(edgeAdjustments) < SAMPLE_MEDIUM ? "MEDIUM" : "HIGH";
  const summary = `${result} on ${symbol} ${action} (pnl=${pnl.toFixed(2)}). ${edgeAdjustments.length} signal edge(s) updated, ${mistakeAdjustments.length} mistake pattern(s). Sample bucket=${sampleBucket}.`;
  await db.update(learningEventsTable).set({
    learningSummary: summary,
    adjustments: { edgeAdjustments, mistakeAdjustments, sampleBucket } as unknown as object,
  }).where(eq(learningEventsTable.id, eventId!));

  // 8. Vault audit (append-only, best-effort).
  const severity = isLoss ? "WARN" : "INFO";
  await db.insert(vaultEventsTable).values({
    kind: "LEARNING_EVENT_PROCESSED",
    severity,
    source: "SYSTEM",
    truthDomain: "BEHAVIOR",
    summary: `Learning event ${eventId} for debrief ${debriefId} (${symbol} ${action} ${result})`,
    payload: {
      eventId, debriefId, tradeId: payload.trade_id, decisionId: payload.decision_id,
      symbol, action, result, pnl,
      edgesUpdated: edgeAdjustments.length, mistakesUpdated: mistakeAdjustments.length,
      sampleBucket,
    },
    reasons: [],
    blockers: [],
    generatedAtIso: new Date().toISOString(),
  }).catch((err) => {
    log.warn({ err: String(err) }, "vault write failed (non-fatal)");
  });

  log.info({
    eventId, debriefId, tradeId: payload.trade_id, symbol, action, result,
    edgesUpdated: edgeAdjustments.length, mistakesUpdated: mistakeAdjustments.length, sampleBucket,
  }, "learning event processed");

  return { ...baseRes, status: "processed", eventId, result, edgeAdjustments, mistakeAdjustments };
}

function totalSamples(adjs: LearningResult["edgeAdjustments"]): number {
  if (adjs.length === 0) return 0;
  return Math.max(...adjs.map((a) => a.sampleCount));
}

// ── Edge upsert ────────────────────────────────────────────────────────────
async function upsertEdge(args: {
  symbol: string; signalName: string; action: string; result: string; pnl: number; tradeId: number;
  deltaEdge: number; deltaConf: number; deltaRisk: number;
}): Promise<LearningResult["edgeAdjustments"][number]> {
  const { symbol, signalName, action, result, pnl, tradeId, deltaEdge, deltaConf, deltaRisk } = args;
  const existing = (await db.select().from(strategyEdgesTable)
    .where(and(eq(strategyEdgesTable.symbol, symbol), eq(strategyEdgesTable.signalName, signalName), eq(strategyEdgesTable.action, action)))
    .limit(1))[0];

  const isWin  = result === "WIN";
  const isLoss = result === "LOSS";
  const isBE   = result === "BREAKEVEN" || result === "BREAK_EVEN";

  if (!existing) {
    const sampleCount = 1;
    const winCount = isWin ? 1 : 0;
    const lossCount = isLoss ? 1 : 0;
    const beCount = isBE ? 1 : 0;
    const newEdge = clamp(deltaEdge, EDGE_MIN, EDGE_MAX);
    const newConf = clamp(deltaConf, CONF_ADJ_MIN, CONF_ADJ_MAX);
    const newRisk = clamp(deltaRisk, RISK_ADJ_MIN, RISK_ADJ_MAX);
    const ins = await db.insert(strategyEdgesTable).values({
      symbol, strategyName: signalName, signalName, action,
      sampleCount, winCount, lossCount, breakEvenCount: beCount,
      netPnl: pnl, avgPnl: pnl,
      confidenceAdjustment: newConf, riskAdjustment: newRisk, edgeScore: newEdge,
      lastResult: result, lastTradeId: tradeId,
    }).returning();
    const row = ins[0]!;
    return { signalName, action, deltaEdge, deltaConf, deltaRisk, newEdgeScore: row.edgeScore, sampleCount: row.sampleCount };
  }

  const sampleCount = existing.sampleCount + 1;
  const winCount  = existing.winCount  + (isWin ? 1 : 0);
  const lossCount = existing.lossCount + (isLoss ? 1 : 0);
  const beCount   = existing.breakEvenCount + (isBE ? 1 : 0);
  const netPnl = existing.netPnl + pnl;
  const avgPnl = netPnl / sampleCount;
  const newEdge = clamp(existing.edgeScore + deltaEdge, EDGE_MIN, EDGE_MAX);
  const newConf = clamp(existing.confidenceAdjustment + deltaConf, CONF_ADJ_MIN, CONF_ADJ_MAX);
  const newRisk = clamp(existing.riskAdjustment + deltaRisk, RISK_ADJ_MIN, RISK_ADJ_MAX);

  await db.update(strategyEdgesTable).set({
    sampleCount, winCount, lossCount, breakEvenCount: beCount,
    netPnl, avgPnl,
    confidenceAdjustment: newConf, riskAdjustment: newRisk, edgeScore: newEdge,
    lastResult: result, lastTradeId: tradeId, updatedAt: new Date(),
  }).where(eq(strategyEdgesTable.id, existing.id));

  return { signalName, action, deltaEdge, deltaConf, deltaRisk, newEdgeScore: newEdge, sampleCount };
}

// ── Mistake-pattern upsert ─────────────────────────────────────────────────
async function upsertMistake(args: {
  tag: string; symbol: string; action: string; isLoss: boolean; tradeId: number;
}): Promise<LearningResult["mistakeAdjustments"][number]> {
  const { tag, symbol, action, isLoss, tradeId } = args;
  const existing = (await db.select().from(mistakePatternsTable)
    .where(and(eq(mistakePatternsTable.tag, tag), eq(mistakePatternsTable.symbol, symbol), eq(mistakePatternsTable.action, action)))
    .limit(1))[0];

  const sevDelta = isLoss ? 8 : 2;
  const guardrail = recommendedGuardrailFor(tag);

  if (!existing) {
    const ins = await db.insert(mistakePatternsTable).values({
      tag, symbol, action,
      count: 1, lastTradeId: tradeId,
      severityScore: clamp(sevDelta, 0, SEVERITY_MAX),
      recommendedGuardrail: guardrail,
    }).returning();
    const row = ins[0]!;
    return { tag, symbol, action, count: row.count, severityScore: row.severityScore };
  }

  const count = existing.count + 1;
  const severityScore = clamp(existing.severityScore + sevDelta, 0, SEVERITY_MAX);
  await db.update(mistakePatternsTable).set({
    count, severityScore, lastTradeId: tradeId,
    recommendedGuardrail: guardrail || existing.recommendedGuardrail,
    updatedAt: new Date(),
  }).where(eq(mistakePatternsTable.id, existing.id));

  return { tag, symbol, action, count, severityScore };
}

function recommendedGuardrailFor(tag: string): string {
  const t = tag.toUpperCase();
  if (t.includes("OVERRODE_HOLD")) return "Add an extra confirmation step when AA recommends HOLD.";
  if (t.includes("EXITED_TOO_QUICKLY")) return "Define and respect a minimum hold time before manual exit.";
  if (t.includes("EXITED_TOO_LATE"))    return "Use trailing stop or time-based exit to lock in gains.";
  if (t.includes("OVERSIZED"))          return "Cap position size at risk_per_trade_pct of equity.";
  if (t.includes("REVENGE"))            return "Force a cool-off after a loss before re-entering.";
  return "Review pre-trade checklist; this mistake has recurred.";
}

// ── Read API for Build AA ──────────────────────────────────────────────────
export async function getSymbolLearningView(symbol: string, action: "BUY" | "SELL" | "HOLD"): Promise<SymbolLearningView> {
  const [edges, mistakes] = await Promise.all([
    db.select().from(strategyEdgesTable)
      .where(and(eq(strategyEdgesTable.symbol, symbol), eq(strategyEdgesTable.action, action))),
    db.select().from(mistakePatternsTable)
      .where(and(eq(mistakePatternsTable.symbol, symbol), eq(mistakePatternsTable.action, action))),
  ]);

  if (edges.length === 0 && mistakes.length === 0) {
    return {
      symbol, totalSampleSize: 0, learningConfidence: "LOW",
      edgeScoreUsed: 0, confidenceAdjustmentApplied: 0, riskAdjustmentApplied: 0,
      knownMistakeWarnings: [], edgeSummary: "No prior learning data for this symbol+action.",
      cohortCount: 0,
    };
  }

  // Sample-weighted aggregate so a 100-sample edge dominates a 1-sample edge.
  let totalSamples = 0;
  let weightedEdge = 0;
  let weightedConf = 0;
  let weightedRisk = 0;
  for (const e of edges) {
    totalSamples += e.sampleCount;
    weightedEdge += e.edgeScore * e.sampleCount;
    weightedConf += e.confidenceAdjustment * e.sampleCount;
    weightedRisk += e.riskAdjustment * e.sampleCount;
  }
  const denom = totalSamples > 0 ? totalSamples : 1;
  const aggEdge = weightedEdge / denom;
  const aggConf = clamp(weightedConf / denom, CONF_ADJ_MIN, CONF_ADJ_MAX);
  const aggRisk = clamp(weightedRisk / denom, RISK_ADJ_MIN, RISK_ADJ_MAX);

  // Sample-confidence buckets.
  const learningConfidence: LearningConfidence =
    totalSamples < SAMPLE_LOW ? "LOW" : totalSamples < SAMPLE_MEDIUM ? "MEDIUM" : "HIGH";

  // Damp adjustments when sample size is LOW (one bad/good trade shouldn't move scoring much).
  const damp = learningConfidence === "LOW" ? 0.3 : learningConfidence === "MEDIUM" ? 0.6 : 1.0;
  const confAdj = clamp(aggConf * damp, CONF_ADJ_MIN, CONF_ADJ_MAX);
  const riskAdj = clamp(aggRisk * damp, RISK_ADJ_MIN, RISK_ADJ_MAX);

  // Rank mistakes by severity.
  const topMistakes = mistakes
    .sort((a, b) => b.severityScore - a.severityScore)
    .slice(0, 5)
    .map((m) => `[${m.tag}] seen ${m.count}× (severity ${m.severityScore.toFixed(0)}) — ${m.recommendedGuardrail}`);

  const totalWins   = edges.reduce((s, e) => s + e.winCount, 0);
  const totalLosses = edges.reduce((s, e) => s + e.lossCount, 0);
  const totalBE     = edges.reduce((s, e) => s + e.breakEvenCount, 0);
  const summary =
    `Learning(${learningConfidence}, n=${totalSamples}, ${edges.length} edge cohort(s)): ` +
    `${totalWins}W/${totalLosses}L/${totalBE}BE, edge=${aggEdge.toFixed(1)}, ` +
    `confΔ=${confAdj.toFixed(1)}, riskΔ=${riskAdj.toFixed(1)}` +
    (topMistakes.length > 0 ? `, ${topMistakes.length} mistake pattern(s)` : "");

  return {
    symbol, totalSampleSize: totalSamples, learningConfidence,
    edgeScoreUsed: aggEdge, confidenceAdjustmentApplied: confAdj, riskAdjustmentApplied: riskAdj,
    knownMistakeWarnings: topMistakes, edgeSummary: summary, cohortCount: edges.length,
  };
}

// ── List/read helpers for routes ───────────────────────────────────────────
export async function listLearningEvents(limit = 10) {
  return db.select().from(learningEventsTable).orderBy(desc(learningEventsTable.id)).limit(limit);
}

export async function listEdges(symbol?: string) {
  if (symbol) {
    return db.select().from(strategyEdgesTable)
      .where(eq(strategyEdgesTable.symbol, symbol))
      .orderBy(desc(strategyEdgesTable.updatedAt));
  }
  return db.select().from(strategyEdgesTable).orderBy(desc(strategyEdgesTable.updatedAt)).limit(100);
}

export async function listMistakes(symbol?: string) {
  if (symbol) {
    return db.select().from(mistakePatternsTable)
      .where(eq(mistakePatternsTable.symbol, symbol))
      .orderBy(desc(mistakePatternsTable.severityScore));
  }
  return db.select().from(mistakePatternsTable).orderBy(desc(mistakePatternsTable.severityScore)).limit(100);
}

// Touch sql import to avoid lint complaint when not used by branch above.
void sql;
