// ═══════════════════════════════════════════════════════════════════════════
// security/handshake.ts — pure per-action security handshake evaluator (AACI
// Security Phase 2).
//
// Deterministic, no IO. The api-server composes the real signals (settings,
// redaction self-test, Security Score band, permission/role) and calls this to
// decide whether a SENSITIVE action may proceed. The verdict feeds the AACI
// HARD_GATE `securityHandshakePass` factor.
//
// SAFETY (inviolable):
//  - ADVISORY-ADDITIVE ONLY. A PASS verdict never enables anything — the
//    authoritative gates (16-gate Phase B pipeline, Risk Governor, kill switch,
//    per-user approval) still run and can still refuse. A FAIL verdict only ADDS
//    a block.
//  - DEFAULT-DENY on the unevaluable. A required check whose input is `undefined`
//    (cannot be verified) is treated as FAIL, never silently assumed secure.
//  - No secret, token, or internal UPPER_SNAKE wording ever appears in the
//    user-facing message. The admin message names check keys only (no values).
// ═══════════════════════════════════════════════════════════════════════════

import type { SecurityHandshake, SecurityHandshakeStatus } from "./types.js";
import type { SecurityBand } from "./types.js";

/**
 * The catalog of SENSITIVE actions that must clear a security handshake before
 * they proceed. Each entry declares whether it is admin-only (the request must
 * arrive on an admin surface) so the evaluator can require the matching checks.
 */
export const SENSITIVE_ACTIONS = {
  LIVE_TRADE_EXECUTION: { label: "Place a live trade", adminOnly: false },
  SELF_TRADE_EXECUTION: { label: "Run an automated trade", adminOnly: false },
  MODIFY_SL_TP: { label: "Modify stop-loss / take-profit", adminOnly: false },
  CLOSE_POSITION: { label: "Close or partially close a position", adminOnly: false },
  ALLOCATE_FUNDS: { label: "Allocate or remove funds", adminOnly: false },
  CHANGE_AUTONOMY: { label: "Change autonomy level", adminOnly: false },
  ENABLE_LIVE_AUTONOMOUS: { label: "Enable live autonomous trading", adminOnly: false },
  INCREASE_MAX_LOT: { label: "Increase maximum lot size", adminOnly: false },
  ENABLE_NEWS_TRADING: { label: "Enable news trading", adminOnly: false },
  DISABLE_KILL_SWITCH: { label: "Disable the kill switch", adminOnly: true },
  ROTATE_BRIDGE_SECRETS: { label: "Rotate bridge secrets", adminOnly: true },
  APPROVE_USER: { label: "Approve a user", adminOnly: true },
  CHANGE_USER_ROLE: { label: "Change a user role", adminOnly: true },
  EXPORT_REPORT: { label: "Export a report", adminOnly: true },
  RESET_PASSWORD: { label: "Reset a password", adminOnly: false },
  ISSUE_INVITE: { label: "Issue an invite code", adminOnly: true },
  REVOKE_KEY: { label: "Revoke a registration key", adminOnly: true },
  UPDATE_KEY_EXPIRY: { label: "Change a registration key's expiry", adminOnly: true },
  ADMIN_DIAGNOSTICS: { label: "Access admin diagnostics", adminOnly: true },
} as const;

export type SensitiveAction = keyof typeof SENSITIVE_ACTIONS;

export const SENSITIVE_ACTION_KEYS = Object.keys(SENSITIVE_ACTIONS) as SensitiveAction[];

export function isSensitiveAction(value: string): value is SensitiveAction {
  return Object.prototype.hasOwnProperty.call(SENSITIVE_ACTIONS, value);
}

/**
 * Real security signals for one action. Each is a tri-state:
 *   true      → verified good
 *   false     → verified bad
 *   undefined → could NOT be verified (default-deny treats this as FAIL)
 *
 * `lockdownActive` is inverted: `true` is bad. `undefined` means the lockdown
 * state itself could not be read → also default-deny (cannot prove "no
 * lockdown").
 */
