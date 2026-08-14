// Agent Ecosystem — Layer 3 Governance Court (PURE).
//
// PURPOSE
//   Turn the per-agent advisory contributions (already computed by the PURE
//   advisory engine from earned trust + lifecycle + authority) into a coordinated
//   governance decision: agents take governance POSITIONS, CHALLENGE each other,
//   and the Court resolves a single OUTCOME by AUTHORITY-WEIGHTING (never plain
//   averaging). The outcome is bounded and PROTECTIVE — it can lower a ranking /
//   add a caution / ask for more data, but it can NEVER inflate a score and is
//   NEVER an execution input.
//
// SAFETY / SCOPE (inviolable):
//   - ADVISORY / SHADOW ONLY. Output adjusts ranking / wording / caution surfaces.
//     Nothing here can place, modify, or block a trade; no caller may route this
//     through the 16-gate live pipeline, the kill switch, allocation, or dispatch.
//   - A pure-shadow / muted agent (effectiveInfluence 0) contributes EXACTLY zero:
//     it cannot take a position, raise a challenge, or change an outcome.
//   - Governance can only LOWER the effective ranking score relative to the
//     advisory score (protective bias). It never raises it.
//   - PURE: deterministic, no I/O, no clock, no DB. All inputs are passed in; the
//     caller owns per-user isolation. Reuses the AdvisoryResult the caller already
//     computed (no second registry read, nothing added to the hot/DB path).

import type {
  AdvisoryDirection,
  AdvisoryResult,
  AgentContribution,
} from "../advisory/agentAdvisory.engine";

// ── Vocabulary ─────────────────────────────────────────────────────────────

/** How important the decision is — drives review depth (set by Traffic Controller). */
export type GovernanceImportance = "HIGH" | "MEDIUM" | "LOW";

/** A single agent's governance position on a decision. */
export type GovernancePosition =
  | "support"
  | "caution"
  | "challenge"
  | "downgrade"
  | "rejection"
  | "escalation"
  | "needs_more_data"
  | "performance_objection"
  | "abstain";

/** The Court's single final outcome for a decision. */
export type GovernanceOutcome =
  | "approved"
  | "approved_with_caution"
  | "downgraded"
  | "rejected"
  | "escalated"
  | "needs_more_data"
  | "muted_low_confidence"
  | "delayed_speed"
  | "learning_camp_review";

/** Household / lifecycle nudges the Court recommends (advisory; admin-audited to apply). */
export type GovernanceLifecycleAction =
  | "LEARNING_CAMP"
  | "REDUCE_INFLUENCE"
  | "MENTOR"
  | "STEP_BACK";

export interface GovernanceAgentPosition {
  agentKey: string;
  name: string;
  department: string;
  position: GovernancePosition;
  /** Effective influence after status gating (0-1); 0 = shadow/muted = no weight. */
  weight: number;
  /** Neutral machine reason; UI / Ruby humanize it. */
  reason: string;
}

export interface GovernanceChallenge {
  byAgentKey: string;
  byName: string;
  byDepartment: string;
  challengeType: Extract<
    GovernancePosition,
    "challenge" | "downgrade" | "rejection" | "escalation" | "performance_objection"
  >;
  /** What is being challenged, in neutral terms. */
  target: string;
  reason: string;
  weight: number;
}

export interface GovernanceLifecycleRecommendation {
  agentKey: string;
  name: string;
  action: GovernanceLifecycleAction;
  reason: string;
}

export interface TrafficSelectionSummary {
  limited: boolean;
  consideredCount: number;
  participatedCount: number;
  reason: string;
}

/**
 * Optional, honest contextual facts that let specific departments raise concrete
 * challenges. Every field is optional: a rule fires ONLY when the data it needs is
 * present — the Court never fabricates a challenge from absent data.
 */
export interface GovernanceContext {
  /** 0-100, higher = riskier. Lets RISK downgrade / reject reckless setups. */
  riskScore?: number;
  /** True when the flame/scalp read is weak / choppy / late / not a true flame. */
  weakFlame?: boolean;
  /** Elevated news / current-event risk against a technical-only setup. */
  highNewsRisk?: boolean;
  /** Entry runs against the larger market structure. */
  againstStructure?: boolean;
  /** Stop-loss / take-profit reasoning does not make sense. */
  slTpUnsound?: boolean;
  /** Not enough data to judge the signal — do not pretend it is strong. */
  insufficientData?: boolean;
  /** Agent keys flagged for poor recent performance (drives lifecycle nudges). */
  poorRecentAgentKeys?: readonly string[];
}

