// ── Mission exit-signal assembly for UNATTENDED ticks ────────────────────────
//
// WHY THIS EXISTS: the automated exit manager (`manageMissionTradeExit`)
// decides protective exits from a bundle of observed signals — invalidation,
// structure break, order-flow reversal, imminent high-impact news, unstable
// spread, agent disagreement, ATR. On a user-pressed exit review the caller
// supplies what the surface observed. On the mission DRIVER's unattended tick
// the caller supplied `{}`, so every non-price trigger was `undefined` on
// EVERY tick and the exit manager only ever saw price-based triggers. This
// module is the missing read: it assembles those signals from the services
// that already produce them, for the position's own symbol.
//
// HONESTY CONTRACT (the whole point of this file):
//   * A signal is emitted ONLY when a real source answered. There is no
//     "assume calm" default anywhere in here.
//   * A source that cannot be read yields NO boolean at all — the key stays
//     absent — and an `unavailable` entry naming the signal, the source and a
//     machine-readable reason. `false` means "read, and no anomaly observed";
//     absent means "not observed". Those are different facts and this module
//     never collapses one into the other.
//   * The unavailability list travels WITH the signals into the exit manager,
//     so the decision can say out loud that it was partially blind instead of
//     silently behaving as if everything were fine.
//   * Every derivation below is documented in terms of the real data it reads.
//     Nothing is inferred from a model, a cache of a guess, or a default.
//   * Read-only. Nothing here places, modifies, or closes anything.
//
// DECISION-GRADE FEED (review fix): the candle-derived signals here can end in
// a real broker CLOSE, so they are read with `routeCandlesForDecision`, NOT the
// display-grade `routeCandles` fallback chain. The router's own contract is
// that a decision surface must never ride a silently substituted venue: when
// the EXECUTION broker's feed is stale or absent the answer is WAIT. A WAIT
// here blinds the four candle-derived signals HONESTLY (each recorded
// unavailable with the router's own refusal reason) rather than closing a live
// position on a series borrowed from another venue.
//
// Per-user isolation: the broker spec read and the agent-stance read are both
// scoped by the owning userId; the quote/candle/news reads are market-wide
// public feeds and carry no tenant data.

import { and, desc, eq } from "drizzle-orm";
import { db, arxSymbolSpecsTable, missionProposalsTable } from "@workspace/db";
import type { Candle } from "./data/types.js";
import { routeQuote, routeCandlesForDecision } from "./data/marketDataRouter.js";
import { getNewsIntelligence } from "./news/newsIntelligenceService.js";
import { analyzeChartStructure, STRUCTURE_MIN_CLOSED_BARS } from "./assistant/chartStructure.js";
import { logger } from "./logger.js";

/** The signal keys this module can observe (mirrors MissionExitSignals). */
export type MissionExitSignalKey =
  | "invalidation"
  | "structureBreak"
  | "orderFlowReversal"
  | "highImpactNewsImminent"
  | "unstableSpread"
  | "agentDisagreement"
  | "atr";

/**
 * One signal that could NOT be observed on this tick. Recorded instead of a
 * fabricated benign value, and carried into the exit decision so the engine
 * (and the journal behind it) knows it was blind on this axis.
 */
export interface MissionExitSignalUnavailability {
  signal: MissionExitSignalKey;
  /** The service/read that was attempted, e.g. "market_data_router:quote". */
  source: string;
  /** Machine-readable reason, e.g. "QUOTE_UNAVAILABLE". */
  reason: string;
}

export interface AssembledMissionExitSignals {
  /** Only the keys a real source answered. Never a placeholder. */
  signals: MissionExitSignalsObserved;
  /** Every signal that could not be read, with why. */
  unavailable: MissionExitSignalUnavailability[];
  /** When the assembly ran (ms epoch). */
  observedAtMs: number;
}

