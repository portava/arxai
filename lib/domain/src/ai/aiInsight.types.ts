import { z } from "zod/v4";

export const AiDecisionVerdictSchema = z.enum(["APPROVE", "WAIT", "BLOCK"]);
export type AiDecisionVerdict = z.infer<typeof AiDecisionVerdictSchema>;

export const AiConfidenceFactorSchema = z.object({
  name: z.string(),
  weight: z.number().min(0).max(1),
  score: z.number().min(0).max(100),
});
export type AiConfidenceFactor = z.infer<typeof AiConfidenceFactorSchema>;

export const AiInsightSchema = z.object({
  symbol: z.string(),
  strategy: z.string().nullable().optional(),
  session: z.string().nullable().optional(),
  recommendation: z.string(),
  strength: z.number().min(0).max(100),
  sampleSize: z.number().int().nonnegative(),
});
export type AiInsight = z.infer<typeof AiInsightSchema>;

export const AiDecisionSchema = z.object({
  verdict: AiDecisionVerdictSchema,
  confidence: z.number().min(0).max(100),
  reasoning: z.string(),
  factors: z.array(AiConfidenceFactorSchema),
  blockers: z.array(z.string()),
  cautions: z.array(z.string()),
});
export type AiDecision = z.infer<typeof AiDecisionSchema>;
