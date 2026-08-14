// ── Profit Mission Phase 5 — Edge Engine (pure, advisory scoring) ───────────
//
// PLANNING / ADVISORY ONLY. The Edge Engine turns a scouted setup + its market
// context into an objective 0–100 `finalEdgeScore` and an A+/A/B/C/D/F tier.
//
// HONESTY CONTRACT (the whole point of this engine):
//   - The score is ADVISORY. It can only ever LOWER a setup's standing — it can
//     NEVER raise a setup above a safety block. Caps and the `blocked` flag are
//     applied with `Math.min`, never `Math.max`.
//   - A stale / awaiting / simulator feed yields a CONTEXT-ONLY read (score 0,
//     tier F, not actionable) — an edge is never minted from a feed we don't
//     trust.
//   - A wide spread caps the score; an extreme spread BLOCKS it.
//   - A late entry downgrades the score; a too-late entry BLOCKS it (a draft can
//     never be created from a too-late edge — Phase 5 §32).
//   - There is NO martingale and NO "force a trade" path: tiers C/D/F are simply
//     not actionable; the caller skips them, it never escalates them.
//
// PURE + DETERMINISTIC + IO-FREE: no clock, DB, network, or globals. Every input
// is supplied by the caller (the service composes scanner/strategy truth into it).

import type { ProposalDirection } from "./agents/proposal.js";

/** Objective edge band. Only A+/A/B are actionable; C/D/F are skipped. */
export type EdgeTier = "A+" | "A" | "B" | "C" | "D" | "F";

/**
 * Positive edge components, each normalized 0..100. `null`/omitted = unknown and
 * is excluded from the weighted blend (remaining weights are renormalized), so a
 * missing signal neither helps nor hurts. Use the exported helpers to map raw
 * scanner values (e.g. reward-to-risk) onto these 0..100 scales.
 */
export interface EdgeComponentInputs {
  /** Conviction in the directional read (scanner confidence). */
  directionConviction?: number | null;
  /** Quality / cleanliness of the setup pattern. */
  setupQuality?: number | null;
  /** Reward-to-risk quality (map raw R with `rewardToRiskScore`). */
  rewardToRisk?: number | null;
  /** Entry-timing precision ("sniper" score). */
  entryQuality?: number | null;
  /** Session / time-of-day favourability. */
  timingQuality?: number | null;
  /** Order-flow / momentum confirmation. */
  orderFlow?: number | null;
  /** Chart-pattern confirmation. */
  pattern?: number | null;
  /** Trendline alignment. */
  trendline?: number | null;
  /** Pivot / key-level alignment. */
  pivot?: number | null;
  /** Advisory agent-ecosystem trust standing. */
  agentTrust?: number | null;
  /** Trading-session quality. */
  session?: number | null;
  /** Symbol tradability / liquidity quality. */
  symbolQuality?: number | null;
}

/**
 * Penalties subtracted from the blended positive score, each 0..100 points.
 * These reduce the score directly (separate from the harder honesty caps below).
 */
export interface EdgePenaltyInputs {
  spread?: number | null;
  slippage?: number | null;
  news?: number | null;
  correlation?: number | null;
}

/** Honest feed truth — anything but `live` makes the read context-only/capped. */
export type EdgeFeedStatus = "live" | "delayed" | "stale" | "awaiting" | "simulator";
/** Spread regime — `wide` caps the score, `extreme` blocks it. */
export type EdgeSpreadState = "normal" | "wide" | "extreme" | "unknown";
/** Entry-timing regime — `late` downgrades, `too_late` blocks. */
export type EdgeTimingState = "fresh" | "late" | "too_late" | "unknown";

export interface EdgeHonestyCaps {
  feedStatus: EdgeFeedStatus;
  spread: EdgeSpreadState;
  timing: EdgeTimingState;
}

export interface EdgeInput {
  direction: ProposalDirection;
  components: EdgeComponentInputs;
  penalties?: EdgePenaltyInputs;
  honesty: EdgeHonestyCaps;
}

