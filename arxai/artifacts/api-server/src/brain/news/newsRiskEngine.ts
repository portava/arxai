// News Risk Engine — verdicts from the REAL economic calendar seam.
//
// FABRICATION REMOVAL (R7 step 1d). This module previously shipped a
// hardcoded weekly template (`NEWS_SCHEDULE`) of "typical" event times —
// including an explicitly labeled "Fed Chair Speech (simulated)" — and scored
// news risk against the UTC clock as if those events existed. That is a clock,
// not a calendar. It is gone.
//
// The repo already has the provider-agnostic calendar seam
// (`lib/news/calendar/newsRiskResolver` → `getEconomicCalendarResult`): a
// connected provider yields REAL events; a missing/errored provider yields the
// honest `newsRiskUnavailable` verdict (never blockTrading, never a countdown,
// `calendarAvailable: false`). This engine is now a thin adapter over that
// seam:
//
//   analyzeNewsRiskLive  — async, resolves the real calendar. Used by the
//                          market brain (already an async path).
//   analyzeNewsRisk      — sync signature kept for the timing brain
//                          (newsHeatEngine calls it synchronously). It answers
//                          from the last successfully-resolved calendar
//                          snapshot and kicks off a background refresh; until
//                          a real snapshot exists it returns the honest
//                          "calendar unavailable" verdict. It NEVER fabricates
//                          an event and NEVER blocks trading on unknown data.

import {
  resolveNewsRiskEvents,
  newsRiskFrom,
  type ResolvedNewsRiskEvents,
} from "../../lib/news/calendar/newsRiskResolver.js";
import {
  isSyntheticNewsSymbol,
  scoreNewsRisk,
  type NewsRisk,
} from "../../lib/news/calendar/newsRiskScorer.js";

export interface NewsRiskAnalysis {
  majorNewsSoon: boolean;
  affectedCurrencies: string[];
  affectedIndices: string[];
  riskLevel: "Low" | "Medium" | "High" | "Critical";
  blockTrading: boolean;
  reason: string;
  nextEvent?: string;
  /** True only when the verdict is derived from a KNOWN event set (connected
   *  calendar, or a synthetic symbol that is genuinely news-immune).
   *  `riskLevel: "Low"` with `providerConnected: false` means "cannot see",
   *  NOT "clear" — never reassure on it. Optional so existing injected test
   *  fixtures (newsHeatEngine deps) stay valid; this engine always sets it. */
  providerConnected?: boolean;
  /** Present when the verdict could not be read from a real calendar. */
  safetyNote?: string;
}

export const NEWS_CALENDAR_NOT_CONNECTED_NOTE =
  "No economic-calendar provider is connected/readable. ARX does not fabricate news " +
  "events, so news risk is UNKNOWN (shown as Low with providerConnected=false) and " +
  "trading is never blocked or cleared on invented data.";

const SYNTHETIC_REASON =
  "Synthetic indices are immune to real-world economic news. No news filter applied.";

function toAnalysis(risk: NewsRisk): NewsRiskAnalysis {
  const riskLevel: NewsRiskAnalysis["riskLevel"] =
    risk.blockTrading ? "Critical"
    : risk.riskLevel === "high" ? "High"
    : risk.riskLevel === "medium" ? "Medium"
    : "Low";
  return {
    majorNewsSoon: risk.riskLevel === "high" || risk.riskLevel === "medium",
    affectedCurrencies: risk.upcomingEvent ? [risk.upcomingEvent.currency] : [],
    affectedIndices: risk.upcomingEvent?.affectedMarkets ?? [],
    riskLevel,
    blockTrading: risk.blockTrading,
    reason: risk.reason,
    nextEvent: risk.upcomingEvent?.title,
    providerConnected: risk.calendarAvailable,
    safetyNote: risk.calendarAvailable ? undefined : NEWS_CALENDAR_NOT_CONNECTED_NOTE,
  };
}

function syntheticAnalysis(): NewsRiskAnalysis {
  return {
    majorNewsSoon: false,
    affectedCurrencies: [],
    affectedIndices: [],
    riskLevel: "Low",
    blockTrading: false,
    reason: SYNTHETIC_REASON,
    // The verdict is genuinely KNOWN without a provider (instrument-class fact).
    providerConnected: true,
  };
}

function unavailableAnalysis(reason: string): NewsRiskAnalysis {
  return {
    majorNewsSoon: false,
    affectedCurrencies: [],
    affectedIndices: [],
    riskLevel: "Low",
    blockTrading: false,
    reason,
    providerConnected: false,
    safetyNote: NEWS_CALENDAR_NOT_CONNECTED_NOTE,
  };
}

// ── Async path (market brain) ─────────────────────────────────────────────────

export async function analyzeNewsRiskLive(
  symbol: string,
  category: string,
): Promise<NewsRiskAnalysis> {
  if (category === "synthetic" || isSyntheticNewsSymbol(symbol)) return syntheticAnalysis();
  const resolved = await resolveCached();
  return toAnalysis(newsRiskFrom(symbol, resolved));
}

// ── Sync path (timing brain / newsHeatEngine) ────────────────────────────────
//
// The calendar can only be read asynchronously. The sync signature is kept for
// its existing consumer by serving the last-resolved snapshot and refreshing in
// the background (the underlying calendar service itself caches for ~5 min).
// UNKNOWN is a valid outcome: before the first successful resolution the
// verdict is the honest unavailable shape, never an invented schedule.

const SNAPSHOT_TTL_MS = 5 * 60_000;
let cachedResolved: ResolvedNewsRiskEvents | null = null;
let cachedAtMs = 0;
let refreshInFlight: Promise<void> | null = null;

async function resolveCached(): Promise<ResolvedNewsRiskEvents> {
  const now = Date.now();
  if (cachedResolved && now - cachedAtMs < SNAPSHOT_TTL_MS) return cachedResolved;
  const resolved = await resolveNewsRiskEvents();
  cachedResolved = resolved;
  cachedAtMs = Date.now();
  return resolved;
}

function kickBackgroundRefresh(): void {
  const now = Date.now();
  if (refreshInFlight) return;
  if (cachedResolved && now - cachedAtMs < SNAPSHOT_TTL_MS) return;
  refreshInFlight = resolveCached()
    .then(() => undefined, () => undefined)
    .finally(() => { refreshInFlight = null; });
}

/** TEST-ONLY: clear the module snapshot so tests are deterministic. */
export function __resetNewsRiskSnapshotForTests(): void {
  cachedResolved = null;
  cachedAtMs = 0;
  refreshInFlight = null;
}

export function analyzeNewsRisk(symbol: string, category: string): NewsRiskAnalysis {
  if (category === "synthetic" || isSyntheticNewsSymbol(symbol)) return syntheticAnalysis();

  kickBackgroundRefresh();

  if (!cachedResolved) {
    return unavailableAnalysis(
      "Economic calendar not loaded yet — news risk is UNKNOWN (no fabricated schedule).",
    );
  }
  if (!cachedResolved.available) {
    return unavailableAnalysis(cachedResolved.reason);
  }
  return toAnalysis(scoreNewsRisk(symbol, cachedResolved.events));
}
