// Pre-trade Risk Governor — context loading, enforcement and audit.
//
// `enforcePreTradeRisk(intent)` is the call every order path makes before it
// writes an order row or queues a broker command. It:
//   1. resolves the user's effective limits (strictest stored value wins),
//   2. loads the facts for the venue (paper ledger, or the user's MT5 bridge),
//      letting the caller supply facts it already holds (the quote it will
//      fill at, its own in-flight rows) so the check and the fill agree,
//   3. evaluates all 13 rules (./preTrade.ts, pure),
//   4. writes one user_risk_events row per evaluation (pass or block) so
//      every decision has an audit trail, unless `preview` is set.
//
// Any failure while loading facts BLOCKS the intent (fail-closed). The
// function never places, queues or modifies an order itself.
//
// The one exception to a block is a written trader override on a PAPER
// venue, and only when rule 13 (the trader's own discipline settings) is the
// sole rule that blocked and the trader's settings allow overrides. The 12
// exposure rules and the stop switches can never be overridden.

import { classifyHeartbeatAgeMs } from "../brokerHub/freshness.js";
import { livePositionLedger, livePositionColumns } from "../positions/ledger.js";
import { readOpenPositions, RISK_COUNT_BASIS } from "../positions/openPositions.js";
import { db } from "@workspace/db";
import {
  paperAccountsTable,
  paperOrdersTable,
  tradesTable,
  tradeActionRequestsTable,
  arxLiveCommandsTable,
  mt5DemoCommandsTable,
  arxSymbolSpecsTable,
  virtualTradingAccountsTable,
  userEquityPeaksTable,
  sharedTradeAttributionTable,
} from "@workspace/db/schema";
import { and, desc, eq, gte, inArray, isNull, ne, notInArray, sql } from "drizzle-orm";
import { getConnection, listUserConnections } from "../brokerHub/connections.js";
import { logRiskEvent } from "./riskEvents.js";
import { loadEffectiveLimits } from "./limitSettings.js";
import { decideContractSize, resolveQuoteToAccountFx } from "../mt5/contractSize.js";
import { loadTradingHalt } from "../safety/tradingHalt.js";
import { brokerReadAdapter } from "../brokerHub/readAdapters.js";
import { isAllocationBlown } from "../live/allocationBlown.js";
import {
  evaluatePreTradeRisk,
  RISK_RULE_IDS,
  type AccountSnapshotFacts,
  type EffectiveLimits,
  type InstrumentModel,
  type RiskAccount,
  type RiskContext,
  type RiskDecision,
  type RiskInFlight,
  type RiskPosition,
  type RiskQuote,
  type TradeIntent,
  type BrokerStatus,
  type TradingActivity,
  summarizeActivity,
} from "./preTrade.js";

export * from "./preTrade.js";

/** The paper ledger books P/L as Δprice × lots × 100 (paperTrading pnlFor, paperExecutionMonitor). */
export const PAPER_LEDGER_INSTRUMENT: InstrumentModel = {
  contractSize: 100, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: null,
  source: "paper_ledger_model",
};
/** Paper accounts carry no leverage column; margin is modelled at 1:100. */
export const PAPER_ACCOUNT_LEVERAGE = 100;

// EA heartbeat budget: the shared heartbeat policy (owner decision 17).
// Fresh below 15 s; 15–60 s the bridge is degraded (closing still allowed);
// 60 s or older, or a future-dated heartbeat, is treated as disconnected.

const IN_FLIGHT_ACTION_STATUSES = ["confirmed", "guard_checking", "queued", "sent_to_mt5"];
const LIVE_TERMINAL = ["LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_CLOSED", "LIVE_EXPIRED"];
const DEMO_IN_FLIGHT = ["USER_CONFIRMATION_REQUIRED", "DEMO_APPROVED", "SENT_TO_MT5_DEMO"];

// A command already handed to the bridge is in flight until the broker
// answers. An unsent draft only counts while it could still be confirmed.
const UNSENT_DRAFT_WINDOW_MS = 30 * 60_000;
function isLiveQueueRow(status: string, createdAt: Date, now: Date): boolean {
  if (status.startsWith("SENT_TO_MT5")) return true;
  return now.getTime() - createdAt.getTime() <= UNSENT_DRAFT_WINDOW_MS;
}

