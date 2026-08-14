// ═══════════════════════════════════════════════════════════════════════════
// security/policies.ts — versioned, typed security policy structure.
//
// One place that declares the security posture as data, not scattered checks.
// Later phases (HARD_GATE integration, audit chaining, Ruby boundaries,
// hardening) read these instead of re-deriving rules ad hoc. Pure constants.
// ═══════════════════════════════════════════════════════════════════════════

import type { SecurityZone, SensitivityLevel } from "./types.js";
import { SECURITY_ZONES } from "./types.js";

/** Bumped whenever the shape or defaults of any policy below change. */
export const SECURITY_POLICY_VERSION = 1 as const;

export interface EncryptionPolicy {
  policyVersion: number;
  /** Symmetric algorithm used by the encryption-at-rest abstraction. */
  algorithm: "aes-256-gcm";
  /** Active key version new writes are encrypted under. */
  activeKeyVersion: number;
  /** Zones whose designated fields SHOULD be encrypted at rest. */
  encryptZonesAtOrAbove: SecurityZone;
  /** Legacy plaintext rows are allowed to be read, but flagged for review. */
  allowLegacyPlaintextRead: boolean;
}

export interface AuditPolicy {
  policyVersion: number;
  /** Security events/access logs are append-only (never updated/deleted). */
  appendOnly: boolean;
  /** Redact every payload before it is written to an audit row. */
  redactBeforeWrite: boolean;
  /** Minimum severity that must always be recorded even if logging is noisy. */
  alwaysRecordAtOrAbove: "INFO" | "WARNING" | "HIGH" | "CRITICAL";
}

export interface ExportPolicy {
  policyVersion: number;
  /** Every export is redacted before it leaves the system. */
  redactExports: boolean;
  /** Account identifiers are masked, never raw, in exports. */
  maskAccountIds: boolean;
  /** Max sensitivity level permitted to appear (post-redaction) in an export. */
  maxSensitivity: SensitivityLevel;
}

export interface RubyMemoryPolicy {
  policyVersion: number;
  /** Ruby (assistant) is read-only and may never persist secrets. */
  readOnly: boolean;
  /** Secrets are stripped from anything Ruby could remember or echo. */
  redactBeforeStore: boolean;
  /** Ruby is strictly scoped to the requesting user's own data. */
  perUserScoped: boolean;
}

export interface PromptInjectionPolicy {
  policyVersion: number;
  /** External/tool content is treated as untrusted data, never instructions. */
  treatExternalContentAsUntrusted: boolean;
  /** Refuse to surface secrets/keys even if asked directly. */
  refuseSecretDisclosure: boolean;
}

export interface SecurityLockdownPolicy {
  policyVersion: number;
  /** When lockdown is active, sensitive surfaces fail closed (deny). */
  failClosedOnLockdown: boolean;
  /** A critical-floor component at 0 caps the band at Critical or worse. */
  criticalFloorCapsBand: boolean;
}

export interface SecurityPolicies {
  policyVersion: number;
  encryptionPolicy: EncryptionPolicy;
  auditPolicy: AuditPolicy;
  exportPolicy: ExportPolicy;
  rubyMemoryPolicy: RubyMemoryPolicy;
  promptInjectionPolicy: PromptInjectionPolicy;
  securityLockdownPolicy: SecurityLockdownPolicy;
}

export const DEFAULT_SECURITY_POLICIES: SecurityPolicies = {
  policyVersion: SECURITY_POLICY_VERSION,
  encryptionPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    algorithm: "aes-256-gcm",
    activeKeyVersion: 1,
    encryptZonesAtOrAbove: SECURITY_ZONES.CREDENTIALS,
    allowLegacyPlaintextRead: true,
  },
  auditPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    appendOnly: true,
    redactBeforeWrite: true,
    alwaysRecordAtOrAbove: "WARNING",
  },
  exportPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    redactExports: true,
    maskAccountIds: true,
    maxSensitivity: "CONFIDENTIAL",
  },
  rubyMemoryPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    readOnly: true,
    redactBeforeStore: true,
    perUserScoped: true,
  },
  promptInjectionPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    treatExternalContentAsUntrusted: true,
    refuseSecretDisclosure: true,
  },
  securityLockdownPolicy: {
    policyVersion: SECURITY_POLICY_VERSION,
    failClosedOnLockdown: true,
    criticalFloorCapsBand: true,
  },
};
