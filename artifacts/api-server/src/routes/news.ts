import { Router } from "express";
import { GetEconomicCalendarQueryParams, GetNewsRiskQueryParams } from "@workspace/api-zod";
import { getMockEvents } from "../lib/news/calendar/economicEvents.js";
import {
  getEconomicCalendarResult,
  isEconomicCalendarProviderSelected,
} from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";
import { scoreNewsRisk } from "../lib/news/calendar/newsRiskScorer.js";

const router = Router();

router.get("/news/calendar", async (req, res) => {
  try {
    const q = GetEconomicCalendarQueryParams.parse({
      currency: req.query["currency"],
      impact: req.query["impact"],
      days: req.query["days"] ? Number(req.query["days"]) : 7,
    });
    const days = q.days ?? 7;
    // When Trading Economics is the SELECTED provider, serve the real shared
    // calendar service (honest-or-empty: missing/error ⇒ [] — NEVER mock). The
    // mock generator is back-compat ONLY when no provider is selected (true
    // legacy default), so a selected-but-unconfigured TE never fabricates events.
    let events;
    if (isEconomicCalendarProviderSelected()) {
      const result = await getEconomicCalendarResult({ daysAhead: days });
      events = result.connected ? toMockShapeEvents(result.events) : [];
    } else {
      events = getMockEvents(days);
    }
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
    res.json(scoreNewsRisk(q.symbol));
  } catch (err) {
    req.log.error(err);
    res.status(400).json({ error: "Invalid news risk request" });
  }
});

export default router;
