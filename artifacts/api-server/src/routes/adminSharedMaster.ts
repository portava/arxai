// P0-1 — Admin Shared Master API surface (new /api/admin/shared-master/* namespace).
//
// This is an ADDITIVE namespace. Existing /api/admin/trading/* and
// /api/admin/virtual-accounts in adminTrading.ts continue to work
// unchanged. New Shared Master work lives here so it can be audited and
// extended in isolation.
//
// SAFETY:
//   * Every handler gates on requireAdmin (ADMIN | OWNER role).
//   * No execution. No order placement. No live-trade flag mutation.
//   * No secrets returned (no apiKeyHash, no accountLogin, no server URL).
//   * The unattributed-link endpoint only RECONCILES bookkeeping; it does
//     NOT cause a new broker order to be sent.

import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  unattributedMasterTradesTable,
  sharedTradeAttributionTable,
  sharedMasterAccountsTable,
  virtualTradingAccountsTable,
} from "@workspace/db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { z } from "zod/v4";

const router = Router();

// Inline admin guard mirrors the pattern in adminTrading.ts. Centralized
// requireAdmin middleware does not exist as a shared helper today; rather
// than introduce one in this minimal patch we re-use the same shape.
function requireAdmin(req: Request, res: Response): "ADMIN" | "OWNER" | null {
  const u = (req as Request & { authUser?: { id?: number; role?: string } }).authUser;
  const role = u?.role?.toUpperCase();
  if (role === "ADMIN" || role === "OWNER") return role as "ADMIN" | "OWNER";
  res.status(403).json({ ok: false, error: "admin_only" });
  return null;
}
function adminId(req: Request): number | null {
  return (req as Request & { authUser?: { id?: number } }).authUser?.id ?? null;
}

// ── GET /api/admin/shared-master/overview ──────────────────────────────────
// Per-master aggregate: virtual accounts attached, open attributions,
// pending_review unattributed count, 24h realized PnL sum across all users.
router.get("/admin/shared-master/overview", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const masters = await db.select({
      id: sharedMasterAccountsTable.id,
      connectionId: sharedMasterAccountsTable.connectionId,
      accountType: sharedMasterAccountsTable.accountType,
      brokerName: sharedMasterAccountsTable.brokerName,
      accountNumberMasked: sharedMasterAccountsTable.accountNumberMasked,
      status: sharedMasterAccountsTable.status,
      isActive: sharedMasterAccountsTable.isActive,
    }).from(sharedMasterAccountsTable);

    const usersPerMaster = await db.select({
      sharedMasterAccountId: virtualTradingAccountsTable.sharedMasterAccountId,
      userCount: sql<number>`count(distinct ${virtualTradingAccountsTable.userId})::int`,
    })
      .from(virtualTradingAccountsTable)
      .groupBy(virtualTradingAccountsTable.sharedMasterAccountId);
    const userMap = new Map<number, number>(
      usersPerMaster
        .filter(r => r.sharedMasterAccountId != null)
        .map(r => [r.sharedMasterAccountId as number, Number(r.userCount)]),
    );

    const openByMaster = await db.select({
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      count: sql<number>`count(*)::int`,
    })
      .from(sharedTradeAttributionTable)
      .where(eq(sharedTradeAttributionTable.status, "open"))
      .groupBy(sharedTradeAttributionTable.sharedMasterAccountId);
    const openMap = new Map<number, number>(
      openByMaster.map(r => [r.sharedMasterAccountId, Number(r.count)]),
    );

    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const realized24h = await db.select({
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      sum: sql<number>`coalesce(sum(${sharedTradeAttributionTable.pnl}),0)::float8`,
    })
      .from(sharedTradeAttributionTable)
      .where(and(
        eq(sharedTradeAttributionTable.status, "closed"),
        sql`${sharedTradeAttributionTable.realizedAppliedAt} is not null and ${sharedTradeAttributionTable.realizedAppliedAt} >= ${oneDayAgo}`,
      ))
      .groupBy(sharedTradeAttributionTable.sharedMasterAccountId);
    const realizedMap = new Map<number, number>(
      realized24h.map(r => [r.sharedMasterAccountId, Number(r.sum)]),
    );

    const unattributedPending = await db.select({
      sharedMasterAccountId: unattributedMasterTradesTable.sharedMasterAccountId,
      count: sql<number>`count(*)::int`,
    })
      .from(unattributedMasterTradesTable)
      .where(eq(unattributedMasterTradesTable.status, "pending_review"))
      .groupBy(unattributedMasterTradesTable.sharedMasterAccountId);
    const unattrMap = new Map<number, number>(
      unattributedPending
        .filter(r => r.sharedMasterAccountId != null)
        .map(r => [r.sharedMasterAccountId as number, Number(r.count)]),
    );

    res.json({
      ok: true,
      masters: masters.map(m => ({
        ...m,
        userCount: userMap.get(m.id) ?? 0,
        openAttributions: openMap.get(m.id) ?? 0,
        realizedPnl24h: realizedMap.get(m.id) ?? 0,
        pendingUnattributed: unattrMap.get(m.id) ?? 0,
      })),
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_shared_master_overview_failed");
    res.status(500).json({ ok: false, error: "overview_failed" });
  }
});