export interface RiskFacts {
  now?: Date;
  account?: RiskAccount | null;
  /** Defaults to the loaded snapshot, or none when `account` is supplied. */
  accountSnapshot?: AccountSnapshotFacts | null;
  instruments?: Record<string, InstrumentModel>;
  quote?: RiskQuote | null;
  positions?: RiskPosition[];
  /** Added to the in-flight rows the loader finds. */
  extraInFlight?: RiskInFlight[];
  /**
   * Replaces the loaded in-flight rows entirely. For a book ARX keeps outside
   * the paper/broker tables (the simulator OMS), whose own orders are the only
   * ones that can duplicate or conflict.
   */
  inFlight?: RiskInFlight[];
  broker?: RiskContext["broker"];
  daily?: RiskContext["daily"];
  halt?: RiskContext["halt"];
  equityPeak?: RiskContext["equityPeak"];
  activity?: TradingActivity | null;
  market?: RiskContext["market"];
  venueRules?: RiskContext["venueRules"];
  allocation?: RiskContext["allocation"];
}

export interface EnforceOptions {
  /** Evaluate and return the decision without writing the audit row. */
  preview?: boolean;
  facts?: RiskFacts;
  /** PAPER venue: the paper account the order will book against. */
  paperAccountId?: number | null;
  /** DEMO/LIVE venue: the bridge the command will route to (defaults to the user's own). */
  connectionId?: number | null;
  /** Shared-master routing: equity and margin come from the user's virtual allocation. */
  virtualAccountId?: number | null;
  /** Free-form context copied into the audit row (route, command id …). */
  auditContext?: Record<string, unknown>;
  /** PAPER only: the trader's written override of a block raised by rule 13 alone. */
  override?: { reason: string } | null;
}

export interface EnforceResult extends RiskDecision {
  allowed: boolean;
  auditEventId: number | null;
  limits: EffectiveLimits | null;
  /** Set when a trader override let a discipline-only block through. */
  override?: { reason: string; rule: "trading_discipline" } | null;
}

/** True when `override` may pass this decision (see the header). */
export function overrideApplies(
  intent: TradeIntent,
  decision: RiskDecision,
  limits: EffectiveLimits | null,
  override: { reason: string } | null | undefined,
): boolean {
  return !!override && override.reason.trim().length >= 5
    && intent.venue === "PAPER"
    && decision.decision === "BLOCK"
    && !!limits?.discipline.allowOverrideInPaperMode
    && decision.blockedBy.length === 1 && decision.blockedBy[0] === "trading_discipline";
}

const ACTIVITY_CLOSES = 50;

