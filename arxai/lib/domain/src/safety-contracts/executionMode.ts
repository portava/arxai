// ARX AI — canonical MT5 *execution mode* state machine.
//
// Phase 28-MT5-DEMO-ARMING (May 2026) — sub-phase 3B: demo-only broker
// dispatch chokepoint admits per-user, EA-version-gated, verified-demo
// commands. Live remains LOCKED. Live placement remains NOT IMPLEMENTED.
//
// This contract is INTENTIONALLY SEPARATE from `bridgeMode.ts`. Bridge mode
// describes connection health (OFFLINE / READ_ONLY / PAPER_ONLY / LIVE_LOCKED).
// Execution mode describes the *permissible action surface* for a given
// user+bridge pair.
//
// Hard invariants (enforced at every boundary):
//   - MT5_DEMO_EXECUTION can ONLY be reached after `runDemoVerificationGate`
//     returns VERIFIED_DEMO. Default for newly connected bridges is
//     MT5_DEMO_READ_ONLY. Default with no bridge is PAPER.
//   - LIVE_LOCKED is terminal. Nothing in this codebase may transition out
//     of LIVE_LOCKED. There is no live execution path.
//   - DEMO_ARMING_BUILT === true: per-user arming + command queue lifecycle.
//   - BROKER_DISPATCH_BUILT === true (sub-phase 3B): demo-only dispatch
//     code exists. `canDispatchToMt5(inputs)` ADMITS only when ALL per-user
//     gates pass AND `inputs.eaVersionAtLeast === true`. Called with no
//     inputs it STILL refuses (no global/system dispatch surface).
//   - LIVE remains LOCKED: `allowOrderExecution`, `commandExecutionAllowed`,
//     `brokerPlacementImplemented` stay literal-false constants. They
//     describe LIVE capability, NOT demo capability.
//   - Shared MT5 routing remains BLOCKED: `sharedMt5RoutingBlocked:true`.
//   - Auto-close remains ALERT_ONLY.
//
// Browser-safe: no Node imports, no IO.

export type ExecutionMode =
  | "PAPER"
  | "MT5_DEMO_READ_ONLY"
  | "MT5_DEMO_EXECUTION"
  | "LIVE_LOCKED";

export const EXECUTION_MODES: readonly ExecutionMode[] = [
  "PAPER",
  "MT5_DEMO_READ_ONLY",
  "MT5_DEMO_EXECUTION",
  "LIVE_LOCKED",
] as const;

export const DEFAULT_EXECUTION_MODE: ExecutionMode = "PAPER";

// ── Phase flags ──────────────────────────────────────────────────────────────
export const DEMO_ARMING_BUILT = true as const;
/** Sub-phase 3B: demo-only dispatch path exists. Live placement still NOT
 *  implemented (`brokerPlacementImplemented` stays literal-false). */
export const BROKER_DISPATCH_BUILT = true as const;
/** @deprecated alias retained for foundation gate report. */
export const EXECUTION_PATHS_BUILT = BROKER_DISPATCH_BUILT;

/** Minimum EA semantic version that contains the demo OrderSend/Modify/Close
 *  consumer. Lower versions are refused at dispatch with EA_VERSION_TOO_OLD. */
export const EA_MIN_DEMO_VERSION = "1.26" as const;

/** First demo EA build with a PLACE_PENDING_ORDER / CANCEL_PENDING_ORDER
 *  handler (ReplitMT5BridgeEA_v132). v1.26–v1.31 answer both with
 *  REJECTED_UNKNOWN_COMMAND_TYPE, so they are refused before dispatch. */
export const EA_MIN_DEMO_PENDING_VERSION = "1.32" as const;

/** Per-command EA minimum above EA_MIN_DEMO_VERSION. A command type not
 *  listed needs only EA_MIN_DEMO_VERSION. */
export const DEMO_COMMAND_MIN_EA_VERSION: Readonly<Partial<Record<DemoCommandType, string>>> = {
  PLACE_PENDING_ORDER: EA_MIN_DEMO_PENDING_VERSION,
  CANCEL_PENDING_ORDER: EA_MIN_DEMO_PENDING_VERSION,
};

export function minEaVersionForDemoCommand(commandType: string): string {
  return DEMO_COMMAND_MIN_EA_VERSION[commandType as DemoCommandType] ?? EA_MIN_DEMO_VERSION;
}

/** null when the reported EA handles `commandType`, else the refusal code
 *  `EA_VERSION_TOO_OLD_FOR_COMMAND:<type>:<reported><<minimum>`. */
export function demoCommandEaVersionBlocker(
  commandType: string,
  reportedEaVersion: string | null | undefined,
): string | null {
  const minimum = minEaVersionForDemoCommand(commandType);
  if (eaVersionAtLeast(reportedEaVersion, minimum)) return null;
  return `EA_VERSION_TOO_OLD_FOR_COMMAND:${commandType}:${reportedEaVersion ?? "unknown"}<${minimum}`;
}

