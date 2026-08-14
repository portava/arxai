// Agent Ecosystem — Advisory influence engine (PURE).
//
// PURPOSE
//   Turn the Agent Ecosystem's earned trust + lifecycle health into a BOUNDED,
//   advisory-only adjustment to a score that an existing engine already computed
//   (a scanner opportunity score, a risk score, a scalp score, …). It NEVER
//   fabricates a signal — it re-weights real, already-computed numbers by how
//   trustworthy the responsible agents currently are.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / SHADOW ONLY. The output adjusts ranking / wording / caution
//     surfaces. It is NEVER an execution input: nothing here can place, modify,
//     or block a trade, and no caller may route this through the 16-gate live
//     pipeline, the kill switch, allocation, or dispatch.
//   - A pure-shadow agent (authorityWeight 0) contributes EXACTLY zero. New /
//     created agents start at 0 authority, so a brand-new agent cannot move any
//     ranking until it has earned authority through the Promotion Board.
//   - Influence is BOUNDED per-agent and in total, so a single weak agent can
//     never dominate and no agent can swing a score arbitrarily.
//   - This module is PURE: deterministic, no I/O, no clock, no DB. All inputs
//     are passed in; all per-user isolation is the caller's responsibility.
//   - Agent statuses that mean "not trusted right now" (LEARNING_CAMP, RESTRICTED,
//     PROBATION, WARNING, SHUTDOWN_RECOMMENDED, ARCHIVED, SHADOW) reduce or
//     remove that agent's positive influence — a demoted / muted agent cannot
//     keep boosting recommendations as if it were healthy.

export type AdvisoryDirection = "BUY" | "SELL" | "NEUTRAL";

/** Where an agent's domain currently stands relative to a candidate signal. */
export type AgentAlignment = "SUPPORT" | "OPPOSE" | "NEUTRAL";

/** The visible stance attributed to an agent after weighting. */
export type AgentStance = "SUPPORT" | "CAUTION" | "CHALLENGE" | "NEUTRAL";

/**
 * A minimal, non-sensitive snapshot of an agent's current standing. This is
 * GLOBAL system/governance state (the shared agent registry), never per-user
 * trading data — so applying it to any user's ranking leaks nothing.
 */
export interface AdvisoryAgentSnapshot {
  agentKey: string;
  name: string;
  department: string; // maps to the engine factor / domain this agent owns
  trustScore: number; // 0-100 rolling aggregate
  authorityWeight: number; // 0-1, 0 = pure shadow (no influence)
  currentStatus: string; // ACTIVE | SHADOW | WARNING | PROBATION | RESTRICTED | LEARNING_CAMP | SHUTDOWN_RECOMMENDED | ARCHIVED
  /**
   * Optional: how this agent's domain reads the candidate signal right now. If
   * omitted the agent acts on trust alone (high trust gently reinforces, low
   * trust gently cautions) — never fabricated as a strong directional vote.
   */
  alignment?: AgentAlignment;
}

export interface AgentContribution {
  agentKey: string;
  name: string;
  department: string;
  stance: AgentStance;
  /** Signed, bounded points this agent applied to the base score. */
  delta: number;
  trustScore: number;
  authorityWeight: number;
  /** Effective influence after status gating (0-1). */
  effectiveInfluence: number;
  /** Neutral machine reason; UI / Ruby humanize it for end users. */
  reason: string;
}

export interface AdvisoryInput {
  /** The score an existing engine already produced (0-100). */
  baseScore: number;
  /** The candidate direction the base signal is proposing. */
  direction: AdvisoryDirection;
  /** Snapshot of the agents responsible for / relevant to this signal. */
  agents: AdvisoryAgentSnapshot[];
  /** Hard cap on the net adjustment magnitude (points). Default 15. */
  maxTotalAdjustment?: number;
  /** Hard cap on any single agent's contribution (points). Default 8. */
  maxPerAgentAdjustment?: number;
}

