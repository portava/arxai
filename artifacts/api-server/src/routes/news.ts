import { Router } from "express";
import { GetEconomicCalendarQueryParams } from "@workspace/api-zod";
import { getEconomicCalendarResult } from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";

const router = Router();

// NOTE (Theme G-CUT): the sweep listed BOTH legacy /news routes as "no frontend
// consumer". That is true of /news/risk, which is deleted here — but NOT of
// /news/calendar, which backs two live surfaces via useGetEconomicCalendar:
// the Economic Calendar page (pages/calendar.tsx) and the cockpit's critical
// events card (CockpitCards.tsx). Theme H5 also names the Economic Calendar as
// the calendar surface to KEEP, so cutting this route would have broken the
// very page the consolidation preserves. It stays.
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

export default router;
