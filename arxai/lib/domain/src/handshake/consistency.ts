// ── ARX Handshake System — cross-layer consistency helpers (pure) ───────────
//
// A cross-layer flow often depends on several layers/components referencing the
// SAME context identifier — e.g. the selected symbol on the chart bus, the
// scanner, and the trade ticket should all agree before a flow proceeds. These
// helpers check that agreement and emit an ADVISORY verdict.
//
// INVIOLABLE: advisory only. A divergence verdict is a hint for the operator /
// caller — it NEVER gates, blocks, or alters any execution path, the 16-gate
// pipeline, the scanner, Ruby, the chart, or the trade modal. HONEST: when no
// value can be read the verdict is UNKNOWN, never a fabricated CONSISTENT.
//
// Pure: no IO, no DB, no HTTP.

import type { HandshakeOverallStatus } from "./handshake.types";

export const CONSISTENCY_DOMAINS = [
  "SELECTED_SYMBOL",
  "SIGNAL",
  "INVESTOR",
  "ADMIN",
  // Chart symbol/timeframe agreement across chart bus / overlay / intelligence.
  "CHART",
  // Trade-ticket prefill agreement across symbol bus / preview / ticket.
  "TRADE_PREVIEW",
  // Open live position identity across attribution / live position / command.
  "LIVE_POSITION",
] as const;
export type ConsistencyDomain = (typeof CONSISTENCY_DOMAINS)[number];

export const CONSISTENCY_STATUSES = ["CONSISTENT", "DIVERGENT", "UNKNOWN"] as const;
export type ConsistencyStatus = (typeof CONSISTENCY_STATUSES)[number];

// One layer's view of the shared context value.
export interface ConsistencyRef {
  // Which layer/component reported this value (operator-facing, no secrets).
  source: string;
  // The identifier this source believes is current. null/empty = "no opinion".
  value: string | null | undefined;
}

export interface ConsistencyMismatch {
  value: string;
  sources: string[];
}

export interface ConsistencyResult {
  domain: ConsistencyDomain;
  status: ConsistencyStatus;
  // Whether divergence in this domain should be treated as advisory-BLOCK.
  required: boolean;
  // Distinct normalized non-null values observed (>1 ⇒ divergent).
  values: string[];
  // The sources backing each distinct value (only populated when divergent).
  mismatches: ConsistencyMismatch[];
}

interface CheckOptions {
  // Divergence on a required domain maps to advisory BLOCK; otherwise WARN.
  required?: boolean;
  // Normalizer applied to each value before comparison (e.g. upper-case symbol).
  normalize?: (value: string) => string;
}

function defaultNormalize(value: string): string {
  return value.trim();
}

/**
 * Generic cross-layer consistency check. Refs with a null/empty value are
 * ignored ("no opinion"). With no non-null refs the result is UNKNOWN (honest).
 * One distinct value ⇒ CONSISTENT. More than one ⇒ DIVERGENT.
 */
export function checkConsistency(
  domain: ConsistencyDomain,
  refs: readonly ConsistencyRef[],
  options: CheckOptions = {},
): ConsistencyResult {
  const required = options.required ?? true;
  const normalize = options.normalize ?? defaultNormalize;

  // Group sources by normalized value, ignoring empty/null opinions.
  const bySource = new Map<string, string[]>();
  for (const ref of refs) {
    if (ref.value === null || ref.value === undefined) continue;
    const trimmed = String(ref.value).trim();
    if (trimmed.length === 0) continue;
    const norm = normalize(trimmed);
    const sources = bySource.get(norm) ?? [];
    sources.push(ref.source);
    bySource.set(norm, sources);
  }

  const values = Array.from(bySource.keys());

  if (values.length === 0) {
    return { domain, status: "UNKNOWN", required, values: [], mismatches: [] };
  }
  if (values.length === 1) {
    return { domain, status: "CONSISTENT", required, values, mismatches: [] };
  }

  const mismatches: ConsistencyMismatch[] = values.map((value) => ({
    value,
    sources: bySource.get(value) ?? [],
  }));
  return { domain, status: "DIVERGENT", required, values, mismatches };
}

/** Map a consistency result to an advisory handshake overall status. */
export function consistencyToOverall(result: ConsistencyResult): HandshakeOverallStatus {
  switch (result.status) {
    case "CONSISTENT":
      return "PASS";
    case "DIVERGENT":
      return result.required ? "BLOCK" : "WARN";
    case "UNKNOWN":
    default:
      return "UNKNOWN";
  }
}

// ── Typed per-domain wrappers ───────────────────────────────────────────────

/** Selected trading symbol across the chart bus / scanner / trade ticket. */
export function checkSelectedSymbolConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("SELECTED_SYMBOL", refs, {
    required: true,
    normalize: (v) => v.toUpperCase(),
  });
}

/** Signal identity across the scanner / explanation / trade flow. */
export function checkSignalConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("SIGNAL", refs, { required: true });
}

/** Investor identity across the fund book / statement / portal views. */
export function checkInvestorConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("INVESTOR", refs, { required: true });
}

/** Admin actor / operating context across admin surfaces. */
export function checkAdminConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("ADMIN", refs, { required: true });
}

/** Chart symbol agreement across the chart bus / overlay / intelligence read. */
export function checkChartConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("CHART", refs, {
    required: true,
    normalize: (v) => v.toUpperCase(),
  });
}

/** Trade-ticket prefill agreement across the symbol bus / preview / ticket. */
export function checkTradePreviewConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("TRADE_PREVIEW", refs, {
    required: true,
    normalize: (v) => v.toUpperCase(),
  });
}

/** Open live position identity across attribution / live position / command. */
export function checkLivePositionConsistency(refs: readonly ConsistencyRef[]): ConsistencyResult {
  return checkConsistency("LIVE_POSITION", refs, { required: true });
}
