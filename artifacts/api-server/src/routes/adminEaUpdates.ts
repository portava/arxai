// Task #32 — Admin/OWNER EA management: remote config + update manifest workflow.
//
// SECURITY / SAFETY (inviolable):
// - Every route requires an ADMIN or OWNER session. Admin-previewing-as-user is
//   auto-downgraded upstream and lands in the 403 branch.
// - Every mutation takes a trimmed reason (≥3 chars) and writes a fail-CLOSED
//   admin_action_audit_log row inside the same transaction as the mutation.
// - Remote config writes pass through `assertNoProtectedFields` + the
//   `sanitiseRemoteConfig` allow-list: a protected field (AlgoTrading, broker
//   connection, local ReadOnlyMode / EnableLiveExecution, ARX kill switch,
//   16-gate evaluator, liveTrading chokepoint) can NEVER be persisted.
// - The update manifest moves draft → staged → approved → revoked. Only an
//   `approved` manifest is ever served to an EA (see mt5RemoteOps.ts). A
//   mandatory sha256 checksum is required at creation.

import { Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  eaRemoteConfigTable,
  eaUpdateManifestTable,
  eaUpdateReportTable,
  adminActionAuditLogTable,
  EA_UPDATE_CHANNELS,
  EA_REMOTE_CONFIG_COMMAND_TYPES,
} from "@workspace/db";
import { z } from "zod/v4";
import {
  assertNoProtectedFields,
  sanitiseRemoteConfig,
} from "@workspace/domain/safety-contracts";

const router = Router();

// ── admin gating + audit helpers (mirror adminBridgeControl) ────────────────
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = String(u?.role ?? "").toUpperCase();
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_OR_OWNER_REQUIRED" });
    return null;
  }
  return role as "ADMIN" | "OWNER";
}
function getAdminId(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}
function clientIp(req: Request): string | null {
  const xf = req.headers["x-forwarded-for"];
  if (typeof xf === "string" && xf.length > 0) return xf.split(",")[0]!.trim();
  return req.ip ?? null;
}
function readReason(body: unknown): string | null {
  const r = (body as { reason?: unknown } | null)?.reason;
  const trimmed = typeof r === "string" ? r.trim() : "";
  return trimmed.length >= 3 ? trimmed : null;
}

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

// ═══ Remote config ═══════════════════════════════════════════════════════════

// Allow-listed config body. Protected fields are rejected by passthrough +
// assertNoProtectedFields below; nothing here can describe a protected surface.
const remoteConfigSchema = z
  .object({
    heartbeatPeriodSeconds: z.number().int().min(1).max(3600).nullable().optional(),
    pollIntervalSeconds: z.number().int().min(1).max(3600).nullable().optional(),
    snapshotPeriodSeconds: z.number().int().min(1).max(3600).nullable().optional(),
    dealHistorySyncSeconds: z.number().int().min(1).max(86400).nullable().optional(),
    symbolSpecPeriodSeconds: z.number().int().min(1).max(86400).nullable().optional(),
    verboseDiagnostics: z.boolean().nullable().optional(),
    maxSpreadPoints: z.number().int().min(0).max(100000).nullable().optional(),
    maxDeviationPoints: z.number().int().min(0).max(100000).nullable().optional(),
    quoteFreshnessSeconds: z.number().int().min(1).max(3600).nullable().optional(),
    defaultCommandTtlSeconds: z.number().int().min(1).max(86400).nullable().optional(),
    retryMaxAttempts: z.number().int().min(0).max(20).nullable().optional(),
    retryBackoffMs: z.number().int().min(0).max(600000).nullable().optional(),
    maxLiveLotCeiling: z.number().min(0).max(100).nullable().optional(),
    closeCommandSupportEnabled: z.boolean().nullable().optional(),
    maintenanceMode: z.boolean().optional(),
    allowedCommandTypes: z.array(z.enum(EA_REMOTE_CONFIG_COMMAND_TYPES)).optional(),
    reason: z.string().optional(),
  })
  .strict(); // unknown keys (incl. any protected field) → parse error.

// GET /api/admin/ea/remote-config/:userId
router.get("/admin/ea/remote-config/:userId", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) {
    res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
    return;
  }
  const [row] = await db
    .select()
    .from(eaRemoteConfigTable)
    .where(eq(eaRemoteConfigTable.userId, userId))
    .limit(1);
  res.json({ ok: true, config: row ?? null });
});

