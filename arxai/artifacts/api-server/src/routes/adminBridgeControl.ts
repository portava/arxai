// Task #31 — Operator bridge controls.
//
// Admin/OWNER-only endpoints that give operators SAFE control over MT5 bridge
// connections without ever weakening a safety surface:
//   1. Bridge-token rotation (with bounded grace window) + revoke.
//   2. Emergency close (per ticket / user / allocation / all-shared / all),
//      funnelled through the normal 16-gate live pipeline — no bypass path.
//   3. Orphan broker-position handling (ignore / mark-external / import-link /
//      close), persisting reconcileState; never auto-assigning ownership.
//   4. Bridge watchdog read + dedupe'd stale/offline alerting.
//
// SECURITY:
//   - Every route requires an ADMIN or OWNER session. Admin-previewing-as-user
//     is auto-downgraded upstream by applyEffectiveViewMode, so a previewing
//     admin lands in the 403 branch — correct.
//   - Bridge-token secrets are NEVER returned, except the raw rotated token
//     shown to the admin EXACTLY ONCE at rotation time. The server stores only
//     SHA-256 hashes; raw tokens are never logged or re-served.
//   - Every mutating action requires a trimmed reason (≥3 chars) and writes an
//     admin_action_audit_log row before responding (fail-CLOSED).

import { Router, type Request, type Response } from "express";
import { randomBytes, createHash } from "node:crypto";
import { db } from "@workspace/db";
import { mt5ConnectionTable, arxLivePositionsTable, adminActionAuditLogTable } from "@workspace/db/schema";
import { and, desc, eq, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import {
  runEmergencyClose,
  type EmergencyCloseScope,
} from "../lib/live/emergencyClose.js";
import { classifyBridge } from "../lib/live/bridgeWatchdog.js";
import { maskConnection } from "../lib/live/bridgeConnectionView.js";
import { createAlert } from "../lib/alerts/alertManager.js";
import { enforceSensitiveAction } from "../lib/security/handshake.js";
import { mirrorCriticalEvent } from "../lib/security/events.js";
import { operatorRoleFromSession } from "../lib/security/adminRoleGate.js";
import {
  EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_REASON,
  ADMIN_EMERGENCY_CLOSE_SOURCE,
} from "../lib/live/killSwitchBypass.js";

const router = Router();

const EMERGENCY_CLOSE_PHRASE = "EMERGENCY CLOSE";
const DEFAULT_GRACE_MINUTES = 15;
const MAX_GRACE_MINUTES = 24 * 60; // 24h ceiling on the grace window.

// ── admin gating + audit helpers (mirrors adminReconciliationCenter) ────────
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  // Task #743 Cluster D — operator gate via the shared helper. INVESTOR / USER /
  // anonymous sessions resolve to null here and are denied 403 at the route
  // level (admin-previewing-as-user is already auto-downgraded upstream).
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = operatorRoleFromSession(u?.role);
  if (!role) {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role;
}

function getAdminId(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

function clientIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0]!.trim();
  return req.ip ?? null;
}

// Transaction executor type — either the top-level db or a tx handle. Lets the
// same writeAudit run inside a db.transaction so the mutation + audit commit (or
// roll back) atomically.
type Executor = typeof db | Parameters<Parameters<typeof db.transaction>[0]>[0];

interface AuditArgs {
  adminId: number | null;
  role: "ADMIN" | "OWNER";
  action: string;
  targetUserId: number | null;
  reason: string | null;
  beforeState?: Record<string, unknown>;
  afterState: Record<string, unknown>;
  ipAddress: string | null;
}

async function writeAudit(args: AuditArgs, exec: Executor = db): Promise<void> {
  // Fail-CLOSED: any audit failure must bubble up so the caller refuses.
  // When `exec` is a transaction, throwing here rolls back the mutation too.
  await exec.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState ?? {},
    afterState: args.afterState,
    reason: args.reason,
    ipAddress: args.ipAddress,
  });
}

function readReason(body: unknown): string | null {
  const r = (body as { reason?: unknown } | null)?.reason;
  const trimmed = typeof r === "string" ? r.trim() : "";
  return trimmed.length >= 3 ? trimmed : null;
}

