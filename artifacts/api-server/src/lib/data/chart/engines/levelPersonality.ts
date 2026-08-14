// Chart Brain v2 — Task 2, Engine 2: level personality & market memory.
//
// Derives support/resistance levels from swing extremes in the visible window,
// then gives each level a personality (fresh / defended / weakening / broken /
// retest_pending / trap_zone / scalp_only / invalidated) from observed
// touch / rejection / break / retest behaviour. It ALSO detects the meaningful
// chart events for the latest bars (held / rejected / breakout / failed_breakout
// / retest / wick_trap) so they can be persisted to market memory, and folds in
// previously remembered events when available. Honest: too little data => empty.

import type { NormalizedChartCandle } from "../candleNormalization.js";
import type { ChartTimeframe } from "../timeframes.js";
import { atr, clamp, decimalsFor, findSwings, mean, round } from "./chartMath.js";
import type {
  ChartEventInput,
  ChartEventType,
  RememberedEvent,
} from "./chartMarketMemory.js";
import type {
  ChartLevel,
  ChartLevelKind,
  ChartLevelPersonality,
  ChartLevelsRead,
} from "./marketUnderstandingTypes.js";

const MIN_BARS = 20;
const MAX_LEVELS = 6;

interface RawLevel {
  kind: ChartLevelKind;
  price: number;
  swingIndices: number[];
}

/** Cluster nearby swings of the same kind into a single level (band = k*ATR). */
function clusterLevels(
  candles: NormalizedChartCandle[],
  atrVal: number,
): RawLevel[] {
  const swings = findSwings(candles, 2);
  const band = Math.max(atrVal * 0.6, 1e-9);
  const out: RawLevel[] = [];
  for (const s of swings) {
    const kind: ChartLevelKind = s.kind === "high" ? "resistance" : "support";
    const existing = out.find(
      (l) => l.kind === kind && Math.abs(l.price - s.price) <= band,
    );
    if (existing) {
      existing.swingIndices.push(s.index);
      // Re-center on the mean of clustered swing prices.
      const prices = existing.swingIndices.map((i) =>
        kind === "resistance" ? candles[i]!.high : candles[i]!.low,
      );
      existing.price = mean(prices);
    } else {
      out.push({ kind, price: s.price, swingIndices: [s.index] });
    }
  }
  return out;
}

interface Behaviour {
  touchCount: number;
  rejectionCount: number;
  breakCount: number;
  retestCount: number;
}

/**
 * Count how the visible candles AFTER a level was formed interacted with it:
 * a touch (came within band), a rejection (touched then closed back away), a
 * break (closed decisively beyond), a retest (returned to a broken level).
 */
function countBehaviour(
  candles: NormalizedChartCandle[],
  level: RawLevel,
  band: number,
): Behaviour {
  const firstIdx = Math.min(...level.swingIndices);
  let touchCount = 0;
  let rejectionCount = 0;
  let breakCount = 0;
  let retestCount = 0;
  let broken = false;

  for (let i = firstIdx + 1; i < candles.length; i++) {
    const c = candles[i]!;
    const near =
      c.low <= level.price + band && c.high >= level.price - band;
    if (!near && !broken) continue;

    if (level.kind === "resistance") {
      if (c.close > level.price + band) {
        if (!broken) {
          broken = true;
          breakCount++;
        }
      } else if (near) {
        touchCount++;
        if (broken) {
          retestCount++;
        } else if (c.high >= level.price - band && c.close < level.price) {
          rejectionCount++;
        }
      }
    } else {
      if (c.close < level.price - band) {
        if (!broken) {
          broken = true;
          breakCount++;
        }
      } else if (near) {
        touchCount++;
        if (broken) {
          retestCount++;
        } else if (c.low <= level.price + band && c.close > level.price) {
          rejectionCount++;
        }
      }
    }
  }

  return { touchCount, rejectionCount, breakCount, retestCount };
}

function resolvePersonality(
  b: Behaviour,
  remembered: { rejections: number; breaks: number; retests: number; traps: number },
): { personality: ChartLevelPersonality; strength: number; weakness: number; trap: number } {
  const rejections = b.rejectionCount + remembered.rejections;
  const breaks = b.breakCount + remembered.breaks;
  const retests = b.retestCount + remembered.retests;
  const traps = remembered.traps;

  // Scores 0-100.
  const strength = clamp(rejections * 22 + b.touchCount * 6);
  const weakness = clamp(breaks * 35 + Math.max(0, b.touchCount - rejections) * 8);
  const trap = clamp(traps * 30 + (breaks > 0 && retests === 0 ? 20 : 0));

  let personality: ChartLevelPersonality;
  if (trap >= 55) {
    personality = "trap_zone";
  } else if (breaks > 0 && retests > 0) {
    personality = "retest_pending";
  } else if (breaks > 0) {
    personality = "broken";
  } else if (rejections >= 3) {
    personality = "defended";
  } else if (rejections >= 1 && b.touchCount > rejections + 1) {
    personality = "weakening";
  } else if (rejections >= 1) {
    personality = "defended";
  } else if (b.touchCount === 0) {
    personality = "fresh";
  } else {
    personality = "scalp_only";
  }
  // A level that was broken AND retested then broken again reads invalidated.
  if (breaks >= 2) personality = "invalidated";

  return { personality, strength, weakness, trap };
}

