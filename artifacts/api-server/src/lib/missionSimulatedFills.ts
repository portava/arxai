// ── Profit Mission — HONEST paper/demo fill simulator + simulated accounting ──
//
// WHY THIS EXISTS: `dispatchApprovedDraft` routed a paper/demo mission to
// `recordSimulatedMissionDispatch`, which wrote an audit row and returned. No
// code path ever wrote an outcome for a non-live draft, so a paper/demo
// mission's `currentValue` was frozen forever, the mission could never complete,
// and the promotion gate's `demo_performance` requirement (sample ≥ 20 at ≥ 45%)
// had NO producible source — which left real-money trading at level 2 as the
// only road to any auto level. This module supplies the missing outcome.
//
// THE HONESTY CONTRACT (why this is not fabrication):
//   1. REAL PRICES ONLY. Every simulated fill is priced from the market-data
//      ROUTER's real quote at decision time (`routeQuote`). No quote → NO FILL
//      and the typed reason `NO_FILL_NO_QUOTE`; the draft is released back to
//      `approved` by the caller exactly like a rejected live dispatch. There is
//      no synthetic-price branch anywhere in this file.
//   2. TAGGED AT ROW LEVEL. Every simulated record sets `simulated = true` and
//      writes ONLY the `sim_*` column family.
//   3. ACCOUNTED SEPARATELY, STRUCTURALLY. A simulated row's broker-reconciled
//      columns (`pnl`, `r_multiple`, `closed_at`, `captured_profit`,
//      `missed_profit`, `broker_ticket`) stay NULL FOREVER. Every consumer of
//      realised money keys off `closed_at`/`pnl`, so a simulated outcome cannot
//      reach a live realised sum or an economic posting even if a future caller
//      forgets to filter. Nothing here contacts a broker, a command table, or
//      the live pipeline — the returned command id is `sim:`-prefixed.
//   4. THE ASSUMPTIONS TRAVEL WITH THE NUMBER. `sim_json` carries the model
//      version, what is and is NOT modelled (spread crossing yes; slippage,
//      partial fills, commission/swap, latency, gap risk no) and the real quote
//      the fill was priced from — provider, timestamp, bid/ask.
//   5. EXITS USE THE SAME LOGIC AGAINST REAL SUBSEQUENT QUOTES. The exit sweep
//      re-reads a REAL quote and applies the same stop/target/protective logic a
//      live position obeys (stop before target — the pessimistic branch).
//
// Per-user / per-mission isolation: every read and write is scoped by
// (missionId, userId), like every other mission service.
import { and, eq, isNull, isNotNull } from "drizzle-orm";
import {
  db,
  missionTradeDraftsTable,
  missionEventsTable,
  oneClickAuditTable,
  type MissionTradeDraftRow,
} from "@workspace/db";
import {
  simulateEntryFill,
  evaluateSimulatedExit,
  plannedRiskDistance,
  simulatedRMultiple,
  simulatedPnl,
  isSimulatedSide,
  SIMULATED_FILL_ASSUMPTIONS,
  SIMULATED_FILL_MODEL_VERSION,
  type SimulatedQuoteInput,
  type SimulatedSide,
} from "@workspace/domain/profit-mission";
import { routeQuote } from "./data/marketDataRouter.js";
import type { MissionSimulatedExecutor } from "./missionExecution.js";
import type { InstantTradeResult } from "./live/instantTrade.js";
import { logger } from "./logger.js";

// ── The quote seam ────────────────────────────────────────────────────────────

/** A real quote plus where it came from. `quote === null` means NO FEED. */
export interface MissionQuoteRead {
  quote: SimulatedQuoteInput | null;
  provider: string | null;
  quotedAt: string | null;
  /** Honest reason when no quote could be served (router's user-safe message). */
  reason: string | null;
}

/** Injectable ONLY so tests can hand in a deterministic quote; production always
 *  uses the real market-data router. */
export type MissionQuoteReader = (symbol: string) => Promise<MissionQuoteRead>;

/**
 * The real quote reader. Delegates to the unified market-data router, which
 * never fabricates a quote — an exhausted provider chain returns `ok:false` and
 * we pass that through as an honest "no feed", never a placeholder price.
 */