export interface AdvisoryResult {
  baseScore: number;
  /** baseScore + netDelta, clamped to 0-100. */
  adjustedScore: number;
  netDelta: number;
  contributions: AgentContribution[];
  /** Plain, surfaced cautions from muted / demoted / opposing agents. */
  cautions: string[];
  /** One-line neutral summary; UI / Ruby humanize for end users. */
  summary: string;
  /** How many agents actually moved the score (effectiveInfluence > 0). */
  influencingAgentCount: number;
  /** True when at least one responsible agent is currently untrusted. */
  hasUntrustedResponsibleAgent: boolean;
}

const DEFAULT_MAX_TOTAL = 15;
const DEFAULT_MAX_PER_AGENT = 8;

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Statuses that mean "do not let this agent positively boost anything". */
const UNTRUSTED_STATUSES = new Set([
  "WARNING",
  "PROBATION",
  "RESTRICTED",
  "LEARNING_CAMP",
  "SHUTDOWN_RECOMMENDED",
  "ARCHIVED",
]);

/**
 * How much of an agent's authority is allowed to act, given its lifecycle
 * status. Pure-shadow / archived agents are fully muted (0). Distressed agents
 * are damped. Healthy agents act at full authority.
 */
export function statusInfluenceMultiplier(status: string): number {
  switch (status) {
    case "ACTIVE":
      return 1;
    case "ON_DEMAND":
    case "SUPERVISED":
    case "FULL":
      return 1;
    case "WARNING":
      return 0.5;
    case "PROBATION":
      return 0.3;
    case "RESTRICTED":
      return 0.15;
    case "SHADOW":
    case "SILENT_SUPPORT":
    case "SLEEPING":
    case "LEARNING_CAMP":
    case "SHUTDOWN_RECOMMENDED":
    case "ARCHIVED":
      return 0;
    default:
      return 0;
  }
}

/**
 * Compute the bounded advisory adjustment for one candidate signal. Pure and
 * deterministic. Returns the adjusted score plus a per-agent contribution
 * breakdown for admin traces and plain-English Ruby summaries.
 */
