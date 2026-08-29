import { Router } from "express";
import { GetEconomicCalendarQueryParams } from "@workspace/api-zod";
import { getEconomicCalendarResult } from "../lib/news/calendar/economicCalendarService.js";
import { toMockShapeEvents } from "../lib/news/calendar/calendarAdapters.js";

const router = Router();

// NOTE (Theme G-CUT): the sweep listed BOTH legacy /news routes as "no frontend
// consumer". That is true of /news/risk, which is deleted here — but NOT of
// /news/calendar, which still backs the cockpit's critical events card
// (CockpitCards.tsx) via useGetEconomicCalendar. The other consumer — the
// legacy pages/calendar.tsx list — was retired in the surface consolidation
// (/calendar now redirects to the unified /economic-calendar, which Theme H5
// names as the calendar surface to KEEP). Cut this route only after
// CockpitCards is repointed to the unified endpoint (an openapi + codegen
// ripple). Until then it stays, honest-or-empty.
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
