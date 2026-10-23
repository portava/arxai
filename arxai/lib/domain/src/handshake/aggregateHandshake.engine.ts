// ── ARX Handshake System — aggregation engine (pure) ────────────────────────
//
// Collapses a set of per-layer checks into a single ADVISORY verdict plus the
// shared standard-result fields (safeToProceed, freshness, user/admin
// messaging). Deterministic and IO-free. It NEVER gates execution; the verdict
// is a hint.

import type {
  HandshakeFreshness,
  HandshakeLayerCheck,
  HandshakeOverallStatus,
  HandshakeReadinessStatus,
} from "./handshake.types";

export interface HandshakeAggregate {
  overallStatus: HandshakeOverallStatus;
  safeToProceed: boolean;
  blockers: string[];
  warnings: string[];
}

function labelFor(c: HandshakeLayerCheck): string {
  return c.detail ? `${c.layer}:${c.status} (${c.detail})` : `${c.layer}:${c.status}`;
}

/**
 * Aggregate per-layer checks into an advisory verdict.
 *
 * Rules (advisory only — never a real gate):
 * - SKIPPED / PASS                       → no contribution.
 * - REQUIRED FAIL or NOT_AVAILABLE       → blocker → BLOCK.
 * - REQUIRED WARN                        → warning.
 * - OPTIONAL non-PASS (not SKIPPED)      → warning.
 * - At least one non-SKIPPED PASS, no
 *   blockers/warnings                    → PASS.
 * - No checks / all SKIPPED              → UNKNOWN (honest; never a fabricated PASS).
 */
export function aggregateHandshake(checks: readonly HandshakeLayerCheck[]): HandshakeAggregate {
  const blockers: string[] = [];
  const warnings: string[] = [];
  let sawEvaluable = false;

  for (const c of checks) {
    if (c.status === "SKIPPED") continue;
    sawEvaluable = true;
    if (c.status === "PASS") continue;
    const label = labelFor(c);
    if (c.required && (c.status === "FAIL" || c.status === "NOT_AVAILABLE")) {
      blockers.push(label);
    } else {
      warnings.push(label);
    }
  }

  let overallStatus: HandshakeOverallStatus;
  if (!sawEvaluable) overallStatus = "UNKNOWN";
  else if (blockers.length > 0) overallStatus = "BLOCK";
  else if (warnings.length > 0) overallStatus = "WARN";
  else overallStatus = "PASS";

  const safeToProceed = blockers.length === 0 && overallStatus !== "UNKNOWN";

  return { overallStatus, safeToProceed, blockers, warnings };
}

/** Summarize freshness across the per-layer checks (advisory only). */
export function summarizeFreshness(
  checks: readonly HandshakeLayerCheck[],
  evaluatedAt: string,
): HandshakeFreshness {
  let oldestSignalAgeMs: number | null = null;
  let hasStaleSignal = false;
  for (const c of checks) {
    if (c.ageMs != null) {
      oldestSignalAgeMs = oldestSignalAgeMs == null ? c.ageMs : Math.max(oldestSignalAgeMs, c.ageMs);
      if (c.status === "WARN" || c.status === "FAIL") hasStaleSignal = true;
    }
  }
  return { evaluatedAt, oldestSignalAgeMs, hasStaleSignal };
}

/**
 * Derive the richer, user-meaningful readiness verdict from the per-layer
 * checks + the 4-value aggregate + freshness. Pure, deterministic, advisory.
 *
 * Precedence (most-severe / most-specific first):
 * 1. Nothing evaluable (no checks, or all SKIPPED)        → ERROR (honest).
 * 2. A REQUIRED layer FAIL                                → BLOCKED.
 * 3. A REQUIRED layer NOT_AVAILABLE                       → WAITING_FOR_DATA.
 * 4. A REQUIRED layer WARN whose age exceeds STALENESS_BUDGET_MS → STALE.
 * 5. Any other REQUIRED layer WARN (fresh age, or no age —       → DEGRADED.
 *    impaired but not genuinely behind)
 * 6. Only OPTIONAL layers non-PASS                        → READY_WITH_WARNINGS.
 * 7. Otherwise                                            → READY.
 *
 * Honesty note: a WARN is only reported as STALE when its data is genuinely
 * behind (age > STALENESS_BUDGET_MS). A WARN that merely carries a (fresh) age —
 * e.g. a current quote that is missing tradable specs — is DEGRADED, never
 * STALE, so the "Late — do not chase" copy is never shown for fresh data.
 *
 * BLOCKED is an advisory "do not proceed" hint only. The authoritative stop for
 * any execution-critical surface is ALWAYS the 16-gate live pipeline.
 */
const STALENESS_BUDGET_MS = 60_000;

export function deriveReadinessStatus(
  checks: readonly HandshakeLayerCheck[],
  agg: HandshakeAggregate,
  _freshness: HandshakeFreshness,
): HandshakeReadinessStatus {
  const evaluable = checks.filter((c) => c.status !== "SKIPPED");
  if (evaluable.length === 0 || agg.overallStatus === "UNKNOWN") return "ERROR";

  if (evaluable.some((c) => c.required && c.status === "FAIL")) return "BLOCKED";
  if (evaluable.some((c) => c.required && c.status === "NOT_AVAILABLE")) return "WAITING_FOR_DATA";
  if (evaluable.some((c) => c.required && c.status === "WARN" && c.ageMs != null && c.ageMs > STALENESS_BUDGET_MS))
    return "STALE";
  if (evaluable.some((c) => c.required && c.status === "WARN")) return "DEGRADED";
  if (evaluable.some((c) => !c.required && c.status !== "PASS")) return "READY_WITH_WARNINGS";
  return "READY";
}

/**
 * Generic, user-safe message for a verdict. Deliberately contains NO internal
 * wording (no layer keys, provider names, or operator reasons). Operators read
 * `adminDetails` for the specifics.
 */
export function buildUserFacingMessage(overallStatus: HandshakeOverallStatus): string {
  switch (overallStatus) {
    case "PASS":
      return "All systems are ready.";
    case "WARN":
      return "Running with reduced confidence — some inputs are limited right now.";
    case "BLOCK":
      return "Some required data isn't ready yet. Please try again shortly.";
    case "UNKNOWN":
    default:
      return "Status is unavailable right now.";
  }
}

/** Operator-facing detail string (admin monitor only). */
export function buildAdminDetails(blockers: readonly string[], warnings: readonly string[]): string {
  const parts: string[] = [];
  if (blockers.length > 0) parts.push(`blockers: ${blockers.join("; ")}`);
  if (warnings.length > 0) parts.push(`warnings: ${warnings.join("; ")}`);
  return parts.length > 0 ? parts.join(" | ") : "no blockers or warnings";
}
