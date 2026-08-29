// ── B6 — Off-policy evaluation over the declined-trades journal (pure) ──────
//
// The rejected/expired/cancelled mission trade drafts are a journal of
// decisions the platform chose NOT to take. This module produces the ADVISORY
// record of what a counterfactual policy that had taken them might have
// earned — bounded honestly and net of C7 costs:
//
//   * BOUNDS, NOT PREDICTIONS. Pre-trade, the only deterministic knowledge is
//     the draft's own plan (max loss at stop, max gain at target) — the same
//     honesty contract as draftCounterfactual.ts. Those bounds are recorded
//     per declined draft, cost-netted.
//   * RESOLVED ONLY WHERE REAL EVIDENCE EXISTS. A declined draft counts
//     toward the aggregate estimate ONLY when the caller supplies a resolved
//     counterfactual outcome for it from RECORDED evidence (the replay lab's
//     post-hoc counterfactual over recorded bars, or a reconciled sibling
//     execution of the same cohort). Anything unresolved is EXCLUDED and
//     counted — never imputed.
//   * NET OF C7 COSTS. Every counterfactual return is reduced by the DECLARED
//     round-trip cost for its instrument class, mirrored from
//     lib/validation/src/costModel.ts (api-server does not depend on
//     @workspace/validation; the QA suite drives the REAL module and asserts
//     the mirror matches). Costs only ever SUBTRACT — net ≤ gross always.
//   * ZERO AUTHORITY. advisory: true, authority "NONE"; no caller may branch
//     an execution decision on this record (pinned by the isolation test).
//
// FLYWHEEL INVARIANT: pure — no IO, no clock, no randomness.

import type { ArxAssetClass } from "@workspace/markets";

// ── C7 declared cost mirror (per SIDE, fractions of notional) ───────────────
// STRUCTURAL MIRROR of lib/validation/src/costModel.ts DECLARED_CLASS_DEFAULTS
// + UNKNOWN_VENUE_COMMISSION_PER_SIDE. The flywheel QA suite dynamically
// imports the real module and asserts these numbers are identical — a drifted
// mirror fails CI, exactly the edgePromotion.ts precedent.
export const FLYWHEEL_DECLARED_COSTS_PER_SIDE: Readonly<
  Record<ArxAssetClass, { halfSpreadFrac: number; perSideSlippageFrac: number }>
> = Object.freeze({
  forex_major: { halfSpreadFrac: 0.0001, perSideSlippageFrac: 0.0001 },
  forex_cross: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
  forex_exotic: { halfSpreadFrac: 0.0008, perSideSlippageFrac: 0.0005 },
  metal: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
  energy: { halfSpreadFrac: 0.0004, perSideSlippageFrac: 0.0003 },
  index: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
  stock: { halfSpreadFrac: 0.0003, perSideSlippageFrac: 0.0003 },
  etf: { halfSpreadFrac: 0.0002, perSideSlippageFrac: 0.0002 },
  crypto: { halfSpreadFrac: 0.0008, perSideSlippageFrac: 0.0007 },
  synthetic: { halfSpreadFrac: 0.0005, perSideSlippageFrac: 0.0003 },
  commodity: { halfSpreadFrac: 0.0004, perSideSlippageFrac: 0.0003 },
});
/** Mirror of costModel's UNKNOWN venue commission — never a free ride. */
export const FLYWHEEL_UNKNOWN_VENUE_COMMISSION_PER_SIDE = 0.0005;

/**
 * PURE — conservative DECLARED round-trip cost fraction for a class. Unknown
 * class gets the most expensive declared entry, never zero.
 */
export function declaredRoundTripCostFrac(assetClass: string): number {
  const entries = Object.values(FLYWHEEL_DECLARED_COSTS_PER_SIDE);
  const known = (FLYWHEEL_DECLARED_COSTS_PER_SIDE as Record<string, { halfSpreadFrac: number; perSideSlippageFrac: number }>)[assetClass];
  const worst = entries.reduce(
    (m, e) => Math.max(m, e.halfSpreadFrac + e.perSideSlippageFrac),
    0,
  );
  const perSide = known
    ? known.halfSpreadFrac + known.perSideSlippageFrac
    : worst;
  return 2 * (perSide + FLYWHEEL_UNKNOWN_VENUE_COMMISSION_PER_SIDE);
}

