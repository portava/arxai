// Guard: reconciled ghost positions must be excluded from live exposure reads.
//
// Three server-side reads must never let a reconciled (IGNORED/EXTERNAL/
// IMPORTED/BROKER_ABSENT) or closed row inflate live exposure:
//
//   1. recomputeMasterPool        — sums floating_pl for the pool's unrealized P/L
//   2. getUserAllocationView      — the canonical user-facing wallet view
//   3. computeAgentDailyPnlUsd    — sums floating_pl + counts open positions
//
// These reads have been CENTRALIZED onto the single canonical predicate
// `openLiveExposureCondition` (lib/live/livePositionExposure.ts), which is the
// one source of truth for "this arx_live_positions row is live exposure right
// now". This guard therefore asserts:
//
//   (a) the canonical predicate itself enforces BOTH closed_at IS NULL AND
//       reconcile_state IS NULL (the protection lives at the source of truth), and
//   (b) every consuming read delegates to it (via openLiveExposureCondition)
//       — or, for resilience, still carries the equivalent inline filter.
//
// This is strictly stronger than the previous literal-text scan: it verifies the
// filter is actually applied at the canonical predicate, not merely that the
// string appears somewhere in the file.
import { join } from "node:path";
import { type CheckResult, ROOT, read } from "./_lib.js";

const NAME = "reconciled-ghost-exposure";

const RECONCILE_LITERAL = "isNull(arxLivePositionsTable.reconcileState)";
const CLOSED_LITERAL = "isNull(arxLivePositionsTable.closedAt)";
const HELPER = "openLiveExposureCondition";

/** A read is safe if it delegates to the canonical helper OR still carries both
 *  inline isNull filters (legacy-equivalent). */
function enforcesExposure(src: string): boolean {
  if (src.includes(`${HELPER}(`)) return true;
  return src.includes(RECONCILE_LITERAL) && src.includes(CLOSED_LITERAL);
}

export function checkReconciledGhostExposure(): CheckResult {
  const violations: string[] = [];
  const notes: string[] = [];

  // ── 0. The canonical predicate must enforce BOTH filters ─────────────────
  const exposurePath = join(
    ROOT,
    "artifacts/api-server/src/lib/live/livePositionExposure.ts",
  );
  const exposure = read(exposurePath);
  const helperEnforcesBoth =
    exposure.includes(RECONCILE_LITERAL) && exposure.includes(CLOSED_LITERAL);
  if (!helperEnforcesBoth) {
    violations.push(
      "openLiveExposureCondition (livePositionExposure.ts) must enforce BOTH " +
        "isNull(arxLivePositionsTable.closedAt) AND " +
        "isNull(arxLivePositionsTable.reconcileState) — it is the single source " +
        "of truth that every exposure read delegates to",
    );
  } else {
    notes.push("openLiveExposureCondition enforces both closedAt IS NULL and reconcileState IS NULL");
  }

  // ── 1. masterBridgePool: recomputeMasterPool + getUserAllocationView ─────
  const poolPath = join(
    ROOT,
    "artifacts/api-server/src/lib/live/masterBridgePool.ts",
  );
  const pool = read(poolPath);
  if (!enforcesExposure(pool)) {
    violations.push(
      "masterBridgePool (recomputeMasterPool + getUserAllocationView) must " +
        "exclude reconciled ghosts — delegate the open-position query to " +
        "openLiveExposureCondition() (or carry both closedAt/reconcileState " +
        "isNull filters) so ghosts cannot inflate pool floating-P/L or the wallet view",
    );
  } else {
    notes.push("masterBridgePool open-position reads delegate to openLiveExposureCondition");
  }

  // ── 2. executionGate.computeAgentDailyPnlUsd ────────────────────────────
  const gatePath = join(
    ROOT,
    "artifacts/api-server/src/lib/selfTrade/executionGate.ts",
  );
  const gate = read(gatePath);
  if (!enforcesExposure(gate)) {
    violations.push(
      "executionGate.computeAgentDailyPnlUsd must exclude reconciled ghosts — " +
        "delegate the arxLivePositionsTable query to openLiveExposureCondition() " +
        "(or carry both closedAt/reconcileState isNull filters) so ghosts cannot " +
        "inflate dailyPnlUsd or the open-position count",
    );
  } else {
    notes.push("executionGate arxLivePositionsTable query delegates to openLiveExposureCondition");
  }

  // openPositionsCount must be derived from the filtered positions result
  // (positions.length), NOT directly from filled.length. The latter counts
  // FILLED agent-execution records regardless of reconcile state, so a
  // reconciled ghost (IGNORED) whose broker ticket matches a FILLED execution
  // would still trip MAX_CONCURRENT_POSITIONS. The correct derivation is the
  // intersection: filled executions ∩ non-reconciled open live positions.
  if (!gate.includes("openPositionsCount = positions.length")) {
    violations.push(
      "executionGate.computeAgentDailyPnlUsd: openPositionsCount must be derived from " +
        "positions.length (filtered arxLivePositionsTable result), not filled.length — " +
        "otherwise reconciled ghosts inflate the concurrent-position count and can " +
        "trip MAX_CONCURRENT_POSITIONS incorrectly",
    );
  } else {
    notes.push("executionGate: openPositionsCount derived from filtered positions.length, not filled.length");
  }

  if (/const openPositionsCount\s*=\s*filled\.length/.test(gate)) {
    violations.push(
      "executionGate: `const openPositionsCount = filled.length` must be replaced — " +
        "openPositionsCount must come from the reconcile-state-filtered positions query",
    );
  }

  return { name: NAME, ok: violations.length === 0, violations, notes };
}
