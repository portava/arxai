// ── Market Heat provider-honesty resolver (Task #611) ───────────────────────
//
// PURE, deterministic fail-closed connectivity resolver for the news provider.
//
// The provider's own `getMarketStatus()` can claim `connected: true` while a
// live fetch fails, returns disconnected, or the provider sits in an ERROR
// freshness state. Trusting `status.connected` alone would let a broken news
// provider surface as live heat with riskScore 0 — i.e. fake "low news risk".
//
// HONESTY RULE: only POSITIVELY-confirmed connectivity counts. A status that
// claims connected but whose live probe fails / returns disconnected, or a
// provider in an ERROR freshness state, is NOT connected and must never resolve
// to a `live` source status. Decision-support only — no execution coupling.

import type { HeatSourceStatus } from "./heatVerdict.js";

export type ProviderFreshness = "LIVE" | "DELAYED" | "STALE" | "UNAVAILABLE";

export interface NewsHonestyInput {
  /** Provider declares it is configured (api key etc. present). */
  configured: boolean;
  /** `getMarketStatus().connected` — claimed connectivity, NOT trusted alone. */
  statusConnected: boolean;
  /** Raw `getMarketStatus().freshnessState` (e.g. "FRESH" | "STALE" | "ERROR"). */
  freshnessState: string | null | undefined;
  /** Live probe (`getMarketNews`) reported connected. */
  probeConnected: boolean;
  /** Live probe threw / failed. */
  probeFailed: boolean;
}

export interface NewsHonestyResult {
  connected: boolean;
  freshness: ProviderFreshness;
  sourceStatus: HeatSourceStatus;
}

/**
 * Resolve the honest, fail-closed news connectivity from the claimed status and
 * the live probe. Pure: same input ⇒ same output.
 */
export function resolveNewsHonesty(input: NewsHonestyInput): NewsHonestyResult {
  const isError = input.freshnessState === "ERROR" || input.probeFailed;

  // Fail-closed: every positive signal must hold for `connected` to be true.
  const connected =
    input.configured &&
    input.statusConnected &&
    input.probeConnected &&
    !input.probeFailed &&
    input.freshnessState !== "ERROR";

  const freshness: ProviderFreshness = !connected
    ? "UNAVAILABLE"
    : input.freshnessState === "FRESH"
      ? "LIVE"
      : input.freshnessState === "STALE"
        ? "STALE"
        : "DELAYED";

  const sourceStatus: HeatSourceStatus = !input.configured
    ? "missing"
    : !connected
      ? isError
        ? "error"
        : "unavailable"
      : freshness === "STALE"
        ? "stale"
        : freshness === "DELAYED"
          ? "delayed"
          : "live";

  return { connected, freshness, sourceStatus };
}