export interface GovernanceReviewInput {
  surface: string;
  direction: AdvisoryDirection;
  importance: GovernanceImportance;
  /** The advisory result the caller already computed for this exact decision. */
  advisory: AdvisoryResult;
  context?: GovernanceContext;
  /** Traffic Controller summary (participant selection). */
  traffic?: TrafficSelectionSummary;
  /**
   * Agent keys the Traffic Controller actually SELECTED for this review. When
   * provided, any contribution whose agent is not in this set steps back: it forms
   * no voting position and raises no challenge (it is recorded as abstaining so the
   * trace still shows it was considered). Fail-open: when omitted, every
   * contribution votes (legacy behaviour). Enforcement can only REMOVE influence,
   * never add it, so the governed ranking stays protective (<= advisory).
   */
  allowedAgentKeys?: readonly string[];
}

export interface GovernanceReview {
  surface: string;
  direction: AdvisoryDirection;
  importance: GovernanceImportance;
  outcome: GovernanceOutcome;
  /** Short neutral label, e.g. "Downgraded", "Rejected (ranking only)". */
  finalDecision: string;
  baseScore: number;
  advisoryScore: number;
  /** Protective: always <= advisoryScore. Ranking / visibility only. */
  governanceScore: number;
  /** governanceScore - baseScore (signed). */
  scoreImpact: number;
  confidenceScore: number;
  positions: GovernanceAgentPosition[];
  challenges: GovernanceChallenge[];
  participatingAgentCount: number;
  /** Which camp prevailed and why (neutral, humanized by the UI/Ruby). */
  winningReasoning: string;
  lifecycleRecommendations: GovernanceLifecycleRecommendation[];
  traffic: TrafficSelectionSummary;
  hasUntrustedResponsibleAgent: boolean;
  /** False when no agent had standing to weigh in (pure pass-through). */
  governanceApplied: boolean;
}

// ── Tunables (named, documented; all bounded) ──────────────────────────────

const REJECT_RISK = 85; // riskScore at/above which RISK requests rejection
const DOWNGRADE_RISK = 70; // riskScore at/above which RISK requests downgrade

// Authority-weighted thresholds (sums of effectiveInfluence). A single trusted,
// fully-authorized specialist (effectiveInfluence ~0.12-0.20) can trip these; a
// shadow agent (0) can trip nothing.
const REJECT_THRESHOLD = 0.15;
const DOWNGRADE_THRESHOLD = 0.15;
const NEEDS_THRESHOLD = 0.12;
const PERF_THRESHOLD = 0.2;
const ESCALATE_CONFLICT = 0.15; // both support and reject camps this strong → escalate
const MUTE_FLOOR = 25; // advisoryScore below this with influence present → muted

// Bounded, protective score haircuts (points OR fraction of advisoryScore).
const HAIRCUT: Record<GovernanceOutcome, { frac: number; cap: number }> = {
  approved: { frac: 0, cap: 0 },
  approved_with_caution: { frac: 0.05, cap: 3 },
  needs_more_data: { frac: 0.1, cap: 5 },
  learning_camp_review: { frac: 0.05, cap: 3 },
  delayed_speed: { frac: 0.1, cap: 6 },
  downgraded: { frac: 0.15, cap: 10 },
  escalated: { frac: 0.15, cap: 10 },
  muted_low_confidence: { frac: 0.3, cap: 20 },
  rejected: { frac: 0.4, cap: 30 },
};

const POSITION_RANK: Record<GovernancePosition, number> = {
  abstain: 0,
  support: 1,
  caution: 2,
  needs_more_data: 3,
  performance_objection: 4,
  challenge: 4,
  downgrade: 5,
  rejection: 6,
  escalation: 7,
};

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

function strongerPosition(a: GovernancePosition, b: GovernancePosition): GovernancePosition {
  return POSITION_RANK[b] > POSITION_RANK[a] ? b : a;
}

// ── Per-agent position derivation ──────────────────────────────────────────

