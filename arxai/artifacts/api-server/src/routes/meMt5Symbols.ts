// T033 Phase 6 (backend) — user-facing symbol read + resolve endpoints.
//
// These are USER-facing (session auth via requireUser), NOT bridge endpoints —
// the app reads them. Symbol INGESTION already exists at /mt5/sync-symbol-specs
// (bridge-authed). This file only exposes the stored truth to the frontend.
//
//   GET  /api/me/mt5/symbols            → the user's EA-reported symbol inventory
//   GET  /api/me/mt5/symbols/:symbol    → one symbol's rules
//   POST /api/me/mt5/resolve-symbol     → display/alias → exact brokerSymbol
//                                         (or candidates / a reason; no guess)
//
// SAFETY: read-only; per-user scoped (userId from session). No execution.

import { Router, type IRouter, type Request, type Response } from "express";
import { z } from "zod/v4";
import { requireUser } from "../lib/auth/middleware.js";
import {
  listSymbolsForUser,
  resolveBrokerSymbol,
  resolveEffectiveSymbolOwnerId,
} from "../lib/mt5/symbolDirectory.js";
import { resolveSymbolsForUser } from "../lib/mt5/resolveSymbolsForUser.js";

const router: IRouter = Router();

function getUserId(req: Request): number | null {
  const authUser = (req as Request & { authUser?: { id: number } }).authUser;
  return authUser?.id ?? null;
}

// GET /api/me/symbols
// The merged symbol universe for the picker: the approved ARX Focus markets
// (always present so the picker never goes dark) enriched with the broker's
// enumerated metadata. Display/scanner only — `tradeable` is honest and
// execution still re-gates. See resolveSymbolsForUser for the safety posture.
router.get("/me/symbols", requireUser, async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ ok: false, error: "auth_required" }); return; }
  try {
    const result = await resolveSymbolsForUser(userId);
    res.json(result);
  } catch (e) {
    req.log.error({ err: String(e), userId }, "me_symbols_resolve_failed");
    res.status(500).json({ ok: false, error: "symbols_resolve_failed" });
  }
});

// GET /api/me/mt5/symbols?includeStale=1&tradableOnly=1
router.get("/me/mt5/symbols", requireUser, async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ ok: false, error: "auth_required" }); return; }
  try {
    const includeStale = req.query["includeStale"] === "1" || req.query["includeStale"] === "true";
    const tradableOnly = req.query["tradableOnly"] === "1" || req.query["tradableOnly"] === "true";
    // Shared-bridge users have no own EA → no own symbol specs. Display the
    // active master account's enumerated directory (the instruments they can
    // actually trade). Self-owning users resolve to themselves.
    const { ownerId } = await resolveEffectiveSymbolOwnerId(userId);
    const symbols = await listSymbolsForUser(ownerId, { includeStale, tradableOnly });
    // Surface an overall freshness so the UI can show a single Fresh/Stale chip.
    const anyFresh = symbols.some((s) => s.freshness === "FRESH");
    const overall = symbols.length === 0 ? "MISSING" : anyFresh ? "FRESH" : "STALE";
    res.json({ ok: true, count: symbols.length, overallFreshness: overall, symbols });
  } catch (e) {
    req.log.error({ err: String(e), userId }, "me_mt5_symbols_failed");
    res.status(500).json({ ok: false, error: "symbols_read_failed" });
  }
});

// GET /api/me/mt5/symbols/:symbol
router.get("/me/mt5/symbols/:symbol", requireUser, async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ ok: false, error: "auth_required" }); return; }
  const requested = String(req.params["symbol"] ?? "");
  try {
    const { ownerId } = await resolveEffectiveSymbolOwnerId(userId);
    const resolution = await resolveBrokerSymbol(ownerId, requested);
    if (resolution.ok) {
      res.json({ ok: true, resolution });
    } else {
      // 200 with ok:false — this is a normal "couldn't resolve" answer, not a
      // server error. `resolution` already carries ok:false + reasonCode; the
      // UI uses reasonCode to decide what to show.
      res.json(resolution);
    }
  } catch (e) {
    req.log.error({ err: String(e), userId, requested }, "me_mt5_symbol_rules_failed");
    res.status(500).json({ ok: false, error: "symbol_rules_failed" });
  }
});

// POST /api/me/mt5/resolve-symbol  { symbol: "V75" }
const ResolveBody = z.object({ symbol: z.string().min(1) });
router.post("/me/mt5/resolve-symbol", requireUser, async (req: Request, res: Response): Promise<void> => {
  const userId = getUserId(req);
  if (!userId) { res.status(401).json({ ok: false, error: "auth_required" }); return; }
  let body: z.infer<typeof ResolveBody>;
  try { body = ResolveBody.parse(req.body); }
  catch { res.status(400).json({ ok: false, error: "symbol_required" }); return; }
  try {
    const { ownerId } = await resolveEffectiveSymbolOwnerId(userId);
    const resolution = await resolveBrokerSymbol(ownerId, body.symbol);
    res.json(resolution.ok ? { ok: true, resolution } : resolution);
  } catch (e) {
    req.log.error({ err: String(e), userId }, "me_mt5_resolve_symbol_failed");
    res.status(500).json({ ok: false, error: "resolve_failed" });
  }
});

export default router;
