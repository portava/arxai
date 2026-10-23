// Phase 11B — Per-user Reporting Center routes.
// SAFETY: requireUser; every query scoped by req.authUser.id. Reports cannot
// place trades, queue commands, modify connections, or bypass the Risk Governor.
// Bodies are served inline (no filesystem path traversal). Filenames sanitized.
import { Router } from "express";
import { db, userReportsTable, tradingSessionsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { requireUser } from "../lib/auth/middleware.js";
import { generateReport, REPORT_TYPES, REPORT_FORMATS, type ReportType, type ReportFormat } from "../lib/reportBuilder.js";
import { fireNotify, fireActivity } from "../lib/notificationService.js";

const router = Router();
const SAFETY_ENVELOPE = { safetyMode: "paper_only" as const, liveLocked: true as const, readOnlyMode: true as const, allowOrderExecution: false as const };

// Per Phase-11 size guardrails: cap inline body bytes to protect DB / availability.
const MAX_REPORT_BYTES = 5 * 1024 * 1024; // 5 MB

function safeName(s: string): string {
  return s.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "report";
}

// Strict YYYY-MM-DD parser. Returns:
//   undefined → not provided; Date → valid; null → invalid (caller must 400).
// Rejects coercible-but-invalid calendar dates (e.g. 2026-02-30, 2026-13-01)
// and rejects loose forms (e.g. 2026-2-3, ISO with time, garbage strings).
function parseDateStrict(v: unknown): Date | null | undefined {
  if (v == null || v === "") return undefined;
  const s = String(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const yyyy = Number(m[1]); const mm = Number(m[2]); const dd = Number(m[3]);
  const d = new Date(Date.UTC(yyyy, mm - 1, dd));
  if (
    d.getUTCFullYear() !== yyyy ||
    d.getUTCMonth() !== mm - 1 ||
    d.getUTCDate() !== dd
  ) return null;
  return d;
}

function err(res: import("express").Response, status: number, message: string) {
  res.status(status).json({ error: message, ...SAFETY_ENVELOPE });
}

// Async wrapper: any uncaught error funnels through err() so SAFETY_ENVELOPE
// is guaranteed on every 500 response.
type Handler = (req: import("express").Request, res: import("express").Response) => Promise<void>;
function safe(h: Handler): Handler {
  return async (req, res) => {
    try { await h(req, res); }
    catch (e) {
      const status = (e as { status?: number })?.status ?? 500;
      const msg = (e as Error)?.message ?? "internal error";
      if (!res.headersSent) err(res, status, msg);
    }
  };
}

router.get("/me/reports/options", requireUser, safe(async (_req, res) => {
  res.json({
    reportTypes: REPORT_TYPES, formats: REPORT_FORMATS,
    pdfSupported: false, pdfNote: "PDF rendering can be added later via a lightweight server-side library; HTML is the safe fallback.",
    ...SAFETY_ENVELOPE,
  });
}));

router.get("/me/reports", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const rows = await db.select({
    id: userReportsTable.id, userId: userReportsTable.userId,
    reportType: userReportsTable.reportType, format: userReportsTable.format,
    status: userReportsTable.status, title: userReportsTable.title,
    dateRangeStart: userReportsTable.dateRangeStart, dateRangeEnd: userReportsTable.dateRangeEnd,
    fileName: userReportsTable.fileName, fileSize: userReportsTable.fileSize,
    mimeType: userReportsTable.mimeType, rowCount: userReportsTable.rowCount,
    downloadUrl: userReportsTable.downloadUrl, errorMessage: userReportsTable.errorMessage,
    createdAt: userReportsTable.createdAt, completedAt: userReportsTable.completedAt,
    expiresAt: userReportsTable.expiresAt, updatedAt: userReportsTable.updatedAt,
  }).from(userReportsTable).where(eq(userReportsTable.userId, userId)).orderBy(desc(userReportsTable.createdAt)).limit(200);
  res.json({ reports: rows, isEmpty: rows.length === 0,
    emptyHints: rows.length === 0 ? [
      "No reports yet",
      "Close paper trades and journal your sessions to generate useful reports",
      "Your reports will appear here",
    ] : [],
    ...SAFETY_ENVELOPE });
}));

