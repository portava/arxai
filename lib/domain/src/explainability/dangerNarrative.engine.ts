import {
  type DangerNarrative, type NarrativeStyle, type Fact, toFactLine,
} from "./explainability.types";

// ═══════════════════════════════════════════════════════════════════════════
// Danger Narrative — explains the most pressing risks in plain English.
// Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface DangerInput {
  severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  threats: ReadonlyArray<string>;
  facts?: ReadonlyArray<Fact>;
  style?: NarrativeStyle;
}

export function buildDangerNarrative(input: DangerInput): DangerNarrative {
  const style = input.style ?? "STANDARD";
  const headline =
      input.severity === "CRITICAL" ? "Critical risk — immediate attention required."
    : input.severity === "HIGH"     ? "High risk — actively managing exposure."
    : input.severity === "MEDIUM"   ? "Elevated risk — staying cautious."
    : "Low risk — routine conditions.";

  const paragraphs: string[] = [];
  if (input.threats.length === 0) {
    paragraphs.push(`No active threats detected.`);
  } else if (style === "TERSE") {
    paragraphs.push(`Top threats: ${input.threats.slice(0, 3).join("; ")}.`);
  } else {
    paragraphs.push(`Detected ${input.threats.length} threat(s):`);
  }

  const bullets = input.threats.slice(0, style === "DETAILED" ? 10 : 5).map((t) => `• ${t}`);
  if (input.facts && style !== "TERSE") {
    bullets.push(...input.facts.slice(0, 5).map((f) => `· ${toFactLine(f)}`));
  }

  return { severity: input.severity, threats: [...input.threats], narrative: { headline, paragraphs, bullets, style } };
}
