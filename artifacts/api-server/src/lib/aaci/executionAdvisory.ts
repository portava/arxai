// AACI — Advisory pre-execution gate for AUTONOMOUS self-trade (Task #231).
//
// Consulted by the self-trade executor AFTER the existing execution gate
// (`evaluateAgentExecution`) has already PERMITTED a decision and BEFORE the
// `executeInstant` → 16-gate Phase B pipeline runs. It composes the AACI
// cohesion verdict for the agent's symbol and maps it to an execution effect.
//
// SAFETY (inviolable):
// - This layer can only ever ADD caution: it may defer (no dispatch), downgrade
//   to prepare-only (stage a draft, never confirm/dispatch), or reduce size. It
//   NEVER enables a trade — a positive AACI verdict still flows through the full
//   16-gate pipeline, which can still refuse.
// - It NEVER bypasses HARD_GATE, Risk Governor, Supervisor approval, kill
//   switches, or allocation. Those run before AND after this check.
// - The decision is persisted (per-user `aaci_decisions`) and audited by the
//   caller before any side effect.

import { buildAaciSnapshot } from "./snapshotService.js";
import { buildAaciDecision } from "./decisionService.js";
import { consultSecurityHandshake } from "../security/handshake.js";
import { logger } from "../logger.js";
import type { AaciDecision, AaciSharedTruthSnapshot } from "@workspace/domain/aaci";
import type { SecurityAutonomyEffect } from "@workspace/domain/security";

// An agent dispatch needs a genuinely healthy cohesion verdict. The recommended
// action resolver already bands by score (ALLOW ≥80, ALLOW_REDUCED_SIZE ≥70,
// PREPARE_ONLY ≥60); this is a defensive secondary floor below which we never
// dispatch at full size even if the action mapping would allow it.
export const AACI_AGENT_DISPATCH_THRESHOLD = 70;

export interface AaciExecutionAdvisory {
  /** Dispatch is permitted by AACI (still subject to the 16-gate pipeline). */
  proceed: boolean;
  /** Force the prepare-only path (stage a draft, never confirm/dispatch). */
  downgradeToPrepareOnly: boolean;
  /** Multiply the computed lot by this (1.0 full, 0.5 reduced). */
  sizeMultiplier: number;
  /** Machine code for audit/exec rows when AACI defers/downgrades. */
  blockReason: string | null;
  recommendedAction: AaciDecision["recommendedAction"];
  finalAaciScore: number;
  hardGatePass: boolean;
  /** Operator-facing one-liner (admin diagnostics). */
  reason: string;
}

/**
 * PURE mapping from a composed AaciDecision to an execution effect. No IO.
 * Drives entirely off the hard gate + recommended action + score floor, so it
 * can only ADD caution relative to the action the executor already permitted.
 */
export function mapAaciDecisionToExecutionAdvisory(
  decision: AaciDecision,
  threshold: number = AACI_AGENT_DISPATCH_THRESHOLD,
): AaciExecutionAdvisory {
  const base = {
    recommendedAction: decision.recommendedAction,
    finalAaciScore: decision.finalAaciScore,
    hardGatePass: decision.hardGatePass,
  };

  // Hard gate fail → never dispatch; take the calmest softer path.
  if (!decision.hardGatePass) {
    return {
      ...base,
      proceed: false,
      downgradeToPrepareOnly: false,
      sizeMultiplier: 1,
      blockReason: `AACI_HARD_GATE:${decision.hardGateFailures[0] ?? "BLOCKED"}`,
      reason: decision.explanation || "AACI hard gate did not pass.",
    };
  }

  const defer = (code: string): AaciExecutionAdvisory => ({
    ...base,
    proceed: false,
    downgradeToPrepareOnly: false,
    sizeMultiplier: 1,
    blockReason: code,
    reason: decision.explanation || code,
  });

  switch (decision.recommendedAction) {
    case "ALLOW":
    case "ALLOW_REDUCED_SIZE": {
      // Defensive score floor: below it, downgrade to prepare-only rather than
      // dispatch — never silently proceed on a weak verdict.
      if (decision.finalAaciScore < threshold) {
        return {
          ...base,
          proceed: false,
          downgradeToPrepareOnly: true,
          sizeMultiplier: 1,
          blockReason: `AACI_BELOW_THRESHOLD:${decision.finalAaciScore}`,
          reason: decision.explanation || "AACI score below dispatch threshold.",
        };
      }
      const reduced = decision.recommendedAction === "ALLOW_REDUCED_SIZE";
      return {
        ...base,
        proceed: true,
        downgradeToPrepareOnly: false,
        sizeMultiplier: reduced ? 0.5 : 1,
        blockReason: null,
        reason: reduced
          ? "AACI permits a reduced-size dispatch."
          : "AACI cohesion clear.",
      };
    }
    case "PREPARE_ONLY":
      return {
        ...base,
        proceed: false,
        downgradeToPrepareOnly: true,
        sizeMultiplier: 1,
        blockReason: "AACI_PREPARE_ONLY",
        reason: decision.explanation || "AACI recommends preparing only.",
      };
    default:
      // WAIT_FOR_CONFIRMATION / WATCH_ONLY / PROTECT_OPEN_TRADE / EXIT_OR_REDUCE
      // / RECONCILE_SYSTEM / BLOCK / ALERT_ADMIN → defer (no dispatch).
      return defer(`AACI_${decision.recommendedAction}`);
  }
}

