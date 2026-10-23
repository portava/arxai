import type { AgentName } from "./agents.types";
import { AGENT_LABELS } from "./agentDisplay";
import {
  CONSENSUS_THRESHOLDS,
  type ConsensusResult, type ConsensusVerdict, type PerAgentBreakdown,
} from "./consensusVerdict.types";

// DecisionNarrative — five answers, one per spec question
//
//   whyApproved          — null unless verdict is EXECUTE / REDUCE_SIZE
//   whyBlocked           — null unless verdict is BLOCK
//   strongestEvidence    — agent that contributed the most weight to the
//                          dominant action (BUY/SELL when there's a
//                          direction, WAIT when WAIT-leaning, BLOCK when
//                          blocked); null only when there were no fresh
//                          non-blocking votes
//   ignoredAgents        — every agent whose vote did not contribute,
//                          with the structural reason (expired)
//   whatWouldChange      — the nearest 1-3 threshold deltas that would
//                          flip the verdict (e.g. "+8 confidence → EXECUTE",
//                          "if [risk] cleared its blocker, would proceed")
export interface DecisionNarrative {
  verdict: ConsensusVerdict;
  whyApproved: string | null;
  whyBlocked: string | null;
  strongestEvidence: {
    agent: AgentName;
    label: string;
    contribution: number;
    direction: "BUY" | "SELL" | "WAIT" | "BLOCK";
    evidence: string[];
  } | null;
  ignoredAgents: Array<{ agent: AgentName; label: string; reason: string }>;
  whatWouldChange: string[];
}

// explainConsensus
//
// Pure: takes the result of `runConsensus(...)` and produces a structured
// narrative. No IO, no mutation, no new evaluation — only re-reads what the
// engine already decided. Intended for the (still-deferred) UI panel and
// for the journal layer to attach to every trade record.
export function explainConsensus(result: ConsensusResult): DecisionNarrative {
  return {
    verdict: result.verdict,
    whyApproved: buildWhyApproved(result),
    whyBlocked: buildWhyBlocked(result),
    strongestEvidence: pickStrongestEvidence(result),
    ignoredAgents: pickIgnoredAgents(result),
    whatWouldChange: buildWhatWouldChange(result),
  };
}

// ── Why approved ──────────────────────────────────────────────────────────
function buildWhyApproved(r: ConsensusResult): string | null {
  if (r.verdict !== "EXECUTE" && r.verdict !== "REDUCE_SIZE") return null;

  const topAgents = topContributors(r, r.direction, 3)
    .map((p) => `${AGENT_LABELS[p.agent]} (${describeContribution(p)})`)
    .join(", ");

  const conf = r.executionConfidence;
  const agree = (r.directionAgreement * 100).toFixed(0);

  if (r.verdict === "EXECUTE") {
    return (
      `Approved at full size: ${r.direction} with confidence ${conf}/100 ` +
      `(≥ ${CONSENSUS_THRESHOLDS.executeConfidence}) and agreement ${agree}% ` +
      `(≥ ${(CONSENSUS_THRESHOLDS.executeAgreement * 100).toFixed(0)}%). ` +
      `Top contributors: ${topAgents}.`
    );
  }
  // REDUCE_SIZE
  const sizePct = Math.round(r.recommendedSizeMultiplier * 100);
  return (
    `Approved at reduced size (${sizePct}%): ${r.direction} with confidence ${conf}/100 ` +
    `and agreement ${agree}%. Below the EXECUTE bar ` +
    `(needs confidence ≥ ${CONSENSUS_THRESHOLDS.executeConfidence} AND agreement ` +
    `≥ ${(CONSENSUS_THRESHOLDS.executeAgreement * 100).toFixed(0)}%) ` +
    `but above the REDUCE_SIZE floor. Top contributors: ${topAgents}.`
  );
}

