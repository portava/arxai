import { z } from "zod/v4";
import { readAtiQuoteOperations } from "../lib/structural/atiQuoteOperations.js";
import { Router } from "express";
import { requireUser } from "../lib/auth/middleware.js";
import { resolveArxMarket } from "@workspace/domain/market";
import { structuralService } from "../lib/structural/runtime.js";
import { logger } from "../lib/logger.js";
import { ForecastRefusal, type StoredForecast, type StructuralForecastService } from "../lib/structural/service.js";
import { reportAtiSpecialistCosts } from "../lib/structural/atiSpecialistCosts.js";
import { reportAtiSpecialists } from "../lib/structural/atiSpecialistReport.js";
import { reportAtiStructuralValidation } from "../lib/structural/atiValidationReport.js";

function symbolFrom(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 100) return null;
  return resolveArxMarket(value)?.canonicalSymbol ?? null;
}
// A legacy receipt can contain a calculated entry that was never published.
// Keep the immutable receipt in storage and expose only the effective instruction.
function publicForecast(row: StoredForecast): StoredForecast {
  const plan = row.forecast.paperInstruction;
  if (!plan || plan.action === "HOLD" || row.paperPublishedAt != null) return row;
  return { ...row, forecast: { ...row.forecast, paperInstruction: {
    action: "HOLD", reason: "No paper order was issued for this forecast.",
  } } };
}
export function createStructuralForecastRouter(service: Pick<StructuralForecastService, "issue" | "history">) {
const router = Router();
router.post("/me/structural/forecasts", requireUser, async (req, res) => {
  const symbol = symbolFrom(req.body?.symbol);
  if (!symbol) { res.status(400).json({ error: "INVALID_SYMBOL" }); return; }
  try {
    // Optional; an unknown window is refused by the service (INVALID_HORIZON).
    const horizon = typeof req.body?.horizon === "string" && req.body.horizon.length <= 8 ? req.body.horizon : undefined;
    const row = await service.issue(req.authUser!.id, symbol, horizon);
    res.json({ ok: true, saved: true, ...publicForecast(row) });
  } catch (error) {
    logger.warn({ err: error }, "Structural forecast unavailable");
    const message = error instanceof Error ? error.message : "FORECAST_UNAVAILABLE";
    // Return domain refusal codes, never database/credential-bearing errors.
    res.status(503).json({ ok: false, saved: false, reason: /^[A-Z_]+$/.test(message) ? message : "FORECAST_UNAVAILABLE",
      ...(error instanceof ForecastRefusal && error.detail ? { detail: error.detail } : {}) });
  }
});
router.get("/me/structural/forecasts", requireUser, async (req, res) => {
  const symbol = symbolFrom(req.query.symbol);
  if (!symbol) { res.status(400).json({ error: "INVALID_SYMBOL" }); return; }
  try {
    const rows = await service.history(req.authUser!.id, symbol);
    res.json({ ok: true, forecasts: rows.map(publicForecast),
      ...(req.query.atiSpecialistCosts === "1" ? { atiSpecialistCosts: await reportAtiSpecialistCosts(rows) } : {}),
      ...(req.query.atiSpecialists === "1" ? { atiSpecialists: reportAtiSpecialists(rows) } : {}),
      ...(req.query.atiValidation === "1" ? { atiValidation: reportAtiStructuralValidation(rows) } : {}) });
  }
  catch (error) { logger.warn({ err: error }, "Structural history unavailable"); res.status(503).json({ ok: false, reason: "PREDICTION_MEMORY_UNAVAILABLE" }); }
});
router.get("/me/structural/forecasts/:receiptId/operations", requireUser, async (req, res) => {
  const id = z.string().regex(/^structural-[0-9a-f]{64}$/).safeParse(req.params.receiptId);
  const query = z.object({asOf:z.iso.datetime().optional()}).safeParse(req.query);
  if (!id.success || !query.success) { res.status(400).json({error:"INVALID_INPUT"}); return; }
  const asOf = query.data.asOf ? new Date(query.data.asOf) : new Date();
  if (+asOf > Date.now()) { res.status(400).json({error:"FUTURE_CUTOFF"}); return; }
  const report = await readAtiQuoteOperations(req.authUser!.id,id.data,asOf);
  if (!report) { res.status(404).json({error:"RECEIPT_UNAVAILABLE"}); return; }
  res.json(report);
});
return router;
}
export default createStructuralForecastRouter(structuralService);
