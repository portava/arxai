// Adapters: normalized CalendarEvent → each consumer's legacy shape. Pure, no
// network. Keeps the rich shared shape as the single source while every existing
// surface keeps its back-compat contract. The `critical` bucket collapses to
// `high` for the two legacy 3-level enums (RawCalendarEvent, assistant EconomicEvent).

import type { RawCalendarEvent } from "@workspace/domain/smart-chart";
import type { CalendarEvent } from "./calendarTypes.js";
import type { ProviderEvent } from "./newsProvider.js";
import type { EconomicEvent as MockEconomicEvent } from "./economicEvents.js";

type ThreeLevel = "low" | "medium" | "high";

function toThreeLevel(impact: CalendarEvent["impact"]): ThreeLevel {
  return impact === "critical" ? "high" : impact;
}

/** Assistant (Ruby) economic-event shape — structurally identical to
 * marketProvider's `EconomicEvent`, declared locally to avoid an import cycle. */
export interface AssistantEconomicEvent {
  whenIso: string;
  region: string;
  title: string;
  importance: ThreeLevel;
  forecast?: string | null;
  previous?: string | null;
}

/** → smart-chart RawCalendarEvent (Market Impact Radar). */
export function toRawCalendarEvents(events: CalendarEvent[]): RawCalendarEvent[] {
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    currency: e.currency,
    impact: toThreeLevel(e.impact),
    eventTimeIso: e.eventTimeUtc,
    affectedMarkets: e.affectedSymbols,
  }));
}

/** → assistant EconomicEvent (Ruby market context). */
export function toAssistantEconomicEvents(events: CalendarEvent[]): AssistantEconomicEvent[] {
  return events.map((e) => ({
    whenIso: e.eventTimeUtc,
    region: e.country || e.currency,
    title: e.title,
    importance: toThreeLevel(e.impact),
    forecast: e.forecast,
    previous: e.previous,
  }));
}

/** → newsProvider ProviderEvent (DB-sync path: Economic Calendar page, News Risk, Scanner). */
export function toProviderEvents(events: CalendarEvent[]): ProviderEvent[] {
  const impactUpper: Record<CalendarEvent["impact"], ProviderEvent["impactLevel"]> = {
    low: "LOW", medium: "MEDIUM", high: "HIGH", critical: "CRITICAL",
  };
  return events.map((e) => ({
    externalId: e.id,
    eventName: e.title,
    country: e.country,
    currency: e.currency,
    impactLevel: impactUpper[e.impact],
    forecast: e.forecast,
    previous: e.previous,
    actual: e.actual,
    eventTime: new Date(e.eventTimeUtc),
    source: e.source,
    affectedSymbols: e.affectedSymbols.length > 0 ? e.affectedSymbols : null,
  }));
}

/** → /news/calendar mock-compatible EconomicEvent array. */
export function toMockShapeEvents(events: CalendarEvent[]): MockEconomicEvent[] {
  return events.map((e) => ({
    id: e.id,
    title: e.title,
    country: e.country,
    currency: e.currency,
    impact: toThreeLevel(e.impact),
    actual: e.actual,
    forecast: e.forecast,
    previous: e.previous,
    eventTime: e.eventTimeUtc,
    affectedMarkets: e.affectedSymbols,
    source: e.source,
  }));
}
