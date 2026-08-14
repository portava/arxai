// Chart Brain v2 — Task 2, Engine 4: timeframe agreement.
//
// Assembles a multi-timeframe bias (M15 / M30 / H1 / H4) and a 0-100 agreement
// score, with a scalp-only warning when lower and higher timeframes conflict.
//
// SPEED CONTRACT: fetching four timeframes is heavy, so this NEVER runs on the
// request hot path. The Fast Brain reads the last cached result instantly; a
// throttled background refresh (Slow Brain context) recomputes it off-path. The
// first read for a symbol returns an honest "computing" placeholder rather than
// blocking. A missing/stale timeframe never blocks — it is simply marked
// unavailable.

import { getChartCandles } from "../chartDataService.js";
import type { ChartTimeframe } from "../timeframes.js";
import { computeTrendRegime } from "./trendRegime.js";
import {
  assertSlowBrainContext,
  markSlowBrainRun,
} from "../chartSlowBrain.js";
import { clamp, round } from "./chartMath.js";
import { logger } from "../../../logger.js";
import type {
  ChartTfBias,
  ChartTimeframeAgreement,
  ChartTimeframeBias,
} from "./marketUnderstandingTypes.js";

const AGREEMENT_TFS: ChartTimeframe[] = ["M15", "M30", "H1", "H4"];
const FETCH_LIMIT = 150;
const REFRESH_TTL_MS = 60_000; // recompute at most once a minute per symbol
const STALE_AFTER_MS = 5 * 60_000; // a cached read older than this reads stale

interface CacheEntry {
  result: ChartTimeframeAgreement;
  computedAtMs: number;
  refreshing: boolean;
}
const cache = new Map<string, CacheEntry>();

function unpopulated(note: string): ChartTimeframeAgreement {
  return {
    populated: false,
    agreementScore: null,
    alignedDirection: "unknown",
    scalpOnlyWarning: false,
    timeframes: AGREEMENT_TFS.map((tf) => ({
      timeframe: tf,
      bias: "unknown",
      available: false,
      stale: false,
    })),
    computedAt: null,
    note,
  };
}

function toTfBias(direction: string): ChartTfBias {
  switch (direction) {
    case "bullish":
      return "bullish";
    case "bearish":
      return "bearish";
    case "ranging":
      return "ranging";
    case "mixed":
      return "mixed";
    default:
      return "unknown";
  }
}

async function recompute(symbol: string): Promise<ChartTimeframeAgreement> {
  assertSlowBrainContext("background");
  const timeframes: ChartTimeframeBias[] = [];
  for (const tf of AGREEMENT_TFS) {
    try {
      const truth = await getChartCandles(symbol, tf, FETCH_LIMIT);
      const closed = truth.candles.filter((c) => c.isComplete);
      const available = truth.aiUsable && closed.length >= 20;
      const stale = truth.feedStatus.stale;
      const bias: ChartTfBias = available
        ? toTfBias(computeTrendRegime(closed).direction)
        : "unknown";
      timeframes.push({ timeframe: tf, bias, available, stale });
    } catch (err) {
      logger.warn({ err, symbol, tf }, "timeframeAgreement: TF fetch failed");
      timeframes.push({ timeframe: tf, bias: "unknown", available: false, stale: false });
    }
  }

  const directional = timeframes.filter(
    (t) => t.available && (t.bias === "bullish" || t.bias === "bearish"),
  );
  const usable = timeframes.filter((t) => t.available);

  let agreementScore: number | null = null;
  let alignedDirection: ChartTfBias = "unknown";
  let scalpOnlyWarning = false;
  let note: string;

  if (usable.length === 0) {
    note = "No timeframe had a usable feed for agreement.";
  } else if (directional.length === 0) {
    agreementScore = round(clamp((usable.length / AGREEMENT_TFS.length) * 30));
    alignedDirection = "ranging";
    note = "Available timeframes show no committed direction (ranging/mixed).";
  } else {
    const bulls = directional.filter((t) => t.bias === "bullish").length;
    const bears = directional.filter((t) => t.bias === "bearish").length;
    const majority = bulls >= bears ? bulls : bears;
    alignedDirection = bulls > bears ? "bullish" : bulls < bears ? "bearish" : "mixed";
    // Fraction of directional TFs that agree, scaled by coverage.
    const agreeFrac = majority / directional.length;
    const coverage = usable.length / AGREEMENT_TFS.length;
    agreementScore = round(clamp(agreeFrac * 100 * (0.6 + 0.4 * coverage)));

    // Scalp-only warning: lower (M15/M30) vs higher (H1/H4) conflict.
    const lower = timeframes.filter(
      (t) => (t.timeframe === "M15" || t.timeframe === "M30") && t.available,
    );
    const higher = timeframes.filter(
      (t) => (t.timeframe === "H1" || t.timeframe === "H4") && t.available,
    );
    const lowerDir = directionOf(lower);
    const higherDir = directionOf(higher);
    if (
      lowerDir !== "unknown" &&
      higherDir !== "unknown" &&
      lowerDir !== higherDir &&
      (lowerDir === "bullish" || lowerDir === "bearish") &&
      (higherDir === "bullish" || higherDir === "bearish")
    ) {
      scalpOnlyWarning = true;
    }
    note = scalpOnlyWarning
      ? "Lower and higher timeframes conflict — scalp-only; do not hold for a swing."
      : `Agreement across ${directional.length} directional timeframe(s).`;
  }

  return {
    populated: usable.length > 0,
    agreementScore,
    alignedDirection,
    scalpOnlyWarning,
    timeframes,
    computedAt: new Date().toISOString(),
    note,
  };
}

function directionOf(group: ChartTimeframeBias[]): ChartTfBias {
  const bulls = group.filter((t) => t.bias === "bullish").length;
  const bears = group.filter((t) => t.bias === "bearish").length;
  if (bulls > 0 && bears === 0) return "bullish";
  if (bears > 0 && bulls === 0) return "bearish";
  if (bulls === 0 && bears === 0) return "unknown";
  return "mixed";
}

/**
 * Fast-path accessor. Returns the cached agreement immediately (or an honest
 * "computing" placeholder the very first time) and kicks off a throttled
 * background refresh. NEVER awaits the heavy multi-timeframe fetch.
 */
export function getTimeframeAgreement(symbol: string): ChartTimeframeAgreement {
  const key = symbol.trim().toUpperCase();
  const entry = cache.get(key);
  const now = Date.now();

  const needsRefresh =
    !entry || (!entry.refreshing && now - entry.computedAtMs >= REFRESH_TTL_MS);

  if (needsRefresh) {
    const placeholder: CacheEntry = entry ?? {
      result: unpopulated("Timeframe agreement is computing in the background."),
      computedAtMs: 0,
      refreshing: false,
    };
    placeholder.refreshing = true;
    cache.set(key, placeholder);
    // Fire-and-forget background recompute — never blocks the caller.
    void recompute(key)
      .then((result) => {
        cache.set(key, { result, computedAtMs: Date.now(), refreshing: false });
        markSlowBrainRun();
      })
      .catch((err) => {
        logger.warn({ err, symbol: key }, "timeframeAgreement: recompute failed");
        const cur = cache.get(key);
        if (cur) cur.refreshing = false;
      });
  }

  const current = cache.get(key);
  if (!current || current.computedAtMs === 0) {
    return unpopulated("Timeframe agreement is computing in the background.");
  }

  // Mark the read as stale if the cached compute is old.
  if (now - current.computedAtMs >= STALE_AFTER_MS) {
    return {
      ...current.result,
      note: `${current.result.note} (cached; refreshing)`,
    };
  }
  return current.result;
}