function basePositionFromStance(c: AgentContribution): GovernancePosition {
  switch (c.stance) {
    case "SUPPORT":
      return "support";
    case "CAUTION":
      return "caution";
    case "CHALLENGE":
      return "challenge";
    default:
      return "abstain";
  }
}

/**
 * Escalate a base position using honest contextual facts. A rule only fires when
 * the agent has real influence (weight > 0) AND the relevant data is present.
 * Escalation can only RAISE a position (more protective), never lower it.
 */
function contextPosition(
  c: AgentContribution,
  ctx: GovernanceContext | undefined,
  direction: AdvisoryDirection,
  traffic: TrafficSelectionSummary | undefined,
): GovernancePosition {
  let pos = basePositionFromStance(c);
  if (c.effectiveInfluence <= 0 || !ctx) return c.effectiveInfluence <= 0 ? "abstain" : pos;

  const isTrade = direction === "BUY" || direction === "SELL";

  if (ctx.insufficientData) pos = strongerPosition(pos, "needs_more_data");

  switch (c.department) {
    case "RISK":
      if (isTrade && ctx.riskScore != null) {
        if (ctx.riskScore >= REJECT_RISK) pos = strongerPosition(pos, "rejection");
        else if (ctx.riskScore >= DOWNGRADE_RISK) pos = strongerPosition(pos, "downgrade");
      }
      break;
    case "SCALP":
      if (ctx.weakFlame) pos = strongerPosition(pos, "challenge");
      break;
    case "NEWS":
      // Fires only once a NEWS agent actually exists in the registry with weight.
      if (ctx.highNewsRisk) pos = strongerPosition(pos, "challenge");
      break;
    case "MARKET_STRUCTURE":
      if (ctx.againstStructure) pos = strongerPosition(pos, "challenge");
      break;
    case "EXIT":
      // Reward-to-risk / SL-TP reasoning owner.
      if (ctx.slTpUnsound) pos = strongerPosition(pos, "downgrade");
      break;
    case "AGENT_OPERATIONS":
      if (c.agentKey === "TRAFFIC_CONTROLLER" && traffic?.limited) {
        pos = strongerPosition(pos, "performance_objection");
      }
      break;
    default:
      break;
  }
  return pos;
}

function positionReason(pos: GovernancePosition, c: AgentContribution): string {
  switch (pos) {
    case "rejection":
      return "risk_too_high_requests_rejection";
    case "downgrade":
      return "domain_concern_requests_downgrade";
    case "challenge":
      return "domain_challenges_setup";
    case "performance_objection":
      return "too_many_agents_speed_objection";
    case "needs_more_data":
      return "insufficient_data";
    case "support":
      return "domain_supports_setup";
    case "caution":
      return "weak_recent_record_dampens";
    case "abstain":
      return c.authorityWeight === 0 ? "shadow_no_authority" : "no_material_position";
    default:
      return c.reason;
  }
}

function challengeTarget(direction: AdvisoryDirection, department: string): string {
  if (department === "AGENT_OPERATIONS") return "agent participation";
  const dir = direction === "NEUTRAL" ? "this setup" : `this ${direction.toLowerCase()} setup`;
  return dir;
}

// ── Court ──────────────────────────────────────────────────────────────────