// ── Why blocked ───────────────────────────────────────────────────────────
function buildWhyBlocked(r: ConsensusResult): string | null {
  if (r.verdict !== "BLOCK") return null;
  const blockingAgents = r.perAgent
    .filter((p) => p.fresh && p.blocking)
    .map((p) => AGENT_LABELS[p.agent]);
  if (blockingAgents.length === 0) {
    return "Blocked but no agent emitted a structured blocker — investigate engine output.";
  }
  const blockerLines = r.blockers.length > 0 ? r.blockers : ["(no blocker text supplied)"];
  return (
    `Blocked by ${blockingAgents.length} agent(s): ${blockingAgents.join(", ")}. ` +
    `Reason${blockerLines.length === 1 ? "" : "s"}: ${blockerLines.join(" | ")}. ` +
    `Any single fresh BLOCK vote is treated as a hard veto — every v2 agent's ` +
    `BLOCK reflects a real don't-trade condition (broker / risk / liquidity / regime / behavior).`
  );
}

// ── Strongest evidence ────────────────────────────────────────────────────
function pickStrongestEvidence(r: ConsensusResult): DecisionNarrative["strongestEvidence"] {
  const fresh = r.perAgent.filter((p) => p.fresh);
  if (fresh.length === 0) return null;

  // BLOCK: the heaviest blocking agent (by weight) speaks loudest
  if (r.verdict === "BLOCK") {
    const blockers = fresh.filter((p) => p.blocking);
    if (blockers.length > 0) {
      const top = blockers.slice().sort((a, b) => b.weightApplied - a.weightApplied)[0];
      return {
        agent: top.agent, label: AGENT_LABELS[top.agent],
        contribution: top.weightApplied, direction: "BLOCK",
        evidence: top.vote.blockers,
      };
    }
  }

  // ACTED states: the agent contributing most weight to the dominant side
  if ((r.verdict === "EXECUTE" || r.verdict === "REDUCE_SIZE") && r.direction !== null) {
    const top = topContributors(r, r.direction, 1)[0];
    if (top) {
      return {
        agent: top.agent, label: AGENT_LABELS[top.agent],
        contribution: r.direction === "BUY" ? top.buyContribution : top.sellContribution,
        direction: r.direction,
        evidence: top.vote.evidence,
      };
    }
  }

  // WAIT / MONITOR_ONLY: agent with the largest single contribution on
  // any axis (gives the user a sense of "what's the biggest signal even
  // though we're not acting").
  const ranked = fresh.slice().sort((a, b) => {
    const aMax = Math.max(a.buyContribution, a.sellContribution, a.waitContribution);
    const bMax = Math.max(b.buyContribution, b.sellContribution, b.waitContribution);
    return bMax - aMax;
  });
  const top = ranked[0];
  const dir = top.buyContribution >= Math.max(top.sellContribution, top.waitContribution) ? "BUY"
            : top.sellContribution >= top.waitContribution ? "SELL" : "WAIT";
  return {
    agent: top.agent, label: AGENT_LABELS[top.agent],
    contribution: Math.max(top.buyContribution, top.sellContribution, top.waitContribution),
    direction: dir, evidence: top.vote.evidence,
  };
}

// ── Ignored agents ────────────────────────────────────────────────────────
// Conservative definition: only agents whose vote was structurally not
// counted. That means expired votes. Low-confidence votes that DID
// contribute are not "ignored" — they're weakly weighted but counted.
function pickIgnoredAgents(r: ConsensusResult): DecisionNarrative["ignoredAgents"] {
  return r.perAgent
    .filter((p) => !p.fresh)
    .map((p) => ({
      agent: p.agent,
      label: AGENT_LABELS[p.agent],
      reason: `vote expired (${p.vote.expirationSeconds}s freshness window) — not counted in tally`,
    }));
}

