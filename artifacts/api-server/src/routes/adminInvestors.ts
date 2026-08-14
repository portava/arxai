// Admin Investor Management (Task #72).
//
// SAFETY (inviolable):
// - Admin-only (role ∈ {ADMIN, OWNER}). Admin-previewing-as-user is downgraded
//   by the upstream product-role gate and lands in the 403 branch here too.
// - Every mutation is FAIL-CLOSED audited: the mutation and its
//   admin_action_audit_log row are written inside ONE db.transaction. If the
//   audit insert fails, the mutation rolls back.
// - These routes NEVER touch any execution path, lot sizing, the 16-gate live
//   pipeline, kill switch, or any broker surface. Allocation approval flips an
//   intent-only preference row to ACTIVE — it does not size or place anything.
// - NO guaranteed / fixed / risk-free return wording anywhere.

import { randomUUID } from "node:crypto";
import { Router, type Request, type Response } from "express";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";
import {
  db,
  usersTable,
  adminActionAuditLogTable,
  investorProfilesTable,
  investorLedgerEntriesTable,
  investorPerformanceBatchesTable,
  investorAllocationPreferencesTable,
  investorStrategyProfilesTable,
  investorAllocationSettingsTable,
  investorStatementsTable,
  investorStatementEventsTable,
} from "@workspace/db";
import { requireUser } from "../lib/auth/middleware.js";
import {
  ensureSettings,
  ensureStrategyProfiles,
  getProfile,
  getLedger,
  getPreferences,
  computeMetrics,
  computeBulkPerformanceAmount,
  bulkPerformanceReason,
  reversalPerformanceReason,
  activePref,
  prefToDto,
  countPendingRequests,
  round2,
} from "../lib/investor/investorService.js";
import {
  objectStorageService,
  safelyDeleteUnreferencedStatementObject,
  setStatementFileAcl,
  streamStatementFile,
  validateStatementFileObject,
} from "../lib/investor/statementFiles.js";

const router = Router();

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function requireAdmin(req: Request, res: Response): { id: number; role: "ADMIN" | "OWNER" } | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  if (!u?.id) { res.status(401).json({ ok: false, error: "AUTH_REQUIRED" }); return null; }
  if (u.role !== "ADMIN" && u.role !== "OWNER") {
    res.status(403).json({ ok: false, error: "ADMIN_REQUIRED" });
    return null;
  }
  return { id: u.id, role: u.role };
}

async function auditInTx(
  tx: Tx,
  args: {
    admin: { id: number; role: "ADMIN" | "OWNER" };
    action: string;
    targetUserId: number | null;
    beforeState: Record<string, unknown>;
    afterState: Record<string, unknown>;
    reason?: string | null;
    ipAddress?: string | null;
  },
) {
  await tx.insert(adminActionAuditLogTable).values({
    adminId: args.admin.id,
    adminRole: args.admin.role,
    action: args.action,
    targetUserId: args.targetUserId,
    beforeState: args.beforeState,
    afterState: args.afterState,
    reason: args.reason ?? null,
    ipAddress: args.ipAddress ?? null,
  });
}

// Task #101 — statement lifecycle transition. Applies a status change to one
// statement INSIDE a transaction, writing (a) the mirrored status fields on the
// statement row, (b) an append-only investor_statement_events row (investor-
// readable transparency record), and (c) the fail-closed admin_action_audit_log
// row. All three succeed together or the whole change rolls back. NEVER touches
// any execution / live / broker surface.
type StatementRow = typeof investorStatementsTable.$inferSelect;
async function applyStatementStatusChange(
  tx: Tx,
  args: {
    admin: { id: number; role: "ADMIN" | "OWNER" };
    userId: number;
    statement: StatementRow;
    action: "CORRECT" | "REPLACE" | "REMOVE" | "RESTORE" | "SUPERSEDE";
    newStatus: string;
    reason: string;
    // undefined = leave replacement unchanged; null = clear it; number = set it.
    replacementStatementId?: number | null;
    ipAddress?: string | null;
  },
) {
  const { admin, userId, statement, action, newStatus, reason } = args;
  const now = new Date();
  const replacement =
    args.replacementStatementId === undefined
      ? statement.replacementStatementId ?? null
      : args.replacementStatementId;

  await tx
    .update(investorStatementsTable)
    .set({
      status: newStatus,
      statusReason: reason,
      statusChangedAt: now,
      statusChangedByAdminId: admin.id,
      replacementStatementId: replacement,
    })
    .where(
      and(
        eq(investorStatementsTable.id, statement.id),
        eq(investorStatementsTable.userId, userId),
      ),
    );

  await tx.insert(investorStatementEventsTable).values({
    userId,
    statementId: statement.id,
    action,
    previousStatus: statement.status,
    newStatus,
    reason,
    replacementStatementId: replacement,
    createdByAdminId: admin.id,
  });

  await auditInTx(tx, {
    admin,
    action: `INVESTOR_STATEMENT_STATUS_${action}`,
    targetUserId: userId,
    beforeState: { status: statement.status, title: statement.title },
    afterState: { status: newStatus, replacementStatementId: replacement },
    reason,
    ipAddress: args.ipAddress ?? null,
  });
}

