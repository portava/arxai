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

import { and, desc, eq } from "drizzle-orm";
import {
  db,
  learningEventsTable,
  paperOrdersTable,
  postTradeDebriefsTable,
  vaultEventsTable,
} from "@workspace/db";
import {
  clamp, CONF_ADJ_MAX, CONF_ADJ_MIN, RISK_ADJ_MAX, RISK_ADJ_MIN,
  listOwnEdges, listOwnMistakes, listPlatformEdges, recordEdgeOutcome, recordMistakeOutcome,
  type OwnedScope,
} from "./learning/scopedMemory.js";
import { logger } from "./logger.js";

const log = logger.child({ component: "learningEngine" });

// ── Per-event deltas (bounds live in learning/scopedMemory.ts) ─────────────
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
export interface LearningOptions {
  /** The authenticated caller; must match the debrief's owner when the debrief names one. */
  ownerUserId?: number | null;
  /** Additional private scopes (strategy / account / broker / instrument / portfolio). */
  scopes?: OwnedScope[];
}

/** Account scope for a paper trade: the paper account it was placed on. */
async function derivedScopes(ownerUserId: number, tradeId: number): Promise<OwnedScope[]> {
  try {
    const [o] = await db.select({ acct: paperOrdersTable.paperAccountId }).from(paperOrdersTable)
      .where(and(eq(paperOrdersTable.id, tradeId), eq(paperOrdersTable.userId, ownerUserId))).limit(1);
    return o?.acct != null ? [{ type: "account", key: `paper:${o.acct}` }] : [];
  } catch { return []; }
}

export async function processLearningPayload(payload: LearningPayload, opts: LearningOptions = {}): Promise<LearningResult> {
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

  // 3. Hydrate from the debrief row if any field is missing; the row also
  // decides ownership and provenance (below).
  const dbRow = (await db.select().from(postTradeDebriefsTable).where(eq(postTradeDebriefsTable.id, debriefId)).limit(1))[0];
  // Learning memory is per trader: the debrief's owner is the owner; a caller
  // may not teach another trader's memory, and an ownerless payload teaches nothing.
  const callerId = opts.ownerUserId ?? null;
  if (dbRow?.userId != null && callerId != null && dbRow.userId !== callerId) {
    return { ...baseRes, status: "skipped_invalid_payload", warnings: ["Debrief belongs to another trader"] };
  }
  const ownerUserId = dbRow?.userId ?? callerId;
  if (ownerUserId == null) {
    return { ...baseRes, status: "skipped_invalid_payload", warnings: ["No owner: learning memory is per trader"] };
  }
  const scopes = [...(opts.scopes ?? []), ...(await derivedScopes(ownerUserId, payload.trade_id))];
  // Provenance gate: only an outcome backed by the owner's own debrief row is
  // shared beyond their private memory (scoped kinds and the platform cohort).
  // A synthesized payload (demo, or a debrief id that does not exist) teaches
  // the caller's private memory only.
  const verified = dbRow?.userId === ownerUserId;
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
      userId: ownerUserId,
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
    const row = await recordEdgeOutcome(ownerUserId, {
      symbol, signalName: sig.source, action, result, pnl, tradeId: payload.trade_id,
      deltaEdge: deltaEdgePerSig, deltaConf: deltaConfPerSig, deltaRisk: deltaRiskPerSig,
    }, scopes, verified);
    edgeAdjustments.push({
      signalName: sig.source, action, deltaEdge: deltaEdgePerSig, deltaConf: deltaConfPerSig, deltaRisk: deltaRiskPerSig,
      newEdgeScore: row.edgeScore, sampleCount: row.sampleCount,
    });
  }

  // 7. Update mistake_patterns per tag (LOSS amplifies; WIN does not erase).
  if (mistakeTags.length > 0) {
    for (const tag of mistakeTags) {
      const row = await recordMistakeOutcome(ownerUserId, {
        tag: String(tag), symbol, action, isLoss, tradeId: payload.trade_id, guardrail: recommendedGuardrailFor(String(tag)),
      }, scopes, verified);
      mistakeAdjustments.push({ tag: row.tag, symbol, action, count: row.count, severityScore: row.severityScore });
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
      sampleBucket, sharedBeyondPrivate: verified,
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

  const warnings = verified ? [] : ["No debrief of yours backs this outcome: it taught your private memory only, not shared scopes or the platform cohort"];
  return { ...baseRes, status: "processed", eventId, result, edgeAdjustments, mistakeAdjustments, warnings };
}

function totalSamples(adjs: LearningResult["edgeAdjustments"]): number {
  if (adjs.length === 0) return 0;
  return Math.max(...adjs.map((a) => a.sampleCount));
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
/**
 * What the decision engine sees for this trader on symbol+action: their own
 * edges, or the anonymized platform cohorts while their own sample is still
 * LOW. Mistake warnings are always the trader's own.
 */
export async function getSymbolLearningView(userId: number, symbol: string, action: "BUY" | "SELL" | "HOLD"): Promise<SymbolLearningView & { source: "own" | "platform" | "none" }> {
  const [ownEdges, mistakes] = await Promise.all([
    listOwnEdges(userId, { symbol, action }),
    listOwnMistakes(userId, { symbol, action }),
  ]);
  const ownSamples = ownEdges.reduce((n, e) => n + e.sampleCount, 0);
  const platformEdges = ownSamples < SAMPLE_LOW ? await listPlatformEdges({ symbol, action }) : [];
  const usePlatform = ownSamples < SAMPLE_LOW && platformEdges.reduce((n, e) => n + e.sampleCount, 0) > ownSamples;
  const edges = usePlatform ? platformEdges : ownEdges;
  const source = edges.length === 0 ? "none" as const : usePlatform ? "platform" as const : "own" as const;

  if (edges.length === 0 && mistakes.length === 0) {
    return {
      symbol, totalSampleSize: 0, learningConfidence: "LOW",
      edgeScoreUsed: 0, confidenceAdjustmentApplied: 0, riskAdjustmentApplied: 0,
      knownMistakeWarnings: [], edgeSummary: "No prior learning data for this symbol+action.",
      cohortCount: 0, source,
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
    `Learning(${learningConfidence}, ${source === "platform" ? "anonymized platform" : "your trades"}, n=${totalSamples}, ${edges.length} edge cohort(s)): ` +
    `${totalWins}W/${totalLosses}L/${totalBE}BE, edge=${aggEdge.toFixed(1)}, ` +
    `confΔ=${confAdj.toFixed(1)}, riskΔ=${riskAdj.toFixed(1)}` +
    (topMistakes.length > 0 ? `, ${topMistakes.length} mistake pattern(s)` : "");

  return {
    symbol, totalSampleSize: totalSamples, learningConfidence,
    edgeScoreUsed: aggEdge, confidenceAdjustmentApplied: confAdj, riskAdjustmentApplied: riskAdj,
    knownMistakeWarnings: topMistakes, edgeSummary: summary, cohortCount: edges.length, source,
  };
}

// ── List/read helpers for routes ───────────────────────────────────────────
export async function listLearningEvents(userId: number, limit = 10) {
  return db.select().from(learningEventsTable).where(eq(learningEventsTable.userId, userId))
    .orderBy(desc(learningEventsTable.id)).limit(limit);
}
