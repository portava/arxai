import {
  type ExplanationBundle, type DecisionVerdict, type Fact, type NarrativeStyle,
} from "./explainability.types";
import { buildDecisionNarrative } from "./decisionNarrative.engine";
import { buildConfidenceNarrative } from "./confidenceNarrative.engine";
import { buildDangerNarrative } from "./dangerNarrative.engine";
import { buildTradeReasoning } from "./tradeReasoning.engine";

// ═══════════════════════════════════════════════════════════════════════════
// Explanation Engine — top-level orchestrator. Builds a single bundle
// containing decision narrative + optional confidence/danger/trade
// narratives, all in the chosen style. Pure.
// ═══════════════════════════════════════════════════════════════════════════

export interface ExplanationInput {
  generatedAtIso: string;
  decision: {
    verdict: DecisionVerdict;
    primaryReason: string;
    supportingReasons?: ReadonlyArray<string>;
    blockers?: ReadonlyArray<string>;
    facts?: ReadonlyArray<Fact>;
  };
  confidence?: { expressedConfidence01: number; observedHitRate01?: number };
  danger?: { severity: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"; threats: ReadonlyArray<string>; facts?: ReadonlyArray<Fact> };
  trade?: {
    symbolId: string; side: "BUY" | "SELL";
    why: ReadonlyArray<string>; whyNotYet?: ReadonlyArray<string>;
    blockers?: ReadonlyArray<string>; facts?: ReadonlyArray<Fact>;
  };
  style?: NarrativeStyle;
}

export function buildExplanation(input: ExplanationInput): ExplanationBundle {
  const style = input.style ?? "STANDARD";
  const reasons: string[] = [];
  const decision = buildDecisionNarrative({ ...input.decision, style });
  const confidence = input.confidence ? buildConfidenceNarrative({ ...input.confidence, style }) : undefined;
  const danger = input.danger ? buildDangerNarrative({ ...input.danger, style }) : undefined;
  const trade = input.trade ? buildTradeReasoning({ ...input.trade, style }) : undefined;
  reasons.push(`bundled decision/${input.confidence ? "confidence/" : ""}${input.danger ? "danger/" : ""}${input.trade ? "trade" : ""}`.replace(/\/$/, ""));
  return { generatedAtIso: input.generatedAtIso, decision, confidence, danger, trade, reasons };
}
