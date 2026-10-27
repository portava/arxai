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
import { normalizeChartTimeframe } from "../data/chart/timeframes.js";
import { UNIVERSE_IDS } from "../marketScanner.js";

const OPPORTUNITY_MAP_TTL_MS = 10_000;

// Bound resolved entries independently of active work. An evicted/expired
// result must not detach a still-running build and start duplicate provider I/O.
const cache = createShortTtlCache<OpportunityMapCore>({
  ttlMs: OPPORTUNITY_MAP_TTL_MS,
  maxEntries: 64,
});
const pendingBuilds = new Map<string, Promise<OpportunityMapCore>>();

/**
 * Opportunity-map read with short-TTL single-flight caching of the expensive
 * universe scan. `selectedSymbol` is intentionally NOT part of the cache key —
 * it only feeds the cheap per-request `bestVsSelected` composition.
 */
export async function getCachedOpportunityMap(
  args: OpportunityMapArgs,
): Promise<OpportunityMapResponse> {
  // Canonical, finite keys: 7 internal universes × 21 supported timeframes.
  // The HTTP route retains its existing 6 public groups. Reject invalid input
  // before any build; aliases must not multiply identical provider reads.
  if (!UNIVERSE_IDS.includes(args.universe)) throw new RangeError("Unsupported opportunity-map universe");
  const timeframe = normalizeChartTimeframe(args.timeframe ?? OPPORTUNITY_MAP_TIMEFRAME);
  if (!timeframe) throw new RangeError("Unsupported opportunity-map timeframe");
  const key = `${args.universe}|${timeframe}`;
  let pending = pendingBuilds.get(key);
  if (!pending) {
    pending = cache.get(key, () => buildOpportunityMapCore({ universe: args.universe, timeframe }));
    pendingBuilds.set(key, pending);
    const current = pending;
    const release = () => {
      if (pendingBuilds.get(key) === current) pendingBuilds.delete(key);
    };
    // Share pending work even beyond the result TTL. Do not timeout/race it:
    // the underlying provider must settle before its I/O permit is released.
    // The existing cache still expires from read START, and neither this layer
    // nor composition resets generatedAt or extends result freshness on finish.
    void pending.then(release, release);
  }
  const core = await pending;
  return composeOpportunityMap(core, args.selectedSymbol ?? null);
}

/** Test helper — clear the cache between cases. */
export function __clearOpportunityMapCache(): void {
  cache.clear();
  pendingBuilds.clear();
}
