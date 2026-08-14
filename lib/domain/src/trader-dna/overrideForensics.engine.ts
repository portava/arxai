// ═══════════════════════════════════════════════════════════════════════════
// Override Forensics
//
// Reviews each manual override (a trader-initiated action that bypassed a
// risk gate / signal filter / size cap) on observable criteria:
//
//   1. Did the override IMPROVE the trade outcome?  (post-override pnl > 0)
//   2. Did it INCREASE risk?                         (lot ratio vs baseline)
//   3. Did it VIOLATE a rule?                        (caller-supplied flag)
//   4. Was it AFTER a recent loss?                   (loss within lookback)
//
// overrideQualityScore01 in [0..1], higher = better discipline.
// Pure. Never mutates inputs.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { Trade } from "../trade/trade.types";
import type { PersonalBaseline } from "./personalBaseline.engine";

export const OverrideRecordSchema = z.object({
  id: z.string().min(1),
  occurredAt: z.string(),                      // ISO
  kind: z.enum([
    "SIZE_OVERRIDE", "FILTER_BYPASS", "RISK_CAP_OVERRIDE", "COOLDOWN_OVERRIDE",
    "CONFIDENCE_OVERRIDE", "OTHER",
  ]),
  ruleViolated: z.boolean().default(false),
  reason: z.string().optional(),
  // Optional linkage to the trade that resulted from / was affected by the override.
  resultTradeId: z.union([z.string(), z.number()]).optional(),
  resultPnl: z.number().optional(),
  resultLotSize: z.number().nonnegative().optional(),
}).strict();
export type OverrideRecord = z.infer<typeof OverrideRecordSchema>;

export const OverrideForensicsItemSchema = OverrideRecordSchema.extend({
  improvedOutcome: z.boolean(),
  increasedRisk: z.boolean(),
  afterLoss: z.boolean(),
  qualityScore01: z.number().min(0).max(1),
  reasons: z.array(z.string()),
}).strict();
export type OverrideForensicsItem = z.infer<typeof OverrideForensicsItemSchema>;

export const OverrideForensicsReportSchema = z.object({
  totalOverrides: z.number().int().nonnegative(),
  improvedOutcomeCount: z.number().int().nonnegative(),
  increasedRiskCount: z.number().int().nonnegative(),
  ruleViolatedCount: z.number().int().nonnegative(),
  afterLossCount: z.number().int().nonnegative(),
  overrideQualityScore01: z.number().min(0).max(1),
  items: z.array(OverrideForensicsItemSchema),
  evidence: z.array(z.string()),
});
export type OverrideForensicsReport = z.infer<typeof OverrideForensicsReportSchema>;

const POST_LOSS_LOOKBACK_MIN = 60;
const SIZE_INCREASE_RATIO = 1.5;

export function analyzeOverrides(
  overrides: OverrideRecord[],
  trades: Trade[],
  baseline: PersonalBaseline,
): OverrideForensicsReport {
  const baseLot = baseline.lotSize.median > 0 ? baseline.lotSize.median : 1;
  const losses = trades
    .filter(t => t.status === "CLOSED_LOSS" && t.closedAt)
    .map(t => new Date(t.closedAt!).getTime())
    .sort((a, b) => a - b);

  const items: OverrideForensicsItem[] = overrides.map(o => {
    const reasons: string[] = [];
    const occurredAt = new Date(o.occurredAt).getTime();

    const improvedOutcome = (o.resultPnl ?? 0) > 0;
    if (improvedOutcome) reasons.push(`outcome improved (pnl ${(o.resultPnl ?? 0).toFixed(2)})`);

    const lotRatio = (o.resultLotSize ?? 0) / baseLot;
    const increasedRisk = lotRatio >= SIZE_INCREASE_RATIO;
    if (increasedRisk) reasons.push(`size ${o.resultLotSize?.toFixed(2)} = ${lotRatio.toFixed(2)}× baseline`);

    const afterLoss = losses.some(t => occurredAt > t && occurredAt - t <= POST_LOSS_LOOKBACK_MIN * 60_000);
    if (afterLoss) reasons.push(`within ${POST_LOSS_LOOKBACK_MIN}m of a loss`);

    if (o.ruleViolated) reasons.push(`explicit rule violation`);

    // Quality: start at 0.5, add for improvement, subtract for risk/violation/post-loss.
    let q = 0.5;
    if (improvedOutcome) q += 0.30;
    if (increasedRisk)   q -= 0.20;
    if (o.ruleViolated)  q -= 0.30;
    if (afterLoss)       q -= 0.15;
    const qualityScore01 = clamp01(q);

    return {
      ...o,
      improvedOutcome, increasedRisk, afterLoss,
      qualityScore01, reasons,
    };
  });

  const total = items.length;
  const improved = items.filter(i => i.improvedOutcome).length;
  const risky    = items.filter(i => i.increasedRisk).length;
  const violated = items.filter(i => i.ruleViolated).length;
  const postLoss = items.filter(i => i.afterLoss).length;
  const overrideQualityScore01 = total === 0 ? 1 : avg(items.map(i => i.qualityScore01));

  const evidence: string[] = [];
  if (total === 0) {
    evidence.push("no overrides in window — discipline holds");
  } else {
    evidence.push(`${total} overrides reviewed`);
    if (improved > 0) evidence.push(`${improved}/${total} improved outcome`);
    if (risky > 0)    evidence.push(`${risky}/${total} increased risk size`);
    if (violated > 0) evidence.push(`${violated}/${total} violated a rule`);
    if (postLoss > 0) evidence.push(`${postLoss}/${total} occurred after a loss`);
  }

  return {
    totalOverrides: total,
    improvedOutcomeCount: improved,
    increasedRiskCount: risky,
    ruleViolatedCount: violated,
    afterLossCount: postLoss,
    overrideQualityScore01,
    items, evidence,
  };
}

function avg(xs: number[]): number { return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0; }
function clamp01(x: number): number { return Number.isFinite(x) ? (x < 0 ? 0 : x > 1 ? 1 : x) : 0; }
