// ═══════════════════════════════════════════════════════════════════════════
// Edge Fingerprint
//
// Composes BestConditions + WorstConditions into two compact "fingerprints":
//   • PersonalEdgeFingerprint   — where the trader operates best
//   • PersonalDangerFingerprint — where the trader operates worst
//
// Each fingerprint is the minimal set of identifying tags so the UI / coach
// can produce neutral guidance ("operates best on X under Y") without
// repeating the full bucket grid.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import { type BestConditions } from "./bestConditions.engine";
import { type WorstConditions } from "./worstConditions.engine";

export const EdgeFingerprintSchema = z.object({
  symbols:    z.array(z.string()),
  sessions:   z.array(z.string()),
  strategies: z.array(z.string()),
  hours:      z.array(z.number().int().min(0).max(23)),
  signature:  z.string(),
  narrative:  z.array(z.string()),
});
export type EdgeFingerprint = z.infer<typeof EdgeFingerprintSchema>;

export function buildPersonalEdgeFingerprint(best: BestConditions): EdgeFingerprint {
  const symbols    = unique([...best.topBuckets.map(b => b.symbol), ...best.topSymbols.map(s => s.symbol)]);
  const sessions   = unique([...best.topBuckets.map(b => b.session as string), ...best.topSessions.map(s => s.session)]);
  const strategies = unique([...best.topBuckets.map(b => b.strategyId), ...best.topStrategies.map(s => s.strategyId)]);
  const hours      = unique(best.topBuckets.map(b => b.hourOfDay));
  return {
    symbols, sessions, strategies, hours,
    signature: `EDGE[${symbols.join(",")}|${sessions.join(",")}|${strategies.join(",")}|${hours.join(",")}]`,
    narrative: best.narrative,
  };
}

export function buildPersonalDangerFingerprint(worst: WorstConditions): EdgeFingerprint {
  const symbols    = unique([...worst.bottomBuckets.map(b => b.symbol), ...worst.worstSymbols.map(s => s.symbol)]);
  const sessions   = unique([...worst.bottomBuckets.map(b => b.session as string), ...worst.worstSessions.map(s => s.session)]);
  const strategies = unique([...worst.bottomBuckets.map(b => b.strategyId), ...worst.worstStrategies.map(s => s.strategyId)]);
  const hours      = unique(worst.bottomBuckets.map(b => b.hourOfDay));
  return {
    symbols, sessions, strategies, hours,
    signature: `DANGER[${symbols.join(",")}|${sessions.join(",")}|${strategies.join(",")}|${hours.join(",")}]`,
    narrative: worst.narrative,
  };
}

function unique<T>(xs: T[]): T[] { return Array.from(new Set(xs)); }