/** The observable subset of `MissionExitSignals` this module produces. */
export interface MissionExitSignalsObserved {
  invalidation?: boolean;
  agentDisagreement?: boolean;
  orderFlowReversal?: boolean;
  highImpactNewsImminent?: boolean;
  unstableSpread?: boolean;
  structureBreak?: boolean;
  atr?: number | null;
}

export interface MissionExitSignalContext {
  userId: number;
  missionId: number;
  symbol: string;
  /** The OPEN position's side — every directional read is relative to it. */
  side: "BUY" | "SELL";
  /** The draft's timeframe; structure/ATR are read on it. */
  timeframe: string;
  /** The position's protective stop, when it has one (invalidation reference). */
  stopLoss: number | null;
  nowMs: number;
}

// ── Tunables (documented constants, not magic numbers) ──────────────────────

/** Candles requested for the structure/ATR read. */
export const EXIT_SIGNAL_CANDLE_LIMIT = 120;
/** ATR period used for the trail sizing hint. */
export const EXIT_SIGNAL_ATR_PERIOD = 14;
/**
 * A live spread at or above this multiple of the broker's own last-reported
 * spread for the symbol is reported UNSTABLE. Deliberately blunt: the read is
 * "the venue is charging a large multiple of what it told us it charges",
 * which is an observation, not a forecast.
 */
export const UNSTABLE_SPREAD_MULTIPLE = 3;
/**
 * Bars of order-flow to inspect for a reversal read. Short by design — a
 * reversal claim over a long window is not a reversal, it is a trend.
 */
export const ORDER_FLOW_LOOKBACK_BARS = 3;
/**
 * Bars whose swing high/low define the structure a break is measured against.
 * Matches the structural window the chart analyzer itself reads from, so
 * "structure broke" means the same thing here as it does on the chart.
 */
export const STRUCTURE_BREAK_LOOKBACK_BARS = 20;
/**
 * Agent stances older than this are STALE: the mission scan that produced them
 * no longer describes the market, so disagreement is reported unavailable
 * rather than asserted from an old opinion.
 */
export const AGENT_STANCE_MAX_AGE_MS = 30 * 60 * 1000;

// ── Injectable source seams (tests only; production uses the real services) ──

export interface MissionExitSignalSources {
  quote?: typeof routeQuote;
  /** Decision-grade candle read — the EXECUTION broker's feed or WAIT. */
  candles?: typeof routeCandlesForDecision;
  news?: typeof getNewsIntelligence;
  /** Per-user broker spec read: point size + the broker's reported spread. */
  brokerSpec?: (userId: number, symbol: string) => Promise<{
    point: number | null;
    spreadPoints: number | null;
  } | null>;
  /** Recent agent stances for this mission+symbol, newest first. */
  agentStances?: (args: {
    userId: number;
    missionId: number;
    symbol: string;
  }) => Promise<Array<{ direction: string; createdAtMs: number | null }>>;
}

// ── Pure helpers ────────────────────────────────────────────────────────────

function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/**
 * PURE — mean true range over the last `period` bars, or null when there is
 * not enough history. Deliberately null (never 0) on insufficient data: a
 * zero ATR would read downstream as "no volatility observed", which is a
 * fabricated all-clear.
 */
export function meanTrueRange(candles: Candle[], period: number): number | null {
  if (period <= 0 || candles.length < period + 1) return null;
  const trs: number[] = [];
  for (let i = candles.length - period; i < candles.length; i++) {
    const c = candles[i];
    const prev = candles[i - 1];
    if (c == null || prev == null) continue;
    const tr = Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close));
    if (Number.isFinite(tr)) trs.push(tr);
  }
  if (trs.length === 0) return null;
  return trs.reduce((a, b) => a + b, 0) / trs.length;
}

/**
 * PURE — has a CLOSED bar closed beyond the position's protective stop while
 * the position is still open? That is the setup's own stated invalidation
 * level being breached on a close, which the exit manager treats as a
 * risk-justified protective exit. Returns null when there is no stop to
 * invalidate against (nothing to observe — never "false").
 */
