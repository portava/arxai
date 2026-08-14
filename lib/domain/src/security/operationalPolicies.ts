// ═══════════════════════════════════════════════════════════════════════════
// security/operationalPolicies.ts — Phase-7 policy-as-code.
//
// One typed, versioned, auditable place that declares the OPERATIONAL security
// posture as data (rate limits, step-up requirements, anomaly thresholds,
// takeover thresholds, operational-mode behaviour, prod/dev + export rules)
// instead of scattering numbers across UI checks and routes. Pure constants and
// types only — no IO. The engine files in this directory consume these; the
// api-server composes the engines with real signals.
//
// SAFETY: defaults are conservative. Tightening a number raises caution; this
// layer can only ADD friction, never relax an existing trade/auth gate.
// ═══════════════════════════════════════════════════════════════════════════

/** Bumped whenever the shape or defaults of any operational policy change. */
export const OPERATIONAL_SECURITY_POLICY_VERSION = 2 as const;

// ── Rate limits + cooldowns ─────────────────────────────────────────────────

export type RateLimitedAction =
  | "LOGIN"
  | "FORGOT_PASSWORD"
  | "RESET_PASSWORD"
  | "INVITE_CODE_ATTEMPT"
  | "REQUEST_ACCESS"
  | "ADMIN_ACTION"
  | "ADMIN_ACTION_FAILED"
  | "RUBY_PROMPT"
  | "LIVE_COMMAND_RETRY"
  | "SCANNER_TO_TRADE"
  | "SELF_TRADE_RETRY"
  | "MANUAL_SCAN";

export const RATE_LIMITED_ACTION_KEYS: readonly RateLimitedAction[] = [
  "LOGIN",
  "FORGOT_PASSWORD",
  "RESET_PASSWORD",
  "INVITE_CODE_ATTEMPT",
  "REQUEST_ACCESS",
  "ADMIN_ACTION",
  "ADMIN_ACTION_FAILED",
  "RUBY_PROMPT",
  "LIVE_COMMAND_RETRY",
  "SCANNER_TO_TRADE",
  "SELF_TRADE_RETRY",
  "MANUAL_SCAN",
];

export interface RateLimitRule {
  /** Max permitted attempts inside one sliding window. */
  limit: number;
  /** Sliding window size in milliseconds. */
  windowMs: number;
  /** Lock-out duration once the limit is exceeded. */
  cooldownMs: number;
  /** Whether the cooldown should be surfaced on admin dashboards. */
  adminVisible: boolean;
  /**
   * Behaviour when the durable counter cannot be evaluated (persistence error).
   * `true` ONLY for public anti-enumeration auth paths, where a DB blip must not
   * lock every prospect/user out and the route has its own protections. EVERY
   * sensitive/admin/trade action is `false` → fail CLOSED so an outage can only
   * reduce risk, never silently grant unlimited attempts (unknown ⇒ caution).
   */
  failOpen: boolean;
}

export type RateLimitPolicy = Record<RateLimitedAction, RateLimitRule>;

const MIN = 60_000;

export const DEFAULT_RATE_LIMIT_POLICY: RateLimitPolicy = {
  LOGIN: { limit: 8, windowMs: 5 * MIN, cooldownMs: 15 * MIN, adminVisible: true, failOpen: true },
  FORGOT_PASSWORD: { limit: 5, windowMs: 15 * MIN, cooldownMs: 30 * MIN, adminVisible: true, failOpen: true },
  RESET_PASSWORD: { limit: 6, windowMs: 15 * MIN, cooldownMs: 30 * MIN, adminVisible: true, failOpen: true },
  INVITE_CODE_ATTEMPT: { limit: 6, windowMs: 10 * MIN, cooldownMs: 30 * MIN, adminVisible: true, failOpen: true },
  REQUEST_ACCESS: { limit: 3, windowMs: 30 * MIN, cooldownMs: 60 * MIN, adminVisible: true, failOpen: true },
  ADMIN_ACTION: { limit: 60, windowMs: 1 * MIN, cooldownMs: 2 * MIN, adminVisible: true, failOpen: false },
  ADMIN_ACTION_FAILED: { limit: 5, windowMs: 10 * MIN, cooldownMs: 30 * MIN, adminVisible: true, failOpen: false },
  RUBY_PROMPT: { limit: 30, windowMs: 1 * MIN, cooldownMs: 2 * MIN, adminVisible: true, failOpen: false },
  LIVE_COMMAND_RETRY: { limit: 5, windowMs: 1 * MIN, cooldownMs: 5 * MIN, adminVisible: true, failOpen: false },
  SCANNER_TO_TRADE: { limit: 20, windowMs: 1 * MIN, cooldownMs: 2 * MIN, adminVisible: true, failOpen: false },
  SELF_TRADE_RETRY: { limit: 6, windowMs: 1 * MIN, cooldownMs: 5 * MIN, adminVisible: true, failOpen: false },
  // Manual Broad Scan throttle: one scan per ~7s window, per user. Durable
  // (DB-backed) so the limit survives server restarts and is shared across
  // horizontally-scaled instances — replacing the prior in-memory cooldown.
  // failOpen MUST stay false: this is not a public anti-enumeration auth path,
  // so a persistence error fails CLOSED (enforced by the securityPhase7
  // fail-open classification guard). A single scan fans out the bounded
  // enrichment pipeline, so caution-on-unknown is the right posture.
  MANUAL_SCAN: { limit: 1, windowMs: 7_000, cooldownMs: 7_000, adminVisible: false, failOpen: false },
};

