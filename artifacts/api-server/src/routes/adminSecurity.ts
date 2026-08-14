// AACI Security — admin-only read surfaces (Task #241, Security Phase 5).
//
// GET /admin/security/overview  → AdminSecurityOverview (score, band, components,
//                                 encryption/protection status, audit chain)
// GET /admin/security/timeline  → AdminSecurityTimeline (redacted security events)
//
// READ-ONLY / OBSERVATION ONLY. These endpoints never place/modify a trade,
// never mutate any setting, and are never an execution gate. They reuse the
// Phase 1/2/4 building blocks: the pure Security Score engine, the redaction
// self-test, encryption-at-rest readiness, and the tamper-evident event chain.
//
// ADMIN/OWNER only. Like aaci.ts, the gate checks the EFFECTIVE request role
// (`req.authUser.role` via `normalizeProductRole`): the view-mode middleware
// downgrades a previewing admin's effective role to USER (stashing the real
// role on `realRole`), so admin-previewing-as-user lands in the 403 branch and
// can never reach operator security detail while previewing.
//
// NEVER returns any secret value — only booleans/enums describing whether a
// control is configured/active. The timeline projects events to a SAFE
// allowlist (no raw metadata blob); event messages are already redacted before
// write by the recording layer.

import { Router, type Request, type Response } from "express";
import { z } from "zod/v4";
import { security } from "@workspace/domain";
import { normalizeProductRole, isAdminProductRole } from "../lib/auth/productRole.js";
import { buildSecurityScore } from "../lib/security/securityScore.js";
import { getSettings } from "../lib/security/settings.js";
import { redactionSelfTest } from "../lib/security/redact.js";
import { isEncryptionReady } from "../lib/security/encryptionAtRest.js";
import {
  listEvents,
  verifySecurityEventChain,
} from "../lib/security/events.js";
import { db, securityEventsTable } from "@workspace/db";
import { and, eq, gte } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { logger } from "../lib/logger.js";
import { listActiveCooldowns } from "../lib/security/cooldowns.js";
import { getOperationalMode, setOperationalMode } from "../lib/security/operationalMode.js";
import { guardDangerousAdminAction } from "../lib/security/dangerousAction.js";
import { getProdDevPosture, getSupplyChainPosture } from "../lib/security/prodDevChecks.js";

const router = Router();

type SecurityControlStatus = "ACTIVE" | "INACTIVE" | "FUTURE_READY" | "UNKNOWN";

const timelineQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  eventType: z.string().min(1).max(64).optional(),
});

/** ADMIN/OWNER gate on the EFFECTIVE role (preview-as-user → USER → 403). */
function requireAdmin(req: Request, res: Response): boolean {
  const userId = req.authUser?.id ?? 0;
  if (!userId) {
    res.status(401).json({ error: "Authentication required" });
    return false;
  }
  const role = normalizeProductRole(req.authUser?.role);
  if (!isAdminProductRole(role)) {
    res.status(403).json({ error: "Admin or owner access required" });
    return false;
  }
  return true;
}

// ── GET /admin/security/overview ─────────────────────────────────────────────

