import {
  type ConfidenceNarrative, type NarrativeStyle, type Narrative,
} from "./explainability.types";

// ═══════════════════════════════════════════════════════════════════════════
// Confidence Narrative — turns a confidence level (and optional observed
// hit rate) into plain-English. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ConfidenceInput {
  expressedConfidence01: number;
  observedHitRate01?: number;
  style?: NarrativeStyle;
}

export function buildConfidenceNarrative(input: ConfidenceInput): ConfidenceNarrative {
  const c = clamp01(input.expressedConfidence01);
  const obs = input.observedHitRate01 != null ? clamp01(input.observedHitRate01) : undefined;
  const style = input.style ?? "STANDARD";

  const band =
      c >= 0.85 ? "very high"
    : c >= 0.70 ? "high"
    : c >= 0.50 ? "moderate"
    : c >= 0.30 ? "low"
    : "very low";
  const headline = `Confidence is ${band} (${(c * 100).toFixed(0)}%).`;

  const paragraphs: string[] = [];
  const bullets: string[] = [];

  if (obs != null) {
    const gap = c - obs;
    if (gap > 0.10) {
      paragraphs.push(`We are likely overconfident. Expressed ${(c*100).toFixed(0)}% but recent hit rate is only ${(obs*100).toFixed(0)}%.`);
      bullets.push(`Adjust position sizing downward.`);
    } else if (gap < -0.10) {
      paragraphs.push(`We may be underconfident. Recent hit rate of ${(obs*100).toFixed(0)}% exceeds expressed confidence.`);
      bullets.push(`Conviction supports normal sizing.`);
    } else {
      paragraphs.push(`Calibration looks healthy: expressed ${(c*100).toFixed(0)}% vs observed ${(obs*100).toFixed(0)}%.`);
    }
  } else if (style !== "TERSE") {
    paragraphs.push(`No calibration sample available — treat this confidence with caution.`);
  }

  if (style === "DETAILED") {
    bullets.push(`Confidence band: ${band}`);
    if (obs != null) bullets.push(`Observed hit rate: ${(obs*100).toFixed(0)}%`);
  }

  return {
    expressedConfidence01: c,
    observedHitRate01: obs,
    narrative: { headline, paragraphs, bullets, style },
  };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}