// Build the full investor-detail DTO (admin view) for a given user id.
async function buildDetail(userId: number) {
  const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
  if (!user) return null;
  const [profile, ledger, prefs] = await Promise.all([
    getProfile(userId),
    getLedger(userId),
    getPreferences(userId),
  ]);
  const m = computeMetrics(ledger);
  const active = activePref(prefs);

  const statements = await db
    .select()
    .from(investorStatementsTable)
    .where(eq(investorStatementsTable.userId, userId))
    .orderBy(desc(investorStatementsTable.createdAt))
    .limit(100);

  const statementEventRows = await db
    .select()
    .from(investorStatementEventsTable)
    .where(eq(investorStatementEventsTable.userId, userId))
    .orderBy(desc(investorStatementEventsTable.createdAt))
    .limit(200);

  const auditRows = await db
    .select({
      id: adminActionAuditLogTable.id,
      action: adminActionAuditLogTable.action,
      adminId: adminActionAuditLogTable.adminId,
      adminRole: adminActionAuditLogTable.adminRole,
      reason: adminActionAuditLogTable.reason,
      createdAt: adminActionAuditLogTable.createdAt,
    })
    .from(adminActionAuditLogTable)
    .where(
      and(
        eq(adminActionAuditLogTable.targetUserId, userId),
        sql`${adminActionAuditLogTable.action} LIKE 'INVESTOR_%'`,
      ),
    )
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(100);

  return {
    ok: true as const,
    userId,
    email: user.email ?? null,
    displayName: profile?.displayName ?? null,
    status: profile?.status ?? "active",
    baseCurrency: profile?.baseCurrency ?? "USD",
    currentValue: m.currentValue,
    depositedTotal: m.depositedTotal,
    withdrawnTotal: m.withdrawnTotal,
    currentRiskProfile: active?.profileKey ?? profile?.currentRiskProfile ?? null,
    pausedReason: profile?.pausedReason ?? null,
    ledger: ledger.map((e) => ({
      id: e.id,
      entryType: e.entryType,
      signedAmount: round2(Number(e.signedAmount)),
      currency: e.currency,
      reason: e.reason,
      createdAt: e.createdAt.toISOString(),
    })),
    allocations: prefs.map(prefToDto),
    statements: statements.map((s) => ({
      id: s.id,
      title: s.title,
      periodLabel: s.periodLabel ?? null,
      statementType: s.statementType,
      summary: s.summary ?? null,
      fileUrl: s.fileUrl ?? null,
      status: s.status,
      statusReason: s.statusReason ?? null,
      statusChangedAt: s.statusChangedAt ? s.statusChangedAt.toISOString() : null,
      replacementStatementId: s.replacementStatementId ?? null,
      createdAt: s.createdAt.toISOString(),
    })),
    statementEvents: statementEventRows.map((e) => ({
      id: e.id,
      statementId: e.statementId,
      action: e.action,
      previousStatus: e.previousStatus ?? null,
      newStatus: e.newStatus,
      reason: e.reason,
      replacementStatementId: e.replacementStatementId ?? null,
      adminId: e.createdByAdminId ?? null,
      createdAt: e.createdAt.toISOString(),
    })),
    audit: auditRows.map((a) => ({
      id: a.id,
      action: a.action,
      adminId: a.adminId ?? null,
      adminRole: a.adminRole ?? null,
      reason: a.reason ?? null,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}

// ── GET /admin/investors ────────────────────────────────────────────────────
router.get("/admin/investors", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const profiles = await db.select().from(investorProfilesTable);
  const investors = await Promise.all(
    profiles.map(async (p) => {
      const [user] = await db.select().from(usersTable).where(eq(usersTable.id, p.userId)).limit(1);
      const ledger = await getLedger(p.userId);
      const prefs = await getPreferences(p.userId);
      const m = computeMetrics(ledger);
      const active = activePref(prefs);
      const pendingRequests = await countPendingRequests(p.userId);
      return {
        userId: p.userId,
        email: user?.email ?? null,
        displayName: p.displayName ?? null,
        status: p.status,
        baseCurrency: p.baseCurrency,
        currentValue: m.currentValue,
        currentRiskProfile: active?.profileKey ?? p.currentRiskProfile ?? null,
        pendingRequests,
        createdAt: p.createdAt.toISOString(),
      };
    }),
  );
  investors.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
  res.json({ ok: true, investors });
});

// ── GET /admin/investors/:id ────────────────────────────────────────────────
router.get("/admin/investors/:id", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const detail = await buildDetail(id);
  if (!detail) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }
  res.json(detail);
});

// ── POST /admin/investors — create or link an investor ──────────────────────
const createSchema = z.object({
  email: z.string().min(3),
  displayName: z.string().optional(),
  baseCurrency: z.string().optional(),
  reason: z.string().optional(),
});

router.post("/admin/investors", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid investor input." });
    return;
  }
  const email = parsed.data.email.trim().toLowerCase();
  const displayName = parsed.data.displayName?.trim() || null;
  const baseCurrency = parsed.data.baseCurrency?.trim().toUpperCase() || "USD";

  const [user] = await db.select().from(usersTable).where(eq(usersTable.email, email)).limit(1);
  if (!user) {
    res.status(400).json({
      ok: false,
      error: "USER_NOT_FOUND",
      message: "No account exists with that email. The investor must register first, then be linked here.",
    });
    return;
  }

  const existingProfile = await getProfile(user.id);

  try {
    await db.transaction(async (tx) => {
      const beforeRole = user.role;
      // Promote the linked account to the INVESTOR product role (view-only).
      await tx.update(usersTable).set({ role: "INVESTOR" }).where(eq(usersTable.id, user.id));

      if (existingProfile) {
        await tx
          .update(investorProfilesTable)
          .set({
            displayName: displayName ?? existingProfile.displayName,
            baseCurrency,
            linkedByAdminId: admin.id,
          })
          .where(eq(investorProfilesTable.userId, user.id));
      } else {
        await tx.insert(investorProfilesTable).values({
          userId: user.id,
          displayName,
          baseCurrency,
          status: "active",
          linkedByAdminId: admin.id,
        });
      }

      await auditInTx(tx, {
        admin,
        action: existingProfile ? "INVESTOR_LINK_UPDATE" : "INVESTOR_CREATE",
        targetUserId: user.id,
        beforeState: { role: beforeRole, hadProfile: Boolean(existingProfile) },
        afterState: { role: "INVESTOR", displayName, baseCurrency },
        reason: parsed.data.reason ?? null,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not create investor." });
    return;
  }

  const detail = await buildDetail(user.id);
  res.json(detail);
});

// ── POST /admin/investors/bulk-performance ──────────────────────────────────
// Post a fund's periodic (typically monthly) PERFORMANCE figure to many
// investors in one action. Two honest modes:
//   FIXED    — credit the same signed figure to every selected investor.
//   PRO_RATA — credit `value`% of each investor's current account value.
// Each investor gets ONE INVESTOR_LEDGER_PERFORMANCE row, individually
// attributed, dated, and FAIL-CLOSED audited in its OWN transaction (ledger
// insert + audit row succeed together or that investor rolls back). One
// investor failing never rolls back the others — the result reports honest
// per-investor POSTED / SKIPPED / FAILED states. Nothing is projected or
// guaranteed; a PRO_RATA figure on a non-positive base is SKIPPED, not invented.
const bulkPerformanceSchema = z.object({
  periodLabel: z.string().min(1),
  mode: z.enum(["FIXED", "PRO_RATA"]),
  value: z.number(),
  currency: z.string().optional(),
  reason: z.string().min(3),
  userIds: z.array(z.number().int()).min(1),
});

router.post("/admin/investors/bulk-performance", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const parsed = bulkPerformanceSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid bulk performance input." });
    return;
  }
  const { periodLabel, mode, value, reason } = parsed.data;
  if (mode === "FIXED" && round2(value) === 0) {
    res.status(400).json({ ok: false, error: "ZERO_AMOUNT", message: "A fixed figure must be non-zero." });
    return;
  }
  // De-duplicate target ids, preserving order.
  const userIds = [...new Set(parsed.data.userIds)];
  const fullReason = bulkPerformanceReason(periodLabel, reason);
  // Stable batch id grouping every PERFORMANCE row this post writes, so the
  // batch can later be listed and reversed as one unit (Task #107).
  const batchId = randomUUID();
  const currencyOverride = parsed.data.currency?.trim().toUpperCase() || null;

  const results: Array<{
    userId: number;
    email: string | null;
    displayName: string | null;
    amount: number;
    currency: string | null;
    status: "POSTED" | "SKIPPED_ZERO" | "SKIPPED_NOT_FOUND" | "FAILED";
  }> = [];

  for (const userId of userIds) {
    const profile = await getProfile(userId);
    if (!profile) {
      results.push({ userId, email: null, displayName: null, amount: 0, currency: null, status: "SKIPPED_NOT_FOUND" });
      continue;
    }
    const [user] = await db.select().from(usersTable).where(eq(usersTable.id, userId)).limit(1);
    const email = user?.email ?? null;
    const currency = currencyOverride || profile.baseCurrency;

    let base = 0;
    if (mode === "PRO_RATA") {
      const ledger = await getLedger(userId);
      base = computeMetrics(ledger).currentValue;
    }
    const amount = computeBulkPerformanceAmount(mode, value, base);

    if (round2(amount) === 0) {
      results.push({ userId, email, displayName: profile.displayName ?? null, amount: 0, currency, status: "SKIPPED_ZERO" });
      continue;
    }

    try {
      await db.transaction(async (tx) => {
        await tx.insert(investorLedgerEntriesTable).values({
          userId,
          entryType: "PERFORMANCE",
          signedAmount: amount,
          currency,
          reason: fullReason,
          createdByAdminId: admin.id,
          batchId,
        });
        await auditInTx(tx, {
          admin,
          action: "INVESTOR_LEDGER_PERFORMANCE",
          targetUserId: userId,
          beforeState: {},
          afterState: { entryType: "PERFORMANCE", signedAmount: round2(amount), currency, periodLabel, mode, batchId },
          reason: fullReason,
          ipAddress: req.ip ?? null,
        });
      });
      results.push({ userId, email, displayName: profile.displayName ?? null, amount: round2(amount), currency, status: "POSTED" });
    } catch {
      results.push({ userId, email, displayName: profile.displayName ?? null, amount: round2(amount), currency, status: "FAILED" });
    }
  }

  const postedCount = results.filter((r) => r.status === "POSTED").length;
  const failedCount = results.filter((r) => r.status === "FAILED").length;
  const skippedCount = results.filter((r) => r.status === "SKIPPED_ZERO" || r.status === "SKIPPED_NOT_FOUND").length;

  // Record the batch grouping (Task #107). Only persist a batch record when at
  // least one row was actually posted — an all-skipped/failed run wrote no
  // PERFORMANCE rows, so there is nothing to list or reverse. Fail-closed
  // audited; if it throws the posted rows still stand (each is individually
  // audited) and the response stays honest.
  let recordedBatchId: string | null = null;
  if (postedCount > 0) {
    try {
      await db.transaction(async (tx) => {
        await tx.insert(investorPerformanceBatchesTable).values({
          batchId,
          periodLabel,
          mode,
          value: round2(value),
          currency: currencyOverride,
          reason,
          postedCount,
          skippedCount,
          failedCount,
          status: "ACTIVE",
          isReversal: false,
          createdByAdminId: admin.id,
        });
        await auditInTx(tx, {
          admin,
          action: "INVESTOR_PERFORMANCE_BATCH_POST",
          targetUserId: null,
          beforeState: {},
          afterState: { batchId, periodLabel, mode, value: round2(value), postedCount, skippedCount, failedCount },
          reason: fullReason,
          ipAddress: req.ip ?? null,
        });
      });
      recordedBatchId = batchId;
    } catch (err) {
      req.log.error({ err: String(err), batchId }, "bulk-performance batch record insert failed");
    }
  }

  res.json({
    ok: true,
    batchId: recordedBatchId,
    periodLabel,
    mode,
    postedCount,
    skippedCount,
    failedCount,
    results,
  });
});

// ── GET /admin/investors/performance-batches ────────────────────────────────
// List every bulk-performance batch (Task #107), newest first, so an admin can
// see "what was posted in this batch" (period label, mode, figure, who/when,
// posted/skipped/failed counts) and whether it has been reversed. Read-only.
function batchToDto(b: typeof investorPerformanceBatchesTable.$inferSelect) {
  return {
    batchId: b.batchId,
    periodLabel: b.periodLabel,
    mode: b.mode,
    value: round2(Number(b.value)),
    currency: b.currency ?? null,
    reason: b.reason,
    postedCount: b.postedCount,
    skippedCount: b.skippedCount,
    failedCount: b.failedCount,
    status: b.status,
    isReversal: b.isReversal,
    reversesBatchId: b.reversesBatchId ?? null,
    reversedByBatchId: b.reversedByBatchId ?? null,
    reversedByAdminId: b.reversedByAdminId ?? null,
    reversedAt: b.reversedAt ? b.reversedAt.toISOString() : null,
    createdByAdminId: b.createdByAdminId,
    createdAt: b.createdAt.toISOString(),
  };
}

router.get("/admin/investors/performance-batches", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const rows = await db
    .select()
    .from(investorPerformanceBatchesTable)
    .orderBy(desc(investorPerformanceBatchesTable.createdAt))
    .limit(200);
  res.json({ ok: true, batches: rows.map(batchToDto) });
});

