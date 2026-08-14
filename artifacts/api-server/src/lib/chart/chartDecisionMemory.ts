// Chart Brain v2 — Task 5: per-user chart-event memory (Slow Brain).
//
// Records MEANINGFUL per-user chart events (not every candle) so Ruby can review
// what happened and the system can learn over time. Strictly per-user: every
// write carries userId, every read is scoped by it. Writes are best-effort and
// fire-and-forget — they NEVER throw into the caller and NEVER block the live
// path or candle render. Reads degrade to [] on any error.

import { db, chartDecisionEventsTable } from "@workspace/db";
import type { NewChartDecisionEvent, ChartDecisionEvent } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";
import { logger } from "../logger.js";

export type ChartDecisionEventType =
  | "level_touch"
  | "level_rejection"
  | "breakout"
  | "failed_breakout"
  | "retest"
  | "retest_failure"
  | "wick_trap"
  | "flame"
  | "exhaustion"
  | "risk_veto"
  | "court_conflict"
  | "ruby_recommendation"
  | "no_trade"
  | "setup_stale"
  | "setup_invalid"
  | "trade_entered"
  | "trade_exited"
  | "trade_reviewed"
  | "learning_marker";

export const CHART_DECISION_EVENT_TYPES: ChartDecisionEventType[] = [
  "level_touch",
  "level_rejection",
  "breakout",
  "failed_breakout",
  "retest",
  "retest_failure",
  "wick_trap",
  "flame",
  "exhaustion",
  "risk_veto",
  "court_conflict",
  "ruby_recommendation",
  "no_trade",
  "setup_stale",
  "setup_invalid",
  "trade_entered",
  "trade_exited",
  "trade_reviewed",
  "learning_marker",
];

export interface ChartDecisionEventInput {
  userId: number;
  symbol: string;
  displaySymbol?: string | null;
  timeframe: string;
  eventType: ChartDecisionEventType;
  direction?: "BUY" | "SELL" | null;
  summary?: string;
  price?: number | null;
  atrAtEvent?: number | null;
  regime?: string | null;
  setupStage?: string | null;
  readinessScore?: number | null;
  qualityLabel?: string | null;
  receiptRef?: string | null;
  meta?: Record<string, unknown>;
  barTime?: Date | null;
}

/**
 * Best-effort, fire-and-forget persistence of meaningful per-user chart events.
 * Never throws into the caller; a failure is logged and ignored so the chart and
 * live paths are never affected.
 */
export async function recordChartDecisionEvents(
  events: ChartDecisionEventInput[],
): Promise<void> {
  if (events.length === 0) return;
  try {
    const rows: NewChartDecisionEvent[] = events.map((e) => ({
      userId: e.userId,
      symbol: e.symbol,
      displaySymbol: e.displaySymbol ?? null,
      timeframe: e.timeframe,
      eventType: e.eventType,
      direction: e.direction ?? null,
      summary: e.summary ?? "",
      price: e.price ?? null,
      atrAtEvent: e.atrAtEvent ?? null,
      regime: e.regime ?? null,
      setupStage: e.setupStage ?? null,
      readinessScore: e.readinessScore ?? null,
      qualityLabel: e.qualityLabel ?? null,
      receiptRef: e.receiptRef ?? null,
      meta: e.meta ?? {},
      barTime: e.barTime ?? null,
    }));
    await db.insert(chartDecisionEventsTable).values(rows);
  } catch (err) {
    logger.warn(
      { err, count: events.length },
      "chartDecisionMemory: best-effort event write failed (ignored)",
    );
  }
}

/**
 * Read recent per-user chart events. Always scoped by userId. Optionally
 * filtered by symbol/timeframe. Degrades to [] on any error.
 */
export async function getUserChartDecisionEvents(
  userId: number,
  opts?: { symbol?: string; timeframe?: string; limit?: number },
): Promise<ChartDecisionEvent[]> {
  const limit = Math.min(Math.max(opts?.limit ?? 100, 1), 500);
  try {
    const filters = [eq(chartDecisionEventsTable.userId, userId)];
    if (opts?.symbol) filters.push(eq(chartDecisionEventsTable.symbol, opts.symbol));
    if (opts?.timeframe) {
      filters.push(eq(chartDecisionEventsTable.timeframe, opts.timeframe));
    }
    return await db
      .select()
      .from(chartDecisionEventsTable)
      .where(and(...filters))
      .orderBy(desc(chartDecisionEventsTable.createdAt))
      .limit(limit);
  } catch (err) {
    logger.warn({ err, userId }, "chartDecisionMemory: event read failed (degrading to [])");
    return [];
  }
}