/** Pure semver-major.minor comparator. EA reports e.g. "1.26", "1.21".
 *  Returns true when `reported` parses as >= `minimum`. */
export function eaVersionAtLeast(reported: string | null | undefined, minimum: string): boolean {
  if (!reported) return false;
  const parse = (s: string): [number, number] => {
    const m = /^v?(\d+)\.(\d+)/.exec(s.trim());
    if (!m) return [0, 0];
    return [Number(m[1]) || 0, Number(m[2]) || 0];
  };
  const [rMaj, rMin] = parse(reported);
  const [mMaj, mMin] = parse(minimum);
  if (rMaj !== mMaj) return rMaj > mMaj;
  return rMin >= mMin;
}

// ── Command queue contract ───────────────────────────────────────────────────
export type DemoCommandType =
  | "PLACE_MARKET_ORDER"
  | "PLACE_PENDING_ORDER"
  | "MODIFY_SLTP"
  | "CLOSE_POSITION"
  | "CANCEL_PENDING_ORDER"
  | "SYNC_REQUEST"
  | "RECONCILE_REQUEST";

export const DEMO_COMMAND_TYPES: readonly DemoCommandType[] = [
  "PLACE_MARKET_ORDER",
  "PLACE_PENDING_ORDER",
  "MODIFY_SLTP",
  "CLOSE_POSITION",
  "CANCEL_PENDING_ORDER",
  "SYNC_REQUEST",
  "RECONCILE_REQUEST",
] as const;

export type DemoCommandStatus =
  | "DRAFT"
  | "USER_CONFIRMATION_REQUIRED"
  | "DEMO_APPROVED"
  | "SENT_TO_MT5_DEMO"
  | "FILLED_DEMO"
  /** A pending order resting at the broker (PLACE_PENDING_ORDER, EA v1.32+).
   *  Not a position: nothing reads it as open exposure until the order fills
   *  (the EA position snapshot shows its ticket) and it becomes FILLED_DEMO. */
  | "PLACED_DEMO"
  /** CANCEL_PENDING_ORDER confirmed by the broker, and the PLACE_PENDING_ORDER
   *  row whose order it removed. */
  | "CANCELLED_DEMO"
  | "REJECTED"
  | "BLOCKED"
  | "FAILED";

export const DEMO_COMMAND_STATUSES: readonly DemoCommandStatus[] = [
  "DRAFT",
  "USER_CONFIRMATION_REQUIRED",
  "DEMO_APPROVED",
  "SENT_TO_MT5_DEMO",
  "FILLED_DEMO",
  "PLACED_DEMO",
  "CANCELLED_DEMO",
  "REJECTED",
  "BLOCKED",
  "FAILED",
] as const;

export const DEMO_COMMAND_TRANSITIONS: Readonly<Record<DemoCommandStatus, readonly DemoCommandStatus[]>> = {
  DRAFT: ["USER_CONFIRMATION_REQUIRED", "BLOCKED", "REJECTED"],
  USER_CONFIRMATION_REQUIRED: ["DEMO_APPROVED", "BLOCKED", "REJECTED"],
  DEMO_APPROVED: ["SENT_TO_MT5_DEMO", "BLOCKED", "FAILED"],
  SENT_TO_MT5_DEMO: ["FILLED_DEMO", "PLACED_DEMO", "CANCELLED_DEMO", "REJECTED", "FAILED"],
  FILLED_DEMO: [],
  // A resting order fills (seen as a position), is cancelled, or is removed
  // by the broker (expiry / rejection after placement).
  PLACED_DEMO: ["FILLED_DEMO", "CANCELLED_DEMO", "FAILED"],
  CANCELLED_DEMO: [],
  REJECTED: [],
  BLOCKED: [],
  FAILED: [],
} as const;

export function isValidDemoCommandTransition(
  from: DemoCommandStatus,
  to: DemoCommandStatus,
): boolean {
  return (DEMO_COMMAND_TRANSITIONS[from] as readonly DemoCommandStatus[]).includes(to);
}

/** EA-reportable result statuses (POST /api/mt5/demo-command-result). */
export const DEMO_BROKER_RESULT_STATUSES = ["FILLED_DEMO", "PLACED_DEMO", "CANCELLED_DEMO", "REJECTED", "FAILED"] as const;
export type DemoBrokerResultStatus = (typeof DEMO_BROKER_RESULT_STATUSES)[number];

/** The only result status each command type may be confirmed with. */
export function demoResultStatusFitsCommand(commandType: string, status: DemoBrokerResultStatus): boolean {
  if (status === "REJECTED" || status === "FAILED") return true;
  if (commandType === "PLACE_PENDING_ORDER") return status === "PLACED_DEMO";
  if (commandType === "CANCEL_PENDING_ORDER") return status === "CANCELLED_DEMO";
  return status === "FILLED_DEMO";
}