// ── token helpers (mirror meMt5Connections — hash only, raw shown once) ──────
function hashBridgeToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}
function generateToken(): { raw: string; hash: string; last4: string } {
  const raw = randomBytes(32).toString("base64url");
  return { raw, hash: hashBridgeToken(raw), last4: raw.slice(-4) };
}

// ─── GET /api/admin/bridge/connections ──────────────────────────────────────
router.get("/admin/bridge/connections", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const rows = await db.select().from(mt5ConnectionTable).orderBy(desc(mt5ConnectionTable.updatedAt));
  res.json({ ok: true, connections: rows.map((r) => maskConnection(r)) });
});

// ─── POST /api/admin/bridge/connections/:id/rotate-token ────────────────────
const RotateBody = z.object({
  reason: z.string().min(3).max(500),
  gracePeriodMinutes: z.number().int().min(0).max(MAX_GRACE_MINUTES).optional(),
});
router.post("/admin/bridge/connections/:id/rotate-token", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const hs = await enforceSensitiveAction("ROTATE_BRIDGE_SECRETS", {
    userId: getAdminId(req), role, authenticated: true, adminSurfaceOk: true,
  });
  if (!hs.ok) { res.status(403).json({ ok: false, error: hs.reasonCode, message: hs.userMessage }); return; }
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "INVALID_ID" }); return; }
  let body: z.infer<typeof RotateBody>;
  try { body = RotateBody.parse(req.body ?? {}); }
  catch { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  const existing = await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, id)).limit(1);
  const row = existing[0];
  if (!row) { res.status(404).json({ ok: false, error: "CONNECTION_NOT_FOUND" }); return; }
  if (row.tokenRevokedAt) { res.status(409).json({ ok: false, error: "CONNECTION_REVOKED" }); return; }

  const graceMinutes = body.gracePeriodMinutes ?? DEFAULT_GRACE_MINUTES;
  const now = new Date();
  const graceExpiry = graceMinutes > 0 ? new Date(now.getTime() + graceMinutes * 60_000) : null;
  // Park the OUTGOING hash for the grace window so a running EA keeps working
  // until the operator swaps in the new token. When grace is 0 the previous
  // hash is cleared immediately (instant cutover).
  const tok = generateToken();
  // Fail-CLOSED: mutation + audit run in ONE transaction. If the audit insert
  // throws, the token rotation is rolled back — no privileged change without an
  // audit trail.
  let updated: (typeof mt5ConnectionTable.$inferSelect)[];
  try {
    updated = await db.transaction(async (tx) => {
      const rows = await tx.update(mt5ConnectionTable).set({
        apiKeyHash: tok.hash,
        tokenLast4: tok.last4,
        tokenCreatedAt: now,
        previousApiKeyHash: graceExpiry ? row.apiKeyHash : null,
        previousTokenExpiresAt: graceExpiry,
        tokenRotatedAt: now,
        tokenRotatedByAdminId: getAdminId(req),
        tokenRotationReason: body.reason,
        updatedAt: now,
      }).where(eq(mt5ConnectionTable.id, id)).returning();
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "BRIDGE_TOKEN_ROTATED",
        targetUserId: row.userId ?? null,
        reason: body.reason,
        beforeState: { connectionId: id, tokenLast4: row.tokenLast4 },
        afterState: { connectionId: id, tokenLast4: tok.last4, graceMinutes, graceExpiry: graceExpiry?.toISOString() ?? null },
        ipAddress: clientIp(req),
      }, tx);
      return rows;
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }

  // Tamper-evident mirror — best-effort, post-commit. Never includes the raw
  // token or any hash; only the connection + masked last4.
  await mirrorCriticalEvent({
    eventType: "SECRET_ROTATION", severity: "HIGH", status: "ALLOWED",
    actorUserId: getAdminId(req), actorRole: role, actorType: role,
    affectedObject: `mt5_connection:${id}`,
    message: "Bridge token rotated",
    metadata: { connectionId: id, tokenLast4: tok.last4, graceMinutes, targetUserId: row.userId ?? null },
  });

  // Raw token shown EXACTLY ONCE. Never logged, never re-served.
  res.json({
    ok: true,
    connection: maskConnection(updated[0]!),
    rawToken: tok.raw,
    rawTokenWarning: "Shown once. Paste it into the EA's BridgeToken input now — it cannot be retrieved later.",
    graceMinutes,
    graceExpiresAt: graceExpiry?.toISOString() ?? null,
  });
});

