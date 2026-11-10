// (N) Pluggable news provider interface for the DB-sync path. Every provider
// reads the single shared calendar service (Trading Economics or FRED). With no
// provider selected the picker returns an honest-empty provider named "none":
// the former mock generator (invented FOMC/CPI/NFP times) is gone.

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
  /** When ARX fetched this event from the provider. */
  fetchedAt: Date;
}

export interface NewsProvider {
  name: string;
  fetchEvents(daysAhead: number): Promise<ProviderEvent[]>;
}

// No provider selected: honest-empty. Never fabricated rows.
export const unconfiguredNewsProvider: NewsProvider = {
  name: "none",
  async fetchEvents(): Promise<ProviderEvent[]> {
    return [];
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
// never fabricated events. No selection at all returns the honest-empty
// "none" provider.
export function pickNewsProvider(): NewsProvider {
  switch (selectedEconomicCalendarProvider()) {
    case "fred":
      return fredNewsProvider;
    case "trading_economics":
      return tradingEconomicsNewsProvider;
    default:
      return unconfiguredNewsProvider;
  }
}
