// AACI Security Foundation — Security Score composition (api-server side).
//
// Assembles the 11 SECURITY_SCORE component inputs from real signals (security
// settings, the redaction self-test, role/permission configuration) and hands
// them to the PURE domain engine. Fail-open to honest UNKNOWN: any signal that
// cannot be read is left undefined so the domain engine degrades the score
// down — it is never fabricated high. No new routes; later phases surface this.

import { db, securityRolesTable, securityPermissionsTable } from "@workspace/db";
import { security } from "@workspace/domain";
import { getSettings } from "./settings.js";
import { redactionSelfTest } from "./redact.js";

export type SecurityScoreReport = security.SecurityScoreResult & {
  generatedAt: string;
};

/**
 * Build the live Security Score. Each component is derived from a verifiable
 * signal; if a probe throws, that component stays undefined (honest UNKNOWN).
 */
export async function buildSecurityScore(): Promise<SecurityScoreReport> {
  const inputs: security.SecurityScoreComponentInputs = {};

  // Redaction self-test → auditRedaction + secretsProtected + tokenSafety.
  try {
    const selfTest = redactionSelfTest();
    const checks = Object.values(selfTest);
    const passed = checks.filter(Boolean).length;
    const pct = checks.length > 0 ? Math.round((passed / checks.length) * 100) : undefined;
    inputs.auditRedaction = pct;
    inputs.secretsProtected = pct;
    inputs.tokenSafety =
      selfTest.jwtRedacted && selfTest.apiKeyRedacted ? 100 : pct;
  } catch {
    /* leave undefined → honest UNKNOWN */
  }

  // Security settings → several posture components.
  try {
    const settings = await getSettings();
    inputs.exportSafety = settings.secretRedactionEnabled ? 100 : 0;
    inputs.dataAccessIsolation = settings.roleSystemEnabled ? 100 : 40;
    inputs.sessionSafety = settings.authRequired ? 100 : 50;
    inputs.commandIntegrity = settings.auditLoggingEnabled ? 90 : 30;
  } catch {
    /* leave undefined → honest UNKNOWN */
  }

  // Role/permission configuration → rolePermissionIntegrity.
  try {
    const [roles, perms] = await Promise.all([
      db.select().from(securityRolesTable),
      db.select().from(securityPermissionsTable),
    ]);
    const hasForbidden = perms.some((p) => p.isForbidden);
    inputs.rolePermissionIntegrity =
      roles.length > 0 && perms.length > 0 && hasForbidden ? 100 : 60;
  } catch {
    /* leave undefined → honest UNKNOWN */
  }

  // encryptionReadiness / replayProtection / secureTransport are owned by later
  // phases (encryption rollout, command signing/replay, transport hardening).
  // Until those land they are intentionally UNKNOWN — honestly scored low here,
  // never faked as ready.

  const result = security.computeSecurityScore(inputs);
  return { ...result, generatedAt: new Date().toISOString() };
}