function startOfTodayUtc(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

// The limit-settings rows are read in ./limitSettings.ts (the one reader).
export { loadStoredLimitRows, loadEffectiveLimits } from "./limitSettings.js";

/**
 * Pending OPEN intents from the Trade Action Center, shared by every venue.
 * Same 5-minute window as the guard chain's own duplicate check: the action
 * queue parks commands as BLOCKED, so an old "queued" row is not in flight.
 */
const ACTION_IN_FLIGHT_WINDOW_MS = 5 * 60_000;
async function loadActionInFlight(userId: number, venue: TradeIntent["venue"], now: Date): Promise<RiskInFlight[]> {
  const mode = venue === "PAPER" ? "SIMULATED" : venue;
  const rows = await db.select().from(tradeActionRequestsTable).where(and(
    eq(tradeActionRequestsTable.userId, userId),
    gte(tradeActionRequestsTable.createdAt, new Date(now.getTime() - ACTION_IN_FLIGHT_WINDOW_MS)),
    eq(tradeActionRequestsTable.actionType, "OPEN"),
    eq(tradeActionRequestsTable.requestedMode, mode),
    inArray(tradeActionRequestsTable.status, IN_FLIGHT_ACTION_STATUSES),
  ));
  return rows.filter((r) => (r.side === "BUY" || r.side === "SELL") && r.lotSize != null).map((r) => ({
    ref: `trade_action:${r.id}`, symbol: r.symbol, side: r.side as "BUY" | "SELL",
    lots: r.lotSize!, at: r.createdAt, kind: "pending" as const,
  }));
}

async function loadPaperFacts(intent: TradeIntent, opts: EnforceOptions, now: Date): Promise<Omit<RiskContext, "limits" | "now">> {
  const acctRows = opts.paperAccountId != null
    ? await db.select().from(paperAccountsTable).where(and(
        eq(paperAccountsTable.id, opts.paperAccountId), eq(paperAccountsTable.userId, intent.userId))).limit(1)
    : await db.select().from(paperAccountsTable).where(and(
        eq(paperAccountsTable.userId, intent.userId), eq(paperAccountsTable.isActive, 1)))
        .orderBy(desc(paperAccountsTable.createdAt)).limit(1);
  const acct = acctRows[0] ?? null;
  const account: RiskAccount | null = acct ? {
    equity: acct.equity, freeMargin: acct.equity - acct.marginUsed,
    leverage: PAPER_ACCOUNT_LEVERAGE, currency: "USD", source: `paper_account:${acct.id}`,
  } : null;

  let positions: RiskPosition[] = [];
  const inFlight: RiskInFlight[] = [];
  let realized: number | null = 0;
  if (acct) {
    const open = await db.select().from(paperOrdersTable).where(and(
      eq(paperOrdersTable.paperAccountId, acct.id), eq(paperOrdersTable.status, "OPEN")));
    positions = open.map((o) => ({
      symbol: o.symbol, side: o.direction as "BUY" | "SELL", lots: o.lotSize,
      entryPrice: o.entryPrice, stopLoss: o.stopLoss,
    }));
    const since = new Date(now.getTime() - 60 * 60_000);
    const recent = await db.select().from(paperOrdersTable).where(and(
      eq(paperOrdersTable.paperAccountId, acct.id), gte(paperOrdersTable.openedAt, since)));
    for (const o of recent) {
      inFlight.push({ ref: `paper_order:${o.id}`, symbol: o.symbol, side: o.direction as "BUY" | "SELL",
        lots: o.lotSize, at: o.openedAt, kind: "filled" });
    }
    const [r] = await db.select({ s: sql<number>`coalesce(sum(${paperOrdersTable.profitLoss}), 0)::float8` })
      .from(paperOrdersTable).where(and(
        eq(paperOrdersTable.paperAccountId, acct.id), ne(paperOrdersTable.status, "OPEN"),
        gte(paperOrdersTable.closedAt, startOfTodayUtc(now))));
    realized = Number(r?.s ?? 0);
  }
  inFlight.push(...await loadActionInFlight(intent.userId, "PAPER", now));

  let activity: TradingActivity | null = null;
  if (acct) {
    try {
      const closes = await db.select({ closedAt: paperOrdersTable.closedAt, pnl: paperOrdersTable.profitLoss })
        .from(paperOrdersTable).where(and(eq(paperOrdersTable.paperAccountId, acct.id), ne(paperOrdersTable.status, "OPEN"),
          sql`${paperOrdersTable.closedAt} is not null`))
        .orderBy(desc(paperOrdersTable.closedAt)).limit(ACTIVITY_CLOSES);
      const day = startOfTodayUtc(now);
      activity = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt!, pnl: Number(c.pnl ?? 0) })),
        positions.length ? (await db.select({ id: paperOrdersTable.id }).from(paperOrdersTable).where(and(
          eq(paperOrdersTable.paperAccountId, acct.id), eq(paperOrdersTable.status, "OPEN"),
          gte(paperOrdersTable.openedAt, day)))).length : 0,
        now, `paper_orders:account:${acct.id}`);
    } catch { activity = null; }
  }

  const instruments: Record<string, InstrumentModel> = {};
  for (const s of new Set([intent.symbol, ...positions.map((p) => p.symbol)])) instruments[s] = PAPER_LEDGER_INSTRUMENT;

  return {
    account,
    instruments,
    quote: null,
    positions,
    inFlight,
    broker: acct
      ? { status: "CONNECTED", lastSeenAt: now, detail: "internal paper simulator" }
      : { status: "DISCONNECTED", lastSeenAt: null, detail: "no active paper account" },
    daily: { realizedPnl: realized, floatingPnl: acct ? acct.equity - acct.currentBalance : null },
    activity,
  };
}