export function closedBeyondStop(args: {
  side: "BUY" | "SELL";
  stopLoss: number | null;
  lastClose: number | null;
}): boolean | null {
  if (!isNum(args.stopLoss) || args.stopLoss <= 0) return null;
  if (!isNum(args.lastClose)) return null;
  return args.side === "BUY" ? args.lastClose < args.stopLoss : args.lastClose > args.stopLoss;
}

/**
 * PURE — order-flow reversal read: over the last `ORDER_FLOW_LOOKBACK_BARS`
 * CLOSED bars, has every bar closed against the position AND has the net move
 * over that window gone against it? Both conditions together, so a single
 * adverse bar inside a favourable stretch is not called a reversal. Returns
 * null when there are not enough bars to look at.
 */
export function orderFlowAgainst(args: {
  side: "BUY" | "SELL";
  candles: Candle[];
  lookback?: number;
}): boolean | null {
  const lookback = args.lookback ?? ORDER_FLOW_LOOKBACK_BARS;
  if (lookback < 2) return null;
  const c = args.candles;
  if (c.length < lookback + 1) return null;
  const window = c.slice(-lookback);
  const prior = c[c.length - lookback - 1];
  if (prior == null) return null;
  let allAgainst = true;
  for (const bar of window) {
    if (!isNum(bar.open) || !isNum(bar.close)) return null;
    const barAgainst = args.side === "BUY" ? bar.close < bar.open : bar.close > bar.open;
    if (!barAgainst) { allAgainst = false; break; }
  }
  const lastClose = window[window.length - 1]!.close;
  if (!isNum(prior.close) || !isNum(lastClose)) return null;
  const netAgainst = args.side === "BUY" ? lastClose < prior.close : lastClose > prior.close;
  return allAgainst && netAgainst;
}

/**
 * PURE — did the last CLOSED bar close BEYOND the structural level the open
 * position depended on? For a BUY that is a close below the swing low of the
 * preceding `lookback` bars; for a SELL, a close above their swing high.
 *
 * WHY THIS SHAPE (review fix): `structureBreak` maps in `decideExit` to an
 * UNCONDITIONAL full CLOSE of a live position on an unattended tick, with the
 * reason "Market structure broke against the trade". That sentence has to be
 * TRUE. It was previously derived from a plain directional chart bias pointing
 * the other way — the very condition `chartStructure` itself reports as a
 * CAUTION ("that is a counter-trend bet"), not an invalidation. A deliberately
 * counter-trend position would have been closed at the broker on the first
 * unattended tick purely for being counter-trend.
 *
 * A BREAK is an EVENT, not a lean: it is the analyzer's own stated invalidation
 * ("a decisive close below <support> breaks the bullish read") measured against
 * real bars. Null — never false — when there is not enough history or a bar is
 * unreadable: an unmeasurable structure is never reported intact.
 */
export function structureBrokeAgainst(args: {
  side: "BUY" | "SELL";
  candles: Candle[];
  lookback?: number;
}): boolean | null {
  const lookback = args.lookback ?? STRUCTURE_BREAK_LOOKBACK_BARS;
  if (lookback < 2) return null;
  const c = args.candles;
  if (c.length < lookback + 1) return null;
  // The structure is read from the bars BEFORE the one being judged, so the
  // breaking bar can never define the level it is being measured against.
  const prior = c.slice(-(lookback + 1), -1);
  const last = c[c.length - 1];
  if (last == null || !isNum(last.close)) return null;
  let swingLow = Infinity;
  let swingHigh = -Infinity;
  for (const bar of prior) {
    if (!isNum(bar.high) || !isNum(bar.low)) return null;
    if (bar.low < swingLow) swingLow = bar.low;
    if (bar.high > swingHigh) swingHigh = bar.high;
  }
  if (!Number.isFinite(swingLow) || !Number.isFinite(swingHigh)) return null;
  return args.side === "BUY" ? last.close < swingLow : last.close > swingHigh;
}

