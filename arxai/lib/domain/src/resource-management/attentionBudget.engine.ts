import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Attention Budget — caps how many concurrent items demand human / AI
// reviewer attention. Anomalies, alerts, and pending approvals all draw
// from a single budget. Over-budget triggers triage: highest severity
// retained, lower severity deferred.
//
// Defensive: budget cannot go negative; deferred items still surface in
// the result so callers can re-queue them.
// ═══════════════════════════════════════════════════════════════════════════

export const AttentionItemSchema = z.object({
  itemId: z.string().min(1),
  severity01: z.number().min(0).max(1),
  costUnits: z.number().min(0),              // attention "cost" — minutes of focus
  perishableInMinutes: z.number().min(0).optional(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const AttentionBudgetInputsSchema = z.object({
  totalBudgetUnits: z.number().min(0),
  items: z.array(AttentionItemSchema),
});
export type AttentionBudgetInputs = z.infer<typeof AttentionBudgetInputsSchema>;

export interface AttentionAssignment {
  itemId: string;
  decision: "ATTEND" | "DEFER" | "DROP";
  reasons: string[];
}

export interface AttentionBudgetResult {
  assignments: AttentionAssignment[];
  attendedCount: number;
  deferredCount: number;
  droppedCount: number;
  unitsConsumed: number;
  unitsRemaining: number;
  reasons: string[];
  blockers: string[];
}

// triageAttention — greedy by severity. Items above a perishability
// threshold are DROPPED rather than DEFERRED if they can't fit (deferring
// a perishable item is worse than dropping it, since reviewing it stale
// burns budget for no value).
export const ATTENTION_TUNING = {
  perishableDropMinutes: 5,                  // ≤ 5 min → DROP if no budget
} as const;

export function triageAttention(i: AttentionBudgetInputs): AttentionBudgetResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (i.totalBudgetUnits < 0) {
    blockers.push(`totalBudgetUnits ${i.totalBudgetUnits} < 0`);
  }

  // Sort by severity desc, then by perishability (more urgent first).
  const ordered = [...i.items].sort((a, b) => {
    if (b.severity01 !== a.severity01) return b.severity01 - a.severity01;
    const ap = a.perishableInMinutes ?? Number.POSITIVE_INFINITY;
    const bp = b.perishableInMinutes ?? Number.POSITIVE_INFINITY;
    return ap - bp;
  });

  let remaining = Math.max(0, i.totalBudgetUnits);
  const assignments: AttentionAssignment[] = [];
  for (const item of ordered) {
    const r: string[] = [];
    if (item.costUnits <= remaining) {
      remaining -= item.costUnits;
      r.push(`severity ${item.severity01.toFixed(3)} fits in budget (cost ${item.costUnits.toFixed(2)}, remaining ${remaining.toFixed(2)})`);
      assignments.push({ itemId: item.itemId, decision: "ATTEND", reasons: r });
    } else if ((item.perishableInMinutes ?? Number.POSITIVE_INFINITY) <= ATTENTION_TUNING.perishableDropMinutes) {
      r.push(`out of budget AND perishable (≤ ${ATTENTION_TUNING.perishableDropMinutes}min) — DROP`);
      assignments.push({ itemId: item.itemId, decision: "DROP", reasons: r });
    } else {
      r.push(`out of budget — DEFER for next window`);
      assignments.push({ itemId: item.itemId, decision: "DEFER", reasons: r });
    }
  }

  const attended = assignments.filter((a) => a.decision === "ATTEND").length;
  const deferred = assignments.filter((a) => a.decision === "DEFER").length;
  const dropped  = assignments.filter((a) => a.decision === "DROP").length;
  const consumed = i.totalBudgetUnits - remaining;
  reasons.push(`triaged ${i.items.length}: attend ${attended}, defer ${deferred}, drop ${dropped}; consumed ${consumed.toFixed(2)} of ${i.totalBudgetUnits.toFixed(2)}`);
  return {
    assignments,
    attendedCount: attended, deferredCount: deferred, droppedCount: dropped,
    unitsConsumed: consumed, unitsRemaining: remaining,
    reasons, blockers,
  };
}