export function classifyBrokerHeartbeat(
  conn: { status: string; lastHeartbeat: Date | null } | null,
  now: Date,
): RiskContext["broker"] {
  if (!conn) return { status: "DISCONNECTED", lastSeenAt: null, detail: "no MT5 connection" };
  if (conn.status === "revoked" || conn.status === "disconnected") {
    return { status: "DISCONNECTED", lastSeenAt: conn.lastHeartbeat, detail: `bridge ${conn.status}` };
  }
  if (!conn.lastHeartbeat) return { status: "DISCONNECTED", lastSeenAt: null, detail: "bridge has never sent a heartbeat" };
  const age = now.getTime() - conn.lastHeartbeat.getTime();
  const secs = Math.round(age / 1000);
  const band = classifyHeartbeatAgeMs(age);
  if (band === "unknown") {
    return { status: "DISCONNECTED", lastSeenAt: conn.lastHeartbeat, detail: "heartbeat time is invalid (in the future)" };
  }
  const status: BrokerStatus = band === "fresh" ? "CONNECTED" : band === "degraded" ? "DEGRADED" : "DISCONNECTED";
  return { status, lastSeenAt: conn.lastHeartbeat, detail: `last heartbeat ${secs}s ago` };
}

async function loadBrokerFacts(intent: TradeIntent, opts: EnforceOptions, now: Date, quote: RiskQuote | null): Promise<Omit<RiskContext, "limits" | "now">> {
  const userId = intent.userId;
  const conn = opts.connectionId != null
    ? await getConnection(opts.connectionId)
    : (await listUserConnections(userId, { order: "heartbeat", limit: 1 }))[0] ?? null;
  const currency = (conn?.accountCurrency ?? "").trim().toUpperCase();

  let account: RiskAccount | null = null;
  let accountSnapshot: AccountSnapshotFacts | null = null;
  let allocation: RiskContext["allocation"] = null;
  if (opts.virtualAccountId != null) {
    const [v] = await db.select().from(virtualTradingAccountsTable).where(and(
      eq(virtualTradingAccountsTable.id, opts.virtualAccountId),
      eq(virtualTradingAccountsTable.userId, userId))).limit(1);
    if (v) {
      const eq0 = v.virtualBalance + v.virtualPnl;
      account = { equity: eq0, freeMargin: eq0 - v.virtualMarginUsed, leverage: conn?.leverage ?? null,
        currency: currency || "USD", source: `virtual_account:${v.id}` };
      // A closed attribution whose P/L could not be sized leaves the true
      // allocation unknown, so new risk waits for it.
      const pending = await db.select({ id: sharedTradeAttributionTable.id }).from(sharedTradeAttributionTable).where(and(
        eq(sharedTradeAttributionTable.userId, userId),
        eq(sharedTradeAttributionTable.virtualAccountId, v.id),
        eq(sharedTradeAttributionTable.status, "closed"),
        isNull(sharedTradeAttributionTable.realizedAppliedAt))).limit(1);
      allocation = {
        status: v.status, blown: isAllocationBlown({ virtualBalance: v.virtualBalance, virtualPnl: v.virtualPnl }),
        pendingSizing: pending.length > 0, source: `virtual_account:${v.id}`,
      };
    }
  } else if (conn && conn.userId === userId) {
    // The Broker Hub owns account snapshots. It only reads a connection the
    // trader owns, so another account's equity can never size this order.
    const snap = await brokerReadAdapter({ venue: "MT5", userId, connectionId: conn.id }).readAccount();
    accountSnapshot = {
      status: snap?.snapshotStatus ?? "MISSING",
      observedAt: snap?.observedAt ? new Date(snap.observedAt) : null,
      source: `broker_hub:mt5:${conn.id}`,
    };
    if (snap && snap.snapshotStatus !== "MISSING" && snap.equity != null) {
      account = { equity: snap.equity, freeMargin: snap.freeMargin, leverage: snap.leverage,
        currency: (snap.currency ?? "").trim().toUpperCase(),
        source: `broker_hub:mt5:${conn.id}:${snap.snapshotStatus.toLowerCase()}` };
    }
  }

  // Open positions: LIVE reads the live pipeline's own ledger
  // (arx_live_positions); DEMO reads the EA-synced live_positions.
  type OpenRow = { id: number; symbol: string; side: string; lots: number; entryPrice: number; stopLoss: number | null; floating: number | null; at: Date };
  // RISK_COUNT_BASIS (UNCLOSED) is the conservative basis (owner decision 6):
  // an operator-reconciled LIVE row that was never closed may still stand at
  // the broker, so it keeps counting. The intent's venue is authoritative
  // here, so no account-mode filter applies.
  const posRows: OpenRow[] = (await readOpenPositions({ userId, venue: intent.venue === "LIVE" ? "LIVE" : "DEMO", basis: RISK_COUNT_BASIS }))
    .map((p) => ({ id: p.id, symbol: p.symbol, side: p.side, lots: p.lots, entryPrice: p.entryPrice,
      stopLoss: p.stopLoss, floating: p.floatingPnl, at: p.openedAt ?? p.recordedAt }));
  const sided = posRows.filter((p): p is OpenRow & { side: "BUY" | "SELL" } => p.side === "BUY" || p.side === "SELL");
  const positions: RiskPosition[] = sided.map((p) => ({
    symbol: p.symbol, side: p.side, lots: p.lots, entryPrice: p.entryPrice, stopLoss: p.stopLoss,
  }));
  const floating = posRows.reduce((s, p) => s + (p.floating ?? 0), 0);

  const inFlight: RiskInFlight[] = [];
  const windowStart = new Date(now.getTime() - 60 * 60_000);
  for (const p of sided) {
    if (p.at >= windowStart) {
      inFlight.push({ ref: `position:${p.id}`, symbol: p.symbol, side: p.side, lots: p.lots, at: p.at, kind: "filled" });
    }
  }
  if (intent.venue === "LIVE") {
    const cmds = await db.select().from(arxLiveCommandsTable).where(and(
      eq(arxLiveCommandsTable.userId, userId),
      inArray(arxLiveCommandsTable.commandType, ["PLACE_LIVE_MARKET_ORDER", "PLACE_LIVE_PENDING_ORDER"]),
      notInArray(arxLiveCommandsTable.status, LIVE_TERMINAL)));
    for (const c of cmds) {
      if (c.side !== "BUY" && c.side !== "SELL") continue;
      if (!isLiveQueueRow(c.status, c.createdAt, now)) continue;
      inFlight.push({ ref: `live_command:${c.commandId}`, symbol: c.symbol, side: c.side, lots: c.requestedVolume, at: c.createdAt, kind: "pending" });
    }
  } else {
    const cmds = await db.select().from(mt5DemoCommandsTable).where(and(
      eq(mt5DemoCommandsTable.userId, userId),
      inArray(mt5DemoCommandsTable.commandType, ["PLACE_MARKET_ORDER", "PLACE_PENDING_ORDER"]),
      inArray(mt5DemoCommandsTable.status, DEMO_IN_FLIGHT)));
    for (const c of cmds) {
      const p = (c.payload ?? {}) as Record<string, unknown>;
      const side = String(p["side"] ?? "").toUpperCase();
      const lots = Number(p["lotSize"]);
      if ((side !== "BUY" && side !== "SELL") || !Number.isFinite(lots)) continue;
      if (!isLiveQueueRow(c.status, c.createdAt, now)) continue;
      inFlight.push({ ref: `demo_command:${c.commandId}`, symbol: String(p["symbol"] ?? ""), side, lots, at: c.createdAt, kind: "pending" });
    }
  }
  inFlight.push(...await loadActionInFlight(userId, intent.venue, now));

  // Realized today: LIVE uses the live ledger's closing P/L (the same bucket
  // the dispatch daily-loss gate reads); DEMO uses the trades journal.
  const [r] = intent.venue === "LIVE"
    ? await livePositionLedger.select(
      { s: sql<number>`coalesce(sum(${livePositionColumns.floatingPl}), 0)::float8` },
      {
        where: and(
          eq(livePositionColumns.userId, userId),
          gte(livePositionColumns.closedAt, startOfTodayUtc(now)),
        ),
      },
    )
    : await db.select({ s: sql<number>`coalesce(sum(${tradesTable.pnl}), 0)::float8` })
        .from(tradesTable).where(and(eq(tradesTable.userId, userId), gte(tradesTable.closedAt, startOfTodayUtc(now))));

  // Trading activity for rule 13, from the same ledgers as realized P/L.
  let activity: TradingActivity | null = null;
  try {
    const day = startOfTodayUtc(now);
    const closes = intent.venue === "LIVE"
      ? (await livePositionLedger.select(
        { closedAt: livePositionColumns.closedAt, pnl: livePositionColumns.floatingPl },
        {
          where: and(eq(livePositionColumns.userId, userId), sql`${livePositionColumns.closedAt} is not null`),
          orderBy: [desc(livePositionColumns.closedAt)],
          limit: ACTIVITY_CLOSES,
        },
      ))
      : (await db.select({ closedAt: tradesTable.closedAt, pnl: tradesTable.pnl })
          .from(tradesTable).where(and(eq(tradesTable.userId, userId), sql`${tradesTable.closedAt} is not null`))
          .orderBy(desc(tradesTable.closedAt)).limit(ACTIVITY_CLOSES));
    activity = summarizeActivity(closes.map((c) => ({ closedAt: c.closedAt!, pnl: Number(c.pnl ?? 0) })),
      sided.filter((p) => p.at >= day).length, now,
      intent.venue === "LIVE" ? "arx_live_positions" : "trades");
  } catch { activity = null; }

  // Instrument model per symbol: broker spec first, else the strict FX lot;
  // the quote→account rate needs the account currency.
  const symbols = [...new Set([intent.symbol, ...positions.map((p) => p.symbol)])];
  const specs = await db.select().from(arxSymbolSpecsTable).where(and(
    eq(arxSymbolSpecsTable.userId, userId), inArray(arxSymbolSpecsTable.symbol, symbols)));
  const instruments: Record<string, InstrumentModel> = {};
  for (const s of symbols) {
    const spec = specs.find((x) => x.symbol === s);
    const cs = decideContractSize({ symbol: s, brokerContractSize: spec?.contractSize ?? null, brokerProfitCurrency: spec?.profitCurrency ?? null });
    const px = s === intent.symbol && quote
      ? (quote.bid != null && quote.ask != null ? (quote.bid + quote.ask) / 2 : quote.bid ?? quote.ask ?? 0)
      : positions.find((p) => p.symbol === s)?.entryPrice ?? 0;
    const fx = currency
      ? resolveQuoteToAccountFx({ symbol: s, profitCurrency: cs.profitCurrency, accountCurrency: currency, closePrice: px })
      : { factor: null };
    instruments[s] = {
      contractSize: cs.contractSize, quoteToAccountFx: fx.factor,
      volumeStep: spec?.volumeStep ?? null, minVolume: spec?.minVolume ?? null, maxVolume: spec?.maxVolume ?? null,
      source: cs.source ?? (cs.reason ?? "unknown"),
    };
  }

  return {
    account,
    accountSnapshot,
    instruments,
    quote,
    positions,
    inFlight,
    broker: classifyBrokerHeartbeat(conn ? { status: conn.status, lastHeartbeat: conn.lastHeartbeat } : null, now),
    daily: { realizedPnl: Number(r?.s ?? 0), floatingPnl: posRows.length ? floating : 0 },
    activity,
    allocation,
  };
}

