// (N) Pluggable news provider interface. The mock provider mirrors the
// existing in-memory generator (kept for /news/calendar back-compat) but
// produces records in the spec shape (CRITICAL impact level supported,
// stable externalId, eventTime as ISO). Replace this file's `pickProvider`
// with a real API client when one is configured.
//
// When TRADING_ECONOMICS_KEY is set, `pickNewsProvider()` returns the real
// Trading Economics provider instead of the mock. Both providers implement
// the same `NewsProvider` interface so no downstream caller changes.

import { getMockEvents } from "./economicEvents.js";
import {
  getEconomicCalendarResult,
  selectedEconomicCalendarProvider,
} from "./economicCalendarService.js";
import { toProviderEvents } from "./calendarAdapters.js";

export interface ProviderEvent {
  externalId: string;
  eventName: string;
  country: string;
  currency: string;
  impactLevel: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
  forecast: string | null;
  previous: string | null;
  actual: string | null;
  eventTime: Date;
  source: string;
  affectedSymbols: string[] | null;
}

export interface NewsProvider {
  name: string;
  fetchEvents(daysAhead: number): Promise<ProviderEvent[]>;
}

const IMPACT_UPPER: Record<string, "LOW" | "MEDIUM" | "HIGH" | "CRITICAL"> = {
  low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
};

// Heuristic: certain titles are de-facto CRITICAL (rate decisions of major
// central banks). Mock data only flags them as HIGH; promote here so the
// downstream rules can exercise the CRITICAL path.
const CRITICAL_TITLES = [/FOMC Rate Decision/i, /ECB Rate Decision/i, /BoE Rate Decision/i, /BoJ Policy/i];

export const mockNewsProvider: NewsProvider = {
  name: "mock",
  async fetchEvents(daysAhead: number): Promise<ProviderEvent[]> {
    const raw = getMockEvents(daysAhead);
    return raw.map((e) => {
      const baseImpact = IMPACT_UPPER[e.impact] ?? "LOW";
      const promoted = CRITICAL_TITLES.some((rx) => rx.test(e.title));
      return {
        externalId: e.id,
        eventName: e.title,
        country: e.country,
        currency: e.currency,
        impactLevel: promoted ? "CRITICAL" : baseImpact,
        forecast: e.forecast,
        previous: e.previous,
        actual: e.actual,
        eventTime: new Date(e.eventTime),
        source: "mock",
        affectedSymbols: e.affectedMarkets ?? null,
      };
    });
  },
};

// Trading Economics-backed provider. Delegates to the single shared calendar
// service so the DB-sync path (Economic Calendar page, News Risk, Scanner) reads
// the SAME real events as every other surface. Honest-or-empty: only connected
// (ok/empty) results yield events — missing/error never fabricate.
export const tradingEconomicsNewsProvider: NewsProvider = {
  name: "trading_economics",
  async fetchEvents(daysAhead: number): Promise<ProviderEvent[]> {
    const result = await getEconomicCalendarResult({ daysAhead });
    if (!result.connected) return [];
    return toProviderEvents(result.events);
  },
};

// FRED-backed provider. Delegates to the SAME shared calendar service so every
// surface reads identical real events. Honest-or-empty: only connected results
// yield events — missing/error never fabricate.
export const fredNewsProvider: NewsProvider = {
  name: "fred",
  async fetchEvents(daysAhead: number): Promise<ProviderEvent[]> {
    const result = await getEconomicCalendarResult({ daysAhead });
    if (!result.connected) return [];
    return toProviderEvents(result.events);
  },
};

// Selector — env-driven. The returned provider's NAME always reflects the
// SELECTED provider (honesty: never report TE while serving FRED). A selected
// provider serves honest-empty when its key is missing or the upstream errors —
// never fabricated events. The mock is back-compat ONLY when NO provider is
// selected (true legacy default), so a selected-but-unconfigured provider never
// silently syncs fabricated rows.
export function pickNewsProvider(): NewsProvider {
  switch (selectedEconomicCalendarProvider()) {
    case "fred":
      return fredNewsProvider;
    case "trading_economics":
      return tradingEconomicsNewsProvider;
    default:
      return mockNewsProvider;
  }
}