export interface EdgeComponentContribution {
  key: keyof EdgeComponentInputs;
  weight: number; // renormalized weight actually used
  value: number; // 0..100
  contribution: number; // weight * value
}

export interface EdgeScore {
  /** Final advisory score, 0..100, after penalties + honesty caps. */
  finalEdgeScore: number;
  /** Blended positive score before penalties/caps (0..100). */
  rawScore: number;
  tier: EdgeTier;
  /** True when this is not an actionable setup (no direction / no live feed). */
  contextOnly: boolean;
  /** True when a safety cap (extreme spread / too-late entry) blocks the setup. */
  blocked: boolean;
  /** Honest machine reason for the dominant cap, or null. */
  capReason: string | null;
  /** True only for A+/A/B — the bands the router/draft path may act on. */
  actionable: boolean;
  components: EdgeComponentContribution[];
  penaltiesApplied: { key: keyof EdgePenaltyInputs; value: number }[];
  warnings: string[];
  reason: string;
}

/** Component weights (sum = 1.0). Conviction/setup/RR dominate. */
const COMPONENT_WEIGHTS: Record<keyof EdgeComponentInputs, number> = {
  directionConviction: 0.22,
  setupQuality: 0.15,
  rewardToRisk: 0.15,
  entryQuality: 0.12,
  timingQuality: 0.08,
  orderFlow: 0.06,
  pattern: 0.05,
  trendline: 0.04,
  pivot: 0.03,
  agentTrust: 0.05,
  session: 0.03,
  symbolQuality: 0.02,
};

/** Score thresholds (finalEdgeScore ≥ value → tier). */
const TIER_THRESHOLDS: { tier: EdgeTier; min: number }[] = [
  { tier: "A+", min: 85 },
  { tier: "A", min: 75 },
  { tier: "B", min: 62 },
  { tier: "C", min: 50 },
  { tier: "D", min: 38 },
  { tier: "F", min: 0 },
];

const ACTIONABLE_TIERS: ReadonlySet<EdgeTier> = new Set<EdgeTier>(["A+", "A", "B"]);

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Is this an actionable (tradeable) edge band? Only A+/A/B qualify. */
export function isActionableTier(tier: EdgeTier): boolean {
  return ACTIONABLE_TIERS.has(tier);
}

/**
 * Map a raw reward-to-risk ratio onto a 0..100 component score. R of 3.0+ caps
 * at 100; R of 1.0 ≈ 33. Returns null when R is unknown/non-positive.
 */
export function rewardToRiskScore(expectedR: number | null | undefined): number | null {
  if (expectedR == null || !Number.isFinite(expectedR) || expectedR <= 0) return null;
  return clamp((expectedR / 3) * 100, 0, 100);
}

function tierFor(score: number): EdgeTier {
  for (const t of TIER_THRESHOLDS) {
    if (score >= t.min) return t.tier;
  }
  return "F";
}

/**
 * Compute an objective, advisory edge score + tier with honest caps. Pure.
 *
 * The blended positive score is a renormalized weighted average of whatever
 * components are present, minus penalties, then floored by the honesty caps.
 * Caps can only LOWER the result; nothing here can raise a setup over a block.
 */
