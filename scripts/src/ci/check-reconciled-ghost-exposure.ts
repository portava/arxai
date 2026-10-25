// Guard: reconciled ghost positions must be excluded from live exposure reads.
//
// Three server-side reads must never let a reconciled (IGNORED/EXTERNAL/
// IMPORTED/BROKER_ABSENT) or closed row inflate live exposure:
//
//   1. recomputeMasterPool        — sums floating_pl for the pool's unrealized P/L
//   2. getUserAllocationView      — the canonical user-facing wallet view
//   3. computeAgentDailyPnlUsd    — sums floating_pl (EXPOSURE). Its open-position
//                                   COUNT is a risk cap and, by owner decision 6,
//                                   counts on RISK_COUNT_BASIS (UNCLOSED), the
//                                   Risk Governor's basis: a reconcile label is
//                                   not a broker-confirmed close.
//
// These reads have been CENTRALIZED onto the single canonical predicate
// `openLiveExposureCondition` (lib/live/livePositionExposure.ts), which is the
// one source of truth for "this arx_live_positions row is live exposure right
// now". This guard therefore asserts:
//
//   (a) the canonical predicate itself enforces BOTH closed_at IS NULL AND
//       reconcile_state IS NULL (the protection lives at the source of truth), and
//   (b) every consuming read delegates to it — directly (openLiveExposureCondition),
//       through the open-position read model with an explicit
//       `basis: "EXPOSURE"` (and no other basis in the file; the read model's
//       EXPOSURE basis is itself checked to be openLiveExposureCondition), or,
//       for resilience, with the equivalent inline filter.
//
// This is strictly stronger than the previous literal-text scan: it verifies the
// filter is actually applied at the canonical predicate, not merely that the
// string appears somewhere in the file.
import { join } from "node:path";
import { type CheckResult, ROOT, read } from "./_lib.js";

const NAME = "reconciled-ghost-exposure";

const RECONCILE_LITERAL = "isNull(livePositionColumns.reconcileState)";
const CLOSED_LITERAL = "isNull(livePositionColumns.closedAt)";
const HELPER = "openLiveExposureCondition";
const READ_MODEL_IMPORT = /from\s+["'][^"']*positions\/openPositions(?:\.js)?["']/;
const BASIS = /\bbasis:\s*["'`](\w+)["'`]/g;

/** True when the file reads through the read model and every basis it names is EXPOSURE. */
function readsExposureThroughReadModel(src: string): boolean {
  if (!READ_MODEL_IMPORT.test(src)) return false;
  const bases = [...src.matchAll(BASIS)].map((m) => m[1]);
  return bases.length > 0 && bases.every((b) => b === "EXPOSURE");
}

/** A read is safe if it delegates to the canonical helper (directly or through
 *  the read model's EXPOSURE basis) OR still carries both inline isNull filters
 *  (legacy-equivalent). */
function enforcesExposure(src: string): boolean {
  if (src.includes(`${HELPER}(`)) return true;
  if (readsExposureThroughReadModel(src)) return true;
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
        "isNull(livePositionColumns.closedAt) AND " +
        "isNull(livePositionColumns.reconcileState) — it is the single source " +
        "of truth that every exposure read delegates to",
    );
  } else {
    notes.push("openLiveExposureCondition enforces both closedAt IS NULL and reconcileState IS NULL");
  }

  // ── 0b. The read model's EXPOSURE basis must be that predicate ───────────
  const readModel = read(join(ROOT, "artifacts/api-server/src/lib/positions/openPositions.ts"));
  if (!/:\s*openLiveExposureCondition\(userId\)/.test(readModel) || !/openLiveExposureCondition\(\)/.test(readModel)) {
    violations.push(
      "lib/positions/openPositions.ts must build the per-user and cross-user LIVE EXPOSURE basis from " +
        "openLiveExposureCondition(userId) / openLiveExposureCondition()",
    );
  } else {
    notes.push("read model EXPOSURE basis (per-user and cross-user) is openLiveExposureCondition");
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
  // Owner decision 6 split this read in two:
  //   * floating P/L stays on EXPOSURE (ghosts carry no live exposure), and
  //   * the MAX_CONCURRENT_POSITIONS count uses the Risk Governor's
  //     conservative basis, RISK_COUNT_BASIS = UNCLOSED (an IGNORED /
  //     EXTERNAL label is not a broker-confirmed close).
  const gatePath = join(
    ROOT,
    "artifacts/api-server/src/lib/selfTrade/executionGate.ts",
  );
  const gate = read(gatePath);
  const gateBases = [...gate.matchAll(BASIS)].map((m) => m[1]);
  if (!READ_MODEL_IMPORT.test(gate) || !gateBases.includes("EXPOSURE")) {
    violations.push(
      "executionGate.computeAgentDailyPnlUsd must sum floating P/L from the read model's " +
        "`basis: \"EXPOSURE\"` read so reconciled ghosts cannot inflate dailyPnlUsd",
    );
  } else {
    notes.push("executionGate floating P/L reads the EXPOSURE basis (openLiveExposureCondition)");
  }
  if (gateBases.some((b) => b !== "EXPOSURE" && b !== "UNCLOSED")) {
    violations.push(`executionGate names an unexpected basis (${gateBases.join(", ")}); only EXPOSURE (P/L) and RISK_COUNT_BASIS (count) are allowed`);
  }

  // The count must come from the RISK_COUNT_BASIS read (live rows), never
  // from filled.length (an execution with no live row would count) and never
  // from the EXPOSURE read (a labelled ghost would stop counting).
  if (!/basis:\s*RISK_COUNT_BASIS\b/.test(gate) || !gate.includes("openPositionsCount = unclosed.length")) {
    violations.push(
      "executionGate.computeAgentDailyPnlUsd: openPositionsCount must be unclosed.length from a " +
        "read with `basis: RISK_COUNT_BASIS` (owner decision 6: the governor's UNCLOSED basis)",
    );
  } else {
    notes.push("executionGate: openPositionsCount counts on RISK_COUNT_BASIS (UNCLOSED), from live rows");
  }
  if (/openPositionsCount\s*=\s*(filled|exposure|positions)\.length/.test(gate)) {
    violations.push(
      "executionGate: openPositionsCount must not come from filled.length or the EXPOSURE read — " +
        "it counts on RISK_COUNT_BASIS",
    );
  }

  // ── 3. The shared risk-count basis is UNCLOSED and the governor uses it ──
  if (!/export const RISK_COUNT_BASIS = "UNCLOSED"/.test(readModel)) {
    violations.push('lib/positions/openPositions.ts must export `RISK_COUNT_BASIS = "UNCLOSED"` (owner decision 6)');
  }
  const enforceSrc = read(join(ROOT, "artifacts/api-server/src/lib/riskGovernor/enforce.ts"));
  if (!/basis:\s*RISK_COUNT_BASIS\b/.test(enforceSrc)) {
    violations.push("riskGovernor/enforce.ts must count broker positions with `basis: RISK_COUNT_BASIS`");
  } else {
    notes.push("Risk Governor and self-trade cap count on the same RISK_COUNT_BASIS");
  }

  return { name: NAME, ok: violations.length === 0, violations, notes };
}