/** Reason prefix written by the server's no-result expiry sweep. */
export const DEMO_EXPIRED_NO_RESULT_PREFIX = "EXPIRED_DEMO_NO_EA_" as const;

/**
 * A broker success that arrives after the server's expiry sweep already
 * FAILED the row. The EA may have executed just before the sweep: the fill is
 * real and must be recorded (and flagged), never 409-orphaned. Only a row the
 * sweep expired qualifies; any other terminal row stays immutable.
 */
export function isLateDemoResultAcceptable(
  row: { status: string; reason: string | null | undefined },
  reported: DemoBrokerResultStatus,
): boolean {
  return row.status === "FAILED"
    && typeof row.reason === "string"
    && row.reason.startsWith(DEMO_EXPIRED_NO_RESULT_PREFIX)
    && (reported === "FILLED_DEMO" || reported === "PLACED_DEMO" || reported === "CANCELLED_DEMO");
}

export interface DemoVerificationDecision {
  status: "VERIFIED_DEMO" | "NOT_READY";
  blockers: readonly string[];
}

export interface ExecutionModeInputs {
  bridgeConnected: boolean;
  heartbeatFresh: boolean;
  demoVerified: boolean;
  liveLocked: boolean;
}

export function deriveExecutionMode(inputs: ExecutionModeInputs): ExecutionMode {
  if (inputs.liveLocked && (!inputs.bridgeConnected || !inputs.heartbeatFresh)) {
    return "PAPER";
  }
  if (!inputs.bridgeConnected || !inputs.heartbeatFresh) {
    return "PAPER";
  }
  return "MT5_DEMO_READ_ONLY";
}

export type ArmDecision =
  | { allowed: true; reason: "VERIFIED_DEMO" }
  | { allowed: false; reason: string };

export function canArmExecution(args: {
  decision: DemoVerificationDecision;
  inputs: ExecutionModeInputs;
}): ArmDecision {
  if (!DEMO_ARMING_BUILT) {
    return { allowed: false, reason: "DEMO_ARMING_NOT_BUILT" };
  }
  if (args.decision.status !== "VERIFIED_DEMO") {
    return {
      allowed: false,
      reason: `DEMO_NOT_VERIFIED — ${args.decision.blockers.join("; ") || "verification gate did not pass"}`,
    };
  }
  if (!args.inputs.bridgeConnected || !args.inputs.heartbeatFresh) {
    return { allowed: false, reason: "BRIDGE_NOT_FRESH" };
  }
  if (!args.inputs.liveLocked) {
    return { allowed: false, reason: "LIVE_LOCKED_INVARIANT_BROKEN" };
  }
  return { allowed: true, reason: "VERIFIED_DEMO" };
}

// ── Per-user dispatch eligibility ────────────────────────────────────────────
export interface PerUserDispatchInputs {
  executionMode: ExecutionMode;
  verifiedDemo: boolean;
  accountTypeExplicitDemo: boolean;
  userOwnsBridge: boolean;
  bridgeConnected: boolean;
  heartbeatFresh: boolean;
  userConfirmed: boolean;
  duplicateClear: boolean;
  riskGatePassed: boolean;
  liveLocked: boolean;
  /** Set only at the chokepoint after computing
   *  `eaVersionAtLeast(reportedEaVersion, EA_MIN_DEMO_VERSION)`. */
  eaVersionAtLeast?: boolean;
  /** EA-reported version string, retained for the audit blocker label. */
  reportedEaVersion?: string | null;
}

export interface PerUserDispatchEligibility {
  eligible: boolean;
  blockers: string[];
  /** True only when the chokepoint would actually admit. False otherwise. */
  canDispatchToMt5Allowed: boolean;
  reason: string;
}

export function evaluatePerUserDispatchEligibility(
  i: PerUserDispatchInputs,
): PerUserDispatchEligibility {
  const blockers: string[] = [];
  if (!i.liveLocked) blockers.push("LIVE_LOCK_BROKEN");
  if (i.executionMode !== "MT5_DEMO_EXECUTION") blockers.push("WRONG_EXECUTION_MODE");
  if (!i.verifiedDemo) blockers.push("NOT_VERIFIED_DEMO");
  if (!i.accountTypeExplicitDemo) blockers.push("ACCOUNT_TYPE_NOT_EXPLICIT_DEMO");
  if (!i.userOwnsBridge) blockers.push("NO_BRIDGE_CONNECTION");
  if (!i.bridgeConnected) blockers.push("BRIDGE_NOT_CONNECTED");
  if (!i.heartbeatFresh) blockers.push("HEARTBEAT_STALE");
  if (!i.userConfirmed) blockers.push("USER_NOT_CONFIRMED");
  if (!i.duplicateClear) blockers.push("DUPLICATE_SUSPECTED");
  if (!i.riskGatePassed) blockers.push("RISK_GATE_FAILED");
  if (i.eaVersionAtLeast === false) {
    blockers.push(`EA_VERSION_TOO_OLD:${i.reportedEaVersion ?? "unknown"}<${EA_MIN_DEMO_VERSION}`);
  }
  const eligible = blockers.length === 0;
  return {
    eligible,
    blockers,
    canDispatchToMt5Allowed: eligible,
    reason: eligible ? "PER_USER_ELIGIBLE" : blockers.join(","),
  };
}

