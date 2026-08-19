// Market Heat — HTTP routes (Task #611).
//
// GET /market-heat                 → full honest heat bundle (countries, currencies, synthetics)
// GET /market-heat/countries       → per-country verdicts
// GET /market-heat/diagnostics     → per-provider diagnostics (key presence only)
// GET /market-heat/symbol/:symbol  → single-symbol verdict (or Focus-Lock blocked envelope)
//
// Advisory only — never an execution gate. Reads are per-user (authUser.id):
// the read is market-level data but requires an authenticated session.

import { Router } from "express";
import { z } from "zod/v4";
import { logger } from "../lib/logger.js";
import {
  buildMarketHeat,
  buildSymbolHeat,
  buildHeatDiagnostics,
} from "../lib/heat/marketHeatService.js";

const router = Router();

const symbolSchema = z.string().min(1).max(64);
const timeframeSchema = z
  .enum(["M1", "M5", "M15", "M30", "H1", "H4", "D1"])
  .default("M15");
const sessionSchema = z.enum(["sydney", "tokyo", "london", "newyork"]);

function boolParam(v: unknown, dflt: boolean): boolean {
  if (typeof v !== "string") return dflt;
  return v !== "false" && v !== "0";
}

/** Parse a comma-separated query value into a trimmed, de-empty list. */
function listParam(v: unknown): string[] | undefined {
  if (typeof v !== "string") return undefined;
  const out = v
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return out.length > 0 ? out : undefined;
}

function sessionParam(v: unknown): string | undefined {
  if (typeof v !== "string") return undefined;
  const parsed = sessionSchema.safeParse(v.toLowerCase());
  return parsed.success ? parsed.data : undefined;
}

// ── GET /market-heat ─────────────────────────────────────────────────────────
router.get("/market-heat", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const tfParse = timeframeSchema.safeParse(req.query["timeframe"] ?? "M15");
    const timeframe = tfParse.success ? tfParse.data : "M15";
    const includeNews = boolParam(req.query["includeNews"], true);
    const includeCalendar = boolParam(req.query["includeCalendar"], true);
    const symbols = listParam(req.query["symbols"]);
    const countries = listParam(req.query["countries"]);
    const session = sessionParam(req.query["session"]);

    const bundle = await buildMarketHeat({
      timeframe,
      includeNews,
      includeCalendar,
      symbols,
      countries,
      session,
    });
    res.json(bundle);
  } catch (err) {
    logger.error({ err }, "marketHeat: bundle failed");
    next(err);
  }
});

// ── GET /market-heat/countries ───────────────────────────────────────────────
router.get("/market-heat/countries", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const tfParse = timeframeSchema.safeParse(req.query["timeframe"] ?? "M15");
    const timeframe = tfParse.success ? tfParse.data : "M15";
    const symbols = listParam(req.query["symbols"]);
    const countries = listParam(req.query["countries"]);
    const session = sessionParam(req.query["session"]);
    const bundle = await buildMarketHeat({
      timeframe,
      includeNews: true,
      includeCalendar: true,
      symbols,
      countries,
      session,
    });
    res.json({
      generatedAt: bundle.generatedAt,
      countries: bundle.countries,
      providerStatus: bundle.providerStatus,
    });
  } catch (err) {
    logger.error({ err }, "marketHeat: countries failed");
    next(err);
  }
});

// ── GET /market-heat/diagnostics ─────────────────────────────────────────────
router.get("/market-heat/diagnostics", async (req, res, next) => {
  try {
    const userId = req.authUser?.id ?? 0;
    if (!userId) {
      res.status(401).json({ error: "Authentication required" });
      return;
    }
    const diag = await buildHeatDiagnostics();
    res.json(diag);
  } catch (err) {
    logger.error({ err }, "marketHeat: diagnostics failed");
    next(err);
  }
});

// ── GET /market-heat/symbol/:symbol ──────────────────────────────────────────
router.get("/market-heat/symbol/:symbol", async (req, res, next) => {
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
    const tfParse = timeframeSchema.safeParse(req.query["timeframe"] ?? "M15");
    const timeframe = tfParse.success ? tfParse.data : "M15";

    // Focus-Lock backstop: buildSymbolHeat returns the honest blocked envelope
    // (isApprovedMarket:false, no data fetched) for an unapproved symbol.
    res.json(await buildSymbolHeat(symbolParse.data, timeframe));
  } catch (err) {
    logger.error({ err }, "marketHeat: symbol failed");
    next(err);
  }
});

export { router as marketHeatRouter };