// ── What would change the decision ────────────────────────────────────────
function buildWhatWouldChange(r: ConsensusResult): string[] {
  const out: string[] = [];
  const T = CONSENSUS_THRESHOLDS;

  if (r.verdict === "BLOCK") {
    const blockers = r.perAgent.filter((p) => p.fresh && p.blocking);
    for (const p of blockers.slice(0, 3)) {
      out.push(`If ${AGENT_LABELS[p.agent]} cleared its blocker, the hard veto would lift.`);
    }
    return out;
  }

  if (r.verdict === "EXECUTE") {
    const confDrop = r.executionConfidence - T.executeConfidence;
    out.push(
      `Currently above EXECUTE bar; a confidence drop of ${confDrop.toFixed(0)} (to ` +
      `${T.executeConfidence}) or agreement falling below ` +
      `${(T.executeAgreement * 100).toFixed(0)}% would downgrade to REDUCE_SIZE.`,
    );
    out.push("Any fresh BLOCK vote from any of the 10 agents would override to BLOCK.");
    return out;
  }

  if (r.verdict === "REDUCE_SIZE") {
    const confGap = T.executeConfidence - r.executionConfidence;
    const agreeGap = T.executeAgreement - r.directionAgreement;
    if (confGap > 0) out.push(`+${confGap.toFixed(0)} confidence (to ${T.executeConfidence}) → EXECUTE.`);
    if (agreeGap > 0) out.push(
      `+${(agreeGap * 100).toFixed(0)}% directional agreement (to ` +
      `${(T.executeAgreement * 100).toFixed(0)}%) → EXECUTE.`,
    );
    return out;
  }

  if (r.verdict === "WAIT") {
    if (r.direction === null) {
      out.push(
        `No clear direction yet. A directional gap ≥ ${(T.splitGapMaxRatio * 100).toFixed(0)}% ` +
        `between BUY and SELL weighted scores would resolve direction.`,
      );
    } else {
      const confGap = T.reduceSizeConfFloor - r.executionConfidence;
      const agreeGap = T.reduceSizeAgreement - r.directionAgreement;
      if (confGap > 0) out.push(
        `+${confGap.toFixed(0)} confidence (to ${T.reduceSizeConfFloor}) → REDUCE_SIZE entry.`,
      );
      if (agreeGap > 0) out.push(
        `+${(agreeGap * 100).toFixed(0)}% directional agreement (to ` +
        `${(T.reduceSizeAgreement * 100).toFixed(0)}%) → REDUCE_SIZE entry.`,
      );
    }
    return out;
  }

  if (r.verdict === "MONITOR_ONLY") {
    out.push(
      `Direction-picking agents are split. Either side gaining a ` +
      `${(T.splitGapMaxRatio * 100).toFixed(0)}% lead in weighted score would resolve direction ` +
      `and lift MONITOR_ONLY.`,
    );
    out.push(
      `Alternatively, if one side fell below ${(T.splitMinSideShare * 100).toFixed(0)}% share ` +
      `of total active weight, the verdict would shift to WAIT (insufficient activity) instead.`,
    );
    return out;
  }

  return out;
}

// ── Helpers ───────────────────────────────────────────────────────────────
// Top-N contributors toward a given direction (BUY/SELL). If direction is
// null, falls back to whichever signed contribution is larger per agent.
function topContributors(
  r: ConsensusResult, direction: "BUY" | "SELL" | null, n: number,
): PerAgentBreakdown[] {
  const fresh = r.perAgent.filter((p) => p.fresh && !p.blocking);
  const scored = fresh.map((p) => {
    const c = direction === "BUY" ? p.buyContribution
            : direction === "SELL" ? p.sellContribution
            : Math.max(p.buyContribution, p.sellContribution);
    return { p, c };
  });
  return scored
    .filter((x) => x.c > 0)
    .sort((a, b) => b.c - a.c)
    .slice(0, n)
    .map((x) => x.p);
}

function describeContribution(p: PerAgentBreakdown): string {
  return `weight ${p.weightApplied.toFixed(1)} × confidence ${p.vote.confidence}`;
}
