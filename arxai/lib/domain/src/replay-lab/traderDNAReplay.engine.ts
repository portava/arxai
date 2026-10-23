// ═══════════════════════════════════════════════════════════════════════════
// Trader DNA Replay
//
// Reads back the recorded Trader DNA + cognitive state at the time of the
// decision. Returns a discipline assessment of the actual intent against
// baseline (size deviation, gap deviation).
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";
import type { ReplaySnapshot } from "./replay.types";

export const TraderDNAReplayReportSchema = z.object({
  baselineMature: z.boolean(),
  disciplineScore01: z.number().min(0).max(1),
  behaviorRiskScore01: z.number().min(0).max(1),
  cognitiveLoad01: z.number().min(0).max(1),
  fatigueScore01: z.number().min(0).max(1),
  sizeDeviationFromBaseline: z.number(),
  disciplineQuality01: z.number().min(0).max(1),
  notes: z.array(z.string()),
});
export type TraderDNAReplayReport = z.infer<typeof TraderDNAReplayReportSchema>;

export function replayTraderDNA(snapshot: ReplaySnapshot): TraderDNAReplayReport {
  const dna = snapshot.traderDNA, cog = snapshot.cognitive;
  const baseLot = dna.baselineLot || 1;
  const lot = snapshot.intent?.lotSize ?? baseLot;
  const dev = Math.abs(lot - baseLot) / baseLot;
  // Discipline quality: closer to baseline + lower behavior risk + higher recorded discipline
  const quality = clamp01(
    (1 - clamp01(dev)) * 0.4 +
    (1 - dna.behaviorRiskScore01) * 0.3 +
    dna.disciplineScore01 * 0.3,
  );
  const notes: string[] = [];
  if (!dna.baselineMature) notes.push("baseline immature — discipline finding advisory only");
  if (dev > 0.5) notes.push(`size ${(dev*100).toFixed(0)}% off baseline`);
  if (cog.cognitiveLoad01 >= 0.65) notes.push(`elevated cognitive load (${cog.cognitiveLoad01.toFixed(2)})`);
  return {
    baselineMature: dna.baselineMature,
    disciplineScore01: dna.disciplineScore01,
    behaviorRiskScore01: dna.behaviorRiskScore01,
    cognitiveLoad01: cog.cognitiveLoad01,
    fatigueScore01: cog.fatigueScore01,
    sizeDeviationFromBaseline: round2(dev),
    disciplineQuality01: round2(quality),
    notes,
  };
}
function clamp01(n: number) { return Math.max(0, Math.min(1, n)); }
function round2(n: number) { return Math.round(n * 100) / 100; }
