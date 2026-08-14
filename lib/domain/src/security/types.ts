// ═══════════════════════════════════════════════════════════════════════════
// security/types.ts — pure typed security model for the ARX AACI Security &
// Encryption Layer (Phase 1 foundation).
//
// Deterministic types + small constants only. No IO, no DB, no HTTP, no crypto.
// Routes and security services in artifacts/api-server compose these.
//
// Honesty contract: an unverifiable security signal is UNKNOWN, never assumed
// "secure". Nothing here fabricates a passing state.
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Security zones 1–7 — ascending sensitivity tiers. A higher zone number means
 * a more sensitive surface that demands stricter handling (encryption,
 * redaction, role gating, audit).
 */
export const SECURITY_ZONES = {
  PUBLIC: 1, // marketing/public copy, health pings
  INTERNAL: 2, // non-sensitive internal state, advisory scores
  USER_PRIVATE: 3, // a user's own non-financial profile/preferences
  FINANCIAL: 4, // balances, P/L, allocations, trade history
  EXECUTION_CONTROL: 5, // arming, kill switch, live-dispatch surfaces
  CREDENTIALS: 6, // bridge tokens, session/reset tokens, invite codes
  SYSTEM_ROOT: 7, // encryption keys, signing keys, env secrets
} as const;

export type SecurityZoneName = keyof typeof SECURITY_ZONES;
export type SecurityZone = (typeof SECURITY_ZONES)[SecurityZoneName];

/** Data sensitivity classification, independent of (but aligned to) zones. */
export const SENSITIVITY_LEVELS = [
  "PUBLIC",
  "INTERNAL",
  "CONFIDENTIAL",
  "RESTRICTED",
  "SECRET",
] as const;
export type SensitivityLevel = (typeof SENSITIVITY_LEVELS)[number];

/** Default sensitivity for each zone (most conservative reasonable mapping). */
export const ZONE_SENSITIVITY: Record<SecurityZone, SensitivityLevel> = {
  [SECURITY_ZONES.PUBLIC]: "PUBLIC",
  [SECURITY_ZONES.INTERNAL]: "INTERNAL",
  [SECURITY_ZONES.USER_PRIVATE]: "CONFIDENTIAL",
  [SECURITY_ZONES.FINANCIAL]: "CONFIDENTIAL",
  [SECURITY_ZONES.EXECUTION_CONTROL]: "RESTRICTED",
  [SECURITY_ZONES.CREDENTIALS]: "SECRET",
  [SECURITY_ZONES.SYSTEM_ROOT]: "SECRET",
};

// ── Security handshake ──────────────────────────────────────────────────────
// Mirrors the cross-layer handshake pattern: a single named check reports a
// status with an honest UNKNOWN when it cannot be verified. This is the type
// later phases (HARD_GATE integration, System Cohesion) consume — it is NOT an
// execution gate by itself in Phase 1.

export type SecurityHandshakeStatus = "PASS" | "WARN" | "FAIL" | "UNKNOWN";

export interface SecurityHandshake {
  /** Stable machine key, e.g. "secretsProtected". */
  check: string;
  status: SecurityHandshakeStatus;
  /** 0–100 contribution; UNKNOWN should map low, never fabricated high. */
  score: number;
  /** Plain-English, token-free, secret-free explanation. */
  message: string;
  zone?: SecurityZone;
  sensitivity?: SensitivityLevel;
}

// ── Security Score components & bands ───────────────────────────────────────

/** The 11 weighted components of SECURITY_SCORE (per the security spec). */
export const SECURITY_SCORE_COMPONENTS = [
  "rolePermissionIntegrity",
  "secretsProtected",
  "encryptionReadiness",
  "commandIntegrity",
  "auditRedaction",
  "tokenSafety",
  "dataAccessIsolation",
  "replayProtection",
  "sessionSafety",
  "secureTransport",
  "exportSafety",
] as const;
export type SecurityScoreComponent = (typeof SECURITY_SCORE_COMPONENTS)[number];

/**
 * Component input map. A component value is 0–100, or `undefined`/`null` when
 * the signal cannot be verified — which degrades the score honestly (treated as
 * 0 by the engine), never silently assumed secure.
 */
export type SecurityScoreComponentInputs = Partial<
  Record<SecurityScoreComponent, number | null | undefined>
>;

/** State bands, most-secure → least-secure. */
export const SECURITY_BANDS = [
  "Secure",
  "Healthy",
  "Watch",
  "Degraded",
  "Critical",
  "Lockdown",
] as const;
export type SecurityBand = (typeof SECURITY_BANDS)[number];

export interface SecurityScoreResult {
  /** Weighted SECURITY_SCORE, integer 0–100. */
  score: number;
  band: SecurityBand;
  /** Normalised per-component scores actually used (unknown → 0). */
  componentScores: Record<SecurityScoreComponent, number>;
  /** Components that could not be verified and were degraded to 0. */
  unknownComponents: SecurityScoreComponent[];
  /** True when a critical-floor component was 0/unknown (band capped). */
  criticalFloorHit: boolean;
  /** True when an explicit lockdown was forced regardless of score. */
  lockdownForced: boolean;
  /** Plain-English, token-free reasons for the band. */
  reasons: string[];
}

// ── Roles ───────────────────────────────────────────────────────────────────
// Aligned to the existing security seed (OWNER/ADMIN/TRADER/ANALYST/VIEWER/
// SYSTEM). Rank is for field-level gating only; it never replaces the
// permission tables — those remain authoritative for actions.

export const SECURITY_ROLE_RANK: Record<string, number> = {
  OWNER: 100,
  ADMIN: 80,
  SYSTEM: 60,
  TRADER: 40,
  ANALYST: 30,
  VIEWER: 10,
};