/** Broker quote for the user's bridge (EA symbol snapshot), else the market provider's quote. */
export async function loadQuote(userId: number, symbol: string): Promise<RiskQuote | null> {
  const [spec] = await db.select({ bid: arxSymbolSpecsTable.bid, ask: arxSymbolSpecsTable.ask, at: arxSymbolSpecsTable.lastTickTime })
    .from(arxSymbolSpecsTable).where(and(eq(arxSymbolSpecsTable.userId, userId), eq(arxSymbolSpecsTable.symbol, symbol))).limit(1);
  if (spec && (spec.bid != null || spec.ask != null) && spec.at) {
    return { bid: spec.bid, ask: spec.ask, at: spec.at, source: "mt5_symbol_snapshot" };
  }
  try {
    const { getMarketProvider } = await import("../assistant/marketProvider.js");
    const q = await getMarketProvider().getLiveQuote(symbol);
    if (q.bid == null && q.ask == null && q.price == null) return null;
    return {
      bid: q.bid ?? q.price, ask: q.ask ?? q.price,
      at: q.asOf ? new Date(q.asOf) : null,
      source: `market_provider:${q.freshness}`,
    };
  } catch {
    return null;
  }
}

async function loadEquityPeak(intent: TradeIntent, account: RiskAccount): Promise<RiskContext["equityPeak"]> {
  const [row] = await db.select().from(userEquityPeaksTable).where(and(
    eq(userEquityPeaksTable.userId, intent.userId),
    eq(userEquityPeaksTable.venue, intent.venue),
    eq(userEquityPeaksTable.accountKey, account.source),
  )).limit(1);
  return row ? { peakEquity: row.peakEquity, since: row.firstSeenAt, source: `user_equity_peaks:${row.id}` } : null;
}

