// Phase Audit-Center — Admin-only unified Audit Log Center + Evidence Export.
//
// SAFETY:
//   * READ-ONLY across existing audit tables. Never inserts into them.
//   * Admin-only via the same getAdminRole pattern used in adminTrading.ts.
//   * Non-admin → 403 ADMIN_OR_OWNER_REQUIRED.
//   * Audits the audit: every VIEW and EXPORT writes an
//     ADMIN_VIEWED_AUDIT_CENTER / ADMIN_EXPORTED_AUDIT row into
//     admin_action_audit_log so misuse is itself auditable.
//   * Output runs through maskSensitiveOutput as defense-in-depth so any
//     accidental future leak of a hash/token field is redacted.
//   * Export includes: exportId, exportedAt, adminId, filtersUsed,
//     eventCount, sha256 checksum, disclaimer, redaction note. No
//     secrets ever included.
//   * Does NOT introduce a new audit schema. Reuses the 4 existing
//     append-only tables:
//       admin_action_audit_log, trade_command_audit_log,
//       live_trading_audit, system_audit_logs
//   * Never queues, opens, or closes any trade. No live dispatch path.

import { Router, type Request, type Response } from "express";
import { db } from "@workspace/db";
import {
  adminActionAuditLogTable,
  tradeCommandAuditLogTable,
  liveTradingAuditTable,
  systemAuditLogsTable,
  usersTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, lte, sql, type SQL } from "drizzle-orm";
import { createHash, randomUUID } from "node:crypto";
import { maskSensitiveOutput } from "../lib/security/redact.js";

const router = Router();

// ─── Admin gate — same canonical per-user-cookie pattern used by
// adminMasterLiveAccess.ts and adminSharedMaster.ts. Reads role from the
// per-user authUser session populated by the requireAuthOrPublic +
// attachSecurityContext middleware. Never reads x-security-role
// directly (CI guard: security-role-header-allowlist).

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

async function writeAdminAudit(args: {
  adminId: number | null; adminRole: string; action: string;
  targetUserId?: number | null;
  beforeState?: Record<string, unknown>; afterState?: Record<string, unknown>;
  reason?: string | null; ipAddress?: string | null;
}) {
  await db.insert(adminActionAuditLogTable).values({
    adminId: args.adminId,
    adminRole: args.adminRole,
    action: args.action,
    targetUserId: args.targetUserId ?? null,
    beforeState: args.beforeState ?? {},
    afterState: args.afterState ?? {},
    reason: args.reason ?? null,
    ipAddress: args.ipAddress ?? null,
  });
}

// ─── Filter parsing ─────────────────────────────────────────────────────────

type Category = "ADMIN" | "TRADE" | "LIVE" | "SYSTEM";
const ALL_CATEGORIES: readonly Category[] = ["ADMIN", "TRADE", "LIVE", "SYSTEM"] as const;

interface ParsedFilters {
  category: readonly Category[];
  eventType: string | null;
  severity: string | null;
  actorUserId: number | null;
  targetUserId: number | null;
  symbol: string | null;
  from: Date | null;
  to: Date | null;
  limit: number;
}

function parseFilters(q: Request["query"]): ParsedFilters {
  const cat = String(q.category ?? "").toUpperCase();
  const category = ALL_CATEGORIES.includes(cat as Category)
    ? [cat as Category]
    : ALL_CATEGORIES;
  const limitRaw = parseInt(String(q.limit ?? "200"), 10);
  return {
    category,
    eventType: q.eventType ? String(q.eventType).slice(0, 64) : null,
    severity: q.severity ? String(q.severity).toUpperCase().slice(0, 16) : null,
    actorUserId: q.actorUserId ? parseInt(String(q.actorUserId), 10) || null : null,
    targetUserId: q.targetUserId ? parseInt(String(q.targetUserId), 10) || null : null,
    symbol: q.symbol ? String(q.symbol).toUpperCase().slice(0, 16) : null,
    from: q.from ? new Date(String(q.from)) : null,
    to: q.to ? new Date(String(q.to)) : null,
    limit: Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 200, 1), 1000),
  };
}