// ── Step-up / separation-of-duties / break-glass ────────────────────────────

export type DangerousAdminAction =
  | "ENABLE_LIVE_AUTONOMOUS"
  | "ALLOCATE_FUNDS"
  | "INCREASE_MAX_LOT"
  | "ENABLE_NEWS_TRADING"
  | "DISABLE_KILL_SWITCH"
  | "CHANGE_LOSS_LIMITS"
  | "PROMOTE_AUTONOMY"
  | "ROTATE_BRIDGE_SECRETS"
  | "DELETE_OR_DISABLE_USER"
  | "CHANGE_USER_ROLE"
  | "EXPORT_SENSITIVE_AUDIT"
  | "SET_OPERATIONAL_MODE";

export const DANGEROUS_ADMIN_ACTION_KEYS: readonly DangerousAdminAction[] = [
  "ENABLE_LIVE_AUTONOMOUS",
  "ALLOCATE_FUNDS",
  "INCREASE_MAX_LOT",
  "ENABLE_NEWS_TRADING",
  "DISABLE_KILL_SWITCH",
  "CHANGE_LOSS_LIMITS",
  "PROMOTE_AUTONOMY",
  "ROTATE_BRIDGE_SECRETS",
  "DELETE_OR_DISABLE_USER",
  "CHANGE_USER_ROLE",
  "EXPORT_SENSITIVE_AUDIT",
  "SET_OPERATIONAL_MODE",
];

export type StepUpMethod = "CONFIRM_PHRASE" | "REAUTH" | "SECOND_ADMIN" | "TWO_FACTOR";

export interface StepUpRule {
  /** Human-readable label (admin diagnostics only). */
  label: string;
  /** Acceptable step-up proofs — ANY one satisfies the primary requirement. */
  methods: StepUpMethod[];
  /** Exact phrase the operator must type when CONFIRM_PHRASE is a method. */
  confirmPhrase?: string;
  /** Separation-of-duties: a second, different admin must approve (future-ready). */
  requireSecondAdmin: boolean;
  /** Whether an audited emergency break-glass override is structurally allowed. */
  breakGlassAllowed: boolean;
}

export type StepUpPolicy = Record<DangerousAdminAction, StepUpRule>;

