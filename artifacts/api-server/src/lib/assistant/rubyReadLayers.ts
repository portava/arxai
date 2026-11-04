// ── Ruby Chart Read — display-only read layers (Task #602) ───────────────────
//
// Splits Ruby's chart read into three explicit DISPLAY tiers so a directional
// STRUCTURAL read can be produced from CLOSED historical candles even when the
// live feed is unconfirmed/delayed — while the exact entry / stop / target /
// reward:risk levels stay WITHHELD unless the shared sufficiency verdict
// (`canShowTradeSetup`) allows them.
//
// ⚠️ SAFETY — DISPLAY-ONLY, NEVER AN EXECUTION INPUT.
// The layer + flags returned here describe what the read PANEL may render. They
// are NEVER an execution gate, NEVER weaken the live (16/18-gate) pipeline, and
// MUST NOT be imported by any execution/safety module (live command pipeline,
// dispatch gate, synthetic-floor, stop-loss policy, import-boundary guards).
// They only shape read copy and which fields the UI shows.

import { STRUCTURE_MIN_CLOSED_BARS } from "./chartStructure.js";

/** PRIMARY wire signal — the explicit read tier the panel renders. */
export type RubyReadLayer = "FULL" | "STRUCTURAL_ONLY" | "INSUFFICIENT";

export interface RubyReadLayerInput {
  /** Count of fully-CLOSED bars available for structural analysis. */
  closedBarsCount: number;
  /** Shared freshness verdict ("LIVE" / "LIVE_DELAYED" / "AWAITING" / …). */
  freshnessVerdict: string | null;
  /** Shared sufficiency verdict: may the exact LIVE trade setup be shown? */
  canShowTradeSetup: boolean;
  /** Client-observed: the chart feed was NOT confirmed at read-time. */
  clientFeedUnconfirmed: boolean;
}

export interface RubyReadLayers {
  /** PRIMARY signal — the explicit read tier (booleans below are transparency). */
  layer: RubyReadLayer;
  /** Enough closed history to read structure at all. */
  canReadStructure: boolean;
  /**
   * The current (forming) candle may inform an entry — only on a confirmed
   * LIVE feed. False ⇒ the read is from closed candles only.
   */
  canUseCurrentCandleForEntry: boolean;
  /**
   * Exact entry / stop / target / reward:risk may be shown — only when the
   * shared sufficiency verdict allows it AND the feed is confirmed.
   */
  canShowLiveTradeSetup: boolean;
}

/**
 * Derive the display-only read layers from the shared chart-context signals.
 *
 * - INSUFFICIENT  — fewer than {@link STRUCTURE_MIN_CLOSED_BARS} closed bars;
 *                   no structural read can be produced.
 * - FULL          — enough structure AND the exact live trade setup is allowed.
 * - STRUCTURAL_ONLY — enough structure to read direction, but the exact trade
 *                   setup is withheld (feed unconfirmed/delayed, or the shared
 *                   sufficiency verdict won't allow the setup yet).
 */
export function deriveRubyReadLayers(input: RubyReadLayerInput): RubyReadLayers {
  const { closedBarsCount, freshnessVerdict, canShowTradeSetup, clientFeedUnconfirmed } =
    input;

  const canReadStructure = closedBarsCount >= STRUCTURE_MIN_CLOSED_BARS;
  const feedConfirmed = !clientFeedUnconfirmed;
  const isLive = String(freshnessVerdict ?? "").toUpperCase() === "LIVE";

  const canUseCurrentCandleForEntry = isLive && feedConfirmed;
  const canShowLiveTradeSetup = canShowTradeSetup && feedConfirmed;

  let layer: RubyReadLayer;
  if (!canReadStructure) {
    layer = "INSUFFICIENT";
  } else if (canShowLiveTradeSetup) {
    layer = "FULL";
  } else {
    layer = "STRUCTURAL_ONLY";
  }

  return { layer, canReadStructure, canUseCurrentCandleForEntry, canShowLiveTradeSetup };
}

/**
 * Resolve whether the live feed is UNCONFIRMED for entry, combining the caller's
 * observed verdict with the server-authoritative ChartFeedStatus.
 *
 * Why this exists: the Scanner "Ruby Chart Read" PANEL passes its observed feed
 * verdict (the chart header badge's `aiUsable`) as `clientFeedUnconfirmed`, but
 * Ruby CHAT's tool call never does — the LLM has no feed observation. So the chat
 * read used to reach a FULL "Verified · Live feed · AACI verified" footer while
 * the panel/header honestly showed "Historical only · Feed not confirmed ·
 * Limited read" for the SAME symbol/timeframe. Recomputing the verdict here from
 * the SAME signal the header badge renders (`ChartFeedStatus.aiUsable`, true ONLY
 * when feed quality === "clean") makes both surfaces agree regardless of what the
 * caller passed.
 *
 * Downgrade-only: EITHER source can mark the feed unconfirmed; neither can
 * upgrade the other. A null/unknown feed status is FAIL-CLOSED (treated as
 * unconfirmed) so an unobservable feed never silently upgrades the read to
 * live-confirmed. DISPLAY-ONLY — never an execution input.
 */
export function resolveFeedUnconfirmed(
  clientFeedUnconfirmed: boolean,
  feedStatus: { aiUsable: boolean } | null | undefined,
): boolean {
  const serverFeedUnconfirmed = feedStatus?.aiUsable !== true;
  return clientFeedUnconfirmed || serverFeedUnconfirmed;
}