// ─── Normalized event envelope (the only shape ever exposed) ────────────────

interface NormalizedEvent {
  eventId: string;
  category: Category;
  eventType: string;
  severity: string;
  actorUserId: number | null;
  actorRole: string | null;
  targetUserId: number | null;
  symbol: string | null;
  result: string | null;
  reason: string | null;
  beforeState: unknown;
  afterState: unknown;
  ipAddress: string | null;
  createdAt: string;
  sourceTable: string;
}

// ─── Per-table queries ──────────────────────────────────────────────────────

async function queryAdminActions(f: ParsedFilters): Promise<NormalizedEvent[]> {
  const where: SQL[] = [];
  if (f.eventType) where.push(eq(adminActionAuditLogTable.action, f.eventType));
  if (f.actorUserId !== null) where.push(eq(adminActionAuditLogTable.adminId, f.actorUserId));
  if (f.targetUserId !== null) where.push(eq(adminActionAuditLogTable.targetUserId, f.targetUserId));
  if (f.from) where.push(gte(adminActionAuditLogTable.createdAt, f.from));
  if (f.to) where.push(lte(adminActionAuditLogTable.createdAt, f.to));
  const rows = await db.select().from(adminActionAuditLogTable)
    .where(where.length ? and(...where) : sql`TRUE`)
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(f.limit);
  return rows.map((r) => ({
    eventId: `admin-${r.id}`,
    category: "ADMIN",
    eventType: r.action,
    severity: "INFO",
    actorUserId: r.adminId,
    actorRole: r.adminRole,
    targetUserId: r.targetUserId,
    symbol: null,
    result: "success",
    reason: r.reason,
    beforeState: r.beforeState,
    afterState: r.afterState,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
    sourceTable: "admin_action_audit_log",
  }));
}

async function queryTradeCommands(f: ParsedFilters): Promise<NormalizedEvent[]> {
  const where: SQL[] = [];
  if (f.eventType) where.push(eq(tradeCommandAuditLogTable.status, f.eventType));
  if (f.actorUserId !== null) where.push(eq(tradeCommandAuditLogTable.userId, f.actorUserId));
  if (f.targetUserId !== null) where.push(eq(tradeCommandAuditLogTable.userId, f.targetUserId));
  if (f.symbol) where.push(eq(tradeCommandAuditLogTable.symbol, f.symbol));
  if (f.from) where.push(gte(tradeCommandAuditLogTable.createdAt, f.from));
  if (f.to) where.push(lte(tradeCommandAuditLogTable.createdAt, f.to));
  const rows = await db.select().from(tradeCommandAuditLogTable)
    .where(where.length ? and(...where) : sql`TRUE`)
    .orderBy(desc(tradeCommandAuditLogTable.createdAt))
    .limit(f.limit);
  return rows.map((r) => ({
    eventId: `trade-${r.id}`,
    category: "TRADE",
    eventType: `TRADE_${r.status}`,
    severity: r.status === "REJECTED" || r.status === "FAILED" ? "WARNING" : "INFO",
    actorUserId: r.userId,
    actorRole: r.requestedBy,
    targetUserId: r.userId,
    symbol: r.symbol,
    result: r.status.toLowerCase(),
    reason: r.rejectionReason,
    beforeState: { mode: r.mode, side: r.side, lotSize: r.lotSize, orderType: r.orderType },
    afterState: { status: r.status, accountType: r.accountType, routingMode: r.accountRoutingMode },
    ipAddress: null,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    sourceTable: "trade_command_audit_log",
  }));
}