/**
 * PURE — do the mission's own agents disagree with the open position? True
 * when any fresh stance points the other way, or when the stances themselves
 * split BUY vs SELL. Stances of "NONE" are abstentions, not disagreement.
 */
export function agentsDisagree(args: {
  side: "BUY" | "SELL";
  directions: string[];
}): boolean {
  const dirs = args.directions.filter((d) => d === "BUY" || d === "SELL");
  if (dirs.length === 0) return false;
  const opposite = args.side === "BUY" ? "SELL" : "BUY";
  if (dirs.includes(opposite)) return true;
  return dirs.includes("BUY") && dirs.includes("SELL");
}

/**
 * PURE — is the live spread an unstable multiple of the broker's own reported
 * spread? Returns null whenever any component is missing (no quote, no bid/ask,
 * no broker point size, no reported reference spread) — an unmeasurable spread
 * is never reported stable.
 */
export function unstableSpreadFrom(args: {
  bid: number | null;
  ask: number | null;
  point: number | null;
  referenceSpreadPoints: number | null;
  multiple?: number;
}): boolean | null {
  if (!isNum(args.bid) || !isNum(args.ask)) return null;
  if (!isNum(args.point) || args.point <= 0) return null;
  if (!isNum(args.referenceSpreadPoints) || args.referenceSpreadPoints <= 0) return null;
  const livePoints = (args.ask - args.bid) / args.point;
  if (!Number.isFinite(livePoints) || livePoints < 0) return null;
  return livePoints >= args.referenceSpreadPoints * (args.multiple ?? UNSTABLE_SPREAD_MULTIPLE);
}

// ── Real source readers (per-user scoped where the data is tenant-scoped) ────

const defaultBrokerSpec: NonNullable<MissionExitSignalSources["brokerSpec"]> = async (
  userId,
  symbol,
) => {
  const rows = await db
    .select({ point: arxSymbolSpecsTable.point, spreadPoints: arxSymbolSpecsTable.spreadPoints })
    .from(arxSymbolSpecsTable)
    .where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol)))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return { point: row.point ?? null, spreadPoints: row.spreadPoints ?? null };
};

const defaultAgentStances: NonNullable<MissionExitSignalSources["agentStances"]> = async (args) => {
  const rows = await db
    .select({
      direction: missionProposalsTable.direction,
      createdAt: missionProposalsTable.createdAt,
    })
    .from(missionProposalsTable)
    .where(
      and(
        eq(missionProposalsTable.missionId, args.missionId),
        eq(missionProposalsTable.userId, args.userId),
        eq(missionProposalsTable.symbol, args.symbol),
      ),
    )
    .orderBy(desc(missionProposalsTable.createdAt), desc(missionProposalsTable.id))
    .limit(12);
  return rows.map((r) => ({
    direction: String(r.direction ?? "NONE"),
    createdAtMs: r.createdAt instanceof Date ? r.createdAt.getTime() : null,
  }));
};

/**
 * Assemble the honest exit-signal bundle for one OPEN mission position.
 *
 * NEVER throws: every source is attempted inside its own try/catch and a
 * failure becomes an `unavailable` entry, not an exception and not a benign
 * default. A totally blind tick therefore returns `{ signals: {}, unavailable:
 * [ …every key… ] }`, which the exit manager reports as blindness rather than
 * calm.
 */
