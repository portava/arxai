// ── Short-TTL cache for the Opportunity Map broad-scan read (Task #462) ──────
//
// `GET /me/opportunity-map` was the remaining read-path outlier (~100-115ms
// warm, ~1017ms cold-start, intermittent 590-716ms spikes) because every request
// re-scanned an ENTIRE symbol universe via `scanSymbolTimeframe` plus per-row
// candle/quote routing. The Scanner page fires it on every "Rescan" click, and
// several users can scan the same market group at once, so the same expensive
// universe scan was recomputed many times over.
//
// This wraps the EXPENSIVE core (`buildOpportunityMapCore`) in a short-TTL
// single-flight cache keyed by `universe|timeframe`. The cheap, caller-specific
// `bestVsSelected` is composed fresh per request from the cached map, so caching
// never fragments per selected symbol (which would gut the hit rate).
//
// HONESTY / SAFETY:
//   - The cached core carries its own `generatedAt`, so a cached response reports
//     when the scan was REALLY run — a cached read is never shown as "fresh now".
//   - The map is NOT per-user data: `buildOpportunityMapCore` reads only global
//     market data and the route applies no per-user redaction, so a single
//     cross-user entry per `universe|timeframe` is correct and safe (no userId in
//     the key is intentional — same precedent as the symbol-level timing cache).
//   - Advisory only — never an execution gate. Internal fresh-read callers keep
//     calling `buildOpportunityMap` directly and always get a fresh scan.

import {
  buildOpportunityMapCore,
  composeOpportunityMap,
  OPPORTUNITY_MAP_TIMEFRAME,
  type OpportunityMapArgs,
  type OpportunityMapCore,
  type OpportunityMapResponse,
} from "./opportunityMapService.js";
import { createShortTtlCache } from "../perf/shortTtlCache.js";

const OPPORTUNITY_MAP_TTL_MS = 10_000;

// Universes (≤6) × the few selectable timeframes — 64 is generous headroom.
const cache = createShortTtlCache<OpportunityMapCore>({
  ttlMs: OPPORTUNITY_MAP_TTL_MS,
  maxEntries: 64,
});

/**
 * Opportunity-map read with short-TTL single-flight caching of the expensive
 * universe scan. `selectedSymbol` is intentionally NOT part of the cache key —
 * it only feeds the cheap per-request `bestVsSelected` composition.
 */
export async function getCachedOpportunityMap(
  args: OpportunityMapArgs,
): Promise<OpportunityMapResponse> {
  const timeframe = args.timeframe?.trim() || OPPORTUNITY_MAP_TIMEFRAME;
  const key = `${args.universe}|${timeframe}`;
  const core = await cache.get(key, () =>
    buildOpportunityMapCore({ universe: args.universe, timeframe }),
  );
  return composeOpportunityMap(core, args.selectedSymbol ?? null);
}

/** Test helper — clear the cache between cases. */
export function __clearOpportunityMapCache(): void {
  cache.clear();
}