// PUT /api/admin/ea/remote-config/:userId — audited, fail-closed, protected-safe.
router.put("/admin/ea/remote-config/:userId", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const adminId = getAdminId(req);
  const userId = Number(req.params.userId);
  if (!Number.isFinite(userId)) {
    res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
    return;
  }
  const reason = readReason(req.body);
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED_MIN_3_CHARS" });
    return;
  }

  // HARD protected-field guard — refuse before any parse/persist.
  try {
    assertNoProtectedFields(req.body);
  } catch (e) {
    res.status(400).json({
      ok: false,
      error: "PROTECTED_FIELD_REJECTED",
      detail: e instanceof Error ? e.message : String(e),
    });
    return;
  }

  const parsed = remoteConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_CONFIG", detail: parsed.error.message });
    return;
  }
  const { reason: _r, ...incoming } = parsed.data;

  // Second pass: only allow-listed keys survive (defence in depth).
  const { clean, violations } = sanitiseRemoteConfig(incoming);
  if (violations.length > 0) {
    res.status(400).json({ ok: false, error: "PROTECTED_FIELD_REJECTED" });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(eaRemoteConfigTable)
        .where(eq(eaRemoteConfigTable.userId, userId))
        .limit(1);

      let saved;
      if (existing) {
        [saved] = await tx
          .update(eaRemoteConfigTable)
          .set({
            ...clean,
            configVersion: existing.configVersion + 1,
            updateReason: reason,
            updatedByAdminId: adminId,
            updatedAt: new Date(),
          })
          .where(eq(eaRemoteConfigTable.id, existing.id))
          .returning();
      } else {
        [saved] = await tx
          .insert(eaRemoteConfigTable)
          .values({
            userId,
            ...clean,
            configVersion: 1,
            updateReason: reason,
            updatedByAdminId: adminId,
          })
          .returning();
      }

      await writeAudit(
        {
          adminId,
          role,
          action: "EA_REMOTE_CONFIG_SET",
          targetUserId: userId,
          reason,
          beforeState: existing ?? {},
          afterState: saved ?? {},
          ipAddress: clientIp(req),
        },
        tx,
      );
      return saved;
    });
    res.json({ ok: true, config: result });
  } catch (e) {
    res.status(500).json({ ok: false, error: "EA_REMOTE_CONFIG_WRITE_FAILED", detail: String(e) });
  }
});

// ═══ Update manifest workflow ════════════════════════════════════════════════

const createManifestSchema = z.object({
  version: z.string().min(1).max(40),
  channel: z.enum(EA_UPDATE_CHANNELS).default("stable"),
  minimumVersion: z.string().max(40).optional(),
  manifestJson: z.record(z.string(), z.unknown()).optional(),
  changelog: z.string().max(20000).optional(),
  sha256Checksum: z.string().regex(/^[a-fA-F0-9]{64}$/, "sha256 must be 64 hex chars"),
  signature: z.string().max(4000).optional(),
  downloadUrl: z.string().url().max(2000),
  rollbackVersion: z.string().max(40).optional(),
  isUpdaterCapable: z.boolean().default(false),
  notes: z.string().max(4000).optional(),
  reason: z.string(),
});

// POST /api/admin/ea/manifests — create draft.
router.post("/admin/ea/manifests", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const adminId = getAdminId(req);
  const reason = readReason(req.body);
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED_MIN_3_CHARS" });
    return;
  }
  const parsed = createManifestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "INVALID_MANIFEST", detail: parsed.error.message });
    return;
  }
  const d = parsed.data;
  try {
    const result = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(eaUpdateManifestTable)
        .values({
          version: d.version,
          channel: d.channel,
          minimumVersion: d.minimumVersion ?? null,
          manifestJson: d.manifestJson ?? {},
          changelog: d.changelog ?? null,
          sha256Checksum: d.sha256Checksum.toLowerCase(),
          signature: d.signature ?? null,
          downloadUrl: d.downloadUrl,
          rollbackVersion: d.rollbackVersion ?? null,
          isUpdaterCapable: d.isUpdaterCapable,
          notes: d.notes ?? null,
          releaseStatus: "draft",
          createdByAdminId: adminId,
        })
        .returning();
      await writeAudit(
        {
          adminId,
          role,
          action: "EA_UPDATE_MANIFEST_CREATE",
          targetUserId: null,
          reason,
          afterState: created ?? {},
          ipAddress: clientIp(req),
        },
        tx,
      );
      return created;
    });
    res.json({ ok: true, manifest: result });
  } catch (e) {
    // Unique (channel, version) violation surfaces here.
    res.status(409).json({ ok: false, error: "MANIFEST_CREATE_FAILED", detail: String(e) });
  }
});