router.get("/admin/security/overview", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;

    // Pure score engine over real signals (fail-open to honest UNKNOWN).
    const report = await buildSecurityScore();

    const components = security.SECURITY_SCORE_COMPONENTS.map((key) => ({
      key,
      label: security.labelFor(key),
      score: report.componentScores[key] ?? 0,
      known: !report.unknownComponents.includes(key),
    }));

    // Protection / encryption status — booleans & enums only, never secrets.
    const selfTest = redactionSelfTest();
    const allRedactionsOk = Object.values(selfTest).every(Boolean);

    let secretRedactionEnabled = false;
    try {
      const settings = await getSettings();
      secretRedactionEnabled = settings.secretRedactionEnabled === true;
    } catch {
      /* honest UNKNOWN → treated as not enabled below */
    }

    const sessionSecretConfigured = Boolean(process.env["SESSION_SECRET"]);

    const encryption = {
      encryptionKeyConfigured: isEncryptionReady(),
      secretsConfigured: sessionSecretConfigured,
      // We can only positively confirm a configured sender from EMAIL_FROM here;
      // the connector-resolved sender requires an async send to verify, so we
      // stay honestly null rather than claim a state we cannot prove.
      emailProviderConfigured: process.env["EMAIL_FROM"] ? true : null,
      // The MT5 command-signing key is derived from SESSION_SECRET.
      bridgeSecretConfigured: sessionSecretConfigured,
      tokenRedactionActive: selfTest.apiKeyRedacted && selfTest.jwtRedacted,
      auditRedactionActive: secretRedactionEnabled && allRedactionsOk,
      // Command signing is architecturally active when its key is configured.
      commandSigningStatus: (sessionSecretConfigured ? "ACTIVE" : "INACTIVE") as SecurityControlStatus,
      // Live commands carry a partial-unique idempotency key (architectural).
      idempotencyStatus: "ACTIVE" as SecurityControlStatus,
      // Owned by later hardening phases — wired but not yet enforced here.
      replayProtectionStatus: "FUTURE_READY" as SecurityControlStatus,
      promptInjectionGuardStatus: "FUTURE_READY" as SecurityControlStatus,
      memoryBoundariesStatus: "FUTURE_READY" as SecurityControlStatus,
      // No legacy-plaintext scan runs here — honest unknown, never "all clear".
      legacyUnencryptedDetected: null,
    };

    // Tamper-evident chain verification (bounded). Fail-open to null.
    let auditChain: {
      valid: boolean;
      checked: number;
      unknownCount: number;
      reason: string | null;
    } | null = null;
    try {
      const chain = await verifySecurityEventChain(5000);
      auditChain = {
        valid: chain.valid,
        checked: chain.checked,
        unknownCount: chain.unknownCount,
        reason: chain.reason,
      };
    } catch (err) {
      logger.warn({ err }, "adminSecurity: chain verification failed (null)");
    }

    // Failed security handshakes in the last 24h (real count; 0 on failure).
    let failedHandshakes24h = 0;
    try {
      const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [row] = await db
        .select({ count: sql<number>`cast(count(*) as int)` })
        .from(securityEventsTable)
        .where(
          and(
            eq(securityEventsTable.eventType, "SECURITY_HANDSHAKE_FAILED"),
            gte(securityEventsTable.createdAt, since),
          ),
        );
      failedHandshakes24h = row?.count ?? 0;
    } catch (err) {
      logger.warn({ err }, "adminSecurity: failed-handshake count failed (0)");
    }

    res.json({
      generatedAt: report.generatedAt,
      score: report.score,
      band: report.band,
      reasons: report.reasons,
      criticalFloorHit: report.criticalFloorHit,
      lockdownActive: report.lockdownForced,
      unknownComponents: report.unknownComponents,
      components,
      encryption,
      auditChain,
      lastSecurityCheck: report.generatedAt,
      failedHandshakes24h,
    });
  } catch (err) {
    logger.error({ err }, "adminSecurity: overview failed");
    next(err);
  }
});

// ── GET /admin/security/timeline ─────────────────────────────────────────────

router.get("/admin/security/timeline", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;

    const parsed = timelineQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid query" });
      return;
    }
    const { limit, eventType } = parsed.data;

    const rows = await listEvents(limit, eventType);

    // SAFE allowlist projection — never the raw metadata blob; messages are
    // already redacted before write by the recording layer.
    const events = rows.map((r) => ({
      securityEventId: r.securityEventId,
      eventType: r.eventType,
      severity: r.severity,
      status: r.status,
      actorRole: r.actorRole ?? null,
      actorType: r.actorType ?? null,
      affectedObject: r.affectedObject ?? null,
      message: r.message ?? null,
      redactionStatus: r.redactionStatus ?? null,
      securityLevel: r.securityLevel ?? null,
      createdAt: r.createdAt ? r.createdAt.toISOString() : null,
    }));

    res.json({ count: events.length, events });
  } catch (err) {
    logger.error({ err }, "adminSecurity: timeline failed");
    next(err);
  }
});

