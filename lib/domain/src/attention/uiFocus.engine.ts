import {
  type AttentionItem, type UrgencyReport, type DangerReport, type SetupReport,
  type UiFocusPlan, type FocusSlot, type CognitiveLoadState,
} from "./attention.types";

// ═══════════════════════════════════════════════════════════════════════════
// UI Focus — assigns ranked items to UI slots, capped by cognitive load:
//   PRIMARY     1 slot  — top danger if present, else top urgency
//   SECONDARY   up to 2 — top setups
//   TICKER      up to 4 — remaining urgency items
//   AMBIENT     remainder up to recommendedMax-7
//   hiddenItemIds — everything past the cap
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface UiFocusInput {
  items: ReadonlyArray<AttentionItem>;
  urgency: UrgencyReport;
  dangers: DangerReport;
  setups: SetupReport;
  load: CognitiveLoadState;
}

export function planUiFocus(input: UiFocusInput): UiFocusPlan {
  const reasons: string[] = [];
  const max = input.load.recommendedMaxItems;
  const used = new Set<string>();
  const primary: string[] = [];
  const secondary: string[] = [];
  const ticker: string[] = [];
  const ambient: string[] = [];

  const topDanger = input.dangers.topDangers[0];
  const topUrg    = input.urgency.ranked[0];
  if (topDanger) { primary.push(topDanger.itemId); used.add(topDanger.itemId); reasons.push(`PRIMARY danger ${topDanger.itemId}`); }
  else if (topUrg) { primary.push(topUrg.itemId); used.add(topUrg.itemId); reasons.push(`PRIMARY urgency ${topUrg.itemId}`); }

  for (const s of input.setups.topSetups) {
    if (used.has(s.itemId) || secondary.length >= 2) break;
    if (used.size >= max) break;
    secondary.push(s.itemId); used.add(s.itemId);
  }
  for (const u of input.urgency.ranked) {
    if (used.has(u.itemId) || ticker.length >= 4) break;
    if (used.size >= max) break;
    ticker.push(u.itemId); used.add(u.itemId);
  }
  for (const u of input.urgency.ranked) {
    if (used.has(u.itemId)) continue;
    if (used.size >= max) break;
    ambient.push(u.itemId); used.add(u.itemId);
  }

  const slots: FocusSlot[] = [
    { slotName: "PRIMARY",   itemIds: primary },
    { slotName: "SECONDARY", itemIds: secondary },
    { slotName: "TICKER",    itemIds: ticker },
    { slotName: "AMBIENT",   itemIds: ambient },
  ];
  const hiddenItemIds = input.items.map((i) => i.itemId).filter((id) => !used.has(id));
  reasons.push(`shown ${used.size}/${input.items.length} (cap ${max}) · hidden ${hiddenItemIds.length}`);
  return { slots, hiddenItemIds, reasons };
}