async function queryLiveTrading(f: ParsedFilters): Promise<NormalizedEvent[]> {
  const where: SQL[] = [];
  if (f.eventType) where.push(eq(liveTradingAuditTable.eventType, f.eventType));
  if (f.severity) where.push(eq(liveTradingAuditTable.severity, f.severity));
  if (f.symbol) where.push(eq(liveTradingAuditTable.symbol, f.symbol));
  if (f.from) where.push(gte(liveTradingAuditTable.createdAt, f.from));
  if (f.to) where.push(lte(liveTradingAuditTable.createdAt, f.to));
  const rows = await db.select().from(liveTradingAuditTable)
    .where(where.length ? and(...where) : sql`TRUE`)
    .orderBy(desc(liveTradingAuditTable.createdAt))
    .limit(f.limit);
  return rows.map((r) => ({
    eventId: `live-${r.id}`,
    category: "LIVE",
    eventType: r.eventType,
    severity: r.severity,
    actorUserId: null,
    actorRole: r.actorRole,
    targetUserId: null,
    symbol: r.symbol,
    result: r.eventType.includes("REJECT") || r.eventType.includes("FAIL") ? "blocked" : "success",
    reason: null,
    beforeState: r.beforeState,
    afterState: r.afterState,
    ipAddress: null,
    createdAt: (r.createdAt ?? new Date()).toISOString(),
    sourceTable: "live_trading_audit",
  }));
}

async function querySystem(f: ParsedFilters): Promise<NormalizedEvent[]> {
  const where: SQL[] = [];
  if (f.eventType) where.push(eq(systemAuditLogsTable.eventType, f.eventType));
  if (f.severity) where.push(eq(systemAuditLogsTable.severity, f.severity));
  if (f.from) where.push(gte(systemAuditLogsTable.createdAt, f.from));
  if (f.to) where.push(lte(systemAuditLogsTable.createdAt, f.to));
  const rows = await db.select().from(systemAuditLogsTable)
    .where(where.length ? and(...where) : sql`TRUE`)
    .orderBy(desc(systemAuditLogsTable.createdAt))
    .limit(f.limit);
  return rows.map((r) => ({
    eventId: `system-${r.id}`,
    category: "SYSTEM",
    eventType: r.eventType,
    severity: r.severity,
    actorUserId: null,
    actorRole: r.actor,
    targetUserId: null,
    symbol: null,
    result: null,
    reason: null,
    beforeState: r.beforeSnapshot ?? {},
    afterState: r.afterSnapshot ?? {},
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
    sourceTable: "system_audit_logs",
  }));
}

async function loadEvents(f: ParsedFilters): Promise<NormalizedEvent[]> {
  const buckets: NormalizedEvent[][] = await Promise.all([
    f.category.includes("ADMIN")  ? queryAdminActions(f) : Promise.resolve([]),
    f.category.includes("TRADE")  ? queryTradeCommands(f) : Promise.resolve([]),
    f.category.includes("LIVE")   ? queryLiveTrading(f) : Promise.resolve([]),
    f.category.includes("SYSTEM") ? querySystem(f) : Promise.resolve([]),
  ]);
  const all = buckets.flat();
  all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return all.slice(0, f.limit);
}

function checksum(events: NormalizedEvent[]): string {
  return createHash("sha256").update(JSON.stringify(events)).digest("hex");
}

