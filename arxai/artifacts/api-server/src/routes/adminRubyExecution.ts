// Admin — Ruby Execution visibility + authority override (Task #319)
//
// Read surface over the `ruby_commands` ledger plus an explicit per-user
// authority override. This is OBSERVABILITY + an admin control knob — it is
// NEVER an execution path. Nothing here dispatches a trade; every Ruby trade
// still flows through the existing instant-trade router → 16-gate dispatch.
//
// Routes:
//   GET  /api/admin/ruby-execution/commands            — recent ledger (DTO)
//   POST /api/admin/ruby-execution/users/:userId/authority
//                                                       — set OFF/ADVISE_ONLY/
//                                                         AI_ASSISTED (AI_AUTO
//                                                         is rejected — defined,
//                                                         not enabled)
//
// SAFETY:
//   - Every handler is requireAdmin (admin-previewing-as-user lands in 403 via
//     the effective-role check, consistent with other operator endpoints).
//   - The list DTO redacts idempotency keys and fingerprints and truncates the
//     raw user command — never returns internal dispatch secrets.
//   - The authority override writes the legacy boolean in lockstep and audits
//     every change with a reason.
import express, { type IRouter, Router, type Request, type Response } from "express";
import { and, desc, eq } from "drizzle-orm";
import {
  db,
  rubyCommandsTable,
  userOneClickSettingsTable,
  adminActionAuditLogTable,
  usersTable,
} from "@workspace/db";

const router: IRouter = Router();
router.use(express.json());

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const sess = (req as Request & { authUser?: { id: number; role?: string } }).authUser;
  if (!sess?.id) {
    res.status(401).json({ ok: false, error: "AUTH_REQUIRED" });
    return null;
  }
  const role = sess.role ?? null;
  if (role !== "ADMIN" && role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: sess.id, role };
}

// Authority values the admin may set. AI_AUTO is intentionally absent — it is
// defined in the data model but not enabled in this build.
const SETTABLE_AUTHORITIES = ["OFF", "ADVISE_ONLY", "AI_ASSISTED"] as const;

// GET /api/admin/ruby-execution/commands
// Recent Ruby command ledger across all users (newest first). Optional filters:
//   ?userId=<n>  ?status=<STATUS>  ?limit=<1..200>
router.get("/admin/ruby-execution/commands", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const limit = Math.min(Math.max(Number(req.query.limit ?? 100) || 100, 1), 200);
  const filters = [] as ReturnType<typeof eq>[];
  const uid = Number(req.query.userId);
  if (Number.isInteger(uid) && uid > 0) filters.push(eq(rubyCommandsTable.userId, uid));
  const status = typeof req.query.status === "string" ? req.query.status.toUpperCase() : null;
  if (status) filters.push(eq(rubyCommandsTable.status, status));

  const rows = await db.select().from(rubyCommandsTable)
    .where(filters.length ? and(...filters) : undefined)
    .orderBy(desc(rubyCommandsTable.id))
    .limit(limit);

  // Redacted DTO — no idempotency key, no fingerprint, capped raw command.
  const commands = rows.map((r) => ({
    id: r.id,
    userId: r.userId,
    accountMode: r.accountMode,
    source: r.source,
    commandKind: r.commandKind,
    symbol: r.symbol,
    action: r.action,
    status: r.status,
    handshakeStatus: r.handshakeStatus,
    liveCommandId: r.liveCommandId,
    brokerTicket: r.brokerTicket,
    retcode: r.retcode,
    blockReason: r.blockReason,
    errorReason: r.errorReason,
    resultDetail: r.resultDetail ? r.resultDetail.slice(0, 240) : null,
    rawUserCommandPreview: r.rawUserCommand ? r.rawUserCommand.slice(0, 120) : null,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  }));

  return res.json({ ok: true, count: commands.length, commands });
});

// POST /api/admin/ruby-execution/users/:userId/authority
// Body: { authority: "OFF"|"ADVISE_ONLY"|"AI_ASSISTED", reason: string }
router.post("/admin/ruby-execution/users/:userId/authority", async (req, res) => {
  const admin = requireAdmin(req, res); if (!admin) return;

  const userId = Number(req.params.userId);
  if (!Number.isInteger(userId) || userId <= 0) {
    return res.status(400).json({ ok: false, error: "INVALID_USER_ID" });
  }
  const body = (req.body ?? {}) as { authority?: string; reason?: string };
  const authority = (body.authority ?? "").trim().toUpperCase();
  const reason = (body.reason ?? "").trim();
  if (!SETTABLE_AUTHORITIES.includes(authority as (typeof SETTABLE_AUTHORITIES)[number])) {
    // Reject AI_AUTO explicitly with an honest reason.
    return res.status(400).json({
      ok: false,
      error: authority === "AI_AUTO" ? "AI_AUTO_NOT_ENABLED" : "INVALID_RUBY_AUTHORITY",
    });
  }
  if (reason.length < 3) {
    return res.status(400).json({ ok: false, error: "REASON_REQUIRED" });
  }

  const [target] = await db.select({ id: usersTable.id }).from(usersTable)
    .where(eq(usersTable.id, userId)).limit(1);
  if (!target) return res.status(404).json({ ok: false, error: "USER_NOT_FOUND" });

  const aiEnabled = authority === "AI_ASSISTED";
  const [before] = await db.select({
    authority: userOneClickSettingsTable.rubyExecutionAuthority,
    aiEnabled: userOneClickSettingsTable.aiInstantTradeCommandsEnabled,
  }).from(userOneClickSettingsTable)
    .where(eq(userOneClickSettingsTable.userId, userId)).limit(1);

  // Fail-closed: the privileged change and its audit row commit together. If
  // the audit write fails, the authority change is rolled back so a mutation
  // can never apply without an accompanying audit record.
  try {
    await db.transaction(async (tx) => {
      await tx.insert(userOneClickSettingsTable)
        .values({ userId, rubyExecutionAuthority: authority, aiInstantTradeCommandsEnabled: aiEnabled })
        .onConflictDoUpdate({
          target: userOneClickSettingsTable.userId,
          set: { rubyExecutionAuthority: authority, aiInstantTradeCommandsEnabled: aiEnabled, updatedAt: new Date() },
        });
      await tx.insert(adminActionAuditLogTable).values({
        adminId: admin.id,
        adminRole: admin.role,
        action: "RUBY_AUTHORITY_ADMIN_OVERRIDE",
        targetUserId: userId,
        beforeState: { authority: before?.authority ?? null, aiEnabled: before?.aiEnabled ?? null },
        afterState: { authority, aiEnabled, reason },
      });
    });
  } catch (err) {
    (req as Request & { log?: { error: (o: unknown, m?: string) => void } }).log?.error(
      { err: (err as Error).message, targetUserId: userId },
      "admin_ruby_authority_override_failed",
    );
    return res.status(500).json({ ok: false, error: "AUTHORITY_OVERRIDE_FAILED" });
  }

  return res.json({ ok: true, userId, rubyExecutionAuthority: authority, aiInstantTradeCommandsEnabled: aiEnabled });
});

export { router as adminRubyExecutionRouter };
export default router;