export function computeGovernanceReview(input: GovernanceReviewInput): GovernanceReview {
  const { advisory, surface, direction, importance, context, traffic } = input;
  const allowSet =
    input.allowedAgentKeys && input.allowedAgentKeys.length > 0
      ? new Set(input.allowedAgentKeys)
      : null;
  const trafficSummary: TrafficSelectionSummary =
    traffic ?? {
      limited: false,
      consideredCount: advisory.contributions.length,
      participatedCount: advisory.contributions.filter((c) => c.effectiveInfluence > 0).length,
      reason: "no_traffic_controller",
    };

  const positions: GovernanceAgentPosition[] = [];
  const challenges: GovernanceChallenge[] = [];

  let rejectW = 0;
  let downgradeW = 0;
  let perfW = 0;
  let needsW = 0;
  let supportW = 0;
  let cautionW = 0;
  let participating = 0;
  // Max SINGLE-agent weight on each side — authority-weighting means escalation
  // needs a heavyweight on BOTH sides, not a crowd of lightweights against one.
  let maxSupportW = 0;
  let maxOpposeW = 0;

  for (const c of advisory.contributions) {
    // Traffic Controller enforcement: an agent the controller did NOT select for
    // this review steps back entirely — no voting position, no challenge. Recorded
    // as abstaining (weight 0) so the trace still shows it was considered. Fail-open
    // when no allow-list is supplied.
    if (allowSet && !allowSet.has(c.agentKey)) {
      positions.push({
        agentKey: c.agentKey,
        name: c.name,
        department: c.department,
        position: "abstain",
        weight: 0,
        reason: "stepped_back_not_selected_by_traffic_controller",
      });
      continue;
    }

    const weight = clamp(c.effectiveInfluence, 0, 1);
    const pos = weight <= 0 ? "abstain" : contextPosition(c, context, direction, trafficSummary);
    positions.push({
      agentKey: c.agentKey,
      name: c.name,
      department: c.department,
      position: pos,
      weight: +weight.toFixed(3),
      reason: positionReason(pos, c),
    });

    if (weight <= 0 || pos === "abstain") continue;
    participating++;

    switch (pos) {
      case "rejection":
        rejectW += weight;
        maxOpposeW = Math.max(maxOpposeW, weight);
        break;
      case "downgrade":
        downgradeW += weight;
        maxOpposeW = Math.max(maxOpposeW, weight);
        break;
      case "challenge":
        downgradeW += weight; // a challenge applies downgrade pressure
        maxOpposeW = Math.max(maxOpposeW, weight);
        break;
      case "performance_objection":
        perfW += weight;
        break;
      case "needs_more_data":
        needsW += weight;
        break;
      case "support":
        supportW += weight;
        maxSupportW = Math.max(maxSupportW, weight);
        break;
      case "caution":
        cautionW += weight;
        break;
      default:
        break;
    }

    if (
      pos === "challenge" ||
      pos === "downgrade" ||
      pos === "rejection" ||
      pos === "performance_objection"
    ) {
      challenges.push({
        byAgentKey: c.agentKey,
        byName: c.name,
        byDepartment: c.department,
        challengeType: pos,
        target: challengeTarget(direction, c.department),
        reason: positionReason(pos, c),
        weight: +weight.toFixed(3),
      });
    }
  }

  // Escalate only when a heavyweight agent on EACH side disagrees — a crowd of
  // lightweight supporters never out-votes a single trusted objection (authority-
  // weighting, not averaging).
  const conflict = maxOpposeW >= ESCALATE_CONFLICT && maxSupportW >= ESCALATE_CONFLICT;

  // Lifecycle / household recommendations (advisory; applied only via audited admin flow).
  const lifecycleRecommendations = buildLifecycleRecommendations(positions, context, trafficSummary);

  // Authority-weighted outcome resolution (NOT averaging).
  let outcome: GovernanceOutcome;
  if (participating === 0) {
    outcome = advisory.hasUntrustedResponsibleAgent ? "needs_more_data" : "approved";
  } else if (conflict) {
    // A strong-for / strong-against split is escalated rather than silently
    // resolved either way — checked before a one-sided rejection.
    outcome = "escalated";
  } else if (rejectW >= REJECT_THRESHOLD) {
    outcome = "rejected";
  } else if (needsW >= NEEDS_THRESHOLD) {
    outcome = "needs_more_data";
  } else if (downgradeW >= DOWNGRADE_THRESHOLD) {
    outcome = "downgraded";
  } else if (perfW >= PERF_THRESHOLD) {
    outcome = "delayed_speed";
  } else if (advisory.adjustedScore < MUTE_FLOOR) {
    outcome = "muted_low_confidence";
  } else if (cautionW > 0 || advisory.netDelta < -1 || advisory.hasUntrustedResponsibleAgent) {
    outcome = "approved_with_caution";
  } else {
    outcome = "approved";
  }

  // A benign outcome flips to learning-camp review only when retraining is the
  // dominant signal (a participating agent is flagged AND nothing stronger fired).
  if (
    (outcome === "approved" || outcome === "approved_with_caution") &&
    lifecycleRecommendations.some((r) => r.action === "LEARNING_CAMP")
  ) {
    outcome = "learning_camp_review";
  }

  const governanceApplied = participating > 0;
  const advisoryScore = advisory.adjustedScore;
  const h = HAIRCUT[outcome];
  const haircut = governanceApplied ? Math.min(advisoryScore * h.frac, h.cap) : 0;
  const governanceScore = +clamp(advisoryScore - haircut, 0, advisoryScore).toFixed(2);
  const scoreImpact = +(governanceScore - advisory.baseScore).toFixed(2);

  const conflictPenalty = conflict ? 15 : 0;
  const untrustPenalty = advisory.hasUntrustedResponsibleAgent ? 5 : 0;
  const confidenceScore = +clamp(governanceScore - conflictPenalty - untrustPenalty, 0, 100).toFixed(2);

  return {
    surface,
    direction,
    importance,
    outcome,
    finalDecision: finalDecisionLabel(outcome),
    baseScore: advisory.baseScore,
    advisoryScore,
    governanceScore,
    scoreImpact,
    confidenceScore,
    positions,
    challenges,
    participatingAgentCount: participating,
    winningReasoning: buildWinningReasoning({
      outcome,
      supportW,
      downgradeW,
      rejectW,
      needsW,
      perfW,
      conflict,
      participating,
    }),
    lifecycleRecommendations,
    traffic: trafficSummary,
    hasUntrustedResponsibleAgent: advisory.hasUntrustedResponsibleAgent,
    governanceApplied,
  };
}