function csvCell(v: unknown): string {
  if (v == null) return "";
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return /[,"\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const DISCLAIMER = "Internal evidence export. Sensitive secrets redacted via maskSensitiveOutput chokepoint. Not a legal, regulatory, tax, broker-dealer, or financial compliance certification.";

// ─── GET /api/admin/audit/center ────────────────────────────────────────────

router.get("/admin/audit/center", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const f = parseFilters(req.query);
    const eventsRaw = await loadEvents(f);
    const events = maskSensitiveOutput(eventsRaw) as NormalizedEvent[];
    await writeAdminAudit({
      adminId: getAdminId(req), adminRole: role,
      action: "ADMIN_VIEWED_AUDIT_CENTER",
      afterState: { filters: f, count: events.length },
      ipAddress: req.ip ?? null,
    }).catch(() => {});
    res.json({
      ok: true,
      count: events.length,
      categories: ALL_CATEGORIES,
      filters: f,
      events,
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_audit_center_failed");
    res.status(500).json({ ok: false, error: "AUDIT_CENTER_FAILED" });
  }
});

// ─── GET /api/admin/audit/categories ────────────────────────────────────────

router.get("/admin/audit/categories", async (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({
    ok: true,
    categories: ALL_CATEGORIES,
    presets: [
      { id: "live-safety-review", label: "Live trade safety review", filter: { category: "LIVE" } },
      { id: "kill-switch-history", label: "Kill switch history", filter: { eventType: "ENGAGE_KILL_SWITCH" } },
      { id: "user-approval-history", label: "User approval history", filter: { eventType: "APPROVE_LIVE" } },
      { id: "blocked-trade-decisions", label: "Blocked trade decisions", filter: { category: "TRADE", eventType: "REJECTED" } },
      { id: "trade-command-lifecycle", label: "Trade command lifecycle", filter: { category: "TRADE" } },
      { id: "admin-actions", label: "Admin actions history", filter: { category: "ADMIN" } },
      { id: "system-events", label: "System events", filter: { category: "SYSTEM" } },
    ],
  });
});

// ─── GET /api/admin/audit/export ────────────────────────────────────────────

router.get("/admin/audit/export", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const format = String(req.query.format ?? "json").toLowerCase();
    if (format !== "json" && format !== "csv") {
      res.status(400).json({ ok: false, error: "INVALID_FORMAT", supported: ["json", "csv"] });
      return;
    }
    const f = parseFilters(req.query);
    const eventsRaw = await loadEvents(f);
    const events = maskSensitiveOutput(eventsRaw) as NormalizedEvent[];
    const exportId = randomUUID();
    const exportedAt = new Date().toISOString();
    const adminId = getAdminId(req);
    const sha256 = checksum(events);

    await writeAdminAudit({
      adminId, adminRole: role,
      action: "ADMIN_EXPORTED_AUDIT",
      afterState: { exportId, format, filters: f, eventCount: events.length, sha256 },
      ipAddress: req.ip ?? null,
    }).catch(() => {});

    if (format === "json") {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-disposition", `attachment; filename="audit-export-${exportId}.json"`);
      res.json({
        exportId, exportedAt, adminId,
        filtersUsed: f,
        eventCount: events.length,
        sha256,
        disclaimer: DISCLAIMER,
        redactionNote: "All output passed through maskSensitiveOutput. Bridge tokens, API keys, session secrets, account passwords, and token hashes are redacted.",
        events,
      });
      return;
    }

    // CSV
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="audit-export-${exportId}.csv"`);
    res.write(`# exportId,${exportId}\n`);
    res.write(`# exportedAt,${exportedAt}\n`);
    res.write(`# adminId,${adminId ?? ""}\n`);
    res.write(`# eventCount,${events.length}\n`);
    res.write(`# sha256,${sha256}\n`);
    res.write(`# filters,${csvCell(f)}\n`);
    res.write(`# disclaimer,${csvCell(DISCLAIMER)}\n`);
    res.write([
      "eventId","category","eventType","severity","actorUserId","actorRole",
      "targetUserId","symbol","result","reason","createdAt","sourceTable",
    ].join(",") + "\n");
    for (const e of events) {
      res.write([
        csvCell(e.eventId), csvCell(e.category), csvCell(e.eventType),
        csvCell(e.severity), csvCell(e.actorUserId), csvCell(e.actorRole),
        csvCell(e.targetUserId), csvCell(e.symbol), csvCell(e.result),
        csvCell(e.reason), csvCell(e.createdAt), csvCell(e.sourceTable),
      ].join(",") + "\n");
    }
    res.end();
  } catch (e) {
    req.log?.error({ err: e }, "admin_audit_export_failed");
    res.status(500).json({ ok: false, error: "AUDIT_EXPORT_FAILED" });
  }
});

// ─── GET /api/admin/audit/pool-views ────────────────────────────────────────
// Recent ALLOCATION_POOL_VIEWED rows joined with the admin user's email so
// an operator can see at-a-glance who opened the Shared Bridge Pool view
// during an incident, without writing SQL. Read-only over
// admin_action_audit_log; never inserts or mutates anything.
//
// Query params:
//   * from, to — ISO timestamps, optional date-range filter
//   * limit    — 1..500, default 50
//   * dedupe   — "1" / "true" to collapse to the most recent view per admin

