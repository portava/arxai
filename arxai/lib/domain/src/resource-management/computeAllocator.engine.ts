import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Compute Allocator — split a fixed compute budget (CPU / GPU / wall-time
// units) across competing requesters by weighted priority. Pure proposal;
// no scheduling here.
//
// Defensive: total allocated never exceeds budget. Below-floor requesters
// are zeroed instead of starving everyone.
// ═══════════════════════════════════════════════════════════════════════════

export const ComputeRequestSchema = z.object({
  requesterId: z.string().min(1),
  priority01: z.number().min(0).max(1),
  needUnits: z.number().min(0),              // how much it ideally wants
  minimumUnits: z.number().min(0),           // below this, allocation is useless
});
export type ComputeRequest = z.infer<typeof ComputeRequestSchema>;

export const ComputeAllocatorInputsSchema = z.object({
  totalBudgetUnits: z.number().min(0),
  requests: z.array(ComputeRequestSchema),
});
export type ComputeAllocatorInputs = z.infer<typeof ComputeAllocatorInputsSchema>;

export interface ComputeAllocation {
  requesterId: string;
  unitsAllocated: number;
  fulfillmentRatio01: number;                // unitsAllocated / needUnits
  reasons: string[];
}

export interface ComputeAllocatorResult {
  allocations: ComputeAllocation[];
  totalAllocated: number;
  unallocated: number;
  reasons: string[];
  blockers: string[];
}

export function allocateCompute(i: ComputeAllocatorInputs): ComputeAllocatorResult {
  const reasons: string[] = [];
  const blockers: string[] = [];
  if (i.totalBudgetUnits <= 0) {
    blockers.push(`totalBudgetUnits ${i.totalBudgetUnits} ≤ 0 — nothing to allocate`);
    return { allocations: [], totalAllocated: 0, unallocated: 0, reasons, blockers };
  }
  if (i.requests.length === 0) {
    blockers.push(`no requesters`);
    return { allocations: [], totalAllocated: 0, unallocated: i.totalBudgetUnits, reasons, blockers };
  }

  // Weight = priority × need. Defensive: weight 0 means no allocation.
  const weights = i.requests.map((r) => ({ r, w: r.priority01 * r.needUnits }));
  const totalWeight = weights.reduce((s, x) => s + x.w, 0);
  if (totalWeight <= 0) {
    blockers.push(`total weight is zero — no allocations possible`);
    return { allocations: [], totalAllocated: 0, unallocated: i.totalBudgetUnits, reasons, blockers };
  }

  // First pass: proportional share, capped at need.
  const initial = weights.map(({ r, w }) => {
    const share = (w / totalWeight) * i.totalBudgetUnits;
    const capped = Math.min(share, r.needUnits);
    return { r, raw: share, allocated: capped };
  });

  // Second pass: zero out anyone below their useful minimum (defensive).
  const finalAllocs: ComputeAllocation[] = initial.map(({ r, allocated, raw }) => {
    const reasonsR: string[] = [];
    let units = allocated;
    if (allocated < r.minimumUnits) {
      reasonsR.push(`zeroed: allocation ${allocated.toFixed(2)} < useful minimum ${r.minimumUnits.toFixed(2)}`);
      units = 0;
    } else {
      reasonsR.push(`weight ${(r.priority01 * r.needUnits).toFixed(2)} → share ${raw.toFixed(2)} → capped at need ${r.needUnits.toFixed(2)} → ${units.toFixed(2)}`);
    }
    return {
      requesterId: r.requesterId,
      unitsAllocated: units,
      fulfillmentRatio01: r.needUnits > 0 ? units / r.needUnits : 0,
      reasons: reasonsR,
    };
  });

  // Defensive: never exceed budget (rounding safety).
  const totalAllocated = finalAllocs.reduce((s, a) => s + a.unitsAllocated, 0);
  const unallocated = Math.max(0, i.totalBudgetUnits - totalAllocated);

  reasons.push(`allocated ${totalAllocated.toFixed(2)} of ${i.totalBudgetUnits.toFixed(2)} budget across ${finalAllocs.length} requesters (${unallocated.toFixed(2)} reserve)`);
  return { allocations: finalAllocs, totalAllocated, unallocated, reasons, blockers };
}