export async function assembleMissionExitSignals(
  ctx: MissionExitSignalContext,
  sources: MissionExitSignalSources = {},
): Promise<AssembledMissionExitSignals> {
  const quoteFn = sources.quote ?? routeQuote;
  const candlesFn = sources.candles ?? routeCandlesForDecision;
  const newsFn = sources.news ?? getNewsIntelligence;
  const specFn = sources.brokerSpec ?? defaultBrokerSpec;
  const stancesFn = sources.agentStances ?? defaultAgentStances;

  const signals: MissionExitSignalsObserved = {};
  const unavailable: MissionExitSignalUnavailability[] = [];
  const blind = (signal: MissionExitSignalKey, source: string, reason: string) => {
    unavailable.push({ signal, source, reason });
  };

  // ── News risk → highImpactNewsImminent ────────────────────────────────────
  // Source of truth: the SAME economic-calendar seam the scanner and the chart
  // radar read. A DISCONNECTED calendar is reported unavailable — it must never
  // read as "no news scheduled", which would be a fabricated all-clear on the
  // one axis the exit manager exits hardest on.
  try {
    const pack = await newsFn(ctx.symbol);
    if (pack.dataSources.calendar.connected !== true) {
      blind("highImpactNewsImminent", "news_intelligence:economic_calendar", "CALENDAR_NOT_CONNECTED");
    } else {
      const severe = pack.riskLevel === "high" || pack.riskLevel === "critical";
      const imminent = pack.timing === "now" || pack.timing === "upcoming";
      signals.highImpactNewsImminent = severe && imminent;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), symbol: ctx.symbol },
      "mission_exit_signals news read failed (reported unavailable, not benign)",
    );
    blind("highImpactNewsImminent", "news_intelligence:economic_calendar", "NEWS_READ_FAILED");
  }

  // ── Live quote + broker spec → unstableSpread ─────────────────────────────
  try {
    const q = await quoteFn(ctx.symbol);
    if (!q.ok || q.quote == null) {
      blind("unstableSpread", "market_data_router:quote", "QUOTE_UNAVAILABLE");
    } else {
      const bid = isNum(q.quote.bid) ? q.quote.bid : null;
      const ask = isNum(q.quote.ask) ? q.quote.ask : null;
      if (bid == null || ask == null) {
        blind("unstableSpread", "market_data_router:quote", "QUOTE_MISSING_BID_ASK");
      } else {
        const spec = await specFn(ctx.userId, ctx.symbol).catch(() => null);
        if (spec == null) {
          blind("unstableSpread", "arx_symbol_specs", "NO_BROKER_SPEC");
        } else {
          const verdict = unstableSpreadFrom({
            bid,
            ask,
            point: spec.point,
            referenceSpreadPoints: spec.spreadPoints,
          });
          if (verdict == null) {
            blind("unstableSpread", "arx_symbol_specs", "NO_BROKER_SPREAD_REFERENCE");
          } else {
            signals.unstableSpread = verdict;
          }
        }
      }
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), symbol: ctx.symbol },
      "mission_exit_signals spread read failed (reported unavailable, not benign)",
    );
    blind("unstableSpread", "market_data_router:quote", "SPREAD_READ_FAILED");
  }

  // ── Candles → structureBreak / invalidation / orderFlowReversal / atr ─────
  // One candle read feeds four derivations; when it fails, ALL FOUR are
  // recorded unavailable rather than any of them defaulting to calm.
  let candles: Candle[] | null = null;
  let candleRefusal: string | null = null;
  try {
    const c = await candlesFn(ctx.symbol, ctx.timeframe, { limit: EXIT_SIGNAL_CANDLE_LIMIT });
    if (c.ok && Array.isArray(c.candles) && c.candles.length > 0) {
      candles = c.candles;
    } else {
      // A decision-grade WAIT: the EXECUTION broker's own feed could not serve
      // this read. Carry the router's refusal code through verbatim so the
      // journal says WHY the tick was blind, not merely that it was.
      candles = null;
      candleRefusal = typeof c.reason === "string" && c.reason !== "" ? c.reason : null;
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), symbol: ctx.symbol },
      "mission_exit_signals candle read failed (reported unavailable, not benign)",
    );
    candles = null;
  }

  if (candles == null) {
    const source = "market_data_router:candles_for_decision";
    const reason = candleRefusal ?? "CANDLES_UNAVAILABLE";
    blind("structureBreak", source, reason);
    blind("invalidation", source, reason);
    blind("orderFlowReversal", source, reason);
    blind("atr", source, reason);
  } else {
    // structureBreak — a CLOSED bar beyond the structural level the position
    // depended on (see `structureBrokeAgainst`). The chart analyzer is consulted
    // ONLY as the sufficiency oracle: `dataQuality: "insufficient"` is it
    // refusing to read structure at all, and that refusal passes straight
    // through. Its directional BIAS is deliberately NOT used — an opposing bias
    // is a counter-trend caution, not a break, and mapping it to an
    // unconditional full close would close a legitimately counter-trend
    // position on the first unattended tick. (That is also why no `htfBias` is
    // fetched here: nothing in this derivation reads the bias it would soften.)
    const read = analyzeChartStructure(candles);
    if (read.dataQuality !== "ok" || candles.length < STRUCTURE_MIN_CLOSED_BARS) {
      blind("structureBreak", "chart_structure", "INSUFFICIENT_STRUCTURE_HISTORY");
    } else {
      const broke = structureBrokeAgainst({ side: ctx.side, candles });
      if (broke == null) {
        blind("structureBreak", "chart_structure", "INSUFFICIENT_STRUCTURE_HISTORY");
      } else {
        signals.structureBreak = broke;
      }
    }

    // invalidation — a CLOSED bar beyond the position's own protective stop.
    const lastClose = candles[candles.length - 1]?.close ?? null;
    const inv = closedBeyondStop({
      side: ctx.side,
      stopLoss: ctx.stopLoss,
      lastClose: isNum(lastClose) ? lastClose : null,
    });
    if (inv == null) {
      blind(
        "invalidation",
        "position_stop_loss",
        ctx.stopLoss == null ? "NO_STOP_LOSS_REFERENCE" : "NO_CLOSING_PRICE",
      );
    } else {
      signals.invalidation = inv;
    }

    // orderFlowReversal — consecutive closed bars against the position AND a
    // net adverse move over the window.
    const flow = orderFlowAgainst({ side: ctx.side, candles });
    if (flow == null) {
      blind("orderFlowReversal", "market_data_router:candles_for_decision", "INSUFFICIENT_ORDER_FLOW_BARS");
    } else {
      signals.orderFlowReversal = flow;
    }

    // atr — sizes the trail. null (not 0) when history is short.
    const a = meanTrueRange(candles, EXIT_SIGNAL_ATR_PERIOD);
    if (a == null) {
      blind("atr", "market_data_router:candles_for_decision", "INSUFFICIENT_ATR_HISTORY");
    } else {
      signals.atr = a;
    }
  }

  // ── Mission agents → agentDisagreement ────────────────────────────────────
  // Read from the mission's OWN persisted proposals for this symbol (per-user
  // scoped). Stale stances are reported unavailable rather than asserted: an
  // opinion from an hour ago is not an observation of now.
  try {
    const stances = await stancesFn({
      userId: ctx.userId,
      missionId: ctx.missionId,
      symbol: ctx.symbol,
    });
    const fresh = stances.filter(
      (s) => s.createdAtMs != null && ctx.nowMs - s.createdAtMs <= AGENT_STANCE_MAX_AGE_MS,
    );
    if (stances.length === 0) {
      blind("agentDisagreement", "mission_proposals", "NO_AGENT_STANCES");
    } else if (fresh.length === 0) {
      blind("agentDisagreement", "mission_proposals", "AGENT_STANCES_STALE");
    } else {
      signals.agentDisagreement = agentsDisagree({
        side: ctx.side,
        directions: fresh.map((s) => s.direction),
      });
    }
  } catch (err) {
    logger.warn(
      { err: err instanceof Error ? err.message : String(err), missionId: ctx.missionId },
      "mission_exit_signals agent-stance read failed (reported unavailable, not benign)",
    );
    blind("agentDisagreement", "mission_proposals", "AGENT_STANCE_READ_FAILED");
  }

  return { signals, unavailable, observedAtMs: ctx.nowMs };
}

/** The resolver seam the mission driver calls (injectable for tests). */
export type MissionExitSignalResolver = (
  ctx: MissionExitSignalContext,
) => Promise<AssembledMissionExitSignals>;