export interface SecurityHandshakeCheckInput {
  /** Caller identity is established (a real authenticated user). */
  authenticated?: boolean;
  /** The caller's role is permitted to perform this class of action. */
  roleAuthorized?: boolean;
  /** The caller holds the specific permission for this action. */
  actionPermissioned?: boolean;
  /** Secret redaction is proven (redaction self-test passes). */
  secretsNotExposed?: boolean;
  /** Audit logging is available to record the action. */
  auditAvailable?: boolean;
  /** For admin-only actions: the request arrived on a genuine admin surface. */
  adminSurfaceOk?: boolean;
  /** Encryption / secret-handling configuration is healthy. */
  encryptionConfigHealthy?: boolean;
  /** A security lockdown is currently active (true = bad). */
  lockdownActive?: boolean;
  /** Optional, future-ready device/session trust signal (never required). */
  sessionDeviceTrust?: boolean;
  /** Overall Security Score band (informational; lockdown is derived upstream). */
  securityBand?: SecurityBand;
}

/** Which class a failed check belongs to — drives the recommended action. */
type CheckClass = "BLOCK" | "ALERT_ADMIN";

export type SecurityHandshakeRecommendedAction = "ALLOW" | "BLOCK" | "ALERT_ADMIN";

export interface SecurityHandshakeVerdict {
  action: SensitiveAction;
  /** True only when every required check positively verified. */
  pass: boolean;
  /** The HARD_GATE factor value (identical to `pass`). */
  securityHandshakePass: boolean;
  /** Worst observed status across the required checks. */
  status: SecurityHandshakeStatus;
  recommendedAction: SecurityHandshakeRecommendedAction;
  /** Stable machine code, always prefixed with SECURITY_HANDSHAKE_FAILED on fail. */
  reasonCode: string;
  /** Every evaluated check (PASS/WARN/FAIL/UNKNOWN). */
  handshakes: SecurityHandshake[];
  /** The subset that did not pass. */
  failedChecks: SecurityHandshake[];
  /** Constant, clean, token-free message safe to show any user. */
  userMessage: string;
  /** Admin-facing diagnostic (names check keys only — no secrets, no values). */
  adminMessage: string;
}

// The constant user-facing copy — never names a check, secret, or internal code.
const USER_FAIL_MESSAGE = "Security check failed. This action cannot continue right now.";
const USER_OK_MESSAGE = "Security checks passed.";

interface CheckSpec {
  key: string;
  /** Resolve tri-state value for this check from the input. */
  value: (i: SecurityHandshakeCheckInput, adminOnly: boolean) => boolean | undefined;
  /** Whether this check is required for the given action. */
  required: (adminOnly: boolean) => boolean;
  /** Failure classification. */
  cls: CheckClass;
  okMessage: string;
  failMessage: string;
  unknownMessage: string;
}

// Ordered: identity/permission first (BLOCK class), then system-side posture
// (ALERT_ADMIN class). The first failed required check drives the reasonCode.
const CHECK_SPECS: ReadonlyArray<CheckSpec> = [
  {
    key: "authenticated",
    value: (i) => i.authenticated,
    required: () => true,
    cls: "BLOCK",
    okMessage: "Your identity is verified.",
    failMessage: "Your identity could not be verified.",
    unknownMessage: "Your identity could not be confirmed.",
  },
  {
    key: "roleAuthorized",
    value: (i) => i.roleAuthorized,
    required: () => true,
    cls: "BLOCK",
    okMessage: "Your role is allowed to do this.",
    failMessage: "Your role is not allowed to do this.",
    unknownMessage: "Your role permissions could not be confirmed.",
  },
  {
    key: "actionPermissioned",
    value: (i) => i.actionPermissioned,
    required: () => true,
    cls: "BLOCK",
    okMessage: "You have permission for this action.",
    failMessage: "You do not have permission for this action.",
    unknownMessage: "Your permission for this action could not be confirmed.",
  },
  {
    key: "adminSurfaceOk",
    value: (i) => i.adminSurfaceOk,
    required: (adminOnly) => adminOnly,
    cls: "ALERT_ADMIN",
    okMessage: "Requested from a valid admin surface.",
    failMessage: "Requested from an unexpected surface.",
    unknownMessage: "The request surface could not be confirmed.",
  },
  {
    key: "secretsNotExposed",
    value: (i) => i.secretsNotExposed,
    required: () => true,
    cls: "ALERT_ADMIN",
    okMessage: "Secret protection is verified.",
    failMessage: "Secret protection is not verified.",
    unknownMessage: "Secret protection could not be confirmed.",
  },
  {
    key: "auditAvailable",
    value: (i) => i.auditAvailable,
    required: () => true,
    cls: "ALERT_ADMIN",
    okMessage: "Audit logging is available.",
    failMessage: "Audit logging is unavailable.",
    unknownMessage: "Audit logging status could not be confirmed.",
  },
  {
    key: "encryptionConfigHealthy",
    value: (i) => i.encryptionConfigHealthy,
    required: () => true,
    cls: "ALERT_ADMIN",
    okMessage: "Security configuration is healthy.",
    failMessage: "Security configuration is unhealthy.",
    unknownMessage: "Security configuration could not be confirmed.",
  },
  {
    key: "noLockdown",
    // Inverted: pass only when lockdown is explicitly NOT active.
    value: (i) => (i.lockdownActive === undefined ? undefined : i.lockdownActive === false),
    required: () => true,
    cls: "ALERT_ADMIN",
    okMessage: "No security lockdown is active.",
    failMessage: "A security lockdown is active.",
    unknownMessage: "Lockdown state could not be confirmed.",
  },
  {
    key: "sessionDeviceTrust",
    value: (i) => i.sessionDeviceTrust,
    // Future-ready: never required, so an UNKNOWN here is a WARN, not a block.
    required: () => false,
    cls: "BLOCK",
    okMessage: "Session/device trust verified.",
    failMessage: "Session/device trust not established.",
    unknownMessage: "Session/device trust not evaluated.",
  },
];