/**
 * Hard refusal authority for actually sending a command to the EA.
 *
 * - Called with NO inputs: ALWAYS refuses with NO_PER_USER_INPUTS. There is
 *   no global/system dispatch surface in this codebase.
 * - Called with inputs: refuses unless BROKER_DISPATCH_BUILT === true AND
 *   `evaluatePerUserDispatchEligibility(inputs).eligible === true`. The
 *   eligibility evaluator itself requires `eaVersionAtLeast === true`.
 *
 * This is the single chokepoint every dispatcher MUST consult. Bypassing
 * it is a P0 safety violation.
 */
export function canDispatchToMt5(
  inputs?: PerUserDispatchInputs,
): { allowed: boolean; reason: string } {
  if (!BROKER_DISPATCH_BUILT) {
    return {
      allowed: false,
      reason: "BROKER_DISPATCH_NOT_BUILT",
    };
  }
  if (!inputs) {
    return {
      allowed: false,
      reason: "NO_PER_USER_INPUTS — global dispatch surface does not exist; provide PerUserDispatchInputs.",
    };
  }
  const e = evaluatePerUserDispatchEligibility(inputs);
  if (!e.eligible) {
    return { allowed: false, reason: e.reason };
  }
  return { allowed: true, reason: "PER_USER_DEMO_DISPATCH_ALLOWED" };
}

/** Safety-gate snapshot shape recorded into audit on every gate run and
 *  attached to every command at every lifecycle transition.
 *
 *  Literal-`false` / literal-true fields describe LIVE capability and are
 *  inviolable invariants:
 *    - `liveLocked: true`
 *    - `allowOrderExecution: false` (live)
 *    - `commandExecutionAllowed: false` (live)
 *    - `brokerPlacementImplemented: false` (live)
 *    - `autoCloseMode: "ALERT_ONLY"`
 *    - `sharedMt5RoutingBlocked: true`
 *
 *  Boolean fields describe per-user demo state and can flip when an armed
 *  user with EA v1.26+ has a confirmed, verified command at the chokepoint:
 *    - `brokerDispatchBuilt`
 *    - `canDispatchToMt5Allowed`
 *    - `readOnlyMode` (false while the owner is demo-armed)
 *    - `userArmed`
 */
export interface SafetyGateSnapshot {
  executionMode: ExecutionMode;
  demoArmingBuilt: boolean;
  brokerDispatchBuilt: boolean;
  /** @deprecated alias for brokerDispatchBuilt */
  executionPathsBuilt: boolean;
  canArmExecutionAllowed: boolean;
  canDispatchToMt5Allowed: boolean;
  liveLocked: true;
  readOnlyMode: boolean;
  allowOrderExecution: false;
  commandExecutionAllowed: false;
  brokerPlacementImplemented: false;
  autoCloseMode: "ALERT_ONLY";
  sharedMt5RoutingBlocked: true;
  demoVerificationStatus: "VERIFIED_DEMO" | "NOT_READY";
  userArmed: boolean;
  capturedAt: string;
}

export function buildSafetyGateSnapshot(args: {
  mode: ExecutionMode;
  demoStatus: "VERIFIED_DEMO" | "NOT_READY";
  canArmAllowed?: boolean;
  userArmed?: boolean;
  canDispatchAllowed?: boolean;
}): SafetyGateSnapshot {
  const userArmed = args.userArmed ?? false;
  return {
    executionMode: args.mode,
    demoArmingBuilt: DEMO_ARMING_BUILT,
    brokerDispatchBuilt: BROKER_DISPATCH_BUILT,
    executionPathsBuilt: BROKER_DISPATCH_BUILT,
    canArmExecutionAllowed: args.canArmAllowed ?? false,
    canDispatchToMt5Allowed: args.canDispatchAllowed ?? false,
    liveLocked: true,
    readOnlyMode: !userArmed,
    allowOrderExecution: false,
    commandExecutionAllowed: false,
    brokerPlacementImplemented: false,
    autoCloseMode: "ALERT_ONLY",
    sharedMt5RoutingBlocked: true,
    demoVerificationStatus: args.demoStatus,
    userArmed,
    capturedAt: new Date().toISOString(),
  };
}
