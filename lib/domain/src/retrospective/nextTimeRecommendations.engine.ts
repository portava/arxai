import type {
  AgentScorecard, BehaviorVerdict, ConfidenceVerdict, EntryVerdict,
  ExitVerdict, NextTimeRecommendation, NextTimeRecommendationsReport,
  RiskVerdict,
} from "./retrospective.types";

// generateNextTimeRecommendations
//
// Synthesis engine — Q8. Reads the prior 7 verdicts and produces concrete,
// process-focused recommendations. Each recommendation cites which verdict(s)
// drove it (basedOnVerdicts) so the reasoning chain is auditable.
//
// Important discipline: recommendations must be ABOUT THE PROCESS, never
// promise an outcome. "Require 5/7 agent agreement on this setup type next
// time" is allowed; "this would have made more money" is not.
export interface NextTimeInput {
  entry: EntryVerdict;
  exit: ExitVerdict;
  agents: AgentScorecard;
  confidence: ConfidenceVerdict;
  risk: RiskVerdict;
  behavior: BehaviorVerdict;
}

export function generateNextTimeRecommendations(input: NextTimeInput): NextTimeRecommendationsReport {
  const recs: NextTimeRecommendation[] = [];
  const reasons: string[] = [];

  // ── From entry verdict ─────────────────────────────────────────────────
  if (input.entry.rating === "POOR") {
    if (input.entry.factors.spreadAtEntryNormality >= 2.0) {
      recs.push({
        category: "ENTRY_FILTER",
        recommendation: "Add a spread-tax veto: skip entries when spread is ≥ 2× normal for the symbol",
        basedOnVerdicts: ["entry"],
        priority: "HIGH",
      });
    }
    if (input.entry.factors.biasAlignment === false) {
      recs.push({
        category: "ENTRY_FILTER",
        recommendation: "Require short-term bias alignment for this setup type before entry",
        basedOnVerdicts: ["entry"],
        priority: "MEDIUM",
      });
    }
    if (input.entry.factors.immediateMfeProgressR <= 0
        && Math.abs(input.entry.factors.mae) > 0.5) {
      recs.push({
        category: "ENTRY_FILTER",
        recommendation: "Tighten the entry trigger — current setup allowed entry before momentum confirmed",
        basedOnVerdicts: ["entry"],
        priority: "MEDIUM",
      });
    }
  }

  // ── From exit verdict ──────────────────────────────────────────────────
  if (input.exit.rating === "POOR" && input.exit.capturedPctOfMfe !== null
      && input.exit.capturedPctOfMfe < 30) {
    recs.push({
      category: "EXIT_RULE",
      recommendation: `Exit captured only ${input.exit.capturedPctOfMfe.toFixed(0)}% of MFE — review exit rules; consider trailing stop activation at lower R-multiple`,
      basedOnVerdicts: ["exit"],
      priority: "HIGH",
    });
  }
  if (input.exit.leftOnTableR >= 1.0 && input.exit.exitReason === "MANUAL_EXIT") {
    recs.push({
      category: "BEHAVIOR_DISCIPLINE",
      recommendation: `Manual exit left ${input.exit.leftOnTableR.toFixed(2)}R on table — reduce discretionary early closes`,
      basedOnVerdicts: ["exit", "behavior"],
      priority: "MEDIUM",
    });
  }

  // ── From agent scorecard ───────────────────────────────────────────────
  const topWrong = input.agents.wrongAgents[0];
  if (topWrong && topWrong.agentConfidence >= 70) {
    recs.push({
      category: "AGENT_WEIGHTING",
      recommendation: `Down-weight agent "${topWrong.agentName}" for this setup type — it argued ${topWrong.agentDirection} at ${topWrong.agentConfidence}% but outcome went ${input.agents.winningDirection}`,
      basedOnVerdicts: ["agents"],
      priority: "MEDIUM",
    });
  }
  if (input.agents.consensusWasCorrect === false && input.agents.rightAgents.length > 0) {
    const dissenter = input.agents.rightAgents[0];
    recs.push({
      category: "AGENT_WEIGHTING",
      recommendation: `Consensus was wrong but agent "${dissenter.agentName}" was right (${dissenter.agentDirection} @ ${dissenter.agentConfidence}%) — investigate up-weighting on this setup type`,
      basedOnVerdicts: ["agents"],
      priority: "LOW",
    });
  }

  // ── From confidence verdict ────────────────────────────────────────────
  if (input.confidence.rating === "TOO_HIGH") {
    recs.push({
      category: "CONFIDENCE_POLICY",
      recommendation: "High-confidence loss recorded — flag this setup pattern for confidence-cap review (single-trade evidence; aggregate before policy change)",
      basedOnVerdicts: ["confidence"],
      priority: "LOW",
    });
  }
  if (input.confidence.rating === "TOO_LOW") {
    recs.push({
      category: "CONFIDENCE_POLICY",
      recommendation: "Low-confidence clean win recorded — flag this setup pattern for confidence-floor review (single-trade evidence; aggregate before policy change)",
      basedOnVerdicts: ["confidence"],
      priority: "LOW",
    });
  }

  // ── From risk verdict ──────────────────────────────────────────────────
  if (input.risk.rating === "TOO_LARGE") {
    recs.push({
      category: "RISK_SIZING",
      recommendation: `Risk multiplier ${input.risk.riskMultiplierUsed.toFixed(2)}× too aggressive for the conviction profile — cap multiplier on this setup type`,
      basedOnVerdicts: ["risk"],
      priority: "HIGH",
    });
  }
  if (input.risk.rating === "TOO_SMALL") {
    recs.push({
      category: "RISK_SIZING",
      recommendation: `Sizing was conservative (${input.risk.riskMultiplierUsed.toFixed(2)}×) on a high-conviction setup — review sizing curve`,
      basedOnVerdicts: ["risk"],
      priority: "LOW",
    });
  }

  // ── From behavior verdict ──────────────────────────────────────────────
  if (input.behavior.netImpact === "HARMFUL") {
    const harmful = input.behavior.events.filter((e) => e.impact === "HARMFUL");
    for (const h of harmful) {
      recs.push({
        category: "BEHAVIOR_DISCIPLINE",
        recommendation: `Avoid "${h.kind}" pattern: ${h.reason}`,
        basedOnVerdicts: ["behavior"],
        priority: "HIGH",
      });
    }
  }

  // ── No-change fallthrough ──────────────────────────────────────────────
  if (recs.length === 0) {
    recs.push({
      category: "NO_CHANGE",
      recommendation: "No process changes recommended — trade played out within expectations",
      basedOnVerdicts: ["entry", "exit", "agents", "confidence", "risk", "behavior"],
      priority: "LOW",
    });
    reasons.push("all verdicts within tolerance — process worked as intended");
  } else {
    reasons.push(`${recs.length} recommendation(s) generated from prior verdicts`);
  }

  // Sort by priority: HIGH > MEDIUM > LOW (stable within band)
  const order: Record<NextTimeRecommendation["priority"], number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  recs.sort((a, b) => order[a.priority] - order[b.priority]);

  return { recommendations: recs, reasons };
}