// ── GET /api/admin/shared-master/virtual-accounts ──────────────────────────
// Paged list of virtual_trading_accounts across all users (admin view).
// Reuses the existing /api/admin/virtual-accounts endpoint's data shape
// but exposes it under the new namespace. Query params:
//   ?masterId=<id>  ?accountType=demo|live  ?limit=50  ?offset=0
router.get("/admin/shared-master/virtual-accounts", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1), 500);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const masterId = req.query.masterId ? parseInt(String(req.query.masterId), 10) : null;
  const accountType = typeof req.query.accountType === "string" ? req.query.accountType : null;
  try {
    const conds = [] as ReturnType<typeof eq>[];
    if (masterId != null && Number.isFinite(masterId)) {
      conds.push(eq(virtualTradingAccountsTable.sharedMasterAccountId, masterId));
    }
    if (accountType) {
      conds.push(eq(virtualTradingAccountsTable.accountType, accountType));
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(virtualTradingAccountsTable)
      .where(where)
      .orderBy(desc(virtualTradingAccountsTable.updatedAt))
      .limit(limit)
      .offset(offset);
    res.json({ ok: true, count: rows.length, limit, offset, rows });
  } catch (e) {
    req.log?.error({ err: e }, "admin_shared_master_virtual_accounts_failed");
    res.status(500).json({ ok: false, error: "virtual_accounts_failed" });
  }
});

// ── GET /api/admin/shared-master/attributions ──────────────────────────────
// Cross-user shared_trade_attribution feed (admin). Query params:
//   ?masterId=<id>  ?userId=<id>  ?status=open|closed|...  ?limit=100  ?offset=0
router.get("/admin/shared-master/attributions", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const masterId = req.query.masterId ? parseInt(String(req.query.masterId), 10) : null;
  const userId = req.query.userId ? parseInt(String(req.query.userId), 10) : null;
  const status = typeof req.query.status === "string" ? req.query.status : null;
  try {
    const conds = [] as ReturnType<typeof eq>[];
    if (masterId != null && Number.isFinite(masterId)) {
      conds.push(eq(sharedTradeAttributionTable.sharedMasterAccountId, masterId));
    }
    if (userId != null && Number.isFinite(userId)) {
      conds.push(eq(sharedTradeAttributionTable.userId, userId));
    }
    if (status) {
      conds.push(eq(sharedTradeAttributionTable.status, status));
    }
    const where = conds.length ? and(...conds) : undefined;
    const rows = await db.select().from(sharedTradeAttributionTable)
      .where(where)
      .orderBy(desc(sharedTradeAttributionTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json({ ok: true, count: rows.length, limit, offset, rows });
  } catch (e) {
    req.log?.error({ err: e }, "admin_shared_master_attributions_failed");
    res.status(500).json({ ok: false, error: "attributions_failed" });
  }
});

// ── GET /api/admin/shared-master/unattributed ──────────────────────────────
// P0-3 admin queue — unreviewed master fills with no user attribution.
//   ?status=pending_review|linked|dismissed  (default: pending_review)
//   ?limit=100  ?offset=0
router.get("/admin/shared-master/unattributed", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const limit = Math.min(Math.max(parseInt(String(req.query.limit ?? "100"), 10) || 100, 1), 500);
  const offset = Math.max(parseInt(String(req.query.offset ?? "0"), 10) || 0, 0);
  const status = typeof req.query.status === "string" ? req.query.status : "pending_review";
  try {
    const rows = await db.select().from(unattributedMasterTradesTable)
      .where(eq(unattributedMasterTradesTable.status, status))
      .orderBy(desc(unattributedMasterTradesTable.createdAt))
      .limit(limit)
      .offset(offset);
    res.json({ ok: true, status, count: rows.length, limit, offset, rows });
  } catch (e) {
    req.log?.error({ err: e }, "admin_shared_master_unattributed_list_failed");
    res.status(500).json({ ok: false, error: "unattributed_list_failed" });
  }
});