// GET /api/admin/ea/manifests — list (optionally by channel/status).
router.get("/admin/ea/manifests", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const rows = await db
    .select()
    .from(eaUpdateManifestTable)
    .orderBy(desc(eaUpdateManifestTable.createdAt));
  res.json({ ok: true, manifests: rows });
});

// Shared status-transition handler for stage/approve/revoke.
type ManifestAction = "stage" | "approve" | "revoke";
const TRANSITIONS: Record<ManifestAction, { from: string[]; to: string; auditAction: string }> = {
  stage: { from: ["draft"], to: "staged", auditAction: "EA_UPDATE_MANIFEST_STAGE" },
  approve: { from: ["staged"], to: "approved", auditAction: "EA_UPDATE_MANIFEST_APPROVE" },
  // A manifest can be revoked from any non-revoked state.
  revoke: { from: ["draft", "staged", "approved"], to: "revoked", auditAction: "EA_UPDATE_MANIFEST_REVOKE" },
};

async function runTransition(action: ManifestAction, req: Request, res: Response): Promise<void> {
  const role = requireAdmin(req, res);
  if (!role) return;
  const adminId = getAdminId(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ ok: false, error: "INVALID_MANIFEST_ID" });
    return;
  }
  const reason = readReason(req.body);
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED_MIN_3_CHARS" });
    return;
  }
  const t = TRANSITIONS[action];
  try {
    const result = await db.transaction(async (tx) => {
      const [existing] = await tx
        .select()
        .from(eaUpdateManifestTable)
        .where(eq(eaUpdateManifestTable.id, id))
        .limit(1);
      if (!existing) return { notFound: true as const };
      if (!t.from.includes(existing.releaseStatus)) {
        return { invalid: true as const, current: existing.releaseStatus };
      }
      const now = new Date();
      const patch: Record<string, unknown> = {
        releaseStatus: t.to,
        updatedAt: now,
      };
      if (action === "stage") {
        patch.stagedByAdminId = adminId;
        patch.stagedAt = now;
      } else if (action === "approve") {
        patch.approvedByAdminId = adminId;
        patch.approvedAt = now;
      } else {
        patch.revokedByAdminId = adminId;
        patch.revokedAt = now;
        patch.revokedReason = reason;
      }
      const [updated] = await tx
        .update(eaUpdateManifestTable)
        .set(patch)
        .where(eq(eaUpdateManifestTable.id, id))
        .returning();
      await writeAudit(
        {
          adminId,
          role,
          action: t.auditAction,
          targetUserId: null,
          reason,
          beforeState: existing,
          afterState: updated ?? {},
          ipAddress: clientIp(req),
        },
        tx,
      );
      return { manifest: updated };
    });
    if ("notFound" in result) {
      res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND" });
      return;
    }
    if ("invalid" in result) {
      res.status(409).json({
        ok: false,
        error: "INVALID_STATUS_TRANSITION",
        detail: `Cannot ${action} a manifest in status "${result.current}".`,
      });
      return;
    }
    res.json({ ok: true, manifest: result.manifest });
  } catch (e) {
    res.status(500).json({ ok: false, error: "MANIFEST_TRANSITION_FAILED", detail: String(e) });
  }
}

router.post("/admin/ea/manifests/:id/stage", (req, res) => runTransition("stage", req, res));
router.post("/admin/ea/manifests/:id/approve", (req, res) => runTransition("approve", req, res));
router.post("/admin/ea/manifests/:id/revoke", (req, res) => runTransition("revoke", req, res));