// ── GET /admin/security/cooldowns ────────────────────────────────────────────
// Active rate-limit cooldowns (admin-visible actions). Scope keys are already
// hashed at write time — never raw IPs/emails. READ-ONLY.

router.get("/admin/security/cooldowns", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const rows = await listActiveCooldowns(200);
    // Redact the (already-hashed) scopeKey entirely — the admin view never needs
    // to correlate a cooldown back to a specific IP/email/admin identity. We
    // surface only the action, attempt count, and timing.
    const cooldowns = rows.map((r) => ({
      actionKey: r.actionKey,
      count: r.count,
      blockedUntil: r.blockedUntil,
      lastEventAt: r.lastEventAt,
      adminVisible: r.adminVisible,
    }));
    res.json({ count: cooldowns.length, cooldowns });
  } catch (err) {
    logger.error({ err }, "adminSecurity: cooldowns failed");
    next(err);
  }
});

// ── GET /admin/security/operational-mode ─────────────────────────────────────
// Current NORMAL | LOCKDOWN | INCIDENT switch + resolved posture. READ-ONLY.

router.get("/admin/security/operational-mode", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const state = await getOperationalMode();
    res.json(state);
  } catch (err) {
    logger.error({ err }, "adminSecurity: operational-mode get failed");
    next(err);
  }
});

// ── POST /admin/security/operational-mode ────────────────────────────────────
// Dangerous admin action: change the operational mode. Step-up gated
// (CONFIRM_PHRASE "SET SECURITY MODE" or recent reauth) + every attempt audited.
// Repeated step-up failures trip the ADMIN_ACTION_FAILED cooldown. This can only
// ADD caution — it never relaxes an existing trade/auth gate.

const setOperationalModeSchema = z.object({
  mode: z.string().min(1).max(32),
  reason: z.string().min(3).max(500),
  confirmPhrase: z.string().max(128).optional(),
  reauthenticated: z.boolean().optional(),
});

router.post("/admin/security/operational-mode", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    const adminId = req.authUser?.id ?? 0;
    const actorRole = normalizeProductRole(req.authUser?.role);

    const parsed = setOperationalModeSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid request" });
      return;
    }
    const { mode, reason, confirmPhrase, reauthenticated } = parsed.data;

    // Shared dangerous-admin-action chokepoint: repeated-failure lockout
    // pre-check → action rate limit → step-up (audited). Additive caution only.
    const guard = await guardDangerousAdminAction(res, {
      action: "SET_OPERATIONAL_MODE",
      adminId,
      actorRole,
      confirmPhrase,
      reauthenticated,
    });
    if (!guard) return;

    const result = await setOperationalMode({ mode, reason, changedBy: adminId, actorRole });
    if (!result.ok) {
      res.status(400).json({ error: result.rejected ?? "REJECTED", state: result.state });
      return;
    }
    res.json(result.state);
  } catch (err) {
    logger.error({ err }, "adminSecurity: operational-mode set failed");
    next(err);
  }
});

// ── GET /admin/security/environment ──────────────────────────────────────────
// Prod/dev separation + supply-chain hygiene posture. Booleans/enums only —
// never secret values. READ-ONLY.

router.get("/admin/security/environment", async (req, res, next) => {
  try {
    if (!requireAdmin(req, res)) return;
    res.json({
      prodDev: getProdDevPosture(),
      supplyChain: getSupplyChainPosture(),
    });
  } catch (err) {
    logger.error({ err }, "adminSecurity: environment posture failed");
    next(err);
  }
});

export default router;
