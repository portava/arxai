// Chart Brain v2 — Task 4: chart agent-consensus summary (advisory/shadow only).
//
// Surfaces the Agent Ecosystem's read on the chart's OWN decision (advisory +
// Court governance) as a user-safe summary. This is READ-ONLY and
// ADVISORY/SHADOW ONLY:
//   - it never touches the live 16-gate dispatch path,
//   - it never gates, blocks, or modifies a trade,
//   - it never changes liveLocked / allowOrderExecution.
//
// It deliberately does NOT persist a governance trace: the chart-intelligence
// endpoint is polled, so durable DB writes belong on user-initiated reads
// (explain-signal / draft-read), not on the hot path. This call is in-memory and
// fail-open — any error yields an honest "no consensus" read.
//
// When the specialist agents are in shadow (no live authority weight), the
// advisory has zero influencing agents and we honestly report no consensus
// rather than fabricating one.

import {
  computeRubySignalAdvisory,
  toUserAdvisory,
} from "../../agentEcosystem/advisoryInfluence.js";
import {
  computeSurfaceGovernance,
  runTrafficSelection,
  toUserGovernance,
} from "../../agentEcosystem/governance.js";
import { clamp, round } from "./engines/chartMath.js";
import type { ChartDecisionState } from "./chartIntelligence.js";

export type ChartConsensusStance = "support" | "caution" | "mixed" | "neutral";
export type ChartConsensusAgentStance =
  | "SUPPORT"
  | "CAUTION"
  | "CHALLENGE"
  | "NEUTRAL";

export interface ChartConsensusAgent {
  name: string;
  stance: ChartConsensusAgentStance;
}

export interface ChartAgentConsensus {
  /** True only when specialist agents actually influenced the read. */
  populated: boolean;
  headline: string;
  detail: string;
  stance: ChartConsensusStance;
  /** True when agents both support and push back (genuine conflict). */
  conflict: boolean;
  /** True when Court governance lowered the read. */
  protective: boolean;
  influencingAgentCount: number;
  agents: ChartConsensusAgent[];
  cautions: string[];
  note: string;
}

function emptyConsensus(note: string): ChartAgentConsensus {
  return {
    populated: false,
    headline: "No agent consensus yet.",
    detail: "",
    stance: "neutral",
    conflict: false,
    protective: false,
    influencingAgentCount: 0,
    agents: [],
    cautions: [],
    note,
  };
}

export async function computeChartAgentConsensus(
  decision: ChartDecisionState,
  readinessScore: number | null,
): Promise<ChartAgentConsensus> {
  try {
    if (!decision.populated) {
      return emptyConsensus("No decision to review — agents stand by.");
    }

    const side: "BUY" | "SELL" | "NEUTRAL" =
      decision.bias === "bullish" ? "BUY" : decision.bias === "bearish" ? "SELL" : "NEUTRAL";
    const conf = round(clamp(readinessScore ?? 0));
    const riskScore = decision.vetoed
      ? Math.max(70, round(clamp(100 - conf)))
      : round(clamp(100 - conf));

    const advisory = await computeRubySignalAdvisory({
      baseScore: conf,
      direction: side,
      confidenceScore: conf,
      riskScore,
    });
    if (!advisory || advisory.influencingAgentCount === 0) {
      return emptyConsensus(
        "Specialist agents are in shadow (no live weight) — no consensus to surface yet.",
      );
    }

    const userAdv = toUserAdvisory(advisory);
    let headline = userAdv.summary;
    let detail = "";
    let protective = false;
    const cautions = [...userAdv.cautions];

    // Court governance review (advisory; never gates a trade).
    const traffic = await runTrafficSelection("RUBY", "LOW");
    const review = computeSurfaceGovernance({
      surface: "RUBY",
      direction: side,
      importance: "LOW",
      advisory,
      context: { riskScore },
      traffic: traffic.summary,
      allowedAgentKeys: traffic.participants.map((pp) => pp.agentKey),
    });
    if (review && review.governanceApplied) {
      const gov = toUserGovernance(review);
      headline = gov.headline;
      detail = gov.detail;
      protective = gov.protective;
      for (const c of gov.cautions) if (!cautions.includes(c)) cautions.push(c);
    }

    const challengeCount = userAdv.agents.filter(
      (a) => a.stance === "CHALLENGE" || a.stance === "CAUTION",
    ).length;
    const supportCount = userAdv.agents.filter((a) => a.stance === "SUPPORT").length;
    const conflict = challengeCount > 0 && supportCount > 0;
    const stance: ChartConsensusStance =
      conflict || protective
        ? "mixed"
        : challengeCount > 0
          ? "caution"
          : supportCount > 0
            ? "support"
            : "neutral";

    return {
      populated: true,
      headline,
      detail,
      stance,
      conflict,
      protective,
      influencingAgentCount: advisory.influencingAgentCount,
      agents: userAdv.agents,
      cautions,
      note: "Advisory/shadow consensus only — never gates a trade or the live path.",
    };
  } catch {
    return emptyConsensus("Agent consensus unavailable — failing open (advisory only).");
  }
}
