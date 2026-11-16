// ═══════════════════════════════════════════════════════════════════════════
// security/handshake.ts (api-server) — composes the REAL security signals for a
// sensitive action and runs the pure domain handshake evaluator (AACI Security
// Phase 2).
//
// The pure verdict (lib/domain/src/security/handshake.ts) is deterministic and
// IO-free. This server wrapper is the only place that reads live signals:
// security settings, the redaction self-test, the Security Score band, and the
// caller's role/permission. It then:
//   - returns the verdict + resolved band + autonomy effect, and
//   - on FAIL, records a REDACTED security event and fires an admin notification.
//
// SAFETY (inviolable):
//   - ADVISORY-ADDITIVE ONLY. A PASS never enables anything; the authoritative
//     gates (16-gate Phase B pipeline, Risk Governor, kill switch, per-user
//     approval) still run downstream. A FAIL only ADDS a block.
//   - DEFAULT-DENY. Any thrown error while composing signals yields a failing
//     verdict (evaluator called with empty input ⇒ every required check FAILs).
//   - Per-user isolation: only the caller's own role/identity is consulted.
//   - No secret, token, or raw value is ever logged or notified — metadata is
//     scrubbed and the user-facing copy is the constant clean message.
// ═══════════════════════════════════════════════════════════════════════════

import {
  evaluateSecurityHandshake,
  resolveSecurityAutonomyEffect,
  SENSITIVE_ACTIONS,
  type SecurityAutonomyEffect,
  type SecurityBand,
  type SecurityHandshakeRecommendedAction,
  type SecurityHandshakeVerdict,
  type SensitiveAction,
} from "@workspace/domain/security";
import { getSettings } from "./settings.js";
import { redactionSelfTest, scrub } from "./redact.js";
import { buildSecurityScore } from "./securityScore.js";
import { normalizeRole } from "./permissions.js";
import { recordSecurityEvent } from "./events.js";
import { listAdminUserIds } from "../joinRequests/notifyAdmins.js";
import { createNotification } from "../notificationService.js";
import { logger } from "../logger.js";

const PRIVILEGED_ROLES = new Set(["OWNER", "ADMIN"]);

export interface ConsultSecurityHandshakeContext {
  /** The user the action is attributed to (per-user isolation). */
  userId: number | null;
  /** The caller's role (raw; normalized internally). */
  role?: string | null;
  /** Whether a real authenticated identity is established. Defaults to userId != null. */
  authenticated?: boolean;
  /**
   * For admin-only actions: the request arrived on a genuine admin surface.
   * Callers on an admin chokepoint should pass `true`. When omitted it derives
   * from the caller holding a privileged role.
   */
  adminSurfaceOk?: boolean;
  /**
   * Explicit override for the action-permission check (e.g. a caller that has
   * already run `checkPermission` for a seeded permission key). When omitted it
   * derives from the role: privileged for admin-only actions, any authenticated
   * role otherwise.
   */
  actionPermissioned?: boolean;
  /** Explicit override for the role-authorization check. */
  roleAuthorized?: boolean;
  /** Optional future-ready device/session trust signal (never required). */
  sessionDeviceTrust?: boolean;
}

export interface ConsultSecurityHandshakeResult {
  verdict: SecurityHandshakeVerdict;
  band: SecurityBand | null;
  autonomy: SecurityAutonomyEffect | null;
}

/**
 * Compose real signals and evaluate the security handshake for a sensitive
 * action. Never throws — any internal failure default-denies (a failing verdict
 * built from empty input). On FAIL it records a redacted security event and
 * notifies admins (best-effort; notification failure never changes the verdict).
 */
export async function consultSecurityHandshake(
  action: SensitiveAction,
  ctx: ConsultSecurityHandshakeContext,
): Promise<ConsultSecurityHandshakeResult> {
  let band: SecurityBand | null = null;
  let verdict: SecurityHandshakeVerdict;

  try {
    const role = normalizeRole(ctx.role);
    const isPrivileged = PRIVILEGED_ROLES.has(role);
    const authenticated = ctx.authenticated ?? ctx.userId != null;
    const adminOnly = SENSITIVE_ACTIONS[action].adminOnly;

    const [settings, score] = await Promise.all([getSettings(), buildSecurityScore()]);
    band = score.band;

    const selfTest = redactionSelfTest();
    const redactionAllOk = Object.values(selfTest).every(Boolean);

    // adminOnly drives whether the admin-surface check is required; the pure
    // evaluator reads `SENSITIVE_ACTIONS[action].adminOnly` itself, so here we
    // only need to SUPPLY the corresponding signals. For admin-only actions the
    // role/permission signals FAIL CLOSED unless the caller is privileged — a
    // merely-authenticated principal is never role-authorized for an admin
    // action (broken-access-control guard).
    verdict = evaluateSecurityHandshake(action, {
      authenticated,
      roleAuthorized: ctx.roleAuthorized ?? deriveRoleAuthorized(adminOnly, isPrivileged, authenticated),
      actionPermissioned:
        ctx.actionPermissioned ?? deriveActionPermissioned(adminOnly, isPrivileged, authenticated),
      secretsNotExposed: settings.secretRedactionEnabled === true,
      auditAvailable: settings.auditLoggingEnabled === true,
      adminSurfaceOk: ctx.adminSurfaceOk ?? isPrivileged,
      encryptionConfigHealthy: redactionAllOk,
      lockdownActive: band === "Lockdown",
      sessionDeviceTrust: ctx.sessionDeviceTrust,
      securityBand: band,
    });
  } catch (err) {
    // DEFAULT-DENY: empty input fails every required check in the evaluator.
    verdict = evaluateSecurityHandshake(action, {});
    logger.warn({ err, action }, "security: handshake consult failed (default-deny)");
  }

  const autonomy = band ? resolveSecurityAutonomyEffect(band) : resolveSecurityAutonomyEffect("Lockdown");

  if (!verdict.pass) {
    await recordHandshakeFailure(action, ctx.userId, verdict, band);
  }

  return { verdict, band, autonomy };
}