/** Fold remembered events for a level price band into running counts. */
function rememberedFor(
  events: RememberedEvent[],
  kind: ChartLevelKind,
  price: number,
  band: number,
): { rejections: number; breaks: number; retests: number; traps: number } {
  let rejections = 0;
  let breaks = 0;
  let retests = 0;
  let traps = 0;
  for (const e of events) {
    if (e.levelKind !== kind) continue;
    if (Math.abs(e.price - price) > band) continue;
    switch (e.eventType) {
      case "rejected":
      case "held":
        rejections++;
        break;
      case "breakout":
        breaks++;
        break;
      case "retest":
        retests++;
        break;
      case "failed_breakout":
      case "wick_trap":
        traps++;
        break;
    }
  }
  return { rejections, breaks, retests, traps };
}

export interface LevelPersonalityResult {
  read: ChartLevelsRead;
  /** Newly detected events on the most recent bars, for best-effort memory. */
  newEvents: ChartEventInput[];
}

/**
 * Detect meaningful events on the latest closed bar against the mapped levels,
 * for persistence. Conservative: only the latest bar, only clear interactions.
 */
function detectLatestEvents(
  candles: NormalizedChartCandle[],
  levels: RawLevel[],
  band: number,
  atrVal: number,
  symbol: string,
  timeframe: ChartTimeframe,
): ChartEventInput[] {
  const n = candles.length;
  if (n < 2) return [];
  const c = candles[n - 1]!;
  const barTime = new Date(c.closeTime);
  const out: ChartEventInput[] = [];

  for (const lv of levels) {
    const near = c.low <= lv.price + band && c.high >= lv.price - band;
    if (!near) continue;
    let eventType: ChartEventType | null = null;
    if (lv.kind === "resistance") {
      if (c.high > lv.price + band && c.close < lv.price) {
        eventType = "wick_trap";
      } else if (c.close > lv.price + band) {
        eventType = "breakout";
      } else if (c.high >= lv.price - band && c.close < lv.price) {
        eventType = "rejected";
      } else {
        eventType = "held";
      }
    } else {
      if (c.low < lv.price - band && c.close > lv.price) {
        eventType = "wick_trap";
      } else if (c.close < lv.price - band) {
        eventType = "breakout";
      } else if (c.low <= lv.price + band && c.close > lv.price) {
        eventType = "rejected";
      } else {
        eventType = "held";
      }
    }
    if (eventType) {
      out.push({
        symbol,
        timeframe,
        eventType,
        levelKind: lv.kind,
        price: round(lv.price, decimalsFor(lv.price)),
        barTime,
        atrAtEvent: atrVal > 0 ? round(atrVal, decimalsFor(atrVal)) : null,
      });
    }
  }
  return out;
}

export function computeLevelPersonality(
  closed: NormalizedChartCandle[],
  remembered: RememberedEvent[],
  symbol: string,
  timeframe: ChartTimeframe,
): LevelPersonalityResult {
  const n = closed.length;
  if (n < MIN_BARS) {
    return {
      read: {
        populated: false,
        levels: [],
        nearestSupport: null,
        nearestResistance: null,
        eventsRemembered: remembered.length,
        note: `Not enough closed candles (${n}) to map levels.`,
      },
      newEvents: [],
    };
  }

  const atrVal = atr(closed, Math.min(14, n - 1)) ?? 0;
  const band = Math.max(atrVal * 0.6, (closed[n - 1]!.close || 1) * 1e-4);
  const lastClose = closed[n - 1]!.close;
  const decimals = decimalsFor(lastClose);

  const raw = clusterLevels(closed, atrVal)
    // Drop single-touch fresh levels that are far away and never interacted.
    .filter((l) => l.swingIndices.length >= 1);

  const levels: ChartLevel[] = raw.map((lv) => {
    const b = countBehaviour(closed, lv, band);
    const mem = rememberedFor(remembered, lv.kind, lv.price, band);
    const { personality, strength, weakness, trap } = resolvePersonality(b, mem);
    const distancePct =
      lastClose !== 0 ? round(((lv.price - lastClose) / lastClose) * 100, 3) : null;
    return {
      kind: lv.kind,
      price: round(lv.price, decimals),
      personality,
      touchCount: b.touchCount,
      rejectionCount: b.rejectionCount + mem.rejections,
      breakCount: b.breakCount + mem.breaks,
      retestCount: b.retestCount + mem.retests,
      strengthScore: round(strength),
      weaknessScore: round(weakness),
      trapScore: round(trap),
      distancePct,
    };
  });

  // Rank: strongest, most-interacted first; keep the top N.
  levels.sort(
    (a, b) =>
      b.strengthScore - a.strengthScore ||
      b.touchCount - a.touchCount ||
      Math.abs(a.distancePct ?? 999) - Math.abs(b.distancePct ?? 999),
  );
  const top = levels.slice(0, MAX_LEVELS);

  const supports = top.filter((l) => l.kind === "support" && l.price < lastClose);
  const resistances = top.filter((l) => l.kind === "resistance" && l.price > lastClose);
  const nearestSupport =
    supports.sort((a, b) => b.price - a.price)[0] ?? null;
  const nearestResistance =
    resistances.sort((a, b) => a.price - b.price)[0] ?? null;

  const newEvents = detectLatestEvents(closed, raw, band, atrVal, symbol, timeframe);

  return {
    read: {
      populated: true,
      levels: top,
      nearestSupport,
      nearestResistance,
      eventsRemembered: remembered.length,
      note: `Mapped ${top.length} level(s) from swings; folded in ${remembered.length} remembered event(s).`,
    },
    newEvents,
  };
}
