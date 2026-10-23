// Phase 13 — Protective Auto-Close: reversal signal analyzer.
//
// SAFETY:
//   * Pure analysis — no DB writes. Reads only the trade's exit plan +
//     live position fields. NEVER fabricates signals; when data is
//     missing returns dataStatus="INSUFFICIENT" and signals=[].
//   * Returns the SAME shape regardless of bridge/live status so the
//     decision engine can apply its own data-status policy.

import { db } from "@workspace/db";
import { livePositionsTable, tradeExitPlansTable } from "@workspace/db/schema";
import { and, eq } from "drizzle-orm";

export interface ReversalSignal {
  signal: string;
  strength: "weak" | "moderate" | "strong";
  evidence: string;
}

export interface ReversalAnalysis {
  signals: ReversalSignal[];
  strongCount: number;
  moderateCount: number;
  confidence: "INSUFFICIENT_DATA" | "LOW" | "MEDIUM" | "HIGH";
  dataStatus: "LIVE" | "DELAYED" | "INCOMPLETE" | "INSUFFICIENT" | "BRIDGE_DISCONNECTED";
  currentPnl: number | null;
  peakPnl: number | null;
  givebackPercent: number | null;
  invalidationLevel: number | null;
  reasonSummary: string;
}

function parsePositionId(tradeKey: string): number | null {
  const m = /^lp_(\d+)$/.exec(tradeKey);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

export async function analyzeReversal(userId: number, tradeKey: string): Promise<ReversalAnalysis> {
  const positionId = parsePositionId(tradeKey);
  if (positionId == null) {
    // Shared-master attribution keys are out of scope for this slice;
    // we report INSUFFICIENT and the engine will fall to ALERT_ONLY.
    return emptyAnalysis("INSUFFICIENT", "non-owned position key (attribution); engine will alert-only");
  }

  const [position] = await db.select().from(livePositionsTable)
    .where(and(eq(livePositionsTable.id, positionId), eq(livePositionsTable.userId, userId)))
    .limit(1);
  if (!position) return emptyAnalysis("INSUFFICIENT", "position not found or not owned by this user");
  if (position.status !== "OPEN") return emptyAnalysis("INSUFFICIENT", `position status=${position.status}; not open`);

  const [exit] = await db.select().from(tradeExitPlansTable)
    .where(and(eq(tradeExitPlansTable.userId, userId), eq(tradeExitPlansTable.tradeKey, tradeKey)))
    .limit(1);

  const signals: ReversalSignal[] = [];
  const currentPnl = (position.unrealizedProfitLoss as number | null) ?? null;
  // Note: schema has no peakUnrealizedProfitLoss column today; giveback %
  // requires the exit-plan-derived peak when it becomes available. We
  // honestly report null until a peak source exists.
  const peakPnl: number | null = null;
  const givebackPercent: number | null = null;

  // Exit-plan-derived signals (only when the plan was computed from real data).
  let invalidationLevel: number | null = null;
  let dataStatus: ReversalAnalysis["dataStatus"] = "INCOMPLETE";
  if (exit) {
    invalidationLevel = (exit.invalidationLevel as number | null) ?? null;
    const action = exit.recommendedAction;
    if (action === "CLOSE_NOW_PROMPT") {
      signals.push({ signal: "exit_plan_close_now", strength: "strong", evidence: `exit plan recommends ${action}` });
    } else if (action === "PARTIAL_CLOSE" || action === "PARTIAL_CLOSE_PROMPT" || action === "TIGHTEN_STOP_PROMPT" || action === "TRAIL_STOP" || action === "MOVE_STOP_TO_BREAKEVEN") {
      signals.push({ signal: "exit_plan_caution", strength: "moderate", evidence: `exit plan recommends ${action}` });
    } else if (action === "CLOSE_CONSIDERATION" || action === "WATCH_CLOSELY") {
      signals.push({ signal: "exit_plan_watch", strength: "moderate", evidence: `exit plan recommends ${action}` });
    }
    // Staleness check against updatedAt — anything older than 5 minutes is DELAYED.
    const ageMs = Date.now() - exit.updatedAt.getTime();
    if (ageMs > 5 * 60_000) dataStatus = "DELAYED";
    else dataStatus = "LIVE";
  }

  // Invalidation proximity — if currentPrice is within 10% of stop distance.
  if (invalidationLevel != null && position.currentPrice != null) {
    const cp = position.currentPrice as number;
    const entryRef = position.entryPrice;
    const stopRef = position.stopLoss as number | null;
    if (stopRef != null && Number.isFinite(stopRef) && Number.isFinite(entryRef)) {
      const stopDist = Math.abs(entryRef - stopRef);
      const proximity = Math.abs(cp - stopRef);
      if (stopDist > 0 && proximity / stopDist < 0.10) {
        signals.push({ signal: "near_invalidation", strength: "strong", evidence: `current price within 10% of stop distance` });
      }
    }
  }

  const strongCount = signals.filter((s) => s.strength === "strong").length;
  const moderateCount = signals.filter((s) => s.strength === "moderate").length;
  let confidence: ReversalAnalysis["confidence"];
  if (!exit && signals.length === 0) confidence = "INSUFFICIENT_DATA";
  else if (strongCount >= 2) confidence = "HIGH";
  else if (strongCount >= 1 && moderateCount >= 1) confidence = "HIGH";
  else if (strongCount >= 1 || moderateCount >= 2) confidence = "MEDIUM";
  else if (moderateCount >= 1) confidence = "LOW";
  else confidence = "INSUFFICIENT_DATA";

  return {
    signals,
    strongCount,
    moderateCount,
    confidence,
    dataStatus,
    currentPnl,
    peakPnl,
    givebackPercent,
    invalidationLevel,
    reasonSummary: signals.length === 0
      ? "no reversal signals detected from available data"
      : `${strongCount} strong + ${moderateCount} moderate signal(s)`,
  };
}

function emptyAnalysis(dataStatus: ReversalAnalysis["dataStatus"], reason: string): ReversalAnalysis {
  return {
    signals: [],
    strongCount: 0,
    moderateCount: 0,
    confidence: "INSUFFICIENT_DATA",
    dataStatus,
    currentPnl: null,
    peakPnl: null,
    givebackPercent: null,
    invalidationLevel: null,
    reasonSummary: reason,
  };
}