/** Costs only ever SUBTRACT: net ≤ gross for every input, by construction. */
export function netOfDeclaredCosts(grossLogReturn: number, assetClass: string): number {
  if (!Number.isFinite(grossLogReturn)) return Number.NaN;
  return grossLogReturn - declaredRoundTripCostFrac(assetClass);
}

// ── Records ─────────────────────────────────────────────────────────────────

export interface DeclinedDraftEvidence {
  draftId: string;
  strategyId: string;
  symbol: string;
  assetClass: string;
  /** rejected | expired | cancelled — the decline the journal recorded. */
  declineStatus: string;
  declineReason: string | null;
  /** The plan's own deterministic bounds (USD), when derivable. */
  maxLossUsd: number | null;
  maxGainUsd: number | null;
  /**
   * Resolved counterfactual net-log-return from RECORDED evidence, or null
   * when nothing recorded resolves it. Null is EXCLUDED, never imputed.
   */
  resolvedGrossLogReturn: number | null;
}

export interface OpePerRecord {
  draftId: string;
  strategyId: string;
  symbol: string;
  declineStatus: string;
  bounds: { maxLossUsd: number | null; maxGainUsd: number | null };
  costFrac: number;
  /** resolved gross − declared round-trip cost; null when unresolved. */
  counterfactualNetLogReturn: number | null;
  resolution: "RESOLVED" | "UNRESOLVED";
  reasons: string[];
}

export interface OpeEstimate {
  method: "MEAN_OF_RESOLVED_COUNTERFACTUALS_NET_OF_DECLARED_COSTS";
  /** null when nothing resolved — an estimate over nothing is not 0. */
  meanCounterfactualNetLogReturn: number | null;
  resolvedCount: number;
  unresolvedCount: number;
  totalDeclined: number;
}

export interface OpeReport {
  kind: "FLYWHEEL_OPE_DECLINED_TRADES";
  advisory: true;
  authority: "NONE";
  estimate: OpeEstimate;
  records: OpePerRecord[];
  reasons: string[];
}

/**
 * PURE — build the advisory OPE report over declined drafts.
 */
export function buildOpeReport(declined: readonly DeclinedDraftEvidence[]): OpeReport {
  const records: OpePerRecord[] = declined.map((d) => {
    const reasons: string[] = [];
    const costFrac = declaredRoundTripCostFrac(d.assetClass);
    let net: number | null = null;
    let resolution: OpePerRecord["resolution"] = "UNRESOLVED";
    if (d.resolvedGrossLogReturn !== null && Number.isFinite(d.resolvedGrossLogReturn)) {
      net = netOfDeclaredCosts(d.resolvedGrossLogReturn, d.assetClass);
      resolution = "RESOLVED";
      reasons.push(`resolved from recorded evidence; declared round-trip cost ${costFrac.toFixed(6)} subtracted`);
    } else {
      reasons.push("UNRESOLVED: no recorded evidence resolves this counterfactual — excluded from the estimate, not imputed");
    }
    if (d.maxLossUsd === null) {
      reasons.push("no derivable loss bound (incomplete plan) — bounds honestly null");
    }
    return {
      draftId: d.draftId,
      strategyId: d.strategyId,
      symbol: d.symbol,
      declineStatus: d.declineStatus,
      bounds: { maxLossUsd: d.maxLossUsd, maxGainUsd: d.maxGainUsd },
      costFrac,
      counterfactualNetLogReturn: net,
      resolution,
      reasons,
    };
  });

  const resolved = records.filter((r) => r.resolution === "RESOLVED");
  const mean =
    resolved.length > 0
      ? resolved.reduce((s, r) => s + (r.counterfactualNetLogReturn ?? 0), 0) / resolved.length
      : null;

  return {
    kind: "FLYWHEEL_OPE_DECLINED_TRADES",
    advisory: true,
    authority: "NONE",
    estimate: {
      method: "MEAN_OF_RESOLVED_COUNTERFACTUALS_NET_OF_DECLARED_COSTS",
      meanCounterfactualNetLogReturn: mean,
      resolvedCount: resolved.length,
      unresolvedCount: records.length - resolved.length,
      totalDeclined: records.length,
    },
    records,
    reasons: [
      "advisory record only — carries zero authority and gates nothing",
      "unresolved counterfactuals are excluded and counted, never imputed",
    ],
  };
}