// ─── POST /api/admin/bridge/connections/:id/revoke ──────────────────────────
router.post("/admin/bridge/connections/:id/revoke", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "INVALID_ID" }); return; }
  const reason = readReason(req.body);
  if (!reason) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  const existing = await db.select().from(mt5ConnectionTable).where(eq(mt5ConnectionTable.id, id)).limit(1);
  const row = existing[0];
  if (!row) { res.status(404).json({ ok: false, error: "CONNECTION_NOT_FOUND" }); return; }

  const now = new Date();
  // Revoke kills both the active hash AND any grace hash so neither token can
  // authenticate after revocation. Fail-CLOSED: mutation + audit are atomic.
  let updated: (typeof mt5ConnectionTable.$inferSelect)[];
  try {
    updated = await db.transaction(async (tx) => {
      const rows = await tx.update(mt5ConnectionTable).set({
        status: "revoked",
        tokenRevokedAt: now,
        apiKeyHash: null,
        previousApiKeyHash: null,
        previousTokenExpiresAt: null,
        updatedAt: now,
      }).where(eq(mt5ConnectionTable.id, id)).returning();
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "BRIDGE_TOKEN_REVOKED",
        targetUserId: row.userId ?? null,
        reason,
        beforeState: { connectionId: id, status: row.status, tokenLast4: row.tokenLast4 },
        afterState: { connectionId: id, status: "revoked" },
        ipAddress: clientIp(req),
      }, tx);
      return rows;
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }
  // Tamper-evident mirror — best-effort, post-commit. Revoking a bridge token
  // is a bridge-security action; recorded so it cannot be retroactively erased.
  await mirrorCriticalEvent({
    eventType: "BRIDGE_SECURITY_FAILURE", severity: "HIGH", status: "TRIGGERED",
    actorUserId: getAdminId(req), actorRole: role, actorType: role,
    affectedObject: `mt5_connection:${id}`,
    message: "Bridge token revoked",
    metadata: { connectionId: id, targetUserId: row.userId ?? null, reason },
  });
  res.json({ ok: true, connection: maskConnection(updated[0]!) });
});

