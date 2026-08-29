// assistant_real quote fetches → forming-bar composer bridge (R1 residual).
//
// WHY
//   The composer had two writers — the MT5 EA ingest path and the Deriv WS
//   bridge. Every forex/metals/indices/crypto/stocks chart served by the
//   assistant_real REST providers (the whole fallback tier whenever the EA is
//   offline) had NO forming-tip driver: no tick ever folded, getFormingBar
//   returned null, and the chart tip froze between closed bars.
//
//   assistant_real has no push stream, so a true tick driver is impossible.
//   But the composite provider already fetches REAL quotes at the existing
//   poll cadence (QUOTE_FRESH_TTL_MS) — folding each genuinely fresh fetch
//   gives honest low-cadence motion (~the poll interval), with the existing
//   FORMING_TIP_LIVE_MS stale flip unchanged when polling pauses.
//
// HONESTY / SAFETY (the composer's posture, plus two bridge-specific rules)
//   - Only a PROVIDER-RETURNED price folds (last price, else bid) — never a
//     derived mid, never a synthesized value, and only from a REALTIME-graded
//     fetch (a DELAYED/STALE/DEMO reading folded "now" would fabricate
//     liveness the provider never claimed).
//   - A cache replay (identical asOf + price) folds NOTHING: no new
//     observation happened, so refreshing the tip's wall freshness off it
//     would fabricate liveness. The bridge memoizes the last folded
//     observation per symbol to enforce this.
//   - Provider times are never synthesized: the provider's own asOf is passed
//     when present, null otherwise (the composer then buckets by honest
//     receive time).
//   - Basis coherence is double-walled: the composer's ownership rule stops an
//     assistant fold from touching a bar a live push stream owns, and
//     chartDataService refuses to sit an assistant_real tip under closed bars
//     served by any other provider family.
//   - Display/telemetry only. In-memory; nothing persisted; no execution path.

import { foldFormingTick } from "./formingBarComposer.js";
import { normalizeSymbolKey } from "../providers/mt5Provider.js";

/** One provider-returned quote observation, exactly as the adapter reported it. */
export interface AssistantQuoteObservation {
  /** Provider-returned last/trade price (preferred fold basis). */
  price: number | null;
  /** Provider-returned bid (fallback basis when no last price exists). */
  bid: number | null;
  /** Provider-returned observation timestamp (ISO), or null when absent. */
  asOf: string | null;
}

// symbol key → the last observation actually folded (cache-replay dedupe).
const lastFoldBySymbol = new Map<string, { asOf: string | null; price: number }>();

/**
 * Fold one successful assistant_real quote fetch into the forming-bar
 * composer. Called from the market-data router's assistant quote adapter on
 * every REALTIME-graded fetch. Best-effort and idempotent per observation —
 * an unchanged (cached) reading folds nothing.
 */
export function foldAssistantQuoteTick(
  symbol: string,
  obs: AssistantQuoteObservation,
  nowWallMs: number = Date.now(),
): void {
  const key = normalizeSymbolKey(symbol);
  if (!key) return;
  // Only a provider-returned price may fold — a mid computed from bid/ask is a
  // derived value, and deriving prices for the tip is forbidden.
  const price =
    obs.price != null && Number.isFinite(obs.price) && obs.price > 0
      ? obs.price
      : obs.bid != null && Number.isFinite(obs.bid) && obs.bid > 0
        ? obs.bid
        : null;
  if (price == null) return;
  const asOf = obs.asOf ?? null;
  const memo = lastFoldBySymbol.get(key);
  // Identical asOf + price = a cache hit or an unchanged snapshot, not a new
  // observation. Folding it would refresh lastTickWallMs and fabricate
  // liveness; skipping lets the tip age honestly toward the stale flip.
  if (memo && memo.asOf === asOf && memo.price === price) return;
  let providerTimeMs: number | null = null;
  if (asOf) {
    const parsed = Date.parse(asOf);
    providerTimeMs = Number.isFinite(parsed) ? parsed : null;
  }
  foldFormingTick(symbol, price, providerTimeMs, nowWallMs, "assistant_real");
  lastFoldBySymbol.set(key, { asOf, price });
}

/** Test-only: clear the per-symbol dedupe memo. */
export function __resetAssistantFormingBridgeForTests(): void {
  lastFoldBySymbol.clear();
}