/**
 * Fold the Security Score band's autonomy effect into an already-computed
 * advisory. CAUTION-ONLY: it can only shrink size, force prepare-only, or defer
 * — it never flips a deferred/prepare-only advisory back to proceed and never
 * raises the size multiplier. The handshake FAIL path is handled separately via
 * the HARD_GATE factor; this layers the posture-band effect on top.
 */
/**
 * Phase 4 — Apply chart handshake caution to an already-computed advisory.
 * CAUTION-ONLY: can only downgrade a would-be dispatch to prepare-only or add
 * a blockReason. Never enables a trade or relaxes any other restriction.
 *
 * - chartHandshake.overall === "FAIL" → downgrade dispatch to prepare-only
 * - chartHandshake.overall === "WARN" → reduce size multiplier by half
 * - chartHandshake absent or "PASS" → no change
 *
 * Fail-open: if the snapshot has no chartHandshake (cold cache, symbol not
 * set), advisory passes through unchanged — honest unknown, not a block.
 */
export function applyChartHandshakeToAdvisory(
  advisory: AaciExecutionAdvisory,
  snapshot: AaciSharedTruthSnapshot,
): AaciExecutionAdvisory {
  const handshake = snapshot.chartHandshake;
  if (!handshake) return advisory; // cold cache / no chart symbol — fail-open

  if (handshake.overall === "FAIL") {
    // Chart truth degraded — downgrade any dispatch to prepare-only.
    if (advisory.proceed) {
      return {
        ...advisory,
        proceed: false,
        downgradeToPrepareOnly: true,
        blockReason: advisory.blockReason ?? `CHART_HANDSHAKE_FAIL:score=${handshake.chartTruthScore}`,
        reason: `Chart Truth score ${handshake.chartTruthScore} < threshold — chart-based dispatch downgraded to prepare-only.`,
      };
    }
  } else if (handshake.overall === "WARN") {
    // Chart degraded but above threshold — reduce size.
    if (advisory.proceed && advisory.sizeMultiplier > 0.5) {
      return {
        ...advisory,
        sizeMultiplier: 0.5,
        reason: advisory.reason + ` (chart WARN: score=${handshake.chartTruthScore})`,
      };
    }
  }

  return advisory;
}

export function applySecurityAutonomyToAdvisory(
  advisory: AaciExecutionAdvisory,
  autonomy: SecurityAutonomyEffect,
): AaciExecutionAdvisory {
  const next: AaciExecutionAdvisory = {
    ...advisory,
    // Size can only ever shrink.
    sizeMultiplier: Math.min(advisory.sizeMultiplier, autonomy.sizeMultiplier),
  };

  // Lockdown / critical: defer entirely (admin review) — no dispatch, no prepare.
  if (!autonomy.allowAutonomy || autonomy.requireAdminReview) {
    next.proceed = false;
    next.downgradeToPrepareOnly = false;
    next.blockReason = next.blockReason ?? `SECURITY_BAND:${autonomy.band}`;
    next.reason = autonomy.reason;
    return next;
  }

  // Degraded: downgrade a would-be dispatch to prepare-only.
  if (autonomy.downgradeToPrepareOnly && next.proceed) {
    next.proceed = false;
    next.downgradeToPrepareOnly = true;
    next.blockReason = next.blockReason ?? `SECURITY_BAND:${autonomy.band}`;
    next.reason = autonomy.reason;
  }

  return next;
}