router.get("/me/reports/preview", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const reportType = String(req.query.reportType ?? "") as ReportType;
  const format = String(req.query.format ?? "json") as ReportFormat;
  if (!REPORT_TYPES.includes(reportType)) return err(res, 400, "invalid reportType");
  if (!REPORT_FORMATS.includes(format)) return err(res, 400, "invalid format");
  const ds = parseDateStrict(req.query.dateRangeStart);
  const de = parseDateStrict(req.query.dateRangeEnd);
  if (ds === null) return err(res, 400, "invalid dateRangeStart");
  if (de === null) return err(res, 400, "invalid dateRangeEnd");
  try {
    const result = await generateReport(userId, {
      reportType, format, dateRangeStart: ds ?? null, dateRangeEnd: de ?? null,
    });
    res.json({
      preview: {
        reportType, format, fileName: result.fileName,
        mimeType: result.mimeType, rowCount: result.rowCount,
        bytes: Buffer.byteLength(result.body, "utf8"),
        sample: result.body.slice(0, 800),
      },
      ...SAFETY_ENVELOPE,
    });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    err(res, status, (e as Error).message ?? "preview failed");
  }
}));

router.post("/me/reports/generate", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const body = (req.body ?? {}) as Record<string, unknown>;
  // Reject any client-supplied userId.
  if ("userId" in body) return err(res, 400, "userId is not accepted from client");
  const reportType = String(body.reportType ?? "") as ReportType;
  const format = String(body.format ?? "json") as ReportFormat;
  if (!REPORT_TYPES.includes(reportType)) return err(res, 400, "invalid reportType");
  if (!REPORT_FORMATS.includes(format)) return err(res, 400, "invalid format");
  const dsParsed = parseDateStrict(body.dateRangeStart);
  const deParsed = parseDateStrict(body.dateRangeEnd);
  if (dsParsed === null) return err(res, 400, "invalid dateRangeStart");
  if (deParsed === null) return err(res, 400, "invalid dateRangeEnd");
  const dateRangeStart = dsParsed ?? null;
  const dateRangeEnd = deParsed ?? null;
  if (dateRangeStart && dateRangeEnd && dateRangeStart > dateRangeEnd) {
    return err(res, 400, "dateRangeStart must be ≤ dateRangeEnd");
  }
  const tradingSessionId = body.tradingSessionId == null ? null : Number(body.tradingSessionId);
  if (tradingSessionId != null) {
    if (!Number.isFinite(tradingSessionId)) return err(res, 400, "invalid tradingSessionId");
    const owns = await db.select({ id: tradingSessionsTable.id }).from(tradingSessionsTable)
      .where(and(eq(tradingSessionsTable.id, tradingSessionId), eq(tradingSessionsTable.userId, userId))).limit(1);
    if (!owns[0]) return err(res, 404, "Session not found or not yours");
  }

  const title = `${reportType.replace(/_/g, " ")} — ${new Date().toISOString().slice(0, 10)}`;
  const filters = {
    symbol: body.symbol ?? null, strategyTag: body.strategyTag ?? null, status: body.status ?? null,
    includeJournal: body.includeJournal !== false, includeAIReviews: body.includeAIReviews !== false,
    includeRiskEvents: body.includeRiskEvents !== false, includePlaybooks: body.includePlaybooks !== false,
    includeCalendar: body.includeCalendar !== false, includeNotifications: body.includeNotifications === true,
    timezone: body.timezone ?? null,
  } as Record<string, unknown>;

  let rep: typeof userReportsTable.$inferSelect | undefined;
  try {
    const inserted = await db.insert(userReportsTable).values({
      userId, reportType, format, status: "processing", title,
      dateRangeStart: dateRangeStart ?? undefined, dateRangeEnd: dateRangeEnd ?? undefined,
      filters,
    }).returning();
    rep = inserted[0]!;

    const result = await generateReport(userId, {
      reportType, format,
      dateRangeStart, dateRangeEnd, tradingSessionId,
      symbol: typeof body.symbol === "string" ? body.symbol : null,
      strategyTag: typeof body.strategyTag === "string" ? body.strategyTag : null,
      status: typeof body.status === "string" ? body.status : null,
      includeJournal: filters.includeJournal as boolean,
      includeAIReviews: filters.includeAIReviews as boolean,
      includeRiskEvents: filters.includeRiskEvents as boolean,
      includePlaybooks: filters.includePlaybooks as boolean,
      includeCalendar: filters.includeCalendar as boolean,
      includeNotifications: filters.includeNotifications as boolean,
      timezone: filters.timezone as string | null,
    });
    const fileSize = Buffer.byteLength(result.body, "utf8");
    if (fileSize > MAX_REPORT_BYTES) {
      const msg = `report too large (${fileSize} bytes > ${MAX_REPORT_BYTES} cap); narrow date range or split filters`;
      await db.update(userReportsTable).set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
        .where(and(eq(userReportsTable.id, rep.id), eq(userReportsTable.userId, userId)));
      return err(res, 413, msg);
    }
    const fileName = safeName(result.fileName);
    const expiresAt = new Date(Date.now() + 7 * 24 * 60 * 60_000);
    const updated = await db.update(userReportsTable).set({
      status: "completed", body: result.body, fileName, mimeType: result.mimeType,
      fileSize, rowCount: result.rowCount,
      downloadUrl: `/api/me/reports/${rep.id}/download`,
      completedAt: new Date(), expiresAt, updatedAt: new Date(),
    }).where(and(eq(userReportsTable.id, rep.id), eq(userReportsTable.userId, userId))).returning();

    fireNotify(userId, {
      notificationType: "report_ready", severity: "info",
      title: "Report ready", message: `${reportType.replace(/_/g, " ")} export completed`,
      source: "system", entityType: "report", entityId: rep.id,
      actionLabel: "Download", actionTarget: `/api/me/reports/${rep.id}/download`,
    });
    fireActivity(userId, {
      eventType: "report_generated", title: `Report generated: ${reportType}`,
      source: "system", entityType: "report", entityId: rep.id,
      metadata: { format, rowCount: result.rowCount },
    });

    res.json({ report: { ...updated[0], body: undefined }, ...SAFETY_ENVELOPE });
  } catch (e) {
    const status = (e as { status?: number })?.status ?? 500;
    const msg = (e as Error).message ?? "report generation failed";
    if (rep) {
      await db.update(userReportsTable).set({ status: "failed", errorMessage: msg, updatedAt: new Date() })
        .where(and(eq(userReportsTable.id, rep.id), eq(userReportsTable.userId, userId)));
    }
    err(res, status, msg);
  }
}));