interface PoolViewFilters {
  from: Date | null;
  to: Date | null;
  dedupe: boolean;
  limit: number;
}

interface PoolViewRow {
  id: number;
  adminId: number | null;
  adminEmail: string | null;
  adminRole: string;
  ipAddress: string | null;
  createdAt: string;
}

function parsePoolViewFilters(q: Request["query"]): PoolViewFilters {
  const limitRaw = parseInt(String(q.limit ?? "50"), 10);
  const limit = Math.min(Math.max(Number.isFinite(limitRaw) ? limitRaw : 50, 1), 500);
  const fromRaw = q.from ? new Date(String(q.from)) : null;
  const toRaw = q.to ? new Date(String(q.to)) : null;
  const from = fromRaw && !isNaN(fromRaw.getTime()) ? fromRaw : null;
  const to = toRaw && !isNaN(toRaw.getTime()) ? toRaw : null;
  const dedupe = String(q.dedupe ?? "").toLowerCase() === "true"
    || String(q.dedupe ?? "") === "1";
  return { from, to, dedupe, limit };
}

// Raw operator IP addresses are OWNER-only. ADMIN sessions (non-owners) and
// any other tier see this placeholder instead. This is a deliberate
// tightening of the documented "OWNER/ADMIN may see IP on operator
// endpoints" invariant: returning the IP to the OWNER subset only is still
// compliant (never exposed below ADMIN) while honouring the rule that
// operator IPs never leak to non-owners. The pool-view audit feed exists so
// an operator can see WHO opened the Shared Bridge Pool view — the admin
// email satisfies that for every operator tier, while the location-revealing
// IP stays OWNER-only.
const REDACTED_IP = "[REDACTED]";