// ─── POST /api/admin/bridge/emergency-close ─────────────────────────────────
// Body: { confirmationPhrase, reason, scope: {...} }. Every close is funnelled
// through the normal 16-gate live pipeline; this endpoint NEVER bypasses a gate.
const ScopeBody = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("ticket"), userId: z.number().int(), brokerTicket: z.string().min(1) }),
  z.object({ kind: z.literal("user"), userId: z.number().int() }),
  z.object({ kind: z.literal("allocation"), allocationId: z.number().int() }),
  z.object({ kind: z.literal("all_shared") }),
  z.object({ kind: z.literal("all") }),
]);
const EmergencyCloseBody = z.object({
  confirmationPhrase: z.string(),
  reason: z.string().min(3).max(500),
  scope: ScopeBody,
});
router.post("/admin/bridge/emergency-close", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  let body: z.infer<typeof EmergencyCloseBody>;
  try { body = EmergencyCloseBody.parse(req.body ?? {}); }
  catch (e) {
    if (e instanceof z.ZodError) { res.status(400).json({ ok: false, error: "INVALID_BODY", details: e.issues }); return; }
    res.status(400).json({ ok: false, error: "INVALID_BODY" }); return;
  }
  if (body.confirmationPhrase.trim() !== EMERGENCY_CLOSE_PHRASE) {
    // Audit the blocked attempt (fail-CLOSED on audit too).
    try {
      await writeAudit({
        adminId: getAdminId(req), role,
        action: "BRIDGE_EMERGENCY_CLOSE_BLOCKED_PHRASE",
        targetUserId: null, reason: body.reason,
        afterState: { scope: body.scope.kind },
        ipAddress: clientIp(req),
      });
    } catch { res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" }); return; }
    res.status(400).json({ ok: false, error: "CONFIRMATION_PHRASE_REQUIRED", expected: EMERGENCY_CLOSE_PHRASE });
    return;
  }

  const targetUserId = body.scope.kind === "ticket" || body.scope.kind === "user" ? body.scope.userId : null;
  // Fail-CLOSED: audit the INTENT before any dispatch. If this throws we refuse
  // and nothing is queued — no live dispatch can ever happen without an audit
  // trail. (The dispatch itself queues live commands that cannot be rolled back
  // in a DB transaction, so we record intent first, then results.)
  try {
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "BRIDGE_EMERGENCY_CLOSE_INITIATED",
      targetUserId,
      reason: body.reason,
      afterState: { scope: body.scope.kind, killSwitchCloseBypass: true },
      ipAddress: clientIp(req),
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }

  // Task #743 Cluster D — admin emergency-close carries the narrow, CLOSE-only
  // kill-switch bypass so an operator can flatten a user's exposure even while
  // the global kill switch is engaged. Role (OWNER/ADMIN), confirmation phrase
  // and intent-audit-before-dispatch are all already enforced above; ownership
  // is resolved read-only inside runEmergencyClose. The bypass relaxes ONLY
  // gate #5 (kill switch) and ONLY for CLOSE — every other gate still runs, and
  // the pipeline writes a distinct per-ticket bypass audit row when it applies.
  const summary = await runEmergencyClose(
    body.scope as EmergencyCloseScope,
    "ADMIN_EMERGENCY_CLOSE",
    {
      killSwitchBypass: {
        reason: EMERGENCY_CLOSE_KILL_SWITCH_BYPASS_REASON,
        source: ADMIN_EMERGENCY_CLOSE_SOURCE,
        initiatorAdminId: getAdminId(req),
        initiatorRole: role,
      },
    },
  );

  // Result audit — intent is already durably recorded, so this is best-effort;
  // failure here must not hide the (already-dispatched) outcome from the caller.
  try {
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "BRIDGE_EMERGENCY_CLOSE",
      targetUserId,
      reason: body.reason,
      afterState: {
        scope: body.scope.kind,
        totalOpenMatched: summary.totalOpenMatched,
        queued: summary.queued, blocked: summary.blocked, errored: summary.errored,
        results: summary.results,
      },
      ipAddress: clientIp(req),
    });
  } catch (err) {
    req.log.error({ event: "bridge_emergency_close_result_audit_failed", err }, "emergency-close result audit failed (intent already recorded)");
  }
  res.json({ ok: true, ...summary });
});

// ─── Orphan broker-position handling ─────────────────────────────────────────
// ignore | mark-external | import-link | close. Persists reconcileState and
// audits. NEVER auto-assigns a userId.
const OrphanActionBody = z.object({
  reason: z.string().min(3).max(500),
  note: z.string().max(1000).optional(),
  sourceCommandId: z.string().min(1).optional(), // required only for import-link
});

async function loadPosition(id: number) {
  const rows = await db.select().from(arxLivePositionsTable).where(eq(arxLivePositionsTable.id, id)).limit(1);
  return rows[0] ?? null;
}

