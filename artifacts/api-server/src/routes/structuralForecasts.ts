import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveArxMarket } from "@workspace/domain/market";
import { structuralService } from "../lib/structural/runtime.js";
import { logger } from "../lib/logger.js";
import type { StructuralForecastService } from "../lib/structural/service.js";

function symbolFrom(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  return resolveArxMarket(value)?.canonicalSymbol ?? null;
}
export function createStructuralForecastRouter(service: Pick<StructuralForecastService, "issue" | "history">) {
const router = Router();
router.post("/me/structural/forecasts", requireUser, async (req, res) => {
  const symbol = symbolFrom(req.body?.symbol);
  if (!symbol) { res.status(400).json({ error: "INVALID_SYMBOL" }); return; }
  try {
    const row = await service.issue(req.authUser!.id, symbol);
    res.json({ ok: true, saved: true, ...row });
  } catch (error) {
    logger.warn({ err: error }, "Structural forecast unavailable");
    const message = error instanceof Error ? error.message : "FORECAST_UNAVAILABLE";
    // Return domain refusal codes, never database/credential-bearing errors.
    res.status(503).json({ ok: false, saved: false, reason: /^[A-Z_]+$/.test(message) ? message : "FORECAST_UNAVAILABLE" });
  }
});
router.get("/me/structural/forecasts", requireUser, async (req, res) => {
  const symbol = symbolFrom(req.query.symbol);
  if (!symbol) { res.status(400).json({ error: "INVALID_SYMBOL" }); return; }
  try { res.json({ ok: true, forecasts: await service.history(req.authUser!.id, symbol) }); }
  catch (error) { logger.warn({ err: error }, "Structural history unavailable"); res.status(503).json({ ok: false, reason: "PREDICTION_MEMORY_UNAVAILABLE" }); }
});
return router;
}
export default createStructuralForecastRouter(structuralService);