/** Raise the account's recorded equity high-water mark; it never falls. */
async function recordEquityPeak(intent: TradeIntent, account: RiskAccount | null): Promise<void> {
  if (!account || account.equity == null || !Number.isFinite(account.equity) || account.equity <= 0) return;
  await db.insert(userEquityPeaksTable).values({
    userId: intent.userId, venue: intent.venue, accountKey: account.source, peakEquity: account.equity,
  }).onConflictDoUpdate({
    target: [userEquityPeaksTable.userId, userEquityPeaksTable.venue, userEquityPeaksTable.accountKey],
    set: {
      peakAt: sql`CASE WHEN excluded.peak_equity > ${userEquityPeaksTable.peakEquity} THEN now() ELSE ${userEquityPeaksTable.peakAt} END`,
      peakEquity: sql`GREATEST(${userEquityPeaksTable.peakEquity}, excluded.peak_equity)`,
      updatedAt: sql`now()`,
    },
  });
}

function contextFailure(intent: TradeIntent, now: Date, message: string): RiskDecision {
  const reason = `Risk context could not be loaded (${message}). Trade blocked for safety.`;
  const rules = RISK_RULE_IDS.map((rule) => ({ rule, outcome: "BLOCK" as const, reason }));
  return { decision: "BLOCK", blockedBy: [...RISK_RULE_IDS], primaryReason: reason, rules, evaluatedAt: now.toISOString() };
}