export const readRealQuote: MissionQuoteReader = async (symbol) => {
  try {
    const r = await routeQuote(symbol);
    if (!r.ok || r.quote == null) {
      return { quote: null, provider: null, quotedAt: null, reason: r.userMessage };
    }
    return {
      quote: {
        bid: numOrNull(r.quote.bid),
        ask: numOrNull(r.quote.ask),
        last: numOrNull(r.quote.last),
      },
      provider: r.primaryProvider,
      quotedAt: r.quote.timestamp ?? null,
      reason: null,
    };
  } catch (err) {
    // A failed read degrades to an honest typed null — never to a made-up price.
    return {
      quote: null,
      provider: null,
      quotedAt: null,
      reason: `quote read failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
};

function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
function isNum(n: number | null | undefined): n is number {
  return n != null && Number.isFinite(n);
}
function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
function asRecord(v: unknown): Record<string, unknown> {
  return v != null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function journalMissionEvent(args: {
  missionId: number;
  type: string;
  message: string;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(missionEventsTable).values({
    missionId: args.missionId,
    type: args.type,
    message: args.message,
    metadataJson: args.metadata ?? null,
  });
}

async function auditMission(args: {
  userId: number;
  action: string;
  ip?: string | null;
  ua?: string | null;
  metadata?: unknown;
}): Promise<void> {
  await db.insert(oneClickAuditTable).values({
    userId: args.userId,
    action: args.action,
    ip: args.ip ?? null,
    userAgent: args.ua ?? null,
    metadata: args.metadata != null ? JSON.stringify(args.metadata) : null,
  });
}

/** The quote snapshot persisted beside every simulated price, so the number can
 *  always be traced back to the real feed reading that produced it. */
function quoteProvenance(read: MissionQuoteRead): Record<string, unknown> {
  return {
    provider: read.provider,
    quotedAt: read.quotedAt,
    bid: read.quote?.bid ?? null,
    ask: read.quote?.ask ?? null,
    last: read.quote?.last ?? null,
  };
}

// ── 1. Entry: the simulated executor ─────────────────────────────────────────

export interface SimulateMissionFillOpts {
  /** Tests only. Production always reads the real router quote. */
  quoteReader?: MissionQuoteReader;
}

/**
 * Build the paper/demo simulated executor. It runs AFTER the full mission gate
 * chain + Phase 7 + the single-flight claim (exactly where the old recorder ran)
 * and models an entry fill from a REAL quote, or refuses honestly.
 *
 * A refusal returns `ok:false`, which makes `dispatchApprovedDraft` release the
 * claim and return the draft to `approved` — the same honest path a rejected
 * live dispatch takes. Nothing is invented to force a fill.
 */
export function makeMissionFillSimulator(
  opts: SimulateMissionFillOpts = {},
): MissionSimulatedExecutor {
  const readQuote = opts.quoteReader ?? readRealQuote;

  return async (args): Promise<InstantTradeResult> => {
    const read = await readQuote(args.draft.symbol);
    const fill = simulateEntryFill({ direction: args.draft.direction, quote: read.quote });

    if (!fill.ok) {
      // HONEST NO-FILL. Journal + audit the refusal with its typed reason and
      // return a rejection; the caller releases the claim. No row is written
      // that could later be mistaken for a trade.
      await journalMissionEvent({
        missionId: args.missionId,
        type: "draft_simulated_fill_refused",
        message: `No simulated fill for ${args.draft.symbol} ${args.draft.direction} in ${args.executionMode} mode: ${fill.detail}. The draft stays approved — a paper fill is never priced from an invented number.`,
        metadata: {
          draftId: args.draft.draftId,
          executionMode: args.executionMode,
          refusal: fill.refusal,
          quoteReason: read.reason,
        },
      });
      await auditMission({
        userId: args.userId,
        action: "mission_draft_simulated_fill_refused",
        ip: args.ip,
        ua: args.ua,
        metadata: {
          missionId: args.missionId,
          draftId: args.draft.draftId,
          executionMode: args.executionMode,
          refusal: fill.refusal,
        },
      });
      return {
        ok: false,
        error: `${fill.refusal}: ${fill.detail}`,
        primaryReason: fill.refusal,
        httpStatus: 503,
      };
    }

    const commandId = `sim:${args.executionMode}:${args.draft.draftId}:${args.nowMs}`;
    const openedAt = new Date(args.nowMs);
    const riskDistance = plannedRiskDistance({
      plannedEntryPrice: numOrNull(args.draft.entryPrice) ?? fill.price,
      stopLoss: numOrNull(args.draft.stopLoss),
    });

    const simJson: Record<string, unknown> = {
      simulated: true,
      modelVersion: SIMULATED_FILL_MODEL_VERSION,
      executionMode: args.executionMode,
      assumptions: SIMULATED_FILL_ASSUMPTIONS,
      // The exact honesty caveat, stored so no reader has to infer it.
      notBrokerTruth:
        "SIMULATED — modelled from a real quote, not a broker fill. Never money, never an economic posting, never a live realised figure.",
      entry: {
        price: fill.price,
        side: fill.side,
        priceBasis: fill.basis,
        plannedEntryPrice: numOrNull(args.draft.entryPrice),
        entrySlippageVsPlan: isNum(args.draft.entryPrice)
          ? fill.price - args.draft.entryPrice
          : null,
        riskDistance,
        riskAmount: numOrNull(args.draft.riskAmount),
        pnlDerivable: riskDistance != null && isNum(args.draft.riskAmount),
        quote: quoteProvenance(read),
        at: openedAt.toISOString(),
      },
    };

    // Write ONLY the sim_* family. pnl / closedAt / brokerTicket stay NULL.
    await db
      .update(missionTradeDraftsTable)
      .set({
        simulated: true,
        simEntryPrice: fill.price,
        simOpenedAt: openedAt,
        simJson,
        updatedAt: openedAt,
      })
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, args.draft.draftId),
          eq(missionTradeDraftsTable.userId, args.userId),
        ),
      );

    await auditMission({
      userId: args.userId,
      action: "mission_draft_dispatch_simulated",
      ip: args.ip,
      ua: args.ua,
      metadata: {
        missionId: args.missionId,
        draftId: args.draft.draftId,
        executionMode: args.executionMode,
        commandId,
        simulated: true,
        simEntryPrice: fill.price,
        quote: quoteProvenance(read),
        intent: args.intent,
      },
    });
    await journalMissionEvent({
      missionId: args.missionId,
      type: "draft_dispatch_simulated",
      message: `SIMULATED fill for ${args.draft.symbol} ${args.draft.direction} at ${fill.price} in ${args.executionMode} mode — priced from the real ${read.provider ?? "feed"} quote. The live broker was never contacted; this is a modelled outcome, not money.`,
      metadata: {
        draftId: args.draft.draftId,
        executionMode: args.executionMode,
        commandId,
        simulated: true,
        simEntryPrice: fill.price,
        priceBasis: fill.basis,
        quote: quoteProvenance(read),
      },
    });

    return { ok: true, commandId, action: args.intent.action };
  };
}

/** The production simulated executor (real router quotes). */
export const simulateMissionFill: MissionSimulatedExecutor = makeMissionFillSimulator();

// ── 2. Exit: close simulated positions against REAL subsequent quotes ─────────

/** Cap on simulated positions swept per mission per pass (mirrors the live cap). */
const MAX_SIMULATED_EXITS_PER_PASS = 25;

export interface SimulatedExitPassResult {
  evaluated: number;
  closed: number;
  /** Positions left open because no real quote was available (honest, not an error). */
  heldNoQuote: number;
}

/**
 * Sweep a mission's OPEN simulated positions against real current quotes and
 * close the ones whose stop, target, or mission window has been reached. This is
 * the simulated twin of `manageMissionTradeExit` — it never contacts a broker
 * and never writes a broker-reconciled column.
 */
export async function runMissionSimulatedExitPass(
  args: {
    userId: number;
    missionId: number;
    /** True when the mission window has ended — open positions mark out honestly. */
    missionEnded?: boolean;
    nowMs?: number;
  },
  opts: SimulateMissionFillOpts = {},
): Promise<SimulatedExitPassResult> {
  const readQuote = opts.quoteReader ?? readRealQuote;
  const nowMs = args.nowMs ?? Date.now();
  const result: SimulatedExitPassResult = { evaluated: 0, closed: 0, heldNoQuote: 0 };

  const open = (await db
    .select()
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.simulated, true),
        isNotNull(missionTradeDraftsTable.simEntryPrice),
        isNull(missionTradeDraftsTable.simClosedAt),
      ),
    )
    .limit(MAX_SIMULATED_EXITS_PER_PASS)) as MissionTradeDraftRow[];

  for (const draft of open) {
    result.evaluated += 1;
    try {
      const closedNow = await evaluateOneSimulatedPosition({
        draft,
        userId: args.userId,
        missionId: args.missionId,
        missionEnded: args.missionEnded === true,
        nowMs,
        readQuote,
      });
      if (closedNow === "closed") result.closed += 1;
      else if (closedNow === "no_quote") result.heldNoQuote += 1;
    } catch (err) {
      // Fail-soft per position: an unreadable position is left exactly as it is.
      logger.warn(
        {
          err: err instanceof Error ? err.message : String(err),
          missionId: args.missionId,
          draftId: draft.draftId,
        },
        "mission simulated exit failed for one draft (non-fatal, position untouched)",
      );
    }
  }
  return result;
}

async function evaluateOneSimulatedPosition(args: {
  draft: MissionTradeDraftRow;
  userId: number;
  missionId: number;
  missionEnded: boolean;
  nowMs: number;
  readQuote: MissionQuoteReader;
}): Promise<"closed" | "open" | "no_quote"> {
  const { draft } = args;
  const side = draft.direction.trim().toUpperCase();
  if (!isSimulatedSide(side)) return "open";
  const entryPrice = numOrNull(draft.simEntryPrice);
  if (entryPrice == null) return "open";

  const read = await args.readQuote(draft.symbol);
  const prior = asRecord(draft.simJson);
  // The stop/target the simulated position is managed against. A protective
  // update may only TIGHTEN these (see `simulatedProtectiveLevels`), never widen.
  const levels = simulatedProtectiveLevels(draft, prior);

  const verdict = evaluateSimulatedExit({
    side,
    stopLoss: levels.stopLoss,
    takeProfit: levels.takeProfit,
    quote: read.quote,
    missionEnded: args.missionEnded,
  });

  // ── Still open: refresh the honest excursion marks and stop. ───────────────
  if (!verdict.closed) {
    if (verdict.markPrice == null) return "no_quote";
    const excursion = updateExcursions({
      side,
      entryPrice,
      markPrice: verdict.markPrice,
      priorMfe: numOrNull(draft.simMfe),
      priorMae: numOrNull(draft.simMae),
      riskDistance: riskDistanceFor(draft, entryPrice),
      riskAmount: numOrNull(draft.riskAmount),
    });
    await db
      .update(missionTradeDraftsTable)
      .set({
        simMfe: excursion.mfe,
        simMae: excursion.mae,
        simJson: {
          ...prior,
          lastMark: {
            price: verdict.markPrice,
            at: new Date(args.nowMs).toISOString(),
            quote: quoteProvenance(read),
          },
        },
        updatedAt: new Date(args.nowMs),
      })
      .where(
        and(
          eq(missionTradeDraftsTable.draftId, draft.draftId),
          eq(missionTradeDraftsTable.userId, args.userId),
        ),
      );
    return "open";
  }

  // ── Closed: derive R and the modelled P/L from the mission's OWN planned risk.
  const riskDistance = riskDistanceFor(draft, entryPrice);
  const rMultiple = simulatedRMultiple({
    side,
    entryPrice,
    exitPrice: verdict.exitPrice,
    riskDistance,
  });
  const pnl = simulatedPnl({ rMultiple, riskAmount: numOrNull(draft.riskAmount) });
  const excursion = updateExcursions({
    side,
    entryPrice,
    markPrice: verdict.markPrice,
    priorMfe: numOrNull(draft.simMfe),
    priorMae: numOrNull(draft.simMae),
    riskDistance,
    riskAmount: numOrNull(draft.riskAmount),
  });
  const closedAt = new Date(args.nowMs);

  const simJson: Record<string, unknown> = {
    ...prior,
    exit: {
      price: verdict.exitPrice,
      trigger: verdict.trigger,
      priceBasis: verdict.basis,
      markPrice: verdict.markPrice,
      reason: verdict.reason,
      rMultiple,
      // When either input is missing the P/L is honestly UNKNOWN, not zero.
      pnl,
      pnlUnknownReason:
        pnl == null
          ? riskDistance == null
            ? "no planned entry-to-stop distance — R and P/L are not derivable"
            : "the draft carries no positive planned risk amount — P/L is not derivable"
          : null,
      quote: quoteProvenance(read),
      at: closedAt.toISOString(),
    },
  };

  // ONLY the sim_* family is written. The broker-reconciled columns stay NULL,
  // which is what keeps this outcome out of every live realised total.
  await db
    .update(missionTradeDraftsTable)
    .set({
      simExitPrice: verdict.exitPrice,
      simPnl: pnl != null ? round2(pnl) : null,
      simRMultiple: rMultiple,
      simMfe: excursion.mfe,
      simMae: excursion.mae,
      simExitReason: verdict.trigger,
      simClosedAt: closedAt,
      simJson,
      updatedAt: closedAt,
    })
    .where(
      and(
        eq(missionTradeDraftsTable.draftId, draft.draftId),
        eq(missionTradeDraftsTable.userId, args.userId),
        isNull(missionTradeDraftsTable.simClosedAt),
      ),
    );

  await journalMissionEvent({
    missionId: args.missionId,
    type: "draft_simulated_closed",
    message: `SIMULATED position closed for ${draft.symbol} ${draft.direction} at ${verdict.exitPrice} (${verdict.trigger}) — ${pnl != null ? `modelled ${round2(pnl)}` : "P/L not derivable"}. Modelled from real quotes; not broker-reconciled money.`,
    metadata: {
      draftId: draft.draftId,
      simulated: true,
      trigger: verdict.trigger,
      simExitPrice: verdict.exitPrice,
      simPnl: pnl != null ? round2(pnl) : null,
      simRMultiple: rMultiple,
      quote: quoteProvenance(read),
    },
  });
  return "closed";
}

/**
 * The stop/target a simulated position is managed against. Protective updates
 * persisted under `simJson.protective` may only TIGHTEN the stop (AUTO authority
 * may only REDUCE risk); a stored level that would WIDEN the original stop is
 * ignored, so no code path can loosen a simulated stop either.
 */
function simulatedProtectiveLevels(
  draft: MissionTradeDraftRow,
  simJson: Record<string, unknown>,
): { stopLoss: number | null; takeProfit: number | null } {
  const original = numOrNull(draft.stopLoss);
  const protective = asRecord(simJson.protective);
  const proposed = numOrNull(protective.stopLoss);
  const side = draft.direction.trim().toUpperCase();
  let stopLoss = original;
  if (proposed != null && original != null && isSimulatedSide(side)) {
    // Tighter = closer to entry: higher for a BUY stop, lower for a SELL stop.
    const tighter = side === "BUY" ? proposed > original : proposed < original;
    if (tighter) stopLoss = proposed;
  } else if (proposed != null && original == null) {
    stopLoss = proposed; // adding a stop where there was none is strictly safer
  }
  return { stopLoss, takeProfit: numOrNull(draft.takeProfit) };
}

function riskDistanceFor(draft: MissionTradeDraftRow, simEntryPrice: number): number | null {
  return plannedRiskDistance({
    plannedEntryPrice: numOrNull(draft.entryPrice) ?? simEntryPrice,
    stopLoss: numOrNull(draft.stopLoss),
  });
}

/** MFE/MAE in account currency, derived the same way as the P/L (R × risk). */
function updateExcursions(args: {
  side: SimulatedSide;
  entryPrice: number;
  markPrice: number;
  priorMfe: number | null;
  priorMae: number | null;
  riskDistance: number | null;
  riskAmount: number | null;
}): { mfe: number | null; mae: number | null } {
  const r = simulatedRMultiple({
    side: args.side,
    entryPrice: args.entryPrice,
    exitPrice: args.markPrice,
    riskDistance: args.riskDistance,
  });
  const value = simulatedPnl({ rMultiple: r, riskAmount: args.riskAmount });
  if (value == null) return { mfe: args.priorMfe, mae: args.priorMae };
  const mfe = Math.max(args.priorMfe ?? 0, value);
  const mae = Math.min(args.priorMae ?? 0, value);
  return { mfe: round2(mfe), mae: round2(mae) };
}

// ── 3. Simulated accounting — kept apart from broker-reconciled money ─────────

export interface MissionSimulatedStats {
  /** Sum of MODELLED P/L across closed simulated trades. NOT money. */
  simulatedProfit: number;
  /** Modelled P/L closed since the start of the current UTC day. */
  simulatedProfitToday: number;
  /** Count of closed simulated trades that carried a derivable P/L. */
  simulatedTradeCount: number;
  /** Closed simulated trades whose P/L was NOT derivable (honestly excluded). */
  simulatedUnpricedCount: number;
  /** Always true — a caller can never lose track of what these numbers are. */
  readonly simulated: true;
}

function startOfUtcDayMs(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/**
 * A mission's SIMULATED closed-outcome statistics. This is the simulated twin of
 * `resolveMissionRealisedStats` and is deliberately a SEPARATE function with a
 * separate return type: the two are never added together, and no caller can pass
 * one where the other is expected.
 */
export async function resolveMissionSimulatedStats(args: {
  userId: number;
  missionId: number;
  nowMs?: number;
}): Promise<MissionSimulatedStats> {
  const nowMs = args.nowMs ?? Date.now();
  const rows = await db
    .select({
      simPnl: missionTradeDraftsTable.simPnl,
      simClosedAt: missionTradeDraftsTable.simClosedAt,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, args.missionId),
        eq(missionTradeDraftsTable.userId, args.userId),
        eq(missionTradeDraftsTable.simulated, true),
        isNotNull(missionTradeDraftsTable.simClosedAt),
      ),
    );

  const dayStart = startOfUtcDayMs(nowMs);
  let simulatedProfit = 0;
  let simulatedProfitToday = 0;
  let simulatedTradeCount = 0;
  let simulatedUnpricedCount = 0;
  for (const r of rows) {
    if (r.simClosedAt == null) continue;
    if (!isNum(r.simPnl)) {
      simulatedUnpricedCount += 1;
      continue;
    }
    simulatedTradeCount += 1;
    simulatedProfit += r.simPnl;
    if (r.simClosedAt.getTime() >= dayStart) simulatedProfitToday += r.simPnl;
  }
  return {
    simulatedProfit: round2(simulatedProfit),
    simulatedProfitToday: round2(simulatedProfitToday),
    simulatedTradeCount,
    simulatedUnpricedCount,
    simulated: true,
  };
}

/** One closed simulated trade, for promotion / forward-test evidence. */
export interface SimulatedClosedDraft {
  pnl: number;
  rMultiple: number | null;
  symbol: string | null;
  timeframe: string | null;
  agentKey: string | null;
  closedAt: Date;
  /** Always true — the label travels with the record. */
  readonly simulated: true;
}

/**
 * A mission's closed SIMULATED trades, for the promotion gate's demo evidence
 * and the forward-test aggregation. Each record is stamped `simulated: true` so
 * every consumer must decide what to do with it consciously.
 */
export async function readSimulatedClosedDrafts(
  userId: number,
  missionId: number,
): Promise<SimulatedClosedDraft[]> {
  const rows = await db
    .select({
      simPnl: missionTradeDraftsTable.simPnl,
      simRMultiple: missionTradeDraftsTable.simRMultiple,
      simClosedAt: missionTradeDraftsTable.simClosedAt,
      symbol: missionTradeDraftsTable.symbol,
      timeframe: missionTradeDraftsTable.timeframe,
      agentKey: missionTradeDraftsTable.agentKey,
    })
    .from(missionTradeDraftsTable)
    .where(
      and(
        eq(missionTradeDraftsTable.missionId, missionId),
        eq(missionTradeDraftsTable.userId, userId),
        eq(missionTradeDraftsTable.simulated, true),
        isNotNull(missionTradeDraftsTable.simClosedAt),
      ),
    );
  const out: SimulatedClosedDraft[] = [];
  for (const r of rows) {
    if (r.simClosedAt == null || !isNum(r.simPnl)) continue;
    out.push({
      pnl: r.simPnl,
      rMultiple: isNum(r.simRMultiple) ? r.simRMultiple : null,
      symbol: r.symbol,
      timeframe: r.timeframe,
      agentKey: r.agentKey,
      closedAt: r.simClosedAt,
      simulated: true,
    });
  }
  return out;
}

/**
 * The accounting basis a mission's money surfaces are on. A non-live mission is
 * on SIMULATED accounting; a live mission is on broker-reconciled accounting.
 * The two are never blended into one figure.
 */
export type MissionAccountingBasis = "SIMULATED" | "BROKER_RECONCILED";

/** PURE — the basis for an execution mode. `live` and only `live` is money. */
export function accountingBasisForMode(executionMode: string | null | undefined): MissionAccountingBasis {
  return (executionMode ?? "").trim().toLowerCase() === "live" ? "BROKER_RECONCILED" : "SIMULATED";
}

export type { SimulatedQuoteInput };
