import { rubyAssessmentEvidenceKey, matchesRubyAssessmentEvidence } from "./rubyAssessmentEvidence";
import type { ChartRead } from "./rubyReadPanelState";
import { matchesRubyChartReadContext, type RubyChartReadContext } from "./rubyChartReadContext";

/** Validate the existing read endpoint's display contract before publishing it.
 * Positive responses must identify captured inputs; current-chart matching is
 * required when an observing consumer supplies its evidence. */
export function validateRubyChartRead(value: unknown, expected: RubyChartReadContext, expectedEvidence?: unknown): ChartRead {
  const invalid = () => { throw new Error("Invalid chart read response"); };
  if (!value || typeof value !== "object" || Array.isArray(value)) return invalid();
  const r = value as Record<string, unknown>;
  if (!matchesRubyChartReadContext(r, expected)) throw new Error("Chart read does not match the requested market and interval");
  if (typeof r.gated !== "boolean") return invalid();
  for (const key of ["liveSetupWithheld", "canShowLiveTradeSetup"] as const) {
    if (r[key] !== undefined && typeof r[key] !== "boolean") return invalid();
  }
  if (r.dataQuality !== undefined && r.dataQuality !== "ok" && r.dataQuality !== "insufficient") return invalid();
  if (r.readLayer !== undefined && !["FULL", "STRUCTURAL_ONLY", "INSUFFICIENT"].includes(r.readLayer as string)) return invalid();
  for (const key of ["basis", "headline", "blockedReason", "bias", "confidence", "why", "supportZone", "resistanceZone", "buyCondition", "sellCondition", "invalidation", "riskNote", "htfBias", "disclaimer"]) {
    if (r[key] !== undefined && typeof r[key] !== "string") return invalid();
  }
  if (r.cautions !== undefined && (!Array.isArray(r.cautions) || !r.cautions.every(v => typeof v === "string"))) return invalid();
  for (const kind of ["pattern", "trendline"] as const) {
    const note = r[`${kind}Read`];
    if (note === undefined) continue;
    if (!note || typeof note !== "object" || Array.isArray(note)) return invalid();
    const n = note as Record<string, unknown>;
    for (const suffix of ["Note", "Status"]) if (n[`${kind}${suffix}`] !== undefined && typeof n[`${kind}${suffix}`] !== "string") return invalid();
    for (const suffix of ["Conditional", "ContextOnly"]) if (n[`${kind}${suffix}`] !== undefined && typeof n[`${kind}${suffix}`] !== "boolean") return invalid();
  }
  if (r.gated) {
    // The existing market-resolution refusal predates readLayer; retain it.
    if ((r.readLayer !== undefined && r.readLayer !== "INSUFFICIENT") || r.canShowLiveTradeSetup === true || r.liveSetupWithheld === false
      || ![r.blockedReason, r.headline].some(v => typeof v === "string" && v.trim())) return invalid();
  } else {
    const evidence = r.assessmentEvidence;
    if (!rubyAssessmentEvidenceKey(evidence)
      || !matchesRubyChartReadContext(evidence as Record<string, unknown>, expected)
      || (expectedEvidence !== undefined && !matchesRubyAssessmentEvidence(evidence, expectedEvidence))) {
      throw new Error("The assessment does not match the chart's current source, account and closed candle. Read this chart again.");
    }
    if (typeof r.bias !== "string" || !r.bias.trim() || r.dataQuality === "insufficient") return invalid();
    if (r.readLayer === "FULL") {
      if (r.liveSetupWithheld !== false || r.canShowLiveTradeSetup !== true) return invalid();
    } else if (r.readLayer === "STRUCTURAL_ONLY") {
      if (r.liveSetupWithheld !== true || r.canShowLiveTradeSetup !== false) return invalid();
    } else return invalid();
  }
  return value as ChartRead;
}