async function handleOrphanAction(
  req: Request, res: Response,
  reconcileState: "IGNORED" | "EXTERNAL" | "IMPORTED",
  action: string,
): Promise<void> {
  const role = requireAdmin(req, res); if (!role) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "INVALID_ID" }); return; }
  let body: z.infer<typeof OrphanActionBody>;
  try { body = OrphanActionBody.parse(req.body ?? {}); }
  catch { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }

  const pos = await loadPosition(id);
  if (!pos) { res.status(404).json({ ok: false, error: "POSITION_NOT_FOUND" }); return; }
  if (reconcileState === "IMPORTED" && !body.sourceCommandId) {
    res.status(400).json({ ok: false, error: "SOURCE_COMMAND_ID_REQUIRED" }); return;
  }

  const now = new Date();
  const set: Record<string, unknown> = {
    reconcileState,
    reconcileNote: body.note ?? body.reason,
    reconciledByAdminId: getAdminId(req),
    reconciledAt: now,
  };
  // import-link sets sourceCommandId so the row stops being an orphan — but we
  // NEVER touch userId (no ownership invention).
  if (reconcileState === "IMPORTED") set.sourceCommandId = body.sourceCommandId;

  // Fail-CLOSED: reconcile mutation + audit are atomic.
  let updated: (typeof arxLivePositionsTable.$inferSelect)[];
  try {
    updated = await db.transaction(async (tx) => {
      const rows = await tx.update(arxLivePositionsTable).set(set)
        .where(eq(arxLivePositionsTable.id, id)).returning();
      await writeAudit({
        adminId: getAdminId(req), role,
        action,
        targetUserId: pos.userId ?? null,
        reason: body.reason,
        beforeState: { positionId: id, brokerTicket: pos.brokerTicket, reconcileState: pos.reconcileState, sourceCommandId: pos.sourceCommandId },
        afterState: { positionId: id, reconcileState, sourceCommandId: set.sourceCommandId ?? pos.sourceCommandId },
        ipAddress: clientIp(req),
      }, tx);
      return rows;
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }
  res.json({ ok: true, position: { id: updated[0]!.id, reconcileState: updated[0]!.reconcileState } });
}

router.post("/admin/bridge/orphans/:id/ignore",
  (req, res) => { void handleOrphanAction(req, res, "IGNORED", "ORPHAN_POSITION_IGNORED"); });
router.post("/admin/bridge/orphans/:id/mark-external",
  (req, res) => { void handleOrphanAction(req, res, "EXTERNAL", "ORPHAN_POSITION_MARKED_EXTERNAL"); });
router.post("/admin/bridge/orphans/:id/import-link",
  (req, res) => { void handleOrphanAction(req, res, "IMPORTED", "ORPHAN_POSITION_IMPORT_LINKED"); });

// Close an orphan via the normal emergency-close engine (16-gate pipeline).
router.post("/admin/bridge/orphans/:id/close", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) { res.status(400).json({ ok: false, error: "INVALID_ID" }); return; }
  const reason = readReason(req.body);
  if (!reason) { res.status(400).json({ ok: false, error: "REASON_REQUIRED" }); return; }
  const pos = await loadPosition(id);
  if (!pos) { res.status(404).json({ ok: false, error: "POSITION_NOT_FOUND" }); return; }
  if (pos.userId == null) {
    res.status(409).json({ ok: false, error: "POSITION_HAS_NO_OWNER", detail: "Cannot dispatch a close for an unowned position. Mark it external instead." });
    return;
  }

  // Fail-CLOSED: audit the intent before dispatching the close.
  try {
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "ORPHAN_POSITION_CLOSE_INITIATED",
      targetUserId: pos.userId,
      reason,
      beforeState: { positionId: id, brokerTicket: pos.brokerTicket },
      afterState: { positionId: id },
      ipAddress: clientIp(req),
    });
  } catch {
    res.status(500).json({ ok: false, error: "AUDIT_WRITE_FAILED" });
    return;
  }

  const summary = await runEmergencyClose(
    { kind: "ticket", userId: pos.userId, brokerTicket: pos.brokerTicket },
    "ADMIN_ORPHAN_CLOSE",
  );
  try {
    await writeAudit({
      adminId: getAdminId(req), role,
      action: "ORPHAN_POSITION_CLOSE",
      targetUserId: pos.userId,
      reason,
      beforeState: { positionId: id, brokerTicket: pos.brokerTicket },
      afterState: { positionId: id, ...summary },
      ipAddress: clientIp(req),
    });
  } catch (err) {
    req.log.error({ event: "orphan_close_result_audit_failed", err }, "orphan-close result audit failed (intent already recorded)");
  }
  res.json({ ok: true, ...summary });
});

