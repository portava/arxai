// ═══════════════════════════════════════════════════════════════════════════
// security/anomaly.ts — pure trade-command anomaly + account-takeover heuristics.
//
// Deterministic, no IO. The api-server builds the baseline/observation from REAL
// history + the concrete command and calls these BEFORE an autonomous side
// effect. Output is advisory-additive caution: it recommends ALLOW /
// REQUIRE_REVIEW / BLOCK. It NEVER enables a trade and never relaxes a gate; a
// BLOCK only adds a refusal on top of the existing 16-gate / Risk Governor path.
//
// SAFETY: missing baseline data does NOT manufacture confidence. Ratio checks
// only run on a trusted baseline (sampleSize ≥ policy.minBaselineSampleSize);
// the absolute hard cap and structural checks (agent permission, payload tamper)
// apply unconditionally so an unprofiled actor is never given a free pass.
// ═══════════════════════════════════════════════════════════════════════════

import type { AnomalyPolicy, TakeoverPolicy } from "./operationalPolicies.js";

// ── Trade-command anomaly ───────────────────────────────────────────────────

export interface TradeCommandBaseline {
  /** Typical (median/avg) lot the actor trades, > 0 when known. */
  typicalLot: number;
  /** Symbols the actor normally trades. */
  knownSymbols: string[];
  /** How many historical trades the baseline is derived from. */
  sampleSize: number;
}

export interface TradeCommandObservation {
  lot: number;
  symbol: string;
  hasStopLoss: boolean;
  hourUtc: number; // 0–23
  /** Where the command originated, e.g. "self-trade", "chart", "scanner". */
  source: string;
  /** Sources allowed for this actor (empty ⇒ unchecked). */
  expectedSources: string[];
  /** Count of recent identical/repeated attempts. */
  recentAttempts: number;
  /** Whether the acting agent is permitted to trade this. */
  agentPermitted: boolean;
  /** True when the payload changed after it was approved (tamper). */
  payloadChangedAfterApproval: boolean;
}

export type AnomalyRecommendedAction = "ALLOW" | "REQUIRE_REVIEW" | "BLOCK";
export type AnomalySeverity = "NONE" | "WARN" | "HIGH" | "CRITICAL";

export interface AnomalyFlag {
  code: string;
  severity: "WARN" | "HIGH" | "CRITICAL";
  /** True when this flag alone forces a BLOCK. */
  blocks: boolean;
  message: string;
}

export interface TradeCommandAnomalyVerdict {
  anomalies: AnomalyFlag[];
  severity: AnomalySeverity;
  recommendedAction: AnomalyRecommendedAction;
  reasonCode: string;
  userMessage: string;
  adminMessage: string;
}

const SEVERITY_RANK: Record<"WARN" | "HIGH" | "CRITICAL", number> = { WARN: 1, HIGH: 2, CRITICAL: 3 };

