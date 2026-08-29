// Capability #32 — the per-subsystem DEGRADED-MODE MATRIX, as a contract.
//
// The platform already fails closed per-subsystem, but the behavior lived in
// scattered mechanisms (dispatch gates, watchdogs, freshness pre-gates). This
// file DECLARES the matrix — one row per subsystem outage, each naming the
// detection mechanism that already exists, the execution posture the outage
// imposes, and the recovery condition — plus a pure evaluator so fixtures can
// chaos-test every row offline.
//
// CONTRACT RULES (test-pinned):
//   * Every subsystem in SUBSYSTEMS has exactly one row.
//   * No row leaves `newExposureAllowed: true` while its posture is
//     CLOSE_ONLY or NONE (risk uncertainty stops NEW exposure, never
//     protective management).
//   * Composition is strictest-wins: two simultaneous outages can never
//     produce a looser posture than either alone.
//   * An outage of an UNKNOWN subsystem fails closed to NONE — an unmodeled
//     failure is treated as the worst one.
//   * This matrix is a CONTRACT over existing enforcement, not a new
//     enforcement point: each row's `enforcedBy` names the real mechanism.
//     Changing a row here does not change runtime behavior — it changes what
//     the tests hold the runtime to. Divergence is a test failure, not a
//     silent re-declaration.

import type { ExecutionPermission } from "../global-state/globalState.engine.js";

// ── Subsystems ───────────────────────────────────────────────────────────────

export const SUBSYSTEMS = [
  "BROKER",          // venue itself (MT5 server / Deriv API)
  "DATA_FEED",       // market data (quotes/candles staleness)
  "BRIDGE",          // EA bridge / transport between us and the venue
  "RUBY",            // Ruby signal/quality intelligence
  "MODEL",           // learned models (learning versions, calibration)
  "RECONCILIATION",  // position/order reconciliation lane
  "DATABASE",        // our own Postgres
] as const;
export type Subsystem = (typeof SUBSYSTEMS)[number];

export function isSubsystem(s: string): s is Subsystem {
  return (SUBSYSTEMS as readonly string[]).includes(s);
}

// ── Matrix rows ──────────────────────────────────────────────────────────────

export interface DegradedModeRow {
  subsystem: Subsystem;
  /** What "out" means for this subsystem. */
  outageSignal: string;
  /** The EXISTING mechanism that detects it (file-level, so audits can walk
   *  straight to the code). */
  detectedBy: string;
  /** The EXISTING mechanism that enforces the posture. */
  enforcedBy: string;
  /** Execution posture the outage imposes (vocabulary shared with the
   *  global-state profiles). */
  posture: ExecutionPermission;
  /** May NEW exposure be opened during this outage? (Protective closes and
   *  exits are governed by `posture`, not this flag.) */
  newExposureAllowed: boolean;
  /** What still runs, honestly. */
  degradedBehavior: string;
  /** What ends the degradation. */
  recoveryCondition: string;
}

/** Posture strictness for strictest-wins composition. */
const POSTURE_RANK: Record<ExecutionPermission, number> = {
  NONE: 0,
  CLOSE_ONLY: 1,
  REDUCED: 2,
  FULL: 3,
};

export function stricterPosture(a: ExecutionPermission, b: ExecutionPermission): ExecutionPermission {
  return POSTURE_RANK[a] <= POSTURE_RANK[b] ? a : b;
}

