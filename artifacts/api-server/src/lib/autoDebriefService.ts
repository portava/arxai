// (BB) Build BB — Closed-Loop Auto-Debrief Service.
//
// SAFETY (strict freeze): this service NEVER calls executeTrade, /execute-trade,
// mt5_*, livePositions, setCanPlaceTrades, engageKillSwitch. It only READS
// paper_orders + trade_decision_logs and WRITES post_trade_debriefs +
// analytics_snapshots + vault_events. Build BB does not change Build AA
// scoring logic; that is reserved for Build CC.

import {
  db,
  paperOrdersTable,
  postTradeDebriefsTable,
  tradeDecisionLogsTable,
  analyticsSnapshotsTable,
  vaultEventsTable,
  heatSnapshots,
} from "@workspace/db";
import { asc, eq, gte, lte, and } from "drizzle-orm";
import { computeSnapshot } from "../routes/analytics.js";
import { logger } from "./logger.js";

// ── Heat tag lookup — find the closest heat snapshot at trade entry time ──────
// Fail-soft: returns null if no snapshot found or query fails.
// Outcome resolution requires REAL evidence (real snapshot row), never fabricated.
async function findHeatTagAtEntry(
  symbol: string,
  openedAt: Date,
): Promise<{ heatState: string; heatScore: number; timingGrade: string; entryPermission: string; bestAction: string } | null> {
  try {
    const windowStart = new Date(openedAt.getTime() - 30 * 60 * 1000); // 30min before
    const windowEnd = new Date(openedAt.getTime() + 5 * 60 * 1000);   // 5min after
    const rows = await db.select({
      heatState: heatSnapshots.heatState,
      heatScore: heatSnapshots.heatScore,
      timingGrade: heatSnapshots.timingGrade,
      entryPermission: heatSnapshots.entryPermission,
      bestAction: heatSnapshots.bestAction,
      generatedAt: heatSnapshots.generatedAt,
    }).from(heatSnapshots)
      .where(and(
        eq(heatSnapshots.symbol, symbol.toUpperCase()),
        gte(heatSnapshots.generatedAt, windowStart),
        lte(heatSnapshots.generatedAt, windowEnd),
      ))
      .orderBy(asc(heatSnapshots.generatedAt))
      .limit(5);

    if (rows.length === 0) return null;

    // Pick the closest snapshot to openedAt
    let closest = rows[0]!;
    let minDiff = Math.abs(closest.generatedAt.getTime() - openedAt.getTime());
    for (const r of rows) {
      const diff = Math.abs(r.generatedAt.getTime() - openedAt.getTime());
      if (diff < minDiff) { minDiff = diff; closest = r; }
    }

    return {
      heatState: closest.heatState,
      heatScore: closest.heatScore,
      timingGrade: closest.timingGrade,
      entryPermission: closest.entryPermission,
      bestAction: closest.bestAction,
    };
  } catch {
    return null;
  }
}

export type AutoDebriefStatus =
  | "created"
  | "skipped_already_exists"
  | "skipped_open"
  | "trade_not_found"
  | "error";

export interface AutoDebriefResult {
  status: AutoDebriefStatus;
  orderId: number;
  debriefId?: number;
  decisionId?: number | null;
  result?: "WIN" | "LOSS" | "BREAKEVEN" | "CANCELLED";
  autoMeta?: Record<string, unknown>;
  learningPayload?: Record<string, unknown>;
  snapshotId?: number | null;
  warnings: string[];
  error?: string;
}

const CLOSED_STATUSES = new Set([
  "CLOSED_TP", "CLOSED_SL", "CLOSED_MANUAL",
  "CLOSED_WIN", "CLOSED_LOSS", "CLOSED_BREAK_EVEN",
  "CANCELLED",
]);

export function isClosedStatus(status: string): boolean {
  return CLOSED_STATUSES.has(status);
}

interface DecisionRow {
  id: number;
  symbol: string;
  action: string;
  confidence: number;
  riskScore: number;
  tradeWindowStatus: string;
  decisionJson: unknown;
}

function classifyResult(status: string, pnl: number): "WIN" | "LOSS" | "BREAKEVEN" | "CANCELLED" {
  if (status === "CANCELLED") return "CANCELLED";
  if (pnl > 0.0001) return "WIN";
  if (pnl < -0.0001) return "LOSS";
  return "BREAKEVEN";
}