export function computeEdgeScore(input: EdgeInput): EdgeScore {
  const warnings: string[] = [];

  // ── 1. Blend the present positive components (renormalized weights). ──────
  const contributions: EdgeComponentContribution[] = [];
  let presentWeight = 0;
  for (const key of Object.keys(COMPONENT_WEIGHTS) as (keyof EdgeComponentInputs)[]) {
    const raw = input.components[key];
    if (raw == null || !Number.isFinite(raw)) continue;
    presentWeight += COMPONENT_WEIGHTS[key];
  }
  let rawScore = 0;
  if (presentWeight > 0) {
    for (const key of Object.keys(COMPONENT_WEIGHTS) as (keyof EdgeComponentInputs)[]) {
      const raw = input.components[key];
      if (raw == null || !Number.isFinite(raw)) continue;
      const value = clamp(Number(raw), 0, 100);
      const weight = COMPONENT_WEIGHTS[key] / presentWeight;
      const contribution = weight * value;
      rawScore += contribution;
      contributions.push({ key, weight: round1(weight * 100) / 100, value: round1(value), contribution: round1(contribution) });
    }
  }
  rawScore = clamp(rawScore, 0, 100);

  // ── 2. Subtract soft penalties. ──────────────────────────────────────────
  const penaltiesApplied: { key: keyof EdgePenaltyInputs; value: number }[] = [];
  let penaltyTotal = 0;
  const pen = input.penalties ?? {};
  for (const key of ["spread", "slippage", "news", "correlation"] as (keyof EdgePenaltyInputs)[]) {
    const raw = pen[key];
    if (raw == null || !Number.isFinite(raw) || raw <= 0) continue;
    const value = clamp(Number(raw), 0, 100);
    penaltyTotal += value;
    penaltiesApplied.push({ key, value: round1(value) });
  }
  let score = clamp(rawScore - penaltyTotal, 0, 100);

  // ── 3. Honest caps — these can ONLY lower the score / block the setup. ───
  let contextOnly = false;
  let blocked = false;
  let capReason: string | null = null;

  const applyCap = (capValue: number, reason: string) => {
    if (score > capValue) {
      score = capValue;
      capReason ??= reason;
    }
  };

  // Direction must be real to be an actionable edge.
  if (input.direction === "NONE") {
    contextOnly = true;
    capReason ??= "NO_DIRECTION";
    warnings.push("No directional read — context only, not a setup.");
  }

  // Feed honesty (Scanner Truth): only a live feed yields an actionable edge.
  switch (input.honesty.feedStatus) {
    case "live":
      break;
    case "delayed":
      applyCap(55, "FEED_DELAYED");
      warnings.push("Feed is delayed — edge capped pending a confirmed live tick.");
      break;
    case "stale":
      contextOnly = true;
      capReason ??= "FEED_STALE";
      warnings.push("Feed is stale — context only, no actionable edge.");
      break;
    case "awaiting":
      contextOnly = true;
      capReason ??= "FEED_AWAITING";
      warnings.push("Awaiting a confirmed live feed — context only.");
      break;
    case "simulator":
      contextOnly = true;
      capReason ??= "FEED_SIMULATOR";
      warnings.push("Simulator data — context only, never an actionable edge.");
      break;
  }

  // Spread regime.
  if (input.honesty.spread === "wide") {
    applyCap(70, "SPREAD_WIDE");
    warnings.push("Spread is wide — edge capped.");
  } else if (input.honesty.spread === "extreme") {
    blocked = true;
    capReason ??= "SPREAD_TOO_WIDE";
    warnings.push("Spread is too wide to trade — setup blocked.");
  }

  // Entry-timing regime.
  if (input.honesty.timing === "late") {
    applyCap(65, "ENTRY_LATE");
    warnings.push("Entry is late — edge downgraded.");
  } else if (input.honesty.timing === "too_late") {
    blocked = true;
    capReason ??= "ENTRY_TOO_LATE";
    warnings.push("Entry window has passed — setup blocked.");
  }

  // ── 4. Resolve final score + tier. ───────────────────────────────────────
  if (contextOnly || blocked) {
    score = 0;
  }
  const finalEdgeScore = round1(clamp(score, 0, 100));
  const tier: EdgeTier = contextOnly || blocked ? "F" : tierFor(finalEdgeScore);
  const actionable = !contextOnly && !blocked && isActionableTier(tier);

  const reason = blocked
    ? `Setup blocked by a safety cap (${capReason}).`
    : contextOnly
      ? `Context only (${capReason ?? "no actionable edge"}).`
      : actionable
        ? `Tier ${tier} edge (${finalEdgeScore}/100).`
        : `Tier ${tier} edge (${finalEdgeScore}/100) — below the actionable A/B floor.`;

  return {
    finalEdgeScore,
    rawScore: round1(rawScore),
    tier,
    contextOnly,
    blocked,
    capReason,
    actionable,
    components: contributions,
    penaltiesApplied,
    warnings,
    reason,
  };
}