export const DEGRADED_MODE_MATRIX: readonly DegradedModeRow[] = [
  {
    subsystem: "BROKER",
    outageSignal: "Venue unreachable / rejecting; MT5 disconnect; Deriv transport down.",
    detectedBy: "artifacts/api-server/src/lib/safetyCore.ts (MT5 disconnect → DEGRADED_MODE) + broker-health engines (lib/domain/src/broker-health)",
    enforcedBy: "livePhaseBDispatchGate broker/connection gates + safetyCore per-state allowed-function lists + systemHealth.engine FREEZE_LIVE_TRADING_UNTIL_BROKER_RECOVERS",
    posture: "CLOSE_ONLY",
    newExposureAllowed: false,
    degradedBehavior: "No new orders; protective management and close attempts continue through whatever transport still answers; positions surfaced as UNVERIFIED, never guessed closed.",
    recoveryCondition: "Venue heartbeat restored and reconciliation confirms position truth; re-entry to live authority is metered by recovery probation (#34), not instant.",
  },
  {
    subsystem: "DATA_FEED",
    outageSignal: "Quote/candle staleness beyond threshold; feed gap.",
    detectedBy: "artifacts/api-server/src/lib/data/mt5FeedStalenessWatchdogCore.ts + chart stall detection",
    enforcedBy: "data-staleness dispatch gate (EA_HEARTBEAT_STALE / quoteFresh signals in the gate wall) — stale data refuses NEW dispatch",
    posture: "CLOSE_ONLY",
    newExposureAllowed: false,
    degradedBehavior: "No new entries priced off stale data; existing protective orders live at the BROKER and keep working; UI labels data as stale rather than repainting.",
    recoveryCondition: "Feed freshness back under threshold for a full evaluation window.",
  },
  {
    subsystem: "BRIDGE",
    outageSignal: "EA bridge heartbeat stale; command claims stop; leader conflict.",
    detectedBy: "artifacts/api-server/src/lib/live/bridgeWatchdog.ts (liveness/condition classifier, leader-conflict detection) + stuckCommandWatchdog",
    enforcedBy: "EA_HEARTBEAT_STALE gate + stuck-command expiry (commands go 'expired'/'unknown', never silently assumed executed) + unknownReconcilerWorker",
    posture: "CLOSE_ONLY",
    newExposureAllowed: false,
    degradedBehavior: "Queued commands expire honestly; in-flight commands resolve to UNKNOWN pending venue evidence (never synthesized to success/failure); broker-side protective orders remain armed.",
    recoveryCondition: "Bridge heartbeat restored AND the unknown reconciler has resolved in-flight commands against venue truth.",
  },
  {
    subsystem: "RUBY",
    outageSignal: "Ruby signal/quality intelligence erroring or unavailable.",
    detectedBy: "rubyQuality service errors surface as absent/failed quality reads (artifacts/api-server/src/lib/rubyQuality)",
    enforcedBy: "Default-deny composition: a dispatch that requires a quality read refuses on an unreadable read (typed reason), and advisory Ruby surfaces degrade to honest 'unavailable' — never a synthesized score",
    posture: "CLOSE_ONLY",
    newExposureAllowed: false,
    degradedBehavior: "Signals that depend on Ruby are withheld (honest empty-with-reason); trade management and closes continue — closing never requires an intelligence opinion.",
    recoveryCondition: "Ruby reads succeed again; withheld surfaces resume without backfilling fabricated history.",
  },
  {
    subsystem: "MODEL",
    outageSignal: "Learned-model artifacts unreadable, version store failing, or no live-allowed version exists.",
    detectedBy: "learning_model_versions reads (liveAllowed flag) + model read failures in the consuming services",
    enforcedBy: "learningModelVersions gate flow — liveAllowed defaults FALSE, so a missing/unreadable version is indistinguishable from 'not approved': recommendation layers fall back to non-learned defaults or honest absence",
    posture: "REDUCED",
    newExposureAllowed: true,
    degradedBehavior: "Learned tightenings vanish, learned loosenings vanish with them — the system reverts to its UNLEARNED conservative baseline (rule-based gates unchanged). Learned outputs only ever tighten, so losing them can only make the system more conservative, never less.",
    recoveryCondition: "A liveAllowed model version is readable again.",
  },
  {
    subsystem: "RECONCILIATION",
    outageSignal: "Reconciliation runs stale/failing — position truth cannot be re-verified.",
    detectedBy: "reconciliation_runs freshness (lib/db/src/schema/reconciliationRuns.ts) read by the reconciliation-freshness pre-gate",
    enforcedBy: "reconciliation-freshness pre-gate in the dispatch wall (lib/domain/src/safety-contracts/reconciliation.ts) — stale reconciliation refuses NEW dispatch",
    posture: "CLOSE_ONLY",
    newExposureAllowed: false,
    degradedBehavior: "No new exposure while position truth is unverifiable; last-verified state is displayed WITH its age; closes remain available (reducing exposure is always safe relative to unknown exposure).",
    recoveryCondition: "A fresh reconciliation run completes and matches venue truth.",
  },
  {
    subsystem: "DATABASE",
    outageSignal: "Our Postgres unreachable or erroring — safety state (kill switch, gates, limits) unreadable.",
    detectedBy: "Every DB read path — errors are typed, never swallowed into defaults (e.g. recoveryProbation resolveEffectiveProbation → 'unreadable' → refuse)",
    enforcedBy: "Fail-closed reads across the gate wall: not being able to read the stop button is NOT permission to trade (CLAUDE.md §1); an unreadable safety read refuses dispatch with a typed reason",
    posture: "NONE",
    newExposureAllowed: false,
    degradedBehavior: "No orders of any kind can be gated, so none are sent. Broker-side protective orders (SL/TP living at the venue) continue to protect open positions without us. The independent protection watchdog (#28, own DB connection/process) alerts that the main app cannot verify state.",
    recoveryCondition: "Database reads succeed again; workers resume from honest persisted state (no replay of assumed writes).",
  },
] as const;

