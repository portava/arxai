// ═══════════════════════════════════════════════════════════════════════════
// UI Density Adjustment
//
// At low cognitive load, show full dashboards. At high load, simplify to
// the minimum viable surface so the trader can focus.
// ═══════════════════════════════════════════════════════════════════════════

import { z } from "zod/v4";

export const UIDensitySchema = z.object({
  density: z.enum(["FULL", "STANDARD", "REDUCED", "MINIMAL", "FOCUS_ONLY"]),
  hideAdvancedPanels: z.boolean(),
  hideHistoricalCharts: z.boolean(),
  reasons: z.array(z.string()),
});
export type UIDensity = z.infer<typeof UIDensitySchema>;

export function recommendUIDensity(input: {
  cognitiveLoad01: number;
  fatigueScore01:  number;
}): UIDensity {
  const reasons: string[] = [];
  const severity = Math.max(input.cognitiveLoad01, input.fatigueScore01);
  let density: UIDensity["density"];
  let hideAdvancedPanels = false, hideHistoricalCharts = false;

  if      (severity >= 0.85) { density = "FOCUS_ONLY"; hideAdvancedPanels = true;  hideHistoricalCharts = true;  reasons.push("severity ≥0.85 → focus-only UI"); }
  else if (severity >= 0.65) { density = "MINIMAL";    hideAdvancedPanels = true;  hideHistoricalCharts = true;  reasons.push("severity ≥0.65 → minimal"); }
  else if (severity >= 0.50) { density = "REDUCED";    hideAdvancedPanels = true;                                reasons.push("severity ≥0.50 → reduced"); }
  else if (severity >= 0.25) { density = "STANDARD";                                                             reasons.push("severity ≥0.25 → standard"); }
  else                       { density = "FULL";                                                                 reasons.push("severity <0.25 → full UI"); }

  return { density, hideAdvancedPanels, hideHistoricalCharts, reasons };
}