export function computeAgentAdvisory(input: AdvisoryInput): AdvisoryResult {
  const maxTotal = input.maxTotalAdjustment ?? DEFAULT_MAX_TOTAL;
  const maxPerAgent = input.maxPerAgentAdjustment ?? DEFAULT_MAX_PER_AGENT;
  const base = clamp(input.baseScore, 0, 100);

  const contributions: AgentContribution[] = [];
  const cautions: string[] = [];
  let hasUntrustedResponsibleAgent = false;

  for (const a of input.agents) {
    const statusMult = statusInfluenceMultiplier(a.currentStatus);
    const authority = clamp(a.authorityWeight, 0, 1);
    const effectiveInfluence = clamp(authority * statusMult, 0, 1);

    const untrusted = UNTRUSTED_STATUSES.has(a.currentStatus);
    if (untrusted) hasUntrustedResponsibleAgent = true;

    // trustCentered: -1 (no trust) .. +1 (full trust)
    const trustCentered = clamp((a.trustScore - 50) / 50, -1, 1);

    // Directional sign from the agent's domain read of this signal.
    // SUPPORT = reinforce, OPPOSE = push back, NEUTRAL = trust-only nudge.
    let alignSign = 0;
    switch (a.alignment) {
      case "SUPPORT":
        alignSign = 1;
        break;
      case "OPPOSE":
        alignSign = -1;
        break;
      default:
        alignSign = 0;
    }

    // Raw signed magnitude before bounding.
    //  - With an explicit alignment: agent pushes in that direction scaled by
    //    its trust and effective influence.
    //  - Without alignment: trust alone gently nudges (high trust reinforces a
    //    fraction; low trust gently cautions). Never a fabricated strong vote.
    let raw: number;
    if (alignSign !== 0) {
      // A supporting agent only adds weight if it is actually trusted; a low
      // trust supporter contributes little. An opposing agent's weight scales
      // with how trusted it is (a trusted agent's objection matters more).
      const trustFactor =
        alignSign > 0 ? clamp(trustCentered, 0, 1) : clamp(Math.abs(trustCentered) * 0.5 + 0.5, 0, 1);
      raw = alignSign * trustFactor * effectiveInfluence * maxPerAgent;
    } else {
      raw = trustCentered * 0.4 * effectiveInfluence * maxPerAgent;
    }

    const delta = clamp(raw, -maxPerAgent, maxPerAgent);

    // Derive a visible stance for the breakdown / Ruby copy.
    let stance: AgentStance = "NEUTRAL";
    let reason: string;
    if (effectiveInfluence === 0) {
      stance = "NEUTRAL";
      reason =
        authority === 0
          ? "shadow_agent_no_authority"
          : `muted_by_status:${a.currentStatus}`;
      // A responsible-but-muted agent is worth surfacing as a caution only when
      // it is in an explicitly distressed state (not merely a new shadow agent).
      if (untrusted) {
        cautions.push(
          `${a.name} is under review (${a.currentStatus.toLowerCase().replace(/_/g, " ")}) and is not influencing this read.`,
        );
      }
    } else if (alignSign < 0 && delta < -0.5) {
      stance = "CHALLENGE";
      reason = "trusted_agent_opposes_direction";
      cautions.push(`${a.name} is pushing back on this ${input.direction.toLowerCase()} setup.`);
    } else if (delta > 0.5) {
      stance = "SUPPORT";
      reason = "trusted_agent_supports";
    } else if (delta < -0.5) {
      stance = "CAUTION";
      reason = "low_trust_agent_dampens";
      cautions.push(`${a.name} has a weak recent track record here, so its input is discounted.`);
    } else {
      stance = "NEUTRAL";
      reason = "marginal_influence";
    }

    contributions.push({
      agentKey: a.agentKey,
      name: a.name,
      department: a.department,
      stance,
      delta: +delta.toFixed(3),
      trustScore: a.trustScore,
      authorityWeight: authority,
      effectiveInfluence: +effectiveInfluence.toFixed(3),
      reason,
    });
  }

  const rawNet = contributions.reduce((s, c) => s + c.delta, 0);
  const netDelta = +clamp(rawNet, -maxTotal, maxTotal).toFixed(3);
  const adjustedScore = +clamp(base + netDelta, 0, 100).toFixed(2);

  const influencingAgentCount = contributions.filter((c) => Math.abs(c.delta) > 0.5).length;

  const summary = buildSummary({
    netDelta,
    influencingAgentCount,
    contributions,
    direction: input.direction,
  });

  return {
    baseScore: base,
    adjustedScore,
    netDelta,
    contributions,
    cautions,
    summary,
    influencingAgentCount,
    hasUntrustedResponsibleAgent,
  };
}

function buildSummary(args: {
  netDelta: number;
  influencingAgentCount: number;
  contributions: AgentContribution[];
  direction: AdvisoryDirection;
}): string {
  const { netDelta, influencingAgentCount, contributions } = args;
  if (influencingAgentCount === 0) {
    return "No experienced agent has earned the standing to weigh in yet, so this read is unchanged.";
  }
  const supporters = contributions.filter((c) => c.stance === "SUPPORT").length;
  const challengers = contributions.filter((c) => c.stance === "CHALLENGE").length;
  const cautioners = contributions.filter((c) => c.stance === "CAUTION").length;

  if (netDelta > 1) {
    return `${supporters} trusted agent${supporters === 1 ? "" : "s"} added confidence to this read.`;
  }
  if (netDelta < -1) {
    const n = challengers + cautioners;
    return `${n} agent${n === 1 ? "" : "s"} pulled confidence down on this read.`;
  }
  return "Agent input roughly balanced out; this read is broadly unchanged.";
}