// ── POST /admin/investors/performance-batches/:batchId/reverse ──────────────
// Reverse a whole bulk-performance batch in one action. NEVER hard-deletes the
// append-only ledger: it writes one offsetting PERFORMANCE row per originally-
// posted investor (the exact negative of what was credited), each individually
// attributed and FAIL-CLOSED audited in its own transaction. The reversal is
// claimed EXACTLY ONCE via a status CAS (UPDATE ... WHERE status='ACTIVE') so a
// double-click or concurrent request can never offset twice. A reversal batch is
// recorded (isReversal=true) and the original is flipped to REVERSED.
const reverseBatchSchema = z.object({ reason: z.string().min(3) });

router.post("/admin/investors/performance-batches/:batchId/reverse", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const batchId = String(req.params.batchId);

  const parsed = reverseBatchSchema.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "A reason (3+ characters) is required." });
    return;
  }
  const reason = parsed.data.reason.trim();

  const [original] = await db
    .select()
    .from(investorPerformanceBatchesTable)
    .where(eq(investorPerformanceBatchesTable.batchId, batchId))
    .limit(1);
  if (!original) {
    res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Batch not found." });
    return;
  }
  if (original.isReversal) {
    res.status(409).json({ ok: false, error: "CANNOT_REVERSE_REVERSAL", message: "A reversal batch cannot itself be reversed." });
    return;
  }
  if (original.status !== "ACTIVE") {
    res.status(409).json({ ok: false, error: "ALREADY_REVERSED", message: "This batch has already been reversed." });
    return;
  }

  // The originally-posted investors are exactly the PERFORMANCE rows tagged with
  // this batch id.
  const postedRows = await db
    .select()
    .from(investorLedgerEntriesTable)
    .where(
      and(
        eq(investorLedgerEntriesTable.batchId, batchId),
        eq(investorLedgerEntriesTable.entryType, "PERFORMANCE"),
      ),
    );
  if (postedRows.length === 0) {
    res.status(409).json({ ok: false, error: "NOTHING_TO_REVERSE", message: "This batch has no posted rows to reverse." });
    return;
  }

  const reversalBatchId = randomUUID();
  const reversalReason = reversalPerformanceReason(original.periodLabel, reason);

  // 1) Claim the reversal EXACTLY ONCE via a status CAS and stamp the original as
  //    REVERSED, and create the reversal batch record — all in one fail-closed
  //    transaction. If the CAS matches no row (already reversed / concurrent),
  //    nothing is written and we return 409.
  let claimed = false;
  try {
    claimed = await db.transaction(async (tx) => {
      const updated = await tx
        .update(investorPerformanceBatchesTable)
        .set({
          status: "REVERSED",
          reversedByBatchId: reversalBatchId,
          reversedByAdminId: admin.id,
          reversedAt: new Date(),
        })
        .where(
          and(
            eq(investorPerformanceBatchesTable.batchId, batchId),
            eq(investorPerformanceBatchesTable.status, "ACTIVE"),
            eq(investorPerformanceBatchesTable.isReversal, false),
          ),
        )
        .returning({ id: investorPerformanceBatchesTable.id });
      if (updated.length === 0) return false;

      await tx.insert(investorPerformanceBatchesTable).values({
        batchId: reversalBatchId,
        periodLabel: original.periodLabel,
        mode: original.mode,
        value: round2(Number(original.value)),
        currency: original.currency,
        reason,
        postedCount: 0,
        skippedCount: 0,
        failedCount: 0,
        status: "ACTIVE",
        isReversal: true,
        reversesBatchId: batchId,
        createdByAdminId: admin.id,
      });

      await auditInTx(tx, {
        admin,
        action: "INVESTOR_PERFORMANCE_BATCH_REVERSE",
        targetUserId: null,
        beforeState: { batchId, status: original.status },
        afterState: { batchId, status: "REVERSED", reversalBatchId, rowsToOffset: postedRows.length },
        reason: reversalReason,
        ipAddress: req.ip ?? null,
      });
      return true;
    });
  } catch (err) {
    req.log.error({ err: String(err), batchId }, "performance batch reverse claim failed");
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not reverse the batch." });
    return;
  }

  if (!claimed) {
    res.status(409).json({ ok: false, error: "ALREADY_REVERSED", message: "This batch has already been reversed." });
    return;
  }

  // 2) Write one offsetting PERFORMANCE row per originally-posted investor, each
  //    in its OWN fail-closed transaction (mirrors the bulk-post path). One
  //    investor failing never rolls back the others.
  let reversedCount = 0;
  let failedCount = 0;
  for (const row of postedRows) {
    const offset = round2(-Number(row.signedAmount));
    try {
      await db.transaction(async (tx) => {
        await tx.insert(investorLedgerEntriesTable).values({
          userId: row.userId,
          entryType: "PERFORMANCE",
          signedAmount: offset,
          currency: row.currency,
          reason: reversalReason,
          createdByAdminId: admin.id,
          batchId: reversalBatchId,
        });
        await auditInTx(tx, {
          admin,
          action: "INVESTOR_LEDGER_PERFORMANCE_REVERSAL",
          targetUserId: row.userId,
          beforeState: { reversesLedgerId: row.id, reversesBatchId: batchId },
          afterState: { entryType: "PERFORMANCE", signedAmount: offset, currency: row.currency, batchId: reversalBatchId },
          reason: reversalReason,
          ipAddress: req.ip ?? null,
        });
      });
      reversedCount += 1;
    } catch (err) {
      req.log.error({ err: String(err), userId: row.userId, batchId }, "performance batch reversal row failed");
      failedCount += 1;
    }
  }

  // 3) Stamp the reversal batch's honest counts (best-effort).
  try {
    await db
      .update(investorPerformanceBatchesTable)
      .set({ postedCount: reversedCount, failedCount })
      .where(eq(investorPerformanceBatchesTable.batchId, reversalBatchId));
  } catch (err) {
    req.log.error({ err: String(err), reversalBatchId }, "reversal batch count update failed");
  }

  res.json({
    ok: true,
    batchId,
    reversalBatchId,
    reversedCount,
    failedCount,
  });
});