// ── POST /api/admin/shared-master/unattributed/:id/link ────────────────────
// Manually link an unattributed master trade to an existing shared
// attribution row. No broker call is made; this is bookkeeping only.
const LinkBody = z.object({
  attributionId: z.number().int().positive(),
  notes: z.string().max(2000).optional(),
});
router.post("/admin/shared-master/unattributed/:id/link", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ ok: false, error: "bad_id" });
    return;
  }
  const parsed = LinkBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "bad_body", details: parsed.error.flatten() });
    return;
  }
  try {
    // Verify the target attribution exists.
    const [att] = await db.select({ id: sharedTradeAttributionTable.id })
      .from(sharedTradeAttributionTable)
      .where(eq(sharedTradeAttributionTable.id, parsed.data.attributionId))
      .limit(1);
    if (!att) {
      res.status(404).json({ ok: false, error: "attribution_not_found" });
      return;
    }
    const updated = await db.update(unattributedMasterTradesTable).set({
      status: "linked",
      linkedAttributionId: parsed.data.attributionId,
      linkedByAdminId: adminId(req),
      reviewNotes: parsed.data.notes ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(unattributedMasterTradesTable.id, id),
      eq(unattributedMasterTradesTable.status, "pending_review"),
    )).returning({ id: unattributedMasterTradesTable.id });
    if (!updated[0]) {
      res.status(409).json({ ok: false, error: "not_pending_review" });
      return;
    }
    res.json({ ok: true, id: updated[0].id, linkedAttributionId: parsed.data.attributionId });
  } catch (e) {
    req.log?.error({ err: e, id }, "admin_shared_master_unattributed_link_failed");
    res.status(500).json({ ok: false, error: "link_failed" });
  }
});

// ── POST /api/admin/shared-master/unattributed/:id/dismiss ─────────────────
const DismissBody = z.object({ notes: z.string().max(2000).optional() });
router.post("/admin/shared-master/unattributed/:id/dismiss", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  const id = parseInt(String(req.params.id), 10);
  if (!Number.isFinite(id)) {
    res.status(400).json({ ok: false, error: "bad_id" });
    return;
  }
  const parsed = DismissBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ ok: false, error: "bad_body" });
    return;
  }
  try {
    const updated = await db.update(unattributedMasterTradesTable).set({
      status: "dismissed",
      dismissedByAdminId: adminId(req),
      reviewNotes: parsed.data.notes ?? null,
      updatedAt: new Date(),
    }).where(and(
      eq(unattributedMasterTradesTable.id, id),
      eq(unattributedMasterTradesTable.status, "pending_review"),
    )).returning({ id: unattributedMasterTradesTable.id });
    if (!updated[0]) {
      res.status(409).json({ ok: false, error: "not_pending_review" });
      return;
    }
    res.json({ ok: true, id: updated[0].id });
  } catch (e) {
    req.log?.error({ err: e, id }, "admin_shared_master_unattributed_dismiss_failed");
    res.status(500).json({ ok: false, error: "dismiss_failed" });
  }
});

// ── GET /api/admin/shared-master/netting ───────────────────────────────────
// Capability #49 — netting-effect READ. Runs the pure detector
// (@workspace/domain live-position/netting) over the OPEN attribution slices
// of each shared master account and reports, per symbol, the gross/net
// decomposition, offset (hedged) volume, and whether the offset CROSSES
// users — the state where one user's position is economically the
// counterparty of another's on the same broker account.
//
// READ-ONLY and honest: a failed read returns a typed 500, never a
// synthesized empty report; malformed rows surface in `rejectedSlices` with
// typed reasons (the detector never drops them silently).
router.get("/admin/shared-master/netting", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { detectNettingEffects } = await import("@workspace/domain/live-position");
    const openAttrs = await db.select({
      sharedMasterAccountId: sharedTradeAttributionTable.sharedMasterAccountId,
      userId: sharedTradeAttributionTable.userId,
      symbol: sharedTradeAttributionTable.symbol,
      side: sharedTradeAttributionTable.side,
      lotSize: sharedTradeAttributionTable.lotSize,
      id: sharedTradeAttributionTable.id,
    }).from(sharedTradeAttributionTable)
      .where(eq(sharedTradeAttributionTable.status, "open"));

    const byMaster = new Map<number, typeof openAttrs>();
    for (const a of openAttrs) {
      const list = byMaster.get(a.sharedMasterAccountId) ?? [];
      list.push(a);
      byMaster.set(a.sharedMasterAccountId, list);
    }
    const perMaster = [...byMaster.entries()]
      .sort(([a], [b]) => a - b)
      .map(([sharedMasterAccountId, rows]) => ({
        sharedMasterAccountId,
        report: detectNettingEffects(rows.map((r) => ({
          userId: r.userId,
          symbol: r.symbol,
          side: r.side,
          volumeLots: r.lotSize,
          ref: `attribution:${r.id}`,
        }))),
      }));
    res.json({
      ok: true,
      perMaster,
      crossUserOffsetDetected: perMaster.some((m) => m.report.crossUserOffsetDetected),
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_shared_master_netting_read_failed");
    // Honest failure: no synthesized empty report.
    res.status(500).json({ ok: false, error: "netting_read_failed" });
  }
});

export default router;