interface AutoDebriefHeuristics {
  mistakeTags: string[];
  whatWorked: string[];
  whatFailed: string[];
  lesson: string;
  improvementNote: string;
  didFollowDecision: boolean | null;
}

function deriveHeuristics(args: {
  result: "WIN" | "LOSS" | "BREAKEVEN" | "CANCELLED";
  pnl: number;
  symbol: string;
  direction: string;
  entryPrice: number;
  exitPrice: number | null;
  stopLoss: number;
  holdTimeSeconds: number;
  decision: DecisionRow | null;
}): AutoDebriefHeuristics {
  const { result, pnl, symbol, direction, entryPrice, exitPrice, stopLoss, holdTimeSeconds, decision } = args;
  const mistakeTags: string[] = [];
  const whatWorked: string[] = [];
  const whatFailed: string[] = [];

  // Did the trader follow the orchestrator's recommendation?
  let didFollowDecision: boolean | null = null;
  if (decision) {
    if (decision.action === "HOLD") didFollowDecision = false;
    else didFollowDecision = decision.action === direction;
  }

  if (decision?.action === "HOLD")
    mistakeTags.push("OVERRODE_HOLD_RECOMMENDATION");
  if (decision && decision.action !== "HOLD" && didFollowDecision === false)
    mistakeTags.push("WRONG_DIRECTION_VS_DECISION");
  if (result === "LOSS" && holdTimeSeconds < 60)
    mistakeTags.push("EXITED_TOO_QUICKLY");
  if (result === "LOSS" && exitPrice != null) {
    const slDist = Math.abs(stopLoss - exitPrice);
    const entryToExit = Math.abs(entryPrice - exitPrice);
    if (entryToExit > 0 && slDist > entryToExit * 1.5)
      mistakeTags.push("STOP_LOSS_DISTANCE_TOO_WIDE");
  }
  if (decision && decision.riskScore >= 70 && result !== "WIN")
    mistakeTags.push("TOOK_HIGH_RISK_TRADE");
  if (decision && decision.confidence < 60 && result !== "WIN")
    mistakeTags.push("TOOK_LOW_CONFIDENCE_TRADE");

  if (result === "WIN") {
    whatWorked.push(`Won ${pnl.toFixed(2)} on ${symbol} ${direction}`);
    if (didFollowDecision === true) whatWorked.push("Followed the orchestrator recommendation");
  } else if (result === "LOSS") {
    whatFailed.push(`Lost ${Math.abs(pnl).toFixed(2)} on ${symbol} ${direction}`);
    if (decision?.action === "HOLD") whatFailed.push("Took a trade the orchestrator advised HOLD on");
    else if (didFollowDecision === false) whatFailed.push(`Traded ${direction} when orchestrator suggested ${decision?.action ?? "different action"}`);
  } else if (result === "BREAKEVEN") {
    whatWorked.push("Avoided a loss");
    whatFailed.push("Did not capture a directional move");
  } else {
    whatFailed.push("Trade was cancelled before settlement");
  }

  let lesson: string;
  if (mistakeTags.includes("OVERRODE_HOLD_RECOMMENDATION") && result === "LOSS") {
    lesson = "When the orchestrator says HOLD, the cost of overriding usually exceeds the benefit. Wait for a clean signal next session.";
  } else if (result === "WIN" && didFollowDecision === true) {
    lesson = "Following the orchestrator on this setup paid off — repeat the discipline, not the outcome.";
  } else if (result === "WIN") {
    lesson = "A win is feedback, not proof of skill — examine the process before celebrating.";
  } else if (result === "LOSS") {
    lesson = "Losses are tuition. Examine entry geometry and the orchestrator signals before the next trade.";
  } else if (result === "BREAKEVEN") {
    lesson = "Breakevens often expose entry timing — was the setup wrong or the management right?";
  } else {
    lesson = "Cancelled trades are also data — note what changed your mind before next session.";
  }

  const improvementNote = mistakeTags.length > 0
    ? `Practice the following next session: ${mistakeTags.join(", ")}.`
    : "Maintain current process discipline.";

  return { mistakeTags, whatWorked, whatFailed, lesson, improvementNote, didFollowDecision };
}

