// Deriv synthetic feed — user-facing market-data endpoints.
//
// All responses are read-only and never contain DERIV_APP_ID,
// DERIV_API_TOKEN, bridge tokens, or any other secret. The status
// payload reports config presence as boolean only.

import { Router, type Request, type Response } from "express";
import {
  DERIV_SYNTHETIC_SYMBOLS,
  getDerivCandles,
  getDerivFeedStatus,
  getDerivTick,
  resolveDerivSymbol,
} from "../lib/data/providers/derivProvider.js";

const router = Router();

function requireUserSession(req: Request, res: Response): { id: number } | null {
  const u = (req as unknown as { authUser?: { id: number } }).authUser;
  if (!u) { res.status(401).json({ error: "AUTH_REQUIRED" }); return null; }
  return { id: u.id };
}

router.get("/market-data/deriv/status", async (req, res) => {
  if (!requireUserSession(req, res)) return;
  res.json(getDerivFeedStatus());
});

router.get("/market-data/deriv/symbols", async (req, res) => {
  if (!requireUserSession(req, res)) return;
  res.json({
    symbols: DERIV_SYNTHETIC_SYMBOLS.map((s) => ({
      symbol: s.symbol,
      displayName: s.displayName,
      derivId: s.derivId,
      oneHertz: s.oneHertz,
    })),
  });
});

router.get("/market-data/deriv/ticks", async (req, res) => {
  if (!requireUserSession(req, res)) return;
  const symbol = String(req.query.symbol ?? "").trim();
  if (!symbol) { res.status(400).json({ ok: false, reason: "SYMBOL_REQUIRED", tick: null }); return; }
  const out = await getDerivTick(symbol);
  res.json(out);
});

router.get("/market-data/deriv/candles", async (req, res) => {
  if (!requireUserSession(req, res)) return;
  const symbol = String(req.query.symbol ?? "").trim();
  const timeframe = String(req.query.granularity ?? req.query.timeframe ?? "M15").trim();
  const count = Math.max(1, Math.min(500, Number.parseInt(String(req.query.count ?? "100"), 10) || 100));
  if (!symbol) { res.status(400).json({ ok: false, reason: "SYMBOL_REQUIRED", candles: [] }); return; }
  if (!resolveDerivSymbol(symbol)) {
    res.status(404).json({ ok: false, reason: "Symbol unavailable from Deriv feed.", candles: [], symbol });
    return;
  }
  const out = await getDerivCandles(symbol, timeframe, count);
  res.json(out);
});

export default router;