export function evaluateTradeCommandAnomaly(
  obs: TradeCommandObservation,
  baseline: TradeCommandBaseline,
  policy: AnomalyPolicy,
): TradeCommandAnomalyVerdict {
  const flags: AnomalyFlag[] = [];

  // Structural / unconditional checks (apply with or without a baseline).
  if (!obs.agentPermitted) {
    flags.push({ code: "AGENT_NOT_PERMITTED", severity: "CRITICAL", blocks: true, message: "Acting agent is not permitted to place this trade." });
  }
  if (obs.payloadChangedAfterApproval) {
    flags.push({ code: "PAYLOAD_TAMPERED", severity: "CRITICAL", blocks: true, message: "Command payload changed after approval." });
  }
  if (Number.isFinite(obs.lot) && obs.lot > policy.absoluteLotHardCap) {
    flags.push({ code: "LOT_OVER_HARD_CAP", severity: "CRITICAL", blocks: true, message: "Lot size exceeds the absolute safety cap." });
  }
  if (policy.requireStopLoss && !obs.hasStopLoss) {
    flags.push({ code: "MISSING_STOP_LOSS", severity: "HIGH", blocks: false, message: "Command is missing a stop-loss." });
  }
  if (obs.expectedSources.length > 0 && !obs.expectedSources.includes(obs.source)) {
    flags.push({ code: "UNEXPECTED_SOURCE", severity: "HIGH", blocks: false, message: "Command originated from an unexpected source." });
  }

  // Out-of-session window (supports a wrapped window where start > end).
  const { sessionStartHourUtc: s, sessionEndHourUtc: e } = policy;
  const inSession =
    s === e
      ? false // empty window means "no session is allowed" → always out
      : s < e
        ? obs.hourUtc >= s && obs.hourUtc < e
        : obs.hourUtc >= s || obs.hourUtc < e;
  const fullDay = s === 0 && e === 24;
  if (!fullDay && !inSession) {
    flags.push({ code: "OUT_OF_SESSION", severity: "WARN", blocks: false, message: "Command is outside the configured trading window." });
  }

  // Repeated attempts.
  if (obs.recentAttempts >= policy.repeatedAttemptBlock) {
    flags.push({ code: "REPEATED_ATTEMPTS_BLOCK", severity: "CRITICAL", blocks: true, message: "Too many repeated attempts." });
  } else if (obs.recentAttempts >= policy.repeatedAttemptWarn) {
    flags.push({ code: "REPEATED_ATTEMPTS", severity: "HIGH", blocks: false, message: "Unusually repeated attempts." });
  }

  // Baseline ratio checks — only when the baseline is trusted.
  const baselineTrusted = baseline.sampleSize >= policy.minBaselineSampleSize && baseline.typicalLot > 0;
  if (baselineTrusted && Number.isFinite(obs.lot) && obs.lot > 0) {
    const ratio = obs.lot / baseline.typicalLot;
    if (ratio >= policy.lotBaselineMultipleBlock) {
      flags.push({ code: "LOT_FAR_ABOVE_BASELINE", severity: "CRITICAL", blocks: true, message: "Lot size is far above the actor's normal size." });
    } else if (ratio >= policy.lotBaselineMultipleWarn) {
      flags.push({ code: "LOT_ABOVE_BASELINE", severity: "HIGH", blocks: false, message: "Lot size is well above the actor's normal size." });
    }
  }
  if (baseline.knownSymbols.length > 0 && !baseline.knownSymbols.includes(obs.symbol)) {
    flags.push({ code: "UNUSUAL_SYMBOL", severity: "WARN", blocks: false, message: "Symbol is outside the actor's usual set." });
  }

  const blocks = flags.some((f) => f.blocks);
  const maxSeverity = flags.reduce<AnomalySeverity>((acc, f) => {
    return SEVERITY_RANK[f.severity] > (acc === "NONE" ? 0 : SEVERITY_RANK[acc as "WARN" | "HIGH" | "CRITICAL"]) ? f.severity : acc;
  }, "NONE");

  const recommendedAction: AnomalyRecommendedAction = blocks ? "BLOCK" : flags.length > 0 ? "REQUIRE_REVIEW" : "ALLOW";

  return {
    anomalies: flags,
    severity: maxSeverity,
    recommendedAction,
    reasonCode: blocks ? "ANOMALY_BLOCK" : flags.length > 0 ? "ANOMALY_REVIEW" : "ANOMALY_NONE",
    userMessage:
      recommendedAction === "BLOCK"
        ? "This action was paused for safety and needs review."
        : recommendedAction === "REQUIRE_REVIEW"
          ? "This action looks unusual and may need review."
          : "No anomalies detected.",
    adminMessage:
      flags.length === 0
        ? "No trade-command anomalies."
        : `Trade-command anomalies: ${flags.map((f) => f.code).join(", ")}.`,
  };
}

// ── Account-takeover heuristics ─────────────────────────────────────────────

export interface TakeoverSignals {
  newDevice?: boolean;
  newCountry?: boolean;
  failedLoginCount?: number;
  unusualAdminAction?: boolean;
  largeAllocationChangePct?: number;
  suddenLiveAutonomyEnable?: boolean;
  repeatedPasswordReset?: number;
}

export type TakeoverRecommendedAction = "ALLOW" | "REQUIRE_STEP_UP" | "ALERT_ADMIN" | "BLOCK";
export type TakeoverRiskLevel = "NONE" | "LOW" | "ELEVATED" | "HIGH";