function buildLifecycleRecommendations(
  positions: GovernanceAgentPosition[],
  ctx: GovernanceContext | undefined,
  traffic: TrafficSelectionSummary,
): GovernanceLifecycleRecommendation[] {
  const recs: GovernanceLifecycleRecommendation[] = [];
  const poor = new Set(ctx?.poorRecentAgentKeys ?? []);
  for (const p of positions) {
    if (p.weight > 0 && poor.has(p.agentKey)) {
      recs.push({
        agentKey: p.agentKey,
        name: p.name,
        action: "LEARNING_CAMP",
        reason: "poor_recent_performance_recommend_retraining",
      });
    }
  }
  // Step-back: when the Traffic Controller limited participation, recommend that
  // the skipped low-impact agents stay quiet on light decisions.
  if (traffic.limited && traffic.consideredCount > traffic.participatedCount) {
    recs.push({
      agentKey: "TRAFFIC_CONTROLLER",
      name: "Traffic Controller",
      action: "STEP_BACK",
      reason: "low_impact_agents_step_back_for_speed",
    });
  }
  return recs;
}

function finalDecisionLabel(outcome: GovernanceOutcome): string {
  switch (outcome) {
    case "approved":
      return "Approved";
    case "approved_with_caution":
      return "Approved with caution";
    case "downgraded":
      return "Downgraded (ranking only)";
    case "rejected":
      return "Rejected (ranking only)";
    case "escalated":
      return "Escalated to admin";
    case "needs_more_data":
      return "Needs more data";
    case "muted_low_confidence":
      return "Muted — low confidence";
    case "delayed_speed":
      return "Held back for speed";
    case "learning_camp_review":
      return "Learning-camp review recommended";
    default:
      return "Approved";
  }
}

function buildWinningReasoning(args: {
  outcome: GovernanceOutcome;
  supportW: number;
  downgradeW: number;
  rejectW: number;
  needsW: number;
  perfW: number;
  conflict: boolean;
  participating: number;
}): string {
  const { outcome, conflict, participating } = args;
  if (participating === 0) {
    return "No agent has earned the standing to weigh in, so the read is unchanged.";
  }
  switch (outcome) {
    case "rejected":
      return "A trusted risk-side agent rejected the setup; protection outranks opportunity.";
    case "escalated":
      return conflict
        ? "The team is strongly split for and against, so the conflict is escalated to admin."
        : "An unresolved conflict was escalated to admin.";
    case "downgraded":
      return "The challenging agents carried more weight than the supporters, so the read is downgraded.";
    case "needs_more_data":
      return "There is not enough reliable input to treat this read as strong.";
    case "delayed_speed":
      return "Too many low-impact agents were involved, so review was kept light to protect speed.";
    case "muted_low_confidence":
      return "Confidence is too low to surface this read prominently.";
    case "approved_with_caution":
      return "Supporters prevailed, but at least one agent flagged a caution worth noting.";
    case "learning_camp_review":
      return "The read stands, but a participating agent is flagged for retraining review.";
    case "approved":
    default:
      return "The trusted agents broadly agreed, so the read is approved.";
  }
}
