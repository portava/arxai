import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Attention — TYPES
// Self-contained subdomain. Decides what the dashboard surfaces RIGHT NOW.
// ═══════════════════════════════════════════════════════════════════════════

export const ItemKindSchema = z.enum([
  "DANGER", "TRADE_SETUP", "FILL", "RISK_EVENT",
  "INFO", "STATUS", "EXPLANATION",
]);
export type ItemKind = z.infer<typeof ItemKindSchema>;

export const SeveritySchema = z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const AttentionItemSchema = z.object({
  itemId: z.string().min(1),
  kind: ItemKindSchema,
  severity: SeveritySchema,
  freshnessMs: z.number().nonnegative(),  // age since produced
  decayHalfLifeMs: z.number().positive(),
  signalStrength01: z.number().min(0).max(1),
  actionable: z.boolean(),
  payloadJson: z.string(),
});
export type AttentionItem = z.infer<typeof AttentionItemSchema>;

export const RankedItemSchema = z.object({
  itemId: z.string(),
  score01: z.number().min(0).max(1),
  rank: z.int().nonnegative(),
  reasons: z.array(z.string()),
});
export type RankedItem = z.infer<typeof RankedItemSchema>;

export const UrgencyReportSchema = z.object({
  ranked: z.array(RankedItemSchema),
  reasons: z.array(z.string()),
});
export type UrgencyReport = z.infer<typeof UrgencyReportSchema>;

export const DangerReportSchema = z.object({
  topDangers: z.array(RankedItemSchema),
  reasons: z.array(z.string()),
});
export type DangerReport = z.infer<typeof DangerReportSchema>;

export const SetupReportSchema = z.object({
  topSetups: z.array(RankedItemSchema),
  reasons: z.array(z.string()),
});
export type SetupReport = z.infer<typeof SetupReportSchema>;

export const CognitiveLoadStateSchema = z.object({
  itemsOnScreen: z.int().nonnegative(),
  load01: z.number().min(0).max(1),
  recommendedMaxItems: z.int().positive(),
  reasons: z.array(z.string()),
});
export type CognitiveLoadState = z.infer<typeof CognitiveLoadStateSchema>;

export const FocusSlotSchema = z.object({
  slotName: z.enum(["PRIMARY", "SECONDARY", "TICKER", "AMBIENT"]),
  itemIds: z.array(z.string()),
});
export type FocusSlot = z.infer<typeof FocusSlotSchema>;

export const UiFocusPlanSchema = z.object({
  slots: z.array(FocusSlotSchema),
  hiddenItemIds: z.array(z.string()),
  reasons: z.array(z.string()),
});
export type UiFocusPlan = z.infer<typeof UiFocusPlanSchema>;

export const AttentionPlanSchema = z.object({
  generatedAtIso: z.string(),
  cognitiveLoad: CognitiveLoadStateSchema,
  urgency: UrgencyReportSchema,
  dangers: DangerReportSchema,
  setups: SetupReportSchema,
  ui: UiFocusPlanSchema,
  reasons: z.array(z.string()),
});
export type AttentionPlan = z.infer<typeof AttentionPlanSchema>;

export function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  LOW: 0.25, MEDIUM: 0.5, HIGH: 0.75, CRITICAL: 1.0,
};