async function loadPoolViews(
  f: PoolViewFilters,
  role: "ADMIN" | "OWNER",
): Promise<PoolViewRow[]> {
  const where: SQL[] = [eq(adminActionAuditLogTable.action, "ALLOCATION_POOL_VIEWED")];
  if (f.from) where.push(gte(adminActionAuditLogTable.createdAt, f.from));
  if (f.to) where.push(lte(adminActionAuditLogTable.createdAt, f.to));

  // Over-fetch when deduping so the final list can still hit `limit`
  // distinct admins after we collapse.
  const fetchLimit = f.dedupe ? Math.min(f.limit * 10, 2000) : f.limit;

  const rows = await db
    .select({
      id: adminActionAuditLogTable.id,
      adminId: adminActionAuditLogTable.adminId,
      adminRole: adminActionAuditLogTable.adminRole,
      ipAddress: adminActionAuditLogTable.ipAddress,
      createdAt: adminActionAuditLogTable.createdAt,
      adminEmail: usersTable.email,
    })
    .from(adminActionAuditLogTable)
    .leftJoin(usersTable, eq(usersTable.id, adminActionAuditLogTable.adminId))
    .where(and(...where))
    .orderBy(desc(adminActionAuditLogTable.createdAt))
    .limit(fetchLimit);

  let viewsRaw: PoolViewRow[] = rows.map((r) => ({
    id: r.id,
    adminId: r.adminId,
    adminEmail: r.adminEmail ?? null,
    adminRole: r.adminRole,
    ipAddress: r.ipAddress,
    createdAt: r.createdAt.toISOString(),
  }));

  if (f.dedupe) {
    const seen = new Set<string>();
    const deduped: PoolViewRow[] = [];
    for (const v of viewsRaw) {
      const key = v.adminId !== null ? `id:${v.adminId}` : `email:${v.adminEmail ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(v);
      if (deduped.length >= f.limit) break;
    }
    viewsRaw = deduped;
  }

  const masked = maskSensitiveOutput(viewsRaw) as PoolViewRow[];

  // Role-scoped IP redaction (applied AFTER dedupe so the per-admin collapse
  // still keys off real identities). Only OWNER sees raw operator IPs.
  if (role !== "OWNER") {
    return masked.map((v) => ({ ...v, ipAddress: v.ipAddress == null ? null : REDACTED_IP }));
  }
  return masked;
}

function poolViewsChecksum(views: PoolViewRow[]): string {
  return createHash("sha256").update(JSON.stringify(views)).digest("hex");
}

router.get("/admin/audit/pool-views", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const f = parsePoolViewFilters(req.query);
    const views = await loadPoolViews(f, role);

    res.json({
      ok: true,
      count: views.length,
      limit: f.limit,
      dedupe: f.dedupe,
      from: f.from ? f.from.toISOString() : null,
      to: f.to ? f.to.toISOString() : null,
      views,
    });
  } catch (e) {
    req.log?.error({ err: e }, "admin_audit_pool_views_failed");
    res.status(500).json({ ok: false, error: "AUDIT_POOL_VIEWS_FAILED" });
  }
});

// ─── GET /api/admin/audit/pool-views/export ─────────────────────────────────
// Mirrors /admin/audit/export but scoped to the ALLOCATION_POOL_VIEWED feed.
// Honours the same from/to/dedupe filters as the on-screen list and emits
// the same evidence envelope (exportId, exportedAt, adminId, filtersUsed,
// eventCount, sha256, disclaimer + redaction note). Writes an
// ADMIN_EXPORTED_AUDIT row for every export, same as the main exporter.

router.get("/admin/audit/pool-views/export", async (req, res) => {
  const role = requireAdmin(req, res); if (!role) return;
  try {
    const format = String(req.query.format ?? "json").toLowerCase();
    if (format !== "json" && format !== "csv") {
      res.status(400).json({ ok: false, error: "INVALID_FORMAT", supported: ["json", "csv"] });
      return;
    }
    const f = parsePoolViewFilters(req.query);
    const views = await loadPoolViews(f, role);
    const filtersUsed = {
      from: f.from ? f.from.toISOString() : null,
      to: f.to ? f.to.toISOString() : null,
      dedupe: f.dedupe,
      limit: f.limit,
    };
    const exportId = randomUUID();
    const exportedAt = new Date().toISOString();
    const adminId = getAdminId(req);
    const sha256 = poolViewsChecksum(views);

    await writeAdminAudit({
      adminId, adminRole: role,
      action: "ADMIN_EXPORTED_AUDIT",
      afterState: { exportId, format, scope: "pool-views", filters: filtersUsed, eventCount: views.length, sha256 },
      ipAddress: req.ip ?? null,
    }).catch(() => {});

    if (format === "json") {
      res.setHeader("content-type", "application/json");
      res.setHeader("content-disposition", `attachment; filename="pool-views-export-${exportId}.json"`);
      res.json({
        exportId, exportedAt, adminId,
        filtersUsed,
        eventCount: views.length,
        sha256,
        disclaimer: DISCLAIMER,
        redactionNote: "All output passed through maskSensitiveOutput. Bridge tokens, API keys, session secrets, account passwords, and token hashes are redacted.",
        views,
      });
      return;
    }

    // CSV
    res.setHeader("content-type", "text/csv");
    res.setHeader("content-disposition", `attachment; filename="pool-views-export-${exportId}.csv"`);
    res.write(`# exportId,${exportId}\n`);
    res.write(`# exportedAt,${exportedAt}\n`);
    res.write(`# adminId,${adminId ?? ""}\n`);
    res.write(`# eventCount,${views.length}\n`);
    res.write(`# sha256,${sha256}\n`);
    res.write(`# filters,${csvCell(filtersUsed)}\n`);
    res.write(`# disclaimer,${csvCell(DISCLAIMER)}\n`);
    res.write([
      "id","adminId","adminEmail","adminRole","ipAddress","createdAt",
    ].join(",") + "\n");
    for (const v of views) {
      res.write([
        csvCell(v.id), csvCell(v.adminId), csvCell(v.adminEmail),
        csvCell(v.adminRole), csvCell(v.ipAddress), csvCell(v.createdAt),
      ].join(",") + "\n");
    }
    res.end();
  } catch (e) {
    req.log?.error({ err: e }, "admin_audit_pool_views_export_failed");
    res.status(500).json({ ok: false, error: "AUDIT_POOL_VIEWS_EXPORT_FAILED" });
  }
});

export default router;
