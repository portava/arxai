import { Router } from "express";
import { GetEconomicCalendarQueryParams, GetNewsRiskQueryParams } from "@workspace/api-zod";
import { getEconomicCalendarResult } from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";
import { resolveNewsRiskForSymbol } from "../lib/news/calendar/newsRiskResolver.js";

const router = Router();

router.get("/news/calendar", async (req, res) => {
  try {
    const q = GetEconomicCalendarQueryParams.parse({
      currency: req.query["currency"],
      impact: req.query["impact"],
      days: req.query["days"] ? Number(req.query["days"]) : 7,
    });
    const days = q.days ?? 7;
    // Honest-or-empty, unconditionally: the real shared calendar service is the
    // ONLY source. Missing/errored provider ⇒ [] (Theme A1). The former "no
    // provider selected ⇒ mock generator" back-compat branch fabricated a full
    // FOMC/CPI/NFP schedule at invented times on every unconfigured deployment,
    // so it is gone rather than narrowed.
    const result = await getEconomicCalendarResult({ daysAhead: days });
    let events = result.connected ? toMockShapeEvents(result.events) : [];
    if (q.currency) events = events.filter((e) => e.currency === q.currency);
    if (q.impact) events = events.filter((e) => e.impact === q.impact);
    res.json(events);
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid calendar request" });
  }
});

router.get("/news/risk", async (req, res) => {
  try {
    const q = GetNewsRiskQueryParams.parse({ symbol: req.query["symbol"] });
    // Real events or an honest unavailable read — never a verdict from invented
    // events (Theme A1).
    res.json(await resolveNewsRiskForSymbol(q.symbol));
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid news risk request" });
  }
});

export default router;