export const DEFAULT_STEP_UP_POLICY: StepUpPolicy = {
  ENABLE_LIVE_AUTONOMOUS: { label: "Enable live autonomous trading", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "ENABLE LIVE AUTONOMOUS", requireSecondAdmin: false, breakGlassAllowed: false },
  ALLOCATE_FUNDS: { label: "Allocate or remove funds", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "ALLOCATE FUNDS", requireSecondAdmin: false, breakGlassAllowed: false },
  INCREASE_MAX_LOT: { label: "Increase maximum lot size", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "INCREASE MAX LOT", requireSecondAdmin: false, breakGlassAllowed: false },
  ENABLE_NEWS_TRADING: { label: "Enable news trading", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "ENABLE NEWS TRADING", requireSecondAdmin: false, breakGlassAllowed: false },
  DISABLE_KILL_SWITCH: { label: "Disable the kill switch", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "DISABLE KILL SWITCH", requireSecondAdmin: true, breakGlassAllowed: false },
  CHANGE_LOSS_LIMITS: { label: "Change loss limits", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "CHANGE LOSS LIMITS", requireSecondAdmin: false, breakGlassAllowed: false },
  PROMOTE_AUTONOMY: { label: "Promote autonomy level", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "PROMOTE AUTONOMY", requireSecondAdmin: false, breakGlassAllowed: false },
  ROTATE_BRIDGE_SECRETS: { label: "Rotate bridge secrets", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "ROTATE BRIDGE SECRETS", requireSecondAdmin: false, breakGlassAllowed: true },
  DELETE_OR_DISABLE_USER: { label: "Delete or disable a user", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "DISABLE USER", requireSecondAdmin: false, breakGlassAllowed: false },
  CHANGE_USER_ROLE: { label: "Change a user role", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "CHANGE USER ROLE", requireSecondAdmin: false, breakGlassAllowed: false },
  EXPORT_SENSITIVE_AUDIT: { label: "Export sensitive audit data", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "EXPORT AUDIT DATA", requireSecondAdmin: false, breakGlassAllowed: false },
  SET_OPERATIONAL_MODE: { label: "Change security operational mode", methods: ["CONFIRM_PHRASE", "REAUTH"], confirmPhrase: "SET SECURITY MODE", requireSecondAdmin: false, breakGlassAllowed: true },
};

// ── Trade-command anomaly thresholds ────────────────────────────────────────

export interface AnomalyPolicy {
  /** Lot at/above this multiple of baseline raises caution (REQUIRE_REVIEW). */
  lotBaselineMultipleWarn: number;
  /** Lot at/above this multiple of baseline blocks autonomous execution. */
  lotBaselineMultipleBlock: number;
  /** Absolute lot ceiling regardless of baseline (safety net). */
  absoluteLotHardCap: number;
  /** Minimum trades required before a baseline is trusted for ratio checks. */
  minBaselineSampleSize: number;
  /** Allowed trading window (UTC hours, inclusive start, exclusive end). */
  sessionStartHourUtc: number;
  sessionEndHourUtc: number;
  /** Repeated identical attempts that warn / block. */
  repeatedAttemptWarn: number;
  repeatedAttemptBlock: number;
  /** A trade command must carry a stop-loss. */
  requireStopLoss: boolean;
}

export const DEFAULT_ANOMALY_POLICY: AnomalyPolicy = {
  lotBaselineMultipleWarn: 3,
  lotBaselineMultipleBlock: 6,
  absoluteLotHardCap: 50,
  minBaselineSampleSize: 5,
  sessionStartHourUtc: 0,
  sessionEndHourUtc: 24,
  repeatedAttemptWarn: 4,
  repeatedAttemptBlock: 8,
  requireStopLoss: true,
};

// ── Account-takeover thresholds ─────────────────────────────────────────────

export interface TakeoverPolicy {
  failedLoginSpikeWarn: number;
  failedLoginSpikeBlock: number;
  largeAllocationChangePct: number;
  repeatedPasswordResetWarn: number;
}

export const DEFAULT_TAKEOVER_POLICY: TakeoverPolicy = {
  failedLoginSpikeWarn: 5,
  failedLoginSpikeBlock: 10,
  largeAllocationChangePct: 50,
  repeatedPasswordResetWarn: 3,
};

// ── Aggregate bundle ────────────────────────────────────────────────────────

export interface OperationalSecurityPolicies {
  policyVersion: number;
  rateLimitPolicy: RateLimitPolicy;
  stepUpPolicy: StepUpPolicy;
  anomalyPolicy: AnomalyPolicy;
  takeoverPolicy: TakeoverPolicy;
}

export const DEFAULT_OPERATIONAL_SECURITY_POLICIES: OperationalSecurityPolicies = {
  policyVersion: OPERATIONAL_SECURITY_POLICY_VERSION,
  rateLimitPolicy: DEFAULT_RATE_LIMIT_POLICY,
  stepUpPolicy: DEFAULT_STEP_UP_POLICY,
  anomalyPolicy: DEFAULT_ANOMALY_POLICY,
  takeoverPolicy: DEFAULT_TAKEOVER_POLICY,
};

export function isRateLimitedAction(value: string): value is RateLimitedAction {
  return (RATE_LIMITED_ACTION_KEYS as readonly string[]).includes(value);
}

export function isDangerousAdminAction(value: string): value is DangerousAdminAction {
  return (DANGEROUS_ADMIN_ACTION_KEYS as readonly string[]).includes(value);
}