/**
 * Run an auto-debrief for a closed paper order. Idempotent: if a debrief
 * already exists for the trade_id, returns the existing one without creating
 * a duplicate (relies on `post_trade_debriefs.tradeId` unique index).
 */
export async function runAutoDebrief(
  orderId: number,
  opts?: { triggeredBy?: string },
): Promise<AutoDebriefResult> {
  const log = logger.child({ component: "auto-debrief", orderId });
  const warnings: string[] = [];
  const triggeredBy = opts?.triggeredBy ?? "manual";

  // 1. Load the trade.
  const trade = (await db.select().from(paperOrdersTable)
    .where(eq(paperOrdersTable.id, orderId)).limit(1))[0];
  if (!trade) {
    log.warn("paper trade not found");
    return { status: "trade_not_found", orderId, warnings: ["Paper order not found"] };
  }
  log.info({ status: trade.status, decisionId: trade.decisionId }, "paper trade loaded");

  // 2. Only debrief closed trades.
  if (!isClosedStatus(trade.status)) {
    log.info({ status: trade.status }, "skipped — trade still open");
    return { status: "skipped_open", orderId, warnings: [`Trade status=${trade.status}, debrief only runs on closed trades`] };
  }

  // 3. Idempotency check via existing unique index on tradeId.
  const existing = (await db.select().from(postTradeDebriefsTable)
    .where(eq(postTradeDebriefsTable.tradeId, orderId)).limit(1))[0];
  if (existing) {
    log.info({ debriefId: existing.id, createdBy: existing.createdBy }, "skipped — debrief already exists");
    return {
      status: "skipped_already_exists",
      orderId,
      debriefId: existing.id,
      decisionId: existing.decisionId ?? null,
      learningPayload: (existing.learningPayload as Record<string, unknown>) ?? {},
      warnings: [`Debrief already exists (id=${existing.id}, createdBy=${existing.createdBy}) — idempotent skip`],
    };
  }

  // 4. Resolve linked Build AA decision (if any).
  let decision: DecisionRow | null = null;
  if (trade.decisionId != null) {
    const row = (await db.select().from(tradeDecisionLogsTable)
      .where(eq(tradeDecisionLogsTable.id, trade.decisionId)).limit(1))[0];
    if (row) {
      decision = row as DecisionRow;
      log.info({ decisionId: row.id, action: row.action }, "decision linked");
    } else {
      warnings.push(`Trade references decision_id=${trade.decisionId} but row not found in trade_decision_logs`);
      log.warn({ decisionId: trade.decisionId }, "decision_id present but row missing");
    }
  } else {
    warnings.push("Trade has no decision_id — debrief created without Build AA orchestrator context");
    log.info("no decision_id linked to trade");
  }

  // 5. Compute derived fields.
  const pnl = trade.profitLoss;
  const result = classifyResult(trade.status, pnl);
  const openedMs = trade.openedAt.getTime();
  const closedMs = (trade.closedAt ?? new Date()).getTime();
  const holdTimeSeconds = Math.max(0, Math.floor((closedMs - openedMs) / 1000));
  const notional = trade.entryPrice * trade.lotSize * 100;
  const pnlPercent = notional > 0 ? (pnl / notional) * 100 : 0;

  // 5a. Heat tag at entry — look up closest heat snapshot at trade open time.
  //     Fail-soft: returns null when no snapshot exists (honest absence, not fabricated).
  const heatAtEntry = await findHeatTagAtEntry(trade.symbol, trade.openedAt);

  const heuristics = deriveHeuristics({
    result, pnl,
    symbol: trade.symbol, direction: trade.direction,
    entryPrice: trade.entryPrice, exitPrice: trade.exitPrice,
    stopLoss: trade.stopLoss, holdTimeSeconds, decision,
  });

  const decisionJson = (decision?.decisionJson ?? {}) as { signalsUsed?: unknown[]; blockers?: unknown[] };
  const originalDecisionSummary = decision ? {
    action: decision.action,
    confidence: decision.confidence,
    risk_score: decision.riskScore,
    trade_window_status: decision.tradeWindowStatus,
    blockers: Array.isArray(decisionJson.blockers) ? decisionJson.blockers : [],
    signal_count: Array.isArray(decisionJson.signalsUsed) ? decisionJson.signalsUsed.length : 0,
  } : null;

  // 6. Full structured auto-debrief payload (per Build BB spec).
  const autoMeta: Record<string, unknown> = {
    trade_id: trade.id,
    decision_id: trade.decisionId ?? null,
    symbol: trade.symbol,
    action: trade.direction,
    result,
    pnl,
    pnl_percent: pnlPercent,
    entry_price: trade.entryPrice,
    exit_price: trade.exitPrice,
    opened_at: trade.openedAt.toISOString(),
    closed_at: trade.closedAt ? trade.closedAt.toISOString() : null,
    hold_time_seconds: holdTimeSeconds,
    original_decision_summary: originalDecisionSummary,
    did_follow_decision: heuristics.didFollowDecision,
    decision_confidence: decision?.confidence ?? null,
    decision_risk_score: decision?.riskScore ?? null,
    what_worked: heuristics.whatWorked,
    what_failed: heuristics.whatFailed,
    mistake_tags: heuristics.mistakeTags,
    lesson: heuristics.lesson,
    improvement_note: heuristics.improvementNote,
    // Heat tag at entry — from the nearest heat snapshot at trade open time.
    // null = no snapshot existed at the time (honest absence, never fabricated).
    heat_tag_at_entry: heatAtEntry
      ? {
          heatState: heatAtEntry.heatState,
          heatScore: heatAtEntry.heatScore,
          timingGrade: heatAtEntry.timingGrade,
          entryPermission: heatAtEntry.entryPermission,
          bestAction: heatAtEntry.bestAction,
        }
      : null,
    created_by: "SYSTEM_AUTO_DEBRIEF",
    triggered_by: triggeredBy,
    warnings,
  };

  // 7. Build CC handoff payload (prepared, NOT consumed by any scoring yet).
  const learningPayloadDraft: Record<string, unknown> = {
    trade_id: trade.id,
    decision_id: trade.decisionId ?? null,
    result,
    pnl,
    mistake_tags: heuristics.mistakeTags,
    lesson: heuristics.lesson,
    confidence_before_trade: decision?.confidence ?? null,
    risk_score_before_trade: decision?.riskScore ?? null,
    signals_used: Array.isArray(decisionJson.signalsUsed) ? decisionJson.signalsUsed : [],
    debrief_id: 0, // patched after insert
    ready_for_learning: true,
    note: "Build BB → Build CC handoff payload. Build BB has not altered scoring; Build CC will consume this.",
  };

  // 8. INSERT — guarded by uniqueIndex on tradeId for race-condition idempotency.
  let inserted: typeof postTradeDebriefsTable.$inferSelect;
  try {
    const insRows = await db.insert(postTradeDebriefsTable).values({
      // Per-user isolation: the debrief inherits the paper order's owner so
      // every downstream per-user read (skill, analytics, coach) can scope it.
      userId: trade.userId ?? null,
      tradeId: trade.id,
      decisionId: trade.decisionId ?? null,
      // Map BREAKEVEN/CANCELLED into result column (text, no enum constraint).
      result,
      checklist: [], // empty — auto-debrief has no user answers
      followedPlan: heuristics.didFollowDecision === true ? 1 : 0,
      lessonLearned: heuristics.lesson,
      aiFeedback: `[Auto-debrief] ${[...heuristics.whatWorked, ...heuristics.whatFailed].join(" ")} — ${heuristics.lesson}`,
      recommendedDrill: heuristics.improvementNote,
      createdBy: "SYSTEM_AUTO_DEBRIEF",
      autoMeta,
      learningPayload: learningPayloadDraft,
    }).returning();
    inserted = insRows[0]!;
    log.info({ debriefId: inserted.id, result }, "auto-debrief created");
  } catch (err) {
    // Race-condition: another caller already inserted between our check and write.
    const racy = (await db.select().from(postTradeDebriefsTable)
      .where(eq(postTradeDebriefsTable.tradeId, orderId)).limit(1))[0];
    if (racy) {
      log.warn({ debriefId: racy.id, err: String(err) }, "race-condition: existing debrief found after insert collision");
      return {
        status: "skipped_already_exists",
        orderId,
        debriefId: racy.id,
        decisionId: racy.decisionId ?? null,
        learningPayload: (racy.learningPayload as Record<string, unknown>) ?? {},
        warnings: [...warnings, "Race-condition: another debrief was created concurrently"],
      };
    }
    log.error({ err: String(err) }, "auto-debrief insert failed");
    return { status: "error", orderId, warnings, error: String(err).slice(0, 300) };
  }

  // 9. Patch in real debrief_id on the learning payload.
  const finalLearningPayload: Record<string, unknown> = { ...learningPayloadDraft, debrief_id: inserted.id };
  await db.update(postTradeDebriefsTable)
    .set({ learningPayload: finalLearningPayload, updatedAt: new Date() })
    .where(eq(postTradeDebriefsTable.id, inserted.id));

  // 9b. Build CC handoff — fire-and-forget, NON-FATAL.
  // The debrief is already persisted; CC failures must NOT roll it back or
  // crash the trade-close flow. CC is observe/learn only — see learningEngine.ts.
  if (finalLearningPayload.ready_for_learning === true) {
    void (async () => {
      try {
        const { processLearningPayload } = await import("./learningEngine.js");
        const ccResult = await processLearningPayload(
          finalLearningPayload as unknown as import("./learningEngine.js").LearningPayload,
        );
        log.info({
          debriefId: inserted.id,
          ccStatus: ccResult.status,
          ccEventId: ccResult.eventId,
          edgesUpdated: ccResult.edgeAdjustments.length,
          mistakesUpdated: ccResult.mistakeAdjustments.length,
        }, "Build CC processed BB learning payload");
      } catch (err) {
        log.warn({ err: String(err), debriefId: inserted.id }, "Build CC processing failed (non-fatal)");
      }
    })();
  }

  // 10. Trigger analytics snapshot (best-effort, non-fatal).
  let snapshotId: number | null = null;
  try {
    // Per-user isolation: an analytics snapshot is a per-trader aggregate. An
    // unowned (legacy) paper order has no trader to attribute it to, so we
    // skip rather than persist an instance-wide row that would then be shown
    // to somebody as "your" performance.
    if (trade.userId == null) {
      const msg = "Analytics snapshot skipped: paper order has no user_id — refusing to write an unscoped snapshot.";
      warnings.push(msg);
      log.warn({ orderId: trade.id }, msg);
    } else {
      const computed = await computeSnapshot(trade.userId);
      const snapIns = await db.insert(analyticsSnapshotsTable)
        .values({ ...computed, userId: trade.userId })
        .returning({ id: analyticsSnapshotsTable.id });
      snapshotId = snapIns[0]?.id ?? null;
      log.info({ snapshotId, totalTrades: computed.totalTrades }, "analytics snapshot generated");
    }
  } catch (err) {
    const msg = `Analytics snapshot failed (non-fatal): ${String(err).slice(0, 200)}`;
    warnings.push(msg);
    log.warn({ err: String(err) }, "analytics snapshot failed");
  }

  // 11. Vault audit (append-only, non-fatal).
  await db.insert(vaultEventsTable).values({
    kind: "AUTO_DEBRIEF_CREATED",
    severity: result === "LOSS" ? "WARN" : "INFO",
    source: "SYSTEM",
    truthDomain: "BEHAVIOR",
    summary: `Auto-debrief paper order ${trade.id} (${result})${trade.decisionId ? ` decision=${trade.decisionId}` : " no-decision"}`,
    payload: {
      orderId: trade.id,
      decisionId: trade.decisionId ?? null,
      debriefId: inserted.id,
      result,
      pnl,
      mistakeTags: heuristics.mistakeTags,
      snapshotId,
      triggeredBy,
      autoDebrief: true,
    },
    reasons: [],
    blockers: [],
    generatedAtIso: new Date().toISOString(),
  }).catch((err) => {
    log.warn({ err: String(err) }, "vault write failed (non-fatal)");
  });

  return {
    status: "created",
    orderId,
    debriefId: inserted.id,
    decisionId: trade.decisionId ?? null,
    result,
    autoMeta,
    learningPayload: finalLearningPayload,
    snapshotId,
    warnings,
  };
}