/**
 * Evaluate the security handshake for one sensitive action. Pure: identical
 * inputs always produce identical output. Default-deny — any required check that
 * is `false` or `undefined` fails the handshake.
 */
export function evaluateSecurityHandshake(
  action: SensitiveAction,
  input: SecurityHandshakeCheckInput,
): SecurityHandshakeVerdict {
  const adminOnly = SENSITIVE_ACTIONS[action].adminOnly;

  const handshakes: SecurityHandshake[] = [];
  const failedChecks: SecurityHandshake[] = [];
  let blockFail = false;
  let alertFail = false;
  let firstFailedKey: string | null = null;
  let sawUnknownRequired = false;

  for (const spec of CHECK_SPECS) {
    const required = spec.required(adminOnly);
    const raw = spec.value(input, adminOnly);

    let status: SecurityHandshakeStatus;
    let message: string;
    if (raw === true) {
      status = "PASS";
      message = spec.okMessage;
    } else if (raw === false) {
      status = "FAIL";
      message = spec.failMessage;
    } else {
      // Unknown. Default-deny when required; otherwise a soft WARN.
      status = required ? "FAIL" : "WARN";
      message = spec.unknownMessage;
      if (required) sawUnknownRequired = true;
    }

    const hs: SecurityHandshake = {
      check: spec.key,
      status,
      score: status === "PASS" ? 100 : status === "WARN" ? 50 : 0,
      message,
    };
    handshakes.push(hs);

    if (required && status === "FAIL") {
      failedChecks.push(hs);
      if (firstFailedKey === null) firstFailedKey = spec.key;
      if (spec.cls === "BLOCK") blockFail = true;
      else alertFail = true;
    }
  }

  const pass = !blockFail && !alertFail;

  let recommendedAction: SecurityHandshakeRecommendedAction;
  if (pass) recommendedAction = "ALLOW";
  else if (blockFail) recommendedAction = "BLOCK";
  else recommendedAction = "ALERT_ADMIN";

  const status: SecurityHandshakeStatus = pass
    ? handshakes.some((h) => h.status === "WARN")
      ? "WARN"
      : "PASS"
    : sawUnknownRequired && failedChecks.every((f) => f.status === "FAIL" && isUnknownDerived(f))
      ? "UNKNOWN"
      : "FAIL";

  const reasonCode = pass
    ? "SECURITY_HANDSHAKE_OK"
    : `SECURITY_HANDSHAKE_FAILED:${firstFailedKey ?? "UNKNOWN"}`;

  const adminMessage = pass
    ? `Security handshake passed for ${action}.`
    : `Security handshake failed for ${action} (${recommendedAction}): ${failedChecks
        .map((f) => f.check)
        .join(", ")}.`;

  return {
    action,
    pass,
    securityHandshakePass: pass,
    status,
    recommendedAction,
    reasonCode,
    handshakes,
    failedChecks,
    userMessage: pass ? USER_OK_MESSAGE : USER_FAIL_MESSAGE,
    adminMessage,
  };
}

// A FAIL row whose message is the "could not be confirmed" wording came from an
// unknown input (vs a verified-bad input). Used only to label the rollup status.
function isUnknownDerived(hs: SecurityHandshake): boolean {
  return /could not be confirmed/i.test(hs.message);
}
