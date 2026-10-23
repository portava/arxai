// Chart Brain v2 — Task 2: market-memory read/write for the Level Personality
// engine.
//
// Storage design: meaningful chart events (held / rejected / breakout /
// failed_breakout / retest / wick_trap) are MARKET FACTS keyed by
// symbol+timeframe — not user data, exactly like candles. The reading endpoint
// stays per-user gated; these rows carry no user identity.
//
// Non-blocking contract:
//  - WRITES are fire-and-forget (`void recordChartEvents(...)`). They never
//    throw into the caller and are idempotent (dedupe on the unique index), so
//    the Fast Brain hot path is never blocked or broken by the DB.
//  - READS are a single indexed lookup wrapped in try/catch. On any error or an
//    empty table the engine degrades to window-only personality — honest, never
//    fabricated.

import { db, chartMarketEventsTable } from "@workspace/db";
import { and, desc, eq, gte } from "drizzle-orm";
import { logger } from "../../../logger.js";
import type { ChartTimeframe } from "../timeframes.js";
import type { ChartLevelKind } from "./marketUnderstandingTypes.js";

export type ChartEventType =
  | "held"
  | "rejected"
  | "breakout"
  | "failed_breakout"
  | "retest"
  | "wick_trap";

export interface ChartEventInput {
  symbol: string;
  timeframe: ChartTimeframe;
  eventType: ChartEventType;
  levelKind: ChartLevelKind;
  price: number;
  barTime: Date;
  atrAtEvent: number | null;
}

export interface RememberedEvent {
  eventType: ChartEventType;
  levelKind: ChartLevelKind;
  price: number;
  barTime: Date;
}

const MAX_REMEMBERED = 200;
// Only fold in events newer than this so ancient history does not dominate.
const MEMORY_HORIZON_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

/**
 * Best-effort, fire-and-forget persistence of newly detected chart events.
 * Idempotent via the (symbol, timeframe, event_type, bar_time) unique index —
 * re-detecting the same event is a no-op. Never throws into the caller.
 */
export async function recordChartEvents(events: ChartEventInput[]): Promise<void> {
  if (events.length === 0) return;
  try {
    await db
      .insert(chartMarketEventsTable)
      .values(
        events.map((e) => ({
          symbol: e.symbol,
          timeframe: e.timeframe,
          eventType: e.eventType,
          levelKind: e.levelKind,
          price: e.price,
          barTime: e.barTime,
          atrAtEvent: e.atrAtEvent ?? null,
        })),
      )
      .onConflictDoNothing();
  } catch (err) {
    // Memory is purely additive — a write failure must never affect the chart.
    logger.warn(
      { err, count: events.length },
      "chartMarketMemory: best-effort event write failed (ignored)",
    );
  }
}

/**
 * Read recent remembered events for a chart. Defensive: returns [] on any error
 * so the personality engine degrades to window-only analysis.
 */
export async function getRecentChartEvents(
  symbol: string,
  timeframe: ChartTimeframe,
): Promise<RememberedEvent[]> {
  try {
    const horizon = new Date(Date.now() - MEMORY_HORIZON_MS);
    const rows = await db
      .select({
        eventType: chartMarketEventsTable.eventType,
        levelKind: chartMarketEventsTable.levelKind,
        price: chartMarketEventsTable.price,
        barTime: chartMarketEventsTable.barTime,
      })
      .from(chartMarketEventsTable)
      .where(
        and(
          eq(chartMarketEventsTable.symbol, symbol),
          eq(chartMarketEventsTable.timeframe, timeframe),
          gte(chartMarketEventsTable.barTime, horizon),
        ),
      )
      .orderBy(desc(chartMarketEventsTable.barTime))
      .limit(MAX_REMEMBERED);
    return rows.map((r) => ({
      eventType: r.eventType as ChartEventType,
      levelKind: r.levelKind as ChartLevelKind,
      price: r.price,
      barTime: r.barTime,
    }));
  } catch (err) {
    logger.warn(
      { err, symbol, timeframe },
      "chartMarketMemory: event read failed (degrading to window-only)",
    );
    return [];
  }
}
