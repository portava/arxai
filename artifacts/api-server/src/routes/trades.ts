import { Router } from "express";
import { db } from "@workspace/db";
import { tradesTable, botSettingsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import {
  GetTradesQueryParams,
  GetTradesResponse,
  GetOpenTradesResponse,
} from "@workspace/api-zod";
import { requireUser } from "../lib/auth/middleware.js";

const router = Router();

// GET /trades — Phase-2: scoped to req.authUser.id.
router.get("/trades", requireUser, async (req, res) => {
  try {
    const params = GetTradesQueryParams.parse({
      symbol: req.query["symbol"],
      status: req.query["status"],
      limit: req.query["limit"] ? Number(req.query["limit"]) : 50,
    });
    const userId = req.authUser!.id;
    const rows = await db.select().from(tradesTable)
      .where(eq(tradesTable.userId, userId))
      .orderBy(desc(tradesTable.createdAt))
      .limit(params.limit ?? 50);
    let filtered = rows;
    if (params.symbol) filtered = filtered.filter((r) => r.symbol === params.symbol);
    if (params.status) filtered = filtered.filter((r) => r.status === params.status);
    const data = GetTradesResponse.parse(filtered.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get trades" });
  }
});

// GET /trades/open — Phase-2: scoped to req.authUser.id.
router.get("/trades/open", requireUser, async (req, res) => {
  try {
    const userId = req.authUser!.id;
    const rows = await db.select().from(tradesTable)
      .where(and(eq(tradesTable.status, "OPEN"), eq(tradesTable.userId, userId)))
      .orderBy(desc(tradesTable.createdAt));
    const data = GetOpenTradesResponse.parse(rows.map((r) => ({
      ...r,
      createdAt: r.createdAt?.toISOString() ?? new Date().toISOString(),
      closedAt: r.closedAt?.toISOString() ?? null,
    })));
    res.json(data);
  } catch (err) {
    req.log.error(err);
    res.status(500).json({ error: "Failed to get open trades" });
  }
});

// POST /execute-trade — RETIRED (owner decision 14, 2026-10-25).
//
// This endpoint never placed a broker order. It ran the Safety Core gate and
// wrote a `trades` row whose `mode` column recorded the Safety Core state
// ("LIVE" / "DEMO"), not a venue. It now refuses every request and executes
// nothing: no gate runs, no confirmation is claimed and no row is written. A
// request is never converted into a different mode — in particular a LIVE
// request is NOT turned into a simulated trade. The response names the
// governed paths to use instead:
//   simulated (PAPER) → POST /api/paper/orders (Trade Engine submitTrade, mode
//                       PAPER, with the pre-trade Risk Governor)
//   DEMO / LIVE       → the Trade Action Center (/api/me/trade-actions), whose
//                       confirmed actions go through the Trade Engine pipeline
//                       and every venue gate.
// Historical `trades` rows are kept and still readable through GET /trades.
// See docs/TIER1_TRADE_ENGINE_MODES.md (round 5) and docs/TIER1_PAPER_BOOK.md.
export const EXECUTE_TRADE_RETIRED = {
  ok: false,
  success: false,
  code: "EXECUTE_TRADE_RETIRED",
  error: "POST /api/execute-trade is retired. Nothing was executed and nothing was recorded.",
  executed: false,
  converted: false,
  instead: {
    PAPER: { method: "POST", path: "/api/paper/orders", note: "Simulated order in your active paper account, checked by the Risk Governor." },
    DEMO: { method: "POST", path: "/api/me/trade-actions", note: "Create a DEMO action, then confirm it; it goes through the governed DEMO venue." },
    LIVE: { method: "POST", path: "/api/me/trade-actions", note: "LIVE orders go only through the governed LIVE path and its own confirmation; this endpoint never converts a LIVE request into a simulated one." },
  },
  history: { method: "GET", path: "/api/trades", note: "Historical rows are kept. Their mode field recorded the Safety Core state, not a broker execution." },
} as const;

router.post("/execute-trade", requireUser, (_req, res) => {
  res.status(410).json(EXECUTE_TRADE_RETIRED);
});

// Suppress unused-var warning when botSettingsTable is no longer referenced.
void botSettingsTable;

export default router;