router.get("/me/reports/:id", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const r = await db.select().from(userReportsTable)
    .where(and(eq(userReportsTable.id, id), eq(userReportsTable.userId, userId))).limit(1);
  if (!r[0]) return err(res, 404, "Not found");
  // Don't include the body in metadata fetch.
  const { body, ...meta } = r[0];
  void body;
  res.json({ report: meta, ...SAFETY_ENVELOPE });
}));

router.get("/me/reports/:id/download", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const r = await db.select().from(userReportsTable)
    .where(and(eq(userReportsTable.id, id), eq(userReportsTable.userId, userId))).limit(1);
  if (!r[0]) return err(res, 404, "Not found");
  const rep = r[0];
  if (rep.status !== "completed" || rep.body == null) return err(res, 409, `report status is ${rep.status}`);
  const fileName = safeName(rep.fileName ?? `report_${rep.id}.${rep.format}`);
  res.setHeader("Content-Type", rep.mimeType ?? "application/octet-stream");
  res.setHeader("Content-Disposition", `attachment; filename="${fileName}"`);
  res.setHeader("X-Safety-Mode", "paper_only");
  res.send(rep.body);
}));

router.delete("/me/reports/:id", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const u = await db.delete(userReportsTable)
    .where(and(eq(userReportsTable.id, id), eq(userReportsTable.userId, userId))).returning();
  if (!u[0]) return err(res, 404, "Not found");
  res.json({ deleted: true, id, ...SAFETY_ENVELOPE });
}));

router.post("/me/reports/:id/delete", requireUser, safe(async (req, res) => {
  const userId = req.authUser!.id;
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return err(res, 400, "invalid id");
  const u = await db.delete(userReportsTable)
    .where(and(eq(userReportsTable.id, id), eq(userReportsTable.userId, userId))).returning();
  if (!u[0]) return err(res, 404, "Not found");
  res.json({ deleted: true, id, ...SAFETY_ENVELOPE });
}));

export default router;