// ─── GET /api/admin/bridge/watchdog ─────────────────────────────────────────
// Classifies every non-revoked bridge and fires a dedupe'd alert per
// stale/offline bridge. Read-only on the bridge state.
router.get("/admin/bridge/watchdog", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res); if (!role) return;
  const rows = await db.select().from(mt5ConnectionTable)
    .where(isNull(mt5ConnectionTable.tokenRevokedAt));

  // Per-user fresh-bridge counts for leader-conflict detection.
  const now = new Date();
  const freshByUser = new Map<number, number>();
  for (const r of rows) {
    if (r.userId == null || !r.lastHeartbeat) continue;
    const age = Math.floor((now.getTime() - new Date(r.lastHeartbeat).getTime()) / 1000);
    if (age <= 15) freshByUser.set(r.userId, (freshByUser.get(r.userId) ?? 0) + 1);
  }

  const verdicts = rows.map((r) => {
    const caps = (r.capabilities ?? {}) as { eaInputs?: Record<string, unknown> };
    const ea = caps.eaInputs ?? {};
    const siblingFreshCount = r.userId != null ? Math.max(0, (freshByUser.get(r.userId) ?? 0) - 1) : 0;
    return classifyBridge({
      connectionId: r.id,
      userId: r.userId,
      connectionName: r.connectionName,
      tokenRevokedAt: r.tokenRevokedAt,
      lastHeartbeat: r.lastHeartbeat,
      accountType: r.accountType,
      eaVersion: r.eaVersion,
      eaInputs: {
        readOnlyMode: ea.readOnlyMode === undefined ? null : Boolean(ea.readOnlyMode),
        enableLiveExecution: ea.enableLiveExecution === undefined ? null : Boolean(ea.enableLiveExecution),
        terminalConnected: ea.terminalConnected === undefined ? null : Boolean(ea.terminalConnected),
        algoTradingAllowed: ea.algoTradingAllowed === undefined ? null : Boolean(ea.algoTradingAllowed),
      },
      siblingFreshCount,
      now,
    });
  });

  // Fire dedupe'd alerts for stale/offline bridges. createAlert handles the
  // 30-min in-window dedupe via the dedupeKey, so repeated polls don't spam.
  for (const v of verdicts) {
    if (!v.shouldAlert) continue;
    try {
      await createAlert({
        type: "BROKER_HEALTH",
        priority: v.liveness === "offline" ? "CRITICAL" : "HIGH",
        severity: v.alertSeverity,
        title: v.liveness === "offline" ? "MT5 bridge offline" : "MT5 bridge heartbeat stale",
        message: `${v.connectionName ?? `Connection ${v.connectionId}`}: ${v.summary}`,
        actionRequired: v.liveness === "offline",
        dedupeKey: `bridge_watchdog:${v.connectionId}:${v.liveness}`,
      });
    } catch { /* alerting is best-effort; never block the watchdog read */ }
  }

  res.json({
    ok: true,
    evaluatedAt: now.toISOString(),
    counts: {
      total: verdicts.length,
      fresh: verdicts.filter((v) => v.liveness === "fresh").length,
      stale: verdicts.filter((v) => v.liveness === "stale").length,
      offline: verdicts.filter((v) => v.liveness === "offline").length,
    },
    verdicts,
  });
});

// ─── GET /api/admin/bridge/keepalive-script ─────────────────────────────────
// Returns the VPS keepalive PowerShell script as plain text. Contains NO
// secrets — the operator edits the two marked variables on the VPS. The bridge
// token is never embedded here; it lives only in the EA's BridgeToken input.
const KEEPALIVE_PS1 = `# ARX MT5 Keepalive (keepalive.ps1)
# Ensures the MetaTrader 5 terminal stays running so the EA keeps sending
# heartbeats. Run via a scheduled task every minute. Contains NO secrets.
#
# Register:
#   schtasks /Create /SC MINUTE /MO 1 /TN "ARX MT5 Keepalive" \`
#     /TR "powershell -ExecutionPolicy Bypass -File C:\\\\arx\\\\keepalive.ps1" /F

# ── EDIT THESE TWO VARIABLES ────────────────────────────────────────────────
$Mt5Path    = "C:\\\\Program Files\\\\MetaTrader 5\\\\terminal64.exe"
$Mt5Profile = ""   # optional: path to a portable data folder, or leave empty
# ────────────────────────────────────────────────────────────────────────────

$proc = Get-Process -Name "terminal64" -ErrorAction SilentlyContinue
if ($null -ne $proc) {
    Write-Output "MT5 already running (PID $($proc.Id)). Nothing to do."
    exit 0
}

if (-not (Test-Path $Mt5Path)) {
    Write-Error "terminal64.exe not found at: $Mt5Path. Edit \\$Mt5Path."
    exit 1
}

if ([string]::IsNullOrWhiteSpace($Mt5Profile)) {
    Start-Process -FilePath $Mt5Path
} else {
    Start-Process -FilePath $Mt5Path -ArgumentList "/portable" -WorkingDirectory $Mt5Profile
}
Write-Output "Relaunched MT5 terminal."
exit 0
`;

router.get("/admin/bridge/keepalive-script", (req, res): void => {
  const role = requireAdmin(req, res); if (!role) return;
  res.type("text/plain").send(KEEPALIVE_PS1);
});

export default router;
