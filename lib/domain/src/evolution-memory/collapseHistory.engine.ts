import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Collapse History — record of past system-level collapses. Used by the
// constitution to convert root mutations into permanent forbidden patterns
// (PROJECT LAW L_MEMORY_FORBIDS).
// ═══════════════════════════════════════════════════════════════════════════

export const CollapseEntrySchema = z.object({
  collapseId: z.string().min(1),
  occurredAtIso: z.string(),
  rootMutationFingerprint: z.string().min(1).nullable(),
  drawdownPct: z.number().min(0).max(100),
  affectedStrategyIds: z.array(z.string()),
  rootCause: z.string().min(1),
});
export type CollapseEntry = z.infer<typeof CollapseEntrySchema>;

export const CollapseHistoryInputsSchema = z.object({
  history: z.array(CollapseEntrySchema),
  windowDays: z.number().positive().default(180),
  nowIso: z.string(),
});
export type CollapseHistoryInputs = z.infer<typeof CollapseHistoryInputsSchema>;

export interface CollapseHistoryReport {
  totalCollapses: number;
  collapsesInWindow: number;
  worstDrawdownInWindowPct: number;
  rootFingerprintsToBlacklist: string[];
  reasons: string[];
}

export function summarizeCollapseHistory(
  i: CollapseHistoryInputs,
): CollapseHistoryReport {
  const cutoff = new Date(i.nowIso).getTime() - i.windowDays * 86400 * 1000;
  const inWindow = i.history.filter((e) => new Date(e.occurredAtIso).getTime() >= cutoff);
  const worst = inWindow.reduce((m, e) => Math.max(m, e.drawdownPct), 0);
  const fp = new Set<string>();
  for (const e of i.history) if (e.rootMutationFingerprint) fp.add(e.rootMutationFingerprint);
  return {
    totalCollapses: i.history.length,
    collapsesInWindow: inWindow.length,
    worstDrawdownInWindowPct: worst,
    rootFingerprintsToBlacklist: [...fp],
    reasons: [
      `${i.history.length} total collapses, ${inWindow.length} in last ${i.windowDays}d, worst ${worst.toFixed(2)}%`,
      `${fp.size} fingerprint(s) feed L_MEMORY_FORBIDS`,
    ],
  };
}