// ── Enforcement helper ──────────────────────────────────────────────────────
// Thin decision wrapper around `consultSecurityHandshake` for callsites that
// only need a single boolean. ENFORCEMENT SEMANTIC (advisory-additive):
//   - recommendedAction "BLOCK"       ⇒ ok:false  (refuse — an identity/role
//                                        failure, or default-deny on an
//                                        unevaluable handshake)
//   - recommendedAction "ALERT_ADMIN" ⇒ ok:true   (proceed — the consult has
//                                        already recorded a redacted event and
//                                        alerted admins; a posture degradation
//                                        never locks a user out of reducing live
//                                        risk nor an operator out of remediation)
//   - recommendedAction "ALLOW"       ⇒ ok:true
// A PASS NEVER relaxes any downstream gate — the 16-gate pipeline, Risk
// Governor, kill switch, and per-user approval all still run after this returns.
export interface SensitiveActionEnforcement {
  ok: boolean;
  blocked: boolean;
  reasonCode: string;
  userMessage: string;
  recommendedAction: SecurityHandshakeRecommendedAction;
  band: SecurityBand | null;
  verdict: SecurityHandshakeVerdict;
}

export async function enforceSensitiveAction(
  action: SensitiveAction,
  ctx: ConsultSecurityHandshakeContext,
): Promise<SensitiveActionEnforcement> {
  const { verdict, band } = await consultSecurityHandshake(action, ctx);
  const blocked = verdict.recommendedAction === "BLOCK";
  return {
    ok: !blocked,
    blocked,
    reasonCode: verdict.reasonCode,
    userMessage: verdict.userMessage,
    recommendedAction: verdict.recommendedAction,
    band,
    verdict,
  };
}

// Admin-only actions FAIL CLOSED unless the caller holds a privileged role — a
// merely-authenticated principal is never role-authorized for an admin action.
// Non-admin sensitive actions (live/self trade, modify, close, allocate, …) are
// authoritatively gated by the 16-gate pipeline + per-user approval downstream;
// here the role check only confirms a real authenticated principal.
function deriveRoleAuthorized(
  adminOnly: boolean,
  isPrivileged: boolean,
  authenticated: boolean,
): boolean {
  return adminOnly ? isPrivileged : authenticated;
}

// Same fail-closed posture for the action-permission signal: admin-only actions
// require a privileged role; non-admin actions only require authentication (the
// authoritative per-action gate runs downstream).
function deriveActionPermissioned(
  adminOnly: boolean,
  isPrivileged: boolean,
  authenticated: boolean,
): boolean {
  return adminOnly ? isPrivileged : authenticated;
}

// Record a REDACTED security event and notify admins. Best-effort: any failure
// here is swallowed so it can never change (or block) the handshake verdict.
async function recordHandshakeFailure(
  action: SensitiveAction,
  userId: number | null,
  verdict: SecurityHandshakeVerdict,
  band: SecurityBand | null,
): Promise<void> {
  const severity = verdict.recommendedAction === "BLOCK" ? "HIGH" : "WARNING";
  try {
    await recordSecurityEvent({
      eventType: "SECURITY_HANDSHAKE_FAILED",
      severity,
      status: "DENIED",
      actorRole: null,
      actorUserId: userId,
      permissionKey: `handshake:${action.toLowerCase()}`,
      message: verdict.adminMessage,
      metadata: scrub({
        action,
        band,
        reasonCode: verdict.reasonCode,
        recommendedAction: verdict.recommendedAction,
        failedChecks: verdict.failedChecks.map((f) => f.check),
        userId,
      }) as Record<string, unknown>,
    });
  } catch (err) {
    logger.warn({ err, action }, "security: handshake event record failed (non-fatal)");
  }

  try {
    const adminIds = await listAdminUserIds();
    await Promise.all(
      adminIds.map((adminId) =>
        createNotification(adminId, {
          notificationType: "SECURITY_HANDSHAKE_FAILED",
          severity: severity === "HIGH" ? "critical" : "warning",
          source: "security",
          title: "Security handshake failed",
          message: verdict.adminMessage,
        }),
      ),
    );
  } catch (err) {
    logger.warn({ err, action }, "security: handshake admin notify failed (non-fatal)");
  }
}