export async function buildRiskContext(intent: TradeIntent, opts: EnforceOptions = {}): Promise<RiskContext> {
  const f = opts.facts ?? {};
  const now = f.now ?? new Date();
  const limits = await loadEffectiveLimits(intent.userId);
  const quote = f.quote !== undefined
    ? f.quote
    : intent.action === "OPEN" ? await loadQuote(intent.userId, intent.symbol) : null;
  const loaded = intent.venue === "PAPER"
    ? await loadPaperFacts(intent, opts, now)
    : await loadBrokerFacts(intent, opts, now, quote);
  const account = f.account !== undefined ? f.account : loaded.account;
  const equityPeak = f.equityPeak !== undefined
    ? f.equityPeak
    : limits.maxDrawdownPercent != null && account ? await loadEquityPeak(intent, account) : null;
  return {
    now,
    limits,
    equityPeak,
    account,
    accountSnapshot: f.accountSnapshot !== undefined ? f.accountSnapshot
      : f.account !== undefined ? null : loaded.accountSnapshot ?? null,
    instruments: { ...loaded.instruments, ...(f.instruments ?? {}) },
    quote,
    positions: f.positions ?? loaded.positions,
    inFlight: [...(f.inFlight ?? loaded.inFlight), ...(f.extraInFlight ?? [])],
    broker: f.broker ?? loaded.broker,
    daily: f.daily ?? loaded.daily,
    halt: f.halt !== undefined
      ? f.halt
      : await loadTradingHalt({ userId: intent.userId, venue: intent.venue, virtualAccountId: opts.virtualAccountId ?? null }),
    activity: f.activity !== undefined ? f.activity : loaded.activity ?? null,
    market: f.market ?? null,
    venueRules: f.venueRules ?? null,
    allocation: f.allocation !== undefined ? f.allocation : loaded.allocation ?? null,
  };
}