export interface TakeoverVerdict {
  flags: AnomalyFlag[];
  riskLevel: TakeoverRiskLevel;
  recommendedAction: TakeoverRecommendedAction;
  reasonCode: string;
  userMessage: string;
  adminMessage: string;
}

/**
 * Score account-takeover risk from whatever signals are available. Missing
 * signals raise NO caution but also assert NO safety (future-ready inputs).
 */
export function evaluateTakeoverRisk(signals: TakeoverSignals, policy: TakeoverPolicy): TakeoverVerdict {
  const flags: AnomalyFlag[] = [];
  let block = false;
  let alert = false;
  let stepUp = false;

  if (signals.newDevice === true) {
    flags.push({ code: "NEW_DEVICE", severity: "WARN", blocks: false, message: "Sign-in from a new device." });
    stepUp = true;
  }
  if (signals.newCountry === true) {
    flags.push({ code: "NEW_COUNTRY", severity: "HIGH", blocks: false, message: "Sign-in from a new location." });
    stepUp = true;
    alert = true;
  }
  if (typeof signals.failedLoginCount === "number") {
    if (signals.failedLoginCount >= policy.failedLoginSpikeBlock) {
      flags.push({ code: "FAILED_LOGIN_SPIKE_BLOCK", severity: "CRITICAL", blocks: true, message: "Excessive failed sign-in attempts." });
      block = true;
      alert = true;
    } else if (signals.failedLoginCount >= policy.failedLoginSpikeWarn) {
      flags.push({ code: "FAILED_LOGIN_SPIKE", severity: "HIGH", blocks: false, message: "Elevated failed sign-in attempts." });
      alert = true;
    }
  }
  if (signals.unusualAdminAction === true) {
    flags.push({ code: "UNUSUAL_ADMIN_ACTION", severity: "HIGH", blocks: false, message: "Unusual admin action for this account." });
    stepUp = true;
    alert = true;
  }
  if (typeof signals.largeAllocationChangePct === "number" && signals.largeAllocationChangePct >= policy.largeAllocationChangePct) {
    flags.push({ code: "LARGE_ALLOCATION_CHANGE", severity: "HIGH", blocks: false, message: "Large allocation change." });
    stepUp = true;
    alert = true;
  }
  if (signals.suddenLiveAutonomyEnable === true) {
    flags.push({ code: "SUDDEN_LIVE_AUTONOMY", severity: "HIGH", blocks: false, message: "Sudden enablement of live autonomy." });
    stepUp = true;
    alert = true;
    // Sudden live-autonomy enablement together with a new device/location is a
    // classic takeover pattern → block outright.
    if (signals.newDevice === true || signals.newCountry === true) {
      block = true;
      flags.push({ code: "LIVE_AUTONOMY_FROM_NEW_ORIGIN", severity: "CRITICAL", blocks: true, message: "Live autonomy enabled from a new origin." });
    }
  }
  if (typeof signals.repeatedPasswordReset === "number" && signals.repeatedPasswordReset >= policy.repeatedPasswordResetWarn) {
    flags.push({ code: "REPEATED_PASSWORD_RESET", severity: "HIGH", blocks: false, message: "Repeated password resets." });
    alert = true;
  }

  const recommendedAction: TakeoverRecommendedAction = block ? "BLOCK" : stepUp ? "REQUIRE_STEP_UP" : alert ? "ALERT_ADMIN" : "ALLOW";
  const riskLevel: TakeoverRiskLevel = block ? "HIGH" : stepUp ? "ELEVATED" : alert ? "LOW" : "NONE";

  return {
    flags,
    riskLevel,
    recommendedAction,
    reasonCode: `TAKEOVER_${recommendedAction}`,
    userMessage:
      recommendedAction === "BLOCK"
        ? "For your security, this action was paused. Please contact support."
        : recommendedAction === "REQUIRE_STEP_UP"
          ? "For your security, please confirm it's really you."
          : "No action needed.",
    adminMessage: flags.length === 0 ? "No takeover signals." : `Takeover signals: ${flags.map((f) => f.code).join(", ")}.`,
  };
}
