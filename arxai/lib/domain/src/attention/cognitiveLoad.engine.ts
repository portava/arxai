import { type CognitiveLoadState, clamp01 } from "./attention.types";

// ═══════════════════════════════════════════════════════════════════════════
// Cognitive Load (UI-side) — separate from the cognitive subdomain's
// trader-state model. This engine only governs how many items the UI
// should surface so the operator isn't overloaded.
//
//   load = sigmoid((onScreen - softCap) / k)
//   recommendedMax = max(3, softCap - 2 · ceil(load · softCap))
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface UiLoadInput {
  itemsOnScreen: number;
  softCap?: number;             // default 7
  k?: number;                   // sigmoid sharpness, default 2
  baselineMaxItems?: number;    // default 9
}

export function computeUiCognitiveLoad(input: UiLoadInput): CognitiveLoadState {
  const reasons: string[] = [];
  const onScreen = Math.max(0, Math.floor(input.itemsOnScreen));
  const cap = input.softCap ?? 7;
  const k = input.k ?? 2;
  const baseline = input.baselineMaxItems ?? 9;
  const load01 = clamp01(1 / (1 + Math.exp(-(onScreen - cap) / k)));
  const reduction = Math.ceil(load01 * cap);
  const recommendedMaxItems = Math.max(3, baseline - 2 * reduction);
  reasons.push(`onScreen ${onScreen} (cap ${cap}) → load ${load01.toFixed(2)} → recommendedMax ${recommendedMaxItems}`);
  return { itemsOnScreen: onScreen, load01, recommendedMaxItems, reasons };
}
