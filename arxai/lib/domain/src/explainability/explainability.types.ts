import { z } from "zod/v4";

// ═══════════════════════════════════════════════════════════════════════════
// Explainability — TYPES
// Self-contained subdomain. Generates plain-English narratives explaining
// why an action was approved, blocked, delayed, sized down, etc.
// ═══════════════════════════════════════════════════════════════════════════

export const DecisionVerdictSchema = z.enum([
  "APPROVED", "WAITED", "REDUCED_SIZE", "BLOCKED", "RECOVERY_MODE",
  "COOLDOWN", "DELAYED",
]);
export type DecisionVerdict = z.infer<typeof DecisionVerdictSchema>;

// Lightweight, generic facts the upstream caller passes in. We avoid
// importing other subdomains' types to keep this self-contained.
export const FactSchema = z.object({
  key: z.string().min(1),
  value: z.union([z.string(), z.number(), z.boolean()]),
  unit: z.string().optional(),
  importance01: z.number().min(0).max(1).default(0.5),
});
export type Fact = z.infer<typeof FactSchema>;

export const NarrativeStyleSchema = z.enum(["TERSE", "STANDARD", "DETAILED"]);
export type NarrativeStyle = z.infer<typeof NarrativeStyleSchema>;

export const NarrativeSchema = z.object({
  headline: z.string(),
  paragraphs: z.array(z.string()),
  bullets: z.array(z.string()),
  style: NarrativeStyleSchema,
});
export type Narrative = z.infer<typeof NarrativeSchema>;

export const ConfidenceNarrativeSchema = z.object({
  expressedConfidence01: z.number().min(0).max(1),
  observedHitRate01: z.number().min(0).max(1).optional(),
  narrative: NarrativeSchema,
});
export type ConfidenceNarrative = z.infer<typeof ConfidenceNarrativeSchema>;

export const DangerNarrativeSchema = z.object({
  severity: z.enum(["LOW", "MEDIUM", "HIGH", "CRITICAL"]),
  threats: z.array(z.string()),
  narrative: NarrativeSchema,
});
export type DangerNarrative = z.infer<typeof DangerNarrativeSchema>;

export const DecisionNarrativeSchema = z.object({
  verdict: DecisionVerdictSchema,
  narrative: NarrativeSchema,
});
export type DecisionNarrative = z.infer<typeof DecisionNarrativeSchema>;

export const TradeReasoningSchema = z.object({
  symbolId: z.string(),
  side: z.enum(["BUY", "SELL"]),
  why: z.array(z.string()),       // why we want to take it
  whyNotYet: z.array(z.string()), // pending conditions
  blockers: z.array(z.string()),
  narrative: NarrativeSchema,
});
export type TradeReasoning = z.infer<typeof TradeReasoningSchema>;

export const ExplanationBundleSchema = z.object({
  generatedAtIso: z.string(),
  decision: DecisionNarrativeSchema,
  confidence: ConfidenceNarrativeSchema.optional(),
  danger: DangerNarrativeSchema.optional(),
  trade: TradeReasoningSchema.optional(),
  reasons: z.array(z.string()),
});
export type ExplanationBundle = z.infer<typeof ExplanationBundleSchema>;

export function toFactLine(f: Fact): string {
  const v = typeof f.value === "number" ? Number(f.value).toFixed(2) : String(f.value);
  return f.unit ? `${f.key}: ${v}${f.unit}` : `${f.key}: ${v}`;
}