export interface AaciExecutionAdvisoryInput {
  /** The user the agent executes as (owner / fleet creator). */
  executingUserId: number;
  agentId: number;
  agentKey: string;
  agentName?: string;
  autonomyLevel?: number;
  funded: boolean;
  active: boolean;
  symbol: string;
  timeframe?: "M1" | "M5" | "M15" | "M30" | "H1" | "H4" | "D1";
  signalAgeMs?: number;
  threshold?: number;
}

/**
 * Build the AACI cohesion verdict for one autonomous decision and map it to an
 * execution effect. Reads the SHARED master bridge (the route the agent runs
 * on) and persists the per-user decision. Fail-open: on any internal error this
 * returns a calm PREPARE_ONLY downgrade (never a silent proceed, never a throw
 * that would break the cycle).
 */
export async function evaluateAaciExecutionAdvisory(
  input: AaciExecutionAdvisoryInput,
): Promise<{ advisory: AaciExecutionAdvisory; decision: AaciDecision | null }> {
  const timeframe = input.timeframe ?? "M15";
  try {
    const snapshot = await buildAaciSnapshot({
      userId: input.executingUserId,
      role: "system",
      symbol: input.symbol,
      timeframe,
      includeMasterBroker: true,
    });

    // Override the fleet-aggregate self-trade context with THIS agent's facts so
    // the hard gate reflects the specific agent being dispatched.
    snapshot.selfTradeAgent = {
      ...(snapshot.selfTradeAgent ?? {}),
      agentId: String(input.agentId),
      agentName: input.agentName,
      funded: input.funded,
      active: input.active,
      autonomyLevel: input.autonomyLevel,
    };

    // Security handshake (Phase 2): consult REAL security signals for this
    // autonomous trade. A FAIL feeds securityHandshakePass=false into the AACI
    // HARD_GATE (which then fails closed); the band's autonomy effect layers
    // additional caution on top. ADVISORY-ADDITIVE ONLY — never enables a trade.
    const handshake = await consultSecurityHandshake("SELF_TRADE_EXECUTION", {
      userId: input.executingUserId,
      authenticated: true,
    });

    const decision = await buildAaciDecision({
      snapshot,
      userId: input.executingUserId,
      actorType: "self_trade_agent",
      actorId: input.agentKey,
      actionRequested: "AUTONOMOUS_EXECUTE",
      symbol: input.symbol,
      timeframe,
      signalAgeMs: input.signalAgeMs ?? 0,
      securityHandshakePass: handshake.verdict.securityHandshakePass,
      persist: true,
    });

    const mapped = mapAaciDecisionToExecutionAdvisory(decision, input.threshold);
    const withSecurity = handshake.autonomy
      ? applySecurityAutonomyToAdvisory(mapped, handshake.autonomy)
      : mapped;

    // Phase 4: Apply chart handshake caution — if the chart handshake FAILS
    // (chart truth degraded for this symbol), downgrade any would-be dispatch
    // to prepare-only. ADVISORY-ADDITIVE ONLY — can only add caution, never
    // enable a trade or bypass the 16-gate pipeline.
    const advisory = applyChartHandshakeToAdvisory(withSecurity, snapshot);

    return { advisory, decision };
  } catch (err) {
    logger.warn({ err, agentKey: input.agentKey }, "aaci: execution advisory failed (fail-open to prepare-only)");
    return {
      advisory: {
        proceed: false,
        downgradeToPrepareOnly: true,
        sizeMultiplier: 1,
        blockReason: "AACI_UNAVAILABLE",
        recommendedAction: "PREPARE_ONLY",
        finalAaciScore: 0,
        hardGatePass: false,
        reason: "AACI cohesion check unavailable this cycle — preparing only.",
      },
      decision: null,
    };
  }
}