// ── POST /admin/investors/:id/ledger ────────────────────────────────────────
// DEPOSIT / WITHDRAWAL / ADJUSTMENT record contributions; PERFORMANCE records a
// real, dated gain/loss figure attributed to the investor (e.g. a monthly
// return credited). PERFORMANCE keeps the caller's sign (a loss is negative)
// and is NEVER counted as a contribution — it feeds realized P/L and the
// headline return %, and moves the equity curve.
const ledgerSchema = z.object({
  entryType: z.enum(["DEPOSIT", "WITHDRAWAL", "ADJUSTMENT", "PERFORMANCE"]),
  amount: z.number(),
  currency: z.string().optional(),
  reason: z.string().min(3),
});

router.post("/admin/investors/:id/ledger", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }

  const parsed = ledgerSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid ledger input." });
    return;
  }
  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const { entryType, reason } = parsed.data;
  const magnitude = Math.abs(parsed.data.amount);
  if (entryType !== "ADJUSTMENT" && magnitude === 0) {
    res.status(400).json({ ok: false, error: "ZERO_AMOUNT", message: "Amount must be non-zero." });
    return;
  }
  // Derive the signed amount from the entry type. DEPOSIT > 0, WITHDRAWAL < 0,
  // ADJUSTMENT keeps the caller's sign.
  let signedAmount: number;
  if (entryType === "DEPOSIT") signedAmount = magnitude;
  else if (entryType === "WITHDRAWAL") signedAmount = -magnitude;
  else signedAmount = parsed.data.amount;

  const currency = parsed.data.currency?.trim().toUpperCase() || profile.baseCurrency;

  try {
    await db.transaction(async (tx) => {
      await tx.insert(investorLedgerEntriesTable).values({
        userId: id,
        entryType,
        signedAmount,
        currency,
        reason,
        createdByAdminId: admin.id,
      });
      await auditInTx(tx, {
        admin,
        action: `INVESTOR_LEDGER_${entryType}`,
        targetUserId: id,
        beforeState: {},
        afterState: { entryType, signedAmount: round2(signedAmount), currency },
        reason,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not record ledger entry." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/allocation/:prefId/approve ────────────────────
const approveSchema = z.object({ note: z.string().optional() });

router.post("/admin/investors/:id/allocation/:prefId/approve", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const prefId = Number(req.params.prefId);
  if (!Number.isInteger(id) || !Number.isInteger(prefId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }
  const parsed = approveSchema.safeParse(req.body ?? {});
  if (!parsed.success) { res.status(400).json({ ok: false, error: "VALIDATION_ERROR" }); return; }

  try {
    const result = await db.transaction(async (tx) => {
      const [pref] = await tx
        .select()
        .from(investorAllocationPreferencesTable)
        .where(
          and(
            eq(investorAllocationPreferencesTable.id, prefId),
            eq(investorAllocationPreferencesTable.userId, id),
          ),
        )
        .limit(1);
      if (!pref) return { status: 404 as const, error: "NOT_FOUND" };
      if (pref.status !== "PENDING_APPROVAL") {
        return { status: 409 as const, error: "NOT_PENDING" };
      }
      const now = new Date();

      // Supersede the prior ACTIVE preference (exactly-once via WHERE status).
      await tx
        .update(investorAllocationPreferencesTable)
        .set({ status: "SUPERSEDED", supersededAt: now })
        .where(
          and(
            eq(investorAllocationPreferencesTable.userId, id),
            eq(investorAllocationPreferencesTable.status, "ACTIVE"),
          ),
        );

      await tx
        .update(investorAllocationPreferencesTable)
        .set({
          status: "ACTIVE",
          reviewedByAdminId: admin.id,
          reviewNote: parsed.data.note ?? null,
          reviewedAt: now,
          activatedAt: now,
        })
        .where(eq(investorAllocationPreferencesTable.id, prefId));

      await tx
        .update(investorProfilesTable)
        .set({ currentRiskProfile: pref.profileKey })
        .where(eq(investorProfilesTable.userId, id));

      await auditInTx(tx, {
        admin,
        action: "INVESTOR_ALLOCATION_APPROVE",
        targetUserId: id,
        beforeState: { prefId, status: pref.status },
        afterState: { prefId, status: "ACTIVE", profileKey: pref.profileKey },
        reason: parsed.data.note ?? null,
        ipAddress: req.ip ?? null,
      });
      return { status: 200 as const };
    });

    if (result.status !== 200) {
      res.status(result.status).json({
        ok: false,
        error: result.error,
        message:
          result.error === "NOT_PENDING"
            ? "This allocation request is no longer pending."
            : "Allocation request not found.",
      });
      return;
    }
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not approve request." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/allocation/:prefId/reject ─────────────────────
const rejectSchema = z.object({ note: z.string().min(3) });

router.post("/admin/investors/:id/allocation/:prefId/reject", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const prefId = Number(req.params.prefId);
  if (!Number.isInteger(id) || !Number.isInteger(prefId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }
  const parsed = rejectSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "A rejection note is required." });
    return;
  }

  try {
    const result = await db.transaction(async (tx) => {
      const [pref] = await tx
        .select()
        .from(investorAllocationPreferencesTable)
        .where(
          and(
            eq(investorAllocationPreferencesTable.id, prefId),
            eq(investorAllocationPreferencesTable.userId, id),
          ),
        )
        .limit(1);
      if (!pref) return { status: 404 as const, error: "NOT_FOUND" };
      if (pref.status !== "PENDING_APPROVAL") {
        return { status: 409 as const, error: "NOT_PENDING" };
      }
      const now = new Date();
      await tx
        .update(investorAllocationPreferencesTable)
        .set({
          status: "REJECTED",
          reviewedByAdminId: admin.id,
          reviewNote: parsed.data.note,
          reviewedAt: now,
        })
        .where(eq(investorAllocationPreferencesTable.id, prefId));

      await auditInTx(tx, {
        admin,
        action: "INVESTOR_ALLOCATION_REJECT",
        targetUserId: id,
        beforeState: { prefId, status: pref.status },
        afterState: { prefId, status: "REJECTED" },
        reason: parsed.data.note,
        ipAddress: req.ip ?? null,
      });
      return { status: 200 as const };
    });

    if (result.status !== 200) {
      res.status(result.status).json({
        ok: false,
        error: result.error,
        message:
          result.error === "NOT_PENDING"
            ? "This allocation request is no longer pending."
            : "Allocation request not found.",
      });
      return;
    }
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not reject request." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/pause — pause/resume allocation ───────────────
const pauseSchema = z.object({ paused: z.boolean(), reason: z.string().min(3) });

router.post("/admin/investors/:id/pause", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const parsed = pauseSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "A reason is required." });
    return;
  }
  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const newStatus = parsed.data.paused ? "paused" : "active";
  try {
    await db.transaction(async (tx) => {
      await tx
        .update(investorProfilesTable)
        .set({
          status: newStatus,
          pausedReason: parsed.data.paused ? parsed.data.reason : null,
          pausedByAdminId: parsed.data.paused ? admin.id : null,
          pausedAt: parsed.data.paused ? new Date() : null,
        })
        .where(eq(investorProfilesTable.userId, id));
      await auditInTx(tx, {
        admin,
        action: parsed.data.paused ? "INVESTOR_PAUSE" : "INVESTOR_RESUME",
        targetUserId: id,
        beforeState: { status: profile.status },
        afterState: { status: newStatus },
        reason: parsed.data.reason,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not update investor." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/statements — publish a statement/document ─────
const statementSchema = z.object({
  statementType: z.enum(["STATEMENT", "AGREEMENT", "TAX", "OTHER"]).optional(),
  title: z.string().min(1),
  periodLabel: z.string().optional(),
  summary: z.string().optional(),
  fileUrl: z.string().optional(),
  reason: z.string().optional(),
});

router.post("/admin/investors/:id/statements", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }

  const parsed = statementSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid statement input." });
    return;
  }
  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const statementType = parsed.data.statementType ?? "STATEMENT";
  const title = parsed.data.title.trim();
  const periodLabel = parsed.data.periodLabel?.trim() || null;
  const summary = parsed.data.summary?.trim() || null;
  const fileUrl = parsed.data.fileUrl?.trim() || null;
  if (!title) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "A title is required." });
    return;
  }

  const fileCheck = await validateStatementFileObject(req, fileUrl);
  if (!fileCheck.ok) {
    // The presigned PUT stored the object before this validation ran, so a
    // rejected upload would otherwise leak in storage forever. Best-effort,
    // reference-aware cleanup (no statement persisted yet, so ANY existing row
    // referencing the path protects it). NEVER blocks the error response and is
    // logged on failure; external links / missing objects are no-ops.
    await safelyDeleteUnreferencedStatementObject(req, fileUrl);
    res
      .status(fileCheck.code === "FILE_TOO_LARGE" ? 413 : 400)
      .json({ ok: false, error: fileCheck.code, message: fileCheck.message });
    return;
  }

  try {
    await db.transaction(async (tx) => {
      await tx.insert(investorStatementsTable).values({
        userId: id,
        title,
        periodLabel,
        statementType,
        summary,
        fileUrl,
        createdByAdminId: admin.id,
      });
      await auditInTx(tx, {
        admin,
        action: "INVESTOR_STATEMENT_PUBLISH",
        targetUserId: id,
        beforeState: {},
        afterState: { statementType, title, periodLabel, hasFile: Boolean(fileUrl) },
        reason: parsed.data.reason ?? null,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not publish statement." });
    return;
  }

  // Defence-in-depth: stamp a private owner ACL on the uploaded object (no-op
  // for external-link statements). Access is authoritatively gated by per-user
  // DB scoping on the download route.
  await setStatementFileAcl(req, fileUrl, id);

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── PATCH /admin/investors/:id/statements/:statementId — edit a statement ────
const statementUpdateSchema = z.object({
  statementType: z.enum(["STATEMENT", "AGREEMENT", "TAX", "OTHER"]).optional(),
  title: z.string().min(1),
  periodLabel: z.string().nullable().optional(),
  summary: z.string().nullable().optional(),
  fileUrl: z.string().nullable().optional(),
  reason: z.string().optional(),
});

router.patch("/admin/investors/:id/statements/:statementId", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const statementId = Number(req.params.statementId);
  if (!Number.isInteger(id) || !Number.isInteger(statementId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }

  const parsed = statementUpdateSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid statement input." });
    return;
  }
  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const [existing] = await db
    .select()
    .from(investorStatementsTable)
    .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Statement not found." });
    return;
  }

  const statementType = parsed.data.statementType ?? existing.statementType;
  const title = parsed.data.title.trim();
  if (!title) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "A title is required." });
    return;
  }
  const periodLabel =
    parsed.data.periodLabel === undefined ? existing.periodLabel : parsed.data.periodLabel?.trim() || null;
  const summary =
    parsed.data.summary === undefined ? existing.summary : parsed.data.summary?.trim() || null;
  const fileUrl =
    parsed.data.fileUrl === undefined ? existing.fileUrl : parsed.data.fileUrl?.trim() || null;

  // Only re-validate when the file is being changed in this edit (an unchanged
  // legacy fileUrl must not start failing edits retroactively).
  if (fileUrl && fileUrl !== existing.fileUrl) {
    const fileCheck = await validateStatementFileObject(req, fileUrl);
    if (!fileCheck.ok) {
      // The freshly uploaded replacement object was rejected before it was ever
      // persisted onto this statement (the row still points at existing.fileUrl).
      // Best-effort, reference-aware cleanup so the rejected upload doesn't leak
      // — excluding this statement, ANY other row referencing the path protects
      // it. NEVER blocks the error response; external links / missing objects are
      // no-ops and storage errors are logged only.
      await safelyDeleteUnreferencedStatementObject(req, fileUrl, statementId);
      res
        .status(fileCheck.code === "FILE_TOO_LARGE" ? 413 : 400)
        .json({ ok: false, error: fileCheck.code, message: fileCheck.message });
      return;
    }
  }

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(investorStatementsTable)
        .set({ statementType, title, periodLabel, summary, fileUrl, updatedAt: new Date() })
        .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, id)));
      await auditInTx(tx, {
        admin,
        action: "INVESTOR_STATEMENT_EDIT",
        targetUserId: id,
        beforeState: {
          statementType: existing.statementType,
          title: existing.title,
          periodLabel: existing.periodLabel,
          summary: existing.summary,
          hasFile: Boolean(existing.fileUrl),
        },
        afterState: { statementType, title, periodLabel, summary, hasFile: Boolean(fileUrl) },
        reason: parsed.data.reason ?? null,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not update statement." });
    return;
  }

  await setStatementFileAcl(req, fileUrl, id);

  // Best-effort housekeeping: if this edit pointed the statement at a new
  // file / external link / nothing, the previously uploaded object MAY now be
  // orphaned. Use the reference-aware safe delete so we only remove the object
  // when NO other statement still references it (a file shared by a second
  // active/soft-removed/historical statement must survive). NEVER blocks the
  // edit — external links and missing objects are no-ops and errors are logged
  // only. We skip this entirely when the file is unchanged (same path).
  if (existing.fileUrl && existing.fileUrl !== fileUrl) {
    await safelyDeleteUnreferencedStatementObject(req, existing.fileUrl, statementId);
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── DELETE /admin/investors/:id/statements/:statementId — remove a statement ─
router.delete("/admin/investors/:id/statements/:statementId", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const statementId = Number(req.params.statementId);
  if (!Number.isInteger(id) || !Number.isInteger(statementId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }

  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const [existing] = await db
    .select()
    .from(investorStatementsTable)
    .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Statement not found." });
    return;
  }

  // Soft-remove only — a financial record is NEVER hard-deleted. The row is
  // marked REMOVED (download disabled investor-side) and the change is recorded
  // as an event + audit so it can be restored and is never silent.
  if (existing.status === "REMOVED") {
    res.status(400).json({ ok: false, error: "ALREADY_REMOVED", message: "This statement is already removed." });
    return;
  }
  // A clear reason is required on EVERY statement change — including this legacy
  // remove path. We never substitute a default; an empty/short reason is refused
  // exactly like the /status endpoint so no change to a financial record is ever
  // silent or unexplained.
  const reasonRaw = typeof req.query.reason === "string" ? req.query.reason.trim() : "";
  if (reasonRaw.length < 3) {
    res.status(400).json({
      ok: false,
      error: "VALIDATION_ERROR",
      message: "A clear reason (at least 3 characters) is required for every change.",
    });
    return;
  }
  const reason = reasonRaw;

  try {
    await db.transaction(async (tx) => {
      await applyStatementStatusChange(tx, {
        admin,
        userId: id,
        statement: existing,
        action: "REMOVE",
        newStatus: "REMOVED",
        reason,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not remove statement." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/statements/:statementId/status ─────────────────
// Change a statement's lifecycle status with a REQUIRED reason. Never silent,
// never a hard delete. Each action maps to a destination status:
//   CORRECT→CORRECTED  REPLACE→REPLACED  REMOVE→REMOVED  RESTORE→ACTIVE
//   SUPERSEDE→SUPERSEDED
const statementStatusSchema = z.object({
  action: z.enum(["CORRECT", "REPLACE", "REMOVE", "RESTORE", "SUPERSEDE"]),
  reason: z.string().trim().min(3),
  replacementStatementId: z.number().int().positive().optional(),
});

router.post("/admin/investors/:id/statements/:statementId/status", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const statementId = Number(req.params.statementId);
  if (!Number.isInteger(id) || !Number.isInteger(statementId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }

  const parsed = statementStatusSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      error: "VALIDATION_ERROR",
      message: "A clear reason (at least 3 characters) is required for every change.",
    });
    return;
  }

  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  const [existing] = await db
    .select()
    .from(investorStatementsTable)
    .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, id)))
    .limit(1);
  if (!existing) {
    res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Statement not found." });
    return;
  }

  const { action, reason } = parsed.data;
  const newStatusByAction = {
    CORRECT: "CORRECTED",
    REPLACE: "REPLACED",
    REMOVE: "REMOVED",
    RESTORE: "ACTIVE",
    SUPERSEDE: "SUPERSEDED",
  } as const;
  const newStatus = newStatusByAction[action];

  // Replacement handling: REPLACE requires it, SUPERSEDE allows it, RESTORE
  // clears it, CORRECT/REMOVE leave it unchanged. A replacement must be a
  // DIFFERENT statement belonging to the SAME investor.
  let replacementStatementId: number | null | undefined;
  if (action === "REPLACE" || action === "SUPERSEDE") {
    const repl = parsed.data.replacementStatementId;
    if (action === "REPLACE" && repl == null) {
      res.status(400).json({ ok: false, error: "REPLACEMENT_REQUIRED", message: "Select the statement that replaces this one." });
      return;
    }
    if (repl != null) {
      if (repl === statementId) {
        res.status(400).json({ ok: false, error: "REPLACEMENT_INVALID", message: "A statement cannot replace itself." });
        return;
      }
      const [replRow] = await db
        .select({ id: investorStatementsTable.id })
        .from(investorStatementsTable)
        .where(and(eq(investorStatementsTable.id, repl), eq(investorStatementsTable.userId, id)))
        .limit(1);
      if (!replRow) {
        res.status(400).json({ ok: false, error: "REPLACEMENT_INVALID", message: "The replacement statement was not found for this investor." });
        return;
      }
      replacementStatementId = repl;
    }
  } else if (action === "RESTORE") {
    replacementStatementId = null;
  }

  try {
    await db.transaction(async (tx) => {
      await applyStatementStatusChange(tx, {
        admin,
        userId: id,
        statement: existing,
        action,
        newStatus,
        reason,
        replacementStatementId,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not change the statement status." });
    return;
  }

  const detail = await buildDetail(id);
  res.json(detail);
});

// ── POST /admin/investors/:id/statements/upload-url — presigned upload URL ───
// Admin requests a short-lived presigned PUT URL; the browser uploads the file
// bytes directly to object storage, then publishes/edits the statement with the
// returned objectPath as fileUrl.
router.post("/admin/investors/:id/statements/upload-url", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) { res.status(400).json({ ok: false, error: "BAD_ID" }); return; }
  const profile = await getProfile(id);
  if (!profile) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Investor not found." }); return; }

  try {
    const uploadURL = await objectStorageService.getObjectEntityUploadURL();
    const objectPath = objectStorageService.normalizeObjectEntityPath(uploadURL);
    res.json({ ok: true, uploadURL, objectPath });
  } catch (err) {
    req.log.error({ err }, "Error generating statement upload URL");
    res.status(500).json({ ok: false, error: "UPLOAD_URL_FAILED", message: "Could not create upload URL." });
  }
});

// ── GET /admin/investors/:id/statements/:statementId/file — serve file ───────
// Admin-gated, scoped to the named investor. Streams the uploaded object;
// external-link statements 404 here (the UI links to those URLs directly).
router.get("/admin/investors/:id/statements/:statementId/file", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const id = Number(req.params.id);
  const statementId = Number(req.params.statementId);
  if (!Number.isInteger(id) || !Number.isInteger(statementId)) {
    res.status(400).json({ ok: false, error: "BAD_ID" });
    return;
  }
  const [row] = await db
    .select()
    .from(investorStatementsTable)
    .where(and(eq(investorStatementsTable.id, statementId), eq(investorStatementsTable.userId, id)))
    .limit(1);
  if (!row) { res.status(404).json({ ok: false, error: "NOT_FOUND", message: "Statement not found." }); return; }
  await streamStatementFile(req, res, row.fileUrl);
});

// ── GET /admin/investor-strategy-profiles ───────────────────────────────────
router.get("/admin/investor-strategy-profiles", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const [settings, profiles] = await Promise.all([ensureSettings(), ensureStrategyProfiles()]);
  res.json({
    ok: true,
    maxAggressivePct: settings.maxAggressivePct,
    riskDisclosureVersion: settings.riskDisclosureVersion,
    profiles: profiles.map((p) => ({
      profileKey: p.profileKey,
      label: p.label,
      description: p.description ?? null,
      conservativePct: p.conservativePct,
      balancedPct: p.balancedPct,
      aggressivePct: p.aggressivePct,
    })),
  });
});

// ── PUT /admin/investor-strategy-profiles ───────────────────────────────────
const strategyProfileInput = z.object({
  profileKey: z.enum(["CONSERVATIVE", "BALANCED", "AGGRESSIVE"]),
  label: z.string().min(1),
  description: z.string().optional(),
  conservativePct: z.number().int().min(0).max(100),
  balancedPct: z.number().int().min(0).max(100),
  aggressivePct: z.number().int().min(0).max(100),
});
const strategyConfigSchema = z.object({
  maxAggressivePct: z.number().int().min(0).max(100),
  reason: z.string().optional(),
  profiles: z.array(strategyProfileInput),
});

router.put("/admin/investor-strategy-profiles", requireUser, async (req, res) => {
  const admin = requireAdmin(req, res);
  if (!admin) return;
  const parsed = strategyConfigSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "VALIDATION_ERROR", message: "Invalid strategy config." });
    return;
  }
  const { maxAggressivePct, profiles } = parsed.data;

  // Every profile split must sum to 100 and honor the cap.
  for (const p of profiles) {
    if (p.conservativePct + p.balancedPct + p.aggressivePct !== 100) {
      res.status(400).json({
        ok: false,
        error: "SUM_NOT_100",
        message: `${p.profileKey} sleeves must sum to 100.`,
      });
      return;
    }
    if (p.aggressivePct > maxAggressivePct) {
      res.status(400).json({
        ok: false,
        error: "AGGRESSIVE_CAP_EXCEEDED",
        message: `${p.profileKey} aggressive % exceeds the cap of ${maxAggressivePct}%.`,
      });
      return;
    }
  }

  const settingsBefore = await ensureSettings();
  await ensureStrategyProfiles();

  try {
    await db.transaction(async (tx) => {
      await tx
        .update(investorAllocationSettingsTable)
        .set({ maxAggressivePct, updatedByAdminId: admin.id })
        .where(eq(investorAllocationSettingsTable.id, settingsBefore.id));

      for (const p of profiles) {
        await tx
          .update(investorStrategyProfilesTable)
          .set({
            label: p.label,
            description: p.description ?? null,
            conservativePct: p.conservativePct,
            balancedPct: p.balancedPct,
            aggressivePct: p.aggressivePct,
            updatedByAdminId: admin.id,
          })
          .where(eq(investorStrategyProfilesTable.profileKey, p.profileKey));
      }

      await auditInTx(tx, {
        admin,
        action: "INVESTOR_STRATEGY_CONFIG_UPDATE",
        targetUserId: null,
        beforeState: { maxAggressivePct: settingsBefore.maxAggressivePct },
        afterState: { maxAggressivePct, profiles },
        reason: parsed.data.reason ?? null,
        ipAddress: req.ip ?? null,
      });
    });
  } catch {
    res.status(500).json({ ok: false, error: "WRITE_FAILED", message: "Could not update strategy config." });
    return;
  }

  const [settings, updatedProfiles] = await Promise.all([ensureSettings(), ensureStrategyProfiles()]);
  res.json({
    ok: true,
    maxAggressivePct: settings.maxAggressivePct,
    riskDisclosureVersion: settings.riskDisclosureVersion,
    profiles: updatedProfiles.map((p) => ({
      profileKey: p.profileKey,
      label: p.label,
      description: p.description ?? null,
      conservativePct: p.conservativePct,
      balancedPct: p.balancedPct,
      aggressivePct: p.aggressivePct,
    })),
  });
});

export default router;
