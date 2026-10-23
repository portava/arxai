// ── Cluster exposure guard: pure evaluator (R3 slice 6, spec check 20) ──────
//
// Pure function over caller-supplied state — no IO, no DB, no clock. The
// wave-4 integrator wires this into the live dispatch pre-gates
// (liveCommandPipeline.ts is out of scope for this module's wave).
//
// Clustering contract:
//   - A cluster is (risk family × direction). Same-family SAME-direction
//     positions cluster with the candidate.
//   - Opposite-direction same-family positions give NO offset credit: netting
//     assumptions are venue-specific (hedging mode, margin netting, swap
//     treatment differ per broker), so risk is counted as ABSOLUTE per
//     direction and a hedge never reduces cluster risk. It is also not added
//     to this cluster — it belongs to the opposite-direction cluster, which is
//     evaluated when an order in that direction is the candidate.
//   - An unknown-family candidate clusters only with open positions in the
//     SAME symbol (per-symbol unknown families; see riskFamilies.ts — unknown
//     correlation must not create capacity, spec check 20).
//
// Cap semantics:
//   - null cap = no cap, matching the existing unset semantics of the
//     nullable per-user daily-loss / exposure caps (audit-risk.md check 18:
//     "nullable ⇒ no cap when unset").
//   - 0 is a REAL cap of zero (blocks everything), never "unlimited" — the
//     0-as-unlimited trap called out for check 19 is not reproduced here.
//   - PRODUCTION CAP VALUES ARE AN OWNER DECISION. This module ships no
//     defaults: the audit's standing note is "Risk limits still need
//     owner-approved production values". Callers must source caps from
//     owner-approved config and may pass null only where the owner has
//     explicitly left the dimension uncapped.
//   - A malformed cap (negative, NaN, non-integer position count) REFUSES
//     rather than degrading to "no cap" — fail closed.
//
// Input validation is fail-closed: a corrupt candidate OR a corrupt open
// position row (empty symbol, unrecognised side, non-finite risk) refuses the
// dispatch instead of being skipped, because skipping a row silently creates
// capacity.

import { resolveRiskFamily } from "./riskFamilies";

export type ClusterSide = "BUY" | "SELL";

export interface ClusterPositionInput {
  symbol: string;
  /** "BUY"/"SELL" (case-insensitive; "LONG"/"SHORT" accepted as synonyms). */
  side: string;
  /** Risk in the caller's single consistent unit (currency risk preferred;
   *  lots acceptable if every row uses lots). Counted as absolute value. */
  riskAmount: number;
  /** Optional ArxAssetClass value; sharpens family resolution when known. */
  assetClass?: string;
}

export interface ClusterExposureInput {
  candidate: ClusterPositionInput;
  openPositions: ClusterPositionInput[];
  /** null = no cap (unset). 0 = zero capacity. Owner-approved values only. */
  maxClusterRisk: number | null;
  /** null = no cap (unset). 0 = zero capacity. Owner-approved values only. */
  maxClusterPositions: number | null;
}

export interface ClusterExposureResult {
  allowed: boolean;
  /** "<family>|<side>", e.g. "fx:usd-bloc|BUY". Empty when the candidate was
   *  refused before a cluster could be resolved. */
  clusterKey: string;
  /** Absolute clustered risk INCLUDING the candidate. */
  clusterRisk: number;
  /** Clustered position count INCLUDING the candidate. */
  clusterCount: number;
  reason?: string;
}

export const CLUSTER_RISK_EXCEEDED = "CLUSTER_RISK_EXCEEDED";
export const CLUSTER_POSITIONS_EXCEEDED = "CLUSTER_POSITIONS_EXCEEDED";
export const CANDIDATE_INVALID = "CANDIDATE_INVALID";
export const OPEN_POSITION_INVALID = "OPEN_POSITION_INVALID";
export const CLUSTER_CAP_INVALID = "CLUSTER_CAP_INVALID";

function normalizeSide(side: string): ClusterSide | null {
  const s = typeof side === "string" ? side.trim().toUpperCase() : "";
  if (s === "BUY" || s === "LONG") return "BUY";
  if (s === "SELL" || s === "SHORT") return "SELL";
  return null;
}

function isValidRisk(riskAmount: number): boolean {
  return typeof riskAmount === "number" && Number.isFinite(riskAmount);
}

function isValidSymbol(symbol: string): boolean {
  return typeof symbol === "string" && symbol.trim().length > 0;
}

function riskCapValid(cap: number | null): boolean {
  return cap === null || (Number.isFinite(cap) && cap >= 0);
}

function positionsCapValid(cap: number | null): boolean {
  return cap === null || (Number.isInteger(cap) && cap >= 0);
}

function refused(reason: string, clusterKey = ""): ClusterExposureResult {
  return { allowed: false, clusterKey, clusterRisk: 0, clusterCount: 0, reason };
}

export function evaluateClusterExposure(
  input: ClusterExposureInput,
): ClusterExposureResult {
  const { candidate, openPositions, maxClusterRisk, maxClusterPositions } = input;

  if (
    !isValidSymbol(candidate.symbol) ||
    normalizeSide(candidate.side) === null ||
    !isValidRisk(candidate.riskAmount)
  ) {
    return refused(CANDIDATE_INVALID);
  }
  if (!riskCapValid(maxClusterRisk) || !positionsCapValid(maxClusterPositions)) {
    return refused(CLUSTER_CAP_INVALID);
  }

  const candidateSide = normalizeSide(candidate.side) as ClusterSide;
  const candidateFamily = resolveRiskFamily(
    candidate.symbol,
    candidate.assetClass,
  ).family;
  const clusterKey = `${candidateFamily}|${candidateSide}`;

  let clusterRisk = Math.abs(candidate.riskAmount);
  let clusterCount = 1;

  for (const position of openPositions) {
    const side = normalizeSide(position.side);
    if (
      !isValidSymbol(position.symbol) ||
      side === null ||
      !isValidRisk(position.riskAmount)
    ) {
      return refused(OPEN_POSITION_INVALID, clusterKey);
    }
    const family = resolveRiskFamily(position.symbol, position.assetClass).family;
    if (family === candidateFamily && side === candidateSide) {
      clusterRisk += Math.abs(position.riskAmount);
      clusterCount += 1;
    }
  }

  if (maxClusterRisk !== null && clusterRisk > maxClusterRisk) {
    return {
      allowed: false,
      clusterKey,
      clusterRisk,
      clusterCount,
      reason: CLUSTER_RISK_EXCEEDED,
    };
  }
  if (maxClusterPositions !== null && clusterCount > maxClusterPositions) {
    return {
      allowed: false,
      clusterKey,
      clusterRisk,
      clusterCount,
      reason: CLUSTER_POSITIONS_EXCEEDED,
    };
  }
  return { allowed: true, clusterKey, clusterRisk, clusterCount };
}