export async function enforcePreTradeRisk(intent: TradeIntent, opts: EnforceOptions = {}): Promise<EnforceResult> {
  const now = opts.facts?.now ?? new Date();
  let decision: RiskDecision;
  let limits: EffectiveLimits | null = null;
  let ctx: RiskContext | null = null;
  try {
    ctx = await buildRiskContext(intent, opts);
    limits = ctx.limits;
    decision = evaluatePreTradeRisk(intent, ctx);
  } catch (e) {
    decision = contextFailure(intent, now, (e as Error).message.slice(0, 160));
  }

  let override: EnforceResult["override"] = null;
  if (overrideApplies(intent, decision, limits, opts.override)) {
    override = { reason: opts.override!.reason.trim(), rule: "trading_discipline" };
  }

  let auditEventId: number | null = null;
  if (!opts.preview) {
    const blocked = decision.decision === "BLOCK" && !override;
    try {
      const [row] = await logRiskEvent({
        userId: intent.userId,
        eventType: override ? "override" : blocked ? "blocked_trade" : "risk_check",
        severity: override ? "warning" : blocked ? "critical" : "info",
        decision: override ? "warning" : blocked ? "block" : "pass",
        reason: override
          ? `Trader override of their own trading rules: ${override.reason} (${decision.primaryReason ?? "discipline block"})`
          : blocked ? decision.primaryReason ?? "Blocked by Risk Governor." : `Pre-trade risk passed (${intent.venue} ${intent.action} ${intent.symbol}).`,
        details: {
          source: "pre_trade_risk_governor",
          intent,
          override,
          blockedBy: decision.blockedBy,
          halt: decision.halt ?? null,
          rules: decision.rules,
          limits,
          facts: ctx ? {
            account: ctx.account,
            equityPeak: ctx.equityPeak
              ? { ...ctx.equityPeak, since: ctx.equityPeak.since?.toISOString() ?? null }
              : null,
            accountSnapshot: ctx.accountSnapshot
              ? { ...ctx.accountSnapshot, observedAt: ctx.accountSnapshot.observedAt?.toISOString() ?? null }
              : null,
            quote: ctx.quote ? { ...ctx.quote, at: ctx.quote.at?.toISOString() ?? null } : null,
            broker: { ...ctx.broker, lastSeenAt: ctx.broker.lastSeenAt?.toISOString() ?? null },
            openPositions: ctx.positions.length,
            inFlight: ctx.inFlight.length,
            daily: ctx.daily,
            activity: ctx.activity
              ? { ...ctx.activity, lastClosedAt: ctx.activity.lastClosedAt?.toISOString() ?? null }
              : ctx.activity ?? null,
          } : null,
          ...(opts.auditContext ?? {}),
        },
      });
      auditEventId = row?.id ?? null;
    } catch {
      auditEventId = null;
    }
    // No audit row, no trade: an ALLOW that cannot be recorded is refused.
    if (auditEventId == null && (decision.decision === "ALLOW" || override)) {
      override = null;
      decision = {
        ...decision,
        decision: "BLOCK",
        primaryReason: "The risk decision could not be written to the audit trail. Trade blocked for safety.",
      };
    }
  }

  if (!opts.preview && ctx) {
    // Best effort: a missed update only leaves the previous (lower) peak.
    try { await recordEquityPeak(intent, ctx.account); } catch { /* non-fatal */ }
  }

  return { ...decision, allowed: decision.decision === "ALLOW" || !!override, auditEventId, limits, override };
}
