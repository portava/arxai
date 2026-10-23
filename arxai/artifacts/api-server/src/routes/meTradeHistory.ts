// Trade History routes — MT5 history import + query surface.
//
// Routes:
//   POST /api/me/trade-history/import      — upload CSV/HTML/Excel text
//   GET  /api/me/trade-history/imports     — list import batches
//   GET  /api/me/trade-history             — list imported trades (paged)
//   GET  /api/me/trade-history/summary     — aggregated stats for Ruby
//
// SAFETY:
//   - requireUser on every route — per-user scoped.
//   - Never places trades, never touches MT5 bridge, never modifies gates.
//   - File content is accepted as text (no binary upload needed for CSV/HTML).
//   - Excel rows accepted as pre-parsed JSON arrays from the frontend.

import { Router } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  runTradeHistoryImport,
  listTradeHistoryImports,
  listImportedTrades,
  getTradeHistorySummary,
  type ImportSource,
} from "../lib/tradeHistory/service.js";

const router = Router();

// ── POST /api/me/trade-history/import ─────────────────────────────────────
// Accepts raw file text (CSV or HTML) or pre-parsed Excel rows.
// Returns import summary with data quality score.

const ImportBody = z.object({
  source:       z.enum(["MT5_CSV", "MT5_HTML", "MT5_EXCEL", "MANUAL"]),
  rawText:      z.string().max(10_000_000).optional(), // CSV or HTML content
  excelRows:    z.array(z.array(z.unknown())).max(50_000).optional(),
  fileName:     z.string().max(255).optional(),
  accountLabel: z.string().max(100).optional(),
  brokerHint:   z.string().max(100).optional(),
  isLive:       z.boolean().optional(),
});

router.post("/me/trade-history/import", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const parsed = ImportBody.safeParse(req.body ?? {});
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_BODY", details: parsed.error.issues });
  }

  const { source, rawText, excelRows, fileName, accountLabel, brokerHint, isLive } = parsed.data;

  if (!rawText && !excelRows) {
    return res.status(400).json({ ok: false, error: "NO_DATA", message: "Provide rawText (CSV/HTML) or excelRows." });
  }

  try {
    const summary = await runTradeHistoryImport({
      userId,
      source: source as ImportSource,
      rawText,
      excelRows: excelRows as Array<Array<unknown>> | undefined,
      fileName,
      accountLabel,
      brokerHint,
      isLive,
    });

    return res.json({ ok: true, ...summary });
  } catch (e) {
    req.log?.error({ err: e, userId }, "trade_history_import_failed");
    return res.status(500).json({ ok: false, error: "IMPORT_FAILED", message: "Import failed. Please try again." });
  }
});

// ── GET /api/me/trade-history/imports ────────────────────────────────────
// List all import batches for the current user.

router.get("/me/trade-history/imports", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const imports = await listTradeHistoryImports(userId);
    return res.json({ ok: true, imports });
  } catch (e) {
    req.log?.error({ err: e, userId }, "trade_history_list_imports_failed");
    return res.status(500).json({ ok: false, error: "LIST_FAILED" });
  }
});

// ── GET /api/me/trade-history ─────────────────────────────────────────────
// Paged list of imported trades.
// Query params: importId, symbol, side, limit, offset

const ListQuery = z.object({
  importId: z.string().optional(),
  symbol:   z.string().max(20).optional(),
  side:     z.enum(["BUY", "SELL"]).optional(),
  limit:    z.coerce.number().int().min(1).max(500).optional(),
  offset:   z.coerce.number().int().min(0).optional(),
});

router.get("/me/trade-history", requireUser, async (req, res) => {
  const userId = req.authUser!.id;

  const parsed = ListQuery.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({ ok: false, error: "BAD_QUERY" });
  }

  try {
    const { trades, total } = await listImportedTrades({
      userId,
      ...parsed.data,
    });
    return res.json({ ok: true, trades, total, limit: parsed.data.limit ?? 100, offset: parsed.data.offset ?? 0 });
  } catch (e) {
    req.log?.error({ err: e, userId }, "trade_history_list_failed");
    return res.status(500).json({ ok: false, error: "LIST_FAILED" });
  }
});

// ── GET /api/me/trade-history/summary ────────────────────────────────────
// Aggregated stats — used by Ruby tools and the dashboard.

router.get("/me/trade-history/summary", requireUser, async (req, res) => {
  const userId = req.authUser!.id;
  try {
    const summary = await getTradeHistorySummary(userId);
    return res.json({ ok: true, ...summary });
  } catch (e) {
    req.log?.error({ err: e, userId }, "trade_history_summary_failed");
    return res.status(500).json({ ok: false, error: "SUMMARY_FAILED" });
  }
});

export default router;