/** Row lookup. Returns null for an unknown subsystem (callers fail closed). */
export function degradedModeRowFor(subsystem: string): DegradedModeRow | null {
  return DEGRADED_MODE_MATRIX.find((r) => r.subsystem === subsystem) ?? null;
}

// ── Pure evaluator (chaos-lite fixture target) ───────────────────────────────

export interface SubsystemOutage {
  subsystem: string; // deliberately string — unknown names must fail closed
  detail?: string;
}

export interface DegradedPosture {
  posture: ExecutionPermission;
  newExposureAllowed: boolean;
  outagesApplied: Subsystem[];
  unknownSubsystems: string[];
  reasons: string[];
}

/**
 * Compose the execution posture for a set of simultaneous outages.
 * Strictest-wins; unknown subsystems fail closed to NONE; no outages = FULL
 * (the matrix imposes nothing — every ordinary gate still runs).
 */
export function evaluateDegradedPosture(outages: readonly SubsystemOutage[]): DegradedPosture {
  let posture: ExecutionPermission = "FULL";
  let newExposureAllowed = true;
  const outagesApplied: Subsystem[] = [];
  const unknownSubsystems: string[] = [];
  const reasons: string[] = [];

  for (const o of outages) {
    const row = degradedModeRowFor(o.subsystem);
    if (!row) {
      unknownSubsystems.push(o.subsystem);
      posture = "NONE";
      newExposureAllowed = false;
      reasons.push(`UNKNOWN subsystem '${o.subsystem}' reported down — failing closed to NONE (an unmodeled failure is treated as the worst one)`);
      continue;
    }
    outagesApplied.push(row.subsystem);
    posture = stricterPosture(posture, row.posture);
    newExposureAllowed = newExposureAllowed && row.newExposureAllowed;
    reasons.push(`${row.subsystem} out → posture ${row.posture}, new exposure ${row.newExposureAllowed ? "allowed (reduced)" : "REFUSED"}${o.detail ? ` (${o.detail})` : ""}`);
  }
  if (outages.length === 0) reasons.push("no subsystem outages — matrix imposes nothing (ordinary gates unchanged)");
  return { posture, newExposureAllowed, outagesApplied, unknownSubsystems, reasons };
}
