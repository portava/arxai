// Ruby Market Timing Brain — HTTP route.
//
// GET /me/timing-brain/:symbol   → MarketTimingRead (per-user, auth required)
// GET /me/timing-brain           → multi-symbol shortlist (up to 6 symbols)
//
// Advisory only — never an execution gate.
// All reads are per-user (authUser.id) even though the read itself is
// symbol-level market data, so the user must be authenticated.

import { Router } from "express";
import { z } from "zod/v4";
import { getCachedTimingRead } from "../brain/timing/timingReadCache.js";
import { emitHeatAlerts } from "../lib/heat/heatAlertEmitter.js";
import { logger } from "../lib/logger.js";
import {
  resolveArxMarket,
  arxFocusBlockedEnvelope,
  arxFocusApprovedEnvelope,
} from "@workspace/domain/market";

const router = Router();

const symbolSchema = z.string().min(1).max(64);
const timeframeSchema = z.enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"]).default("M15");

// ── GET /me/timing-brain/:symbol ─────────────────────────────────────────────
// Returns a single MarketTimingRead for the given symbol.
// Requires an authenticated session.

router.get("/me/timing-brain/:symbol", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const symbolParse = symbolSchema.safeParse(req.params["symbol"]);
    if (!symbolParse.success) {
      res.status(400).json({ error: "Invalid symbol" });
      return;
    }

    // Focus-Lock backstop (Task #570): an unapproved symbol returns the shared
    // blocked envelope and fetches NO data. Advisory surface — never a gate.
    const focusMarket = resolveArxMarket(symbolParse.data);
    if (!focusMarket) {
      res.status(200).json(arxFocusBlockedEnvelope(symbolParse.data));
      return;
    }

    const tfParse = timeframeSchema.safeParse(req.query["timeframe"] ?? "M15");
    const timeframe = tfParse.success ? tfParse.data : "M15";

    const userTimezone = typeof req.query["tz"] === "string" ? req.query["tz"] : null;

    const read = await getCachedTimingRead({
      symbol: symbolParse.data,
      timeframe,
      userTimezone,
    });

    // Fire-and-forget: emit heat alerts from the read. Never blocks the response.
    emitHeatAlerts(userId, read).catch(() => undefined);

    // Approved → carry the shared extended approved envelope alongside the read.
    // Additive (nested key) — existing consumers of the read shape are unaffected.
    res.json({ ...read, arxFocus: arxFocusApprovedEnvelope(focusMarket) });
  } catch (err) {
    logger.error({ err }, "timingBrain: single read failed");
    next(err);
  }
});

// ── GET /me/timing-brain ──────────────────────────────────────────────────────
// Multi-symbol heat scan. Pass ?symbols=EURUSD,GBPUSD,... (max 6).
// Returns { results: MarketTimingRead[] } — in-order, fail-open per symbol.

router.get("/me/timing-brain", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }

    const raw = typeof req.query["symbols"] === "string" ? req.query["symbols"] : "";
    const requested = raw.split(",").map((s) => s.trim()).filter(Boolean);

    if (requested.length === 0) {
      res.status(400).json({ error: "Provide at least one symbol via ?symbols=" });
      return;
    }

    const tfParse = timeframeSchema.safeParse(req.query["timeframe"] ?? "M15");
    const timeframe = tfParse.success ? tfParse.data : "M15";
    const userTimezone = typeof req.query["tz"] === "string" ? req.query["tz"] : null;

    // Focus-Lock backstop (Task #570): preserve request order and return an
    // EXPLICIT per-symbol entry for every requested symbol (capped at 6) — an
    // unapproved symbol gets the shared blocked envelope (no data fetched), an
    // approved symbol gets its read augmented with the approved envelope.
    // Advisory-only — never a gate; nothing is silently dropped.
    const capped = requested.slice(0, 6);
    const results = await Promise.all(
      capped.map(async (symbol) => {
        const focusMarket = resolveArxMarket(symbol);
        if (!focusMarket) return arxFocusBlockedEnvelope(symbol);
        try {
          const r = await getCachedTimingRead({ symbol, timeframe, userTimezone });
          emitHeatAlerts(userId, r).catch(() => undefined);
          return { ...r, arxFocus: arxFocusApprovedEnvelope(focusMarket) };
        } catch {
          return null;
        }
      }),
    );

    res.json({ results: results.filter(Boolean) });
  } catch (err) {
    logger.error({ err }, "timingBrain: multi-read failed");
    next(err);
  }
});

export default router;