// POST /api/admin/ea/manifests/:id/rollback — operator rollback, distinct from
// revoke. Reverts the CURRENTLY-APPROVED manifest back to its declared
// `rollbackVersion` (same channel): the current approved release is revoked AND
// the prior version is re-promoted to `approved` in one audited transaction, so
// the EA's next update-check is served the previous good build. This is a
// reversion of the served release, not a one-way kill. Safety surfaces are
// untouched — the EA still only ever applies an `approved`, in-channel, newer,
// checksum-verified manifest through `evaluateEaUpdateGate`; rollback merely
// changes WHICH approved manifest is current.
router.post("/admin/ea/manifests/:id/rollback", async (req, res): Promise<void> => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const adminId = getAdminId(req);
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) {
    res.status(400).json({ ok: false, error: "INVALID_MANIFEST_ID" });
    return;
  }
  const reason = readReason(req.body);
  if (!reason) {
    res.status(400).json({ ok: false, error: "REASON_REQUIRED_MIN_3_CHARS" });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(eaUpdateManifestTable)
        .where(eq(eaUpdateManifestTable.id, id))
        .limit(1);
      if (!current) return { notFound: true as const };
      if (current.releaseStatus !== "approved") {
        return { notApproved: true as const, current: current.releaseStatus };
      }
      if (!current.rollbackVersion) {
        return { noRollbackTarget: true as const };
      }
      const [target] = await tx
        .select()
        .from(eaUpdateManifestTable)
        .where(
          and(
            eq(eaUpdateManifestTable.channel, current.channel),
            eq(eaUpdateManifestTable.version, current.rollbackVersion),
          ),
        )
        .limit(1);
      if (!target) return { targetMissing: true as const, wanted: current.rollbackVersion };
      const now = new Date();
      const [revoked] = await tx
        .update(eaUpdateManifestTable)
        .set({
          releaseStatus: "revoked",
          revokedByAdminId: adminId,
          revokedAt: now,
          revokedReason: `ROLLBACK: ${reason}`,
          updatedAt: now,
        })
        .where(eq(eaUpdateManifestTable.id, current.id))
        .returning();
      const [promoted] = await tx
        .update(eaUpdateManifestTable)
        .set({
          releaseStatus: "approved",
          approvedByAdminId: adminId,
          approvedAt: now,
          revokedByAdminId: null,
          revokedAt: null,
          revokedReason: null,
          updatedAt: now,
        })
        .where(eq(eaUpdateManifestTable.id, target.id))
        .returning();
      await writeAudit(
        {
          adminId,
          role,
          action: "EA_UPDATE_MANIFEST_ROLLBACK",
          targetUserId: null,
          reason,
          beforeState: current,
          afterState: { revoked: revoked ?? {}, promoted: promoted ?? {} },
          ipAddress: clientIp(req),
        },
        tx,
      );
      return { revoked, promoted };
    });
    if ("notFound" in result) {
      res.status(404).json({ ok: false, error: "MANIFEST_NOT_FOUND" });
      return;
    }
    if ("notApproved" in result) {
      res.status(409).json({
        ok: false,
        error: "ROLLBACK_REQUIRES_APPROVED_MANIFEST",
        detail: `Only the currently-approved manifest can be rolled back (status="${result.current}").`,
      });
      return;
    }
    if ("noRollbackTarget" in result) {
      res.status(409).json({
        ok: false,
        error: "NO_ROLLBACK_VERSION_DECLARED",
        detail: "This manifest has no rollbackVersion to revert to.",
      });
      return;
    }
    if ("targetMissing" in result) {
      res.status(409).json({
        ok: false,
        error: "ROLLBACK_TARGET_NOT_FOUND",
        detail: `No manifest found for rollbackVersion "${result.wanted}" in this channel.`,
      });
      return;
    }
    res.json({ ok: true, revoked: result.revoked, promoted: result.promoted });
  } catch (e) {
    res.status(500).json({ ok: false, error: "MANIFEST_ROLLBACK_FAILED", detail: String(e) });
  }
});

// GET /api/admin/ea/update-reports — recent EA self-update lifecycle reports.
router.get("/admin/ea/update-reports", async (req, res) => {
  const role = requireAdmin(req, res);
  if (!role) return;
  const rows = await db
    .select()
    .from(eaUpdateReportTable)
    .orderBy(desc(eaUpdateReportTable.reportedAt))
    .limit(200);
  res.json({ ok: true, reports: rows });
});

export default router;
