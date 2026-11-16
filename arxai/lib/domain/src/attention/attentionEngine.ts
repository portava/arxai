import {
  type AttentionItem, type AttentionPlan,
} from "./attention.types";
import { rankByUrgency } from "./urgencyRanking.engine";
import { prioritizeDangers } from "./dangerPriority.engine";
import { prioritizeSetups } from "./setupPriority.engine";
import { computeUiCognitiveLoad } from "./cognitiveLoad.engine";
import { planUiFocus } from "./uiFocus.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Attention Engine — composes urgency / danger / setup / load / focus
// into a single AttentionPlan. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface AttentionInput {
  items: ReadonlyArray<AttentionItem>;
  generatedAtIso: string;
}

export function buildAttentionPlan(input: AttentionInput): AttentionPlan {
  const reasons: string[] = [];
  const urgency = rankByUrgency(input.items);
  const dangers = prioritizeDangers(input.items);
  const setups  = prioritizeSetups(input.items);
  const load    = computeUiCognitiveLoad({ itemsOnScreen: input.items.length });
  const ui      = planUiFocus({ items: input.items, urgency, dangers, setups, load });
  reasons.push(`built plan from ${input.items.length} items (load ${load.load01.toFixed(2)})`);
  return {
    generatedAtIso: input.generatedAtIso,
    cognitiveLoad: load, urgency, dangers, setups, ui, reasons,
  };
}
