// Paper journal (paper_trades) through the one Risk Governor.
//
// The journal is the trader's hand-entered paper book: they type the entry,
// stop, target and exit, and P/L is Δprice × lots. Opening a journal trade or
// moving its stop adds or changes paper exposure, so it faces the same 13
// rules as every other venue (enforcePreTradeRisk, venue PAPER). This file
// only supplies the journal's facts: its own open trades, its activity, the
// entered price as the fill quote and the account the journal is sized on.
//
// A trader override (paper only) can pass a block raised by rule 13 alone —
// their own discipline settings — never one of the 12 exposure rules.

import { and, eq } from "drizzle-orm";
import { db, mt5ConnectionTable, paperTradesTable, type PaperTrade } from "@workspace/db";
import { enforcePreTradeRisk, PAPER_ACCOUNT_LEVERAGE, type EnforceResult, type RiskFacts } from "./enforce.js";
import type { InstrumentModel, ProcessFacts, RiskAccount, RiskPosition, TradeIntent } from "./preTrade.js";
import { journalActivity } from "./journalActivity.js";

/** Journal P/L is Δprice × lots (routes/mePaperTrades pnlFor). */
export const PAPER_JOURNAL_INSTRUMENT: InstrumentModel = {
  contractSize: 1, quoteToAccountFx: 1, volumeStep: 0.01, minVolume: 0.01, maxVolume: null,
  source: "paper_journal_model",
};
/** Equity the journal is sized on when the trader links no MT5 account. */
export const PAPER_JOURNAL_MODEL_EQUITY = 10_000;

const side = (s: string | null | undefined): "BUY" | "SELL" | null => {
  const u = String(s ?? "").toUpperCase();
  return u === "BUY" || u === "SELL" ? u : null;
};

async function journalAccount(userId: number, trade: Pick<PaperTrade, "mt5ConnectionId">, open: RiskPosition[]): Promise<RiskAccount> {
  let equity: number | null = null;
  let source = "paper_journal_model";
  if (trade.mt5ConnectionId != null) {
    const [conn] = await db.select({ bal: mt5ConnectionTable.accountBalance, id: mt5ConnectionTable.id }).from(mt5ConnectionTable)
      .where(and(eq(mt5ConnectionTable.id, trade.mt5ConnectionId), eq(mt5ConnectionTable.userId, userId))).limit(1);
    if (conn?.bal != null && Number(conn.bal) > 0) { equity = Number(conn.bal); source = `paper_journal:mt5_balance:${conn.id}`; }
  }
  if (equity == null) equity = PAPER_JOURNAL_MODEL_EQUITY;
  const margin = open.reduce((s, p) => s + (p.lots * p.entryPrice) / PAPER_ACCOUNT_LEVERAGE, 0);
  return { equity, freeMargin: equity - margin, leverage: PAPER_ACCOUNT_LEVERAGE, currency: "USD", source };
}

async function journalFacts(userId: number, trade: Pick<PaperTrade, "id" | "symbol" | "mt5ConnectionId">, entry: number | null, now: Date): Promise<RiskFacts> {
  const rows = await db.select().from(paperTradesTable).where(eq(paperTradesTable.userId, userId));
  const open = rows.filter((t) => t.status === "open" && t.id !== trade.id && t.entryPrice != null && side(t.side))
    .map((t) => ({ symbol: t.symbol, side: side(t.side)!, lots: t.lotSize, entryPrice: t.entryPrice!, stopLoss: t.stopLoss }));
  const day = new Date(now); day.setUTCHours(0, 0, 0, 0);
  const realized = rows.filter((t) => t.status === "closed" && t.closedAt && t.closedAt >= day).reduce((s, t) => s + (t.pnl ?? 0), 0);
  const instruments: Record<string, InstrumentModel> = {};
  for (const s of new Set([trade.symbol, ...open.map((p) => p.symbol)])) instruments[s] = PAPER_JOURNAL_INSTRUMENT;
  return {
    now,
    account: await journalAccount(userId, trade, open),
    instruments,
    quote: entry != null ? { bid: entry, ask: entry, at: now, source: "paper_journal_entry_price" } : null,
    positions: open,
    inFlight: [],
    broker: { status: "CONNECTED", lastSeenAt: now, detail: "internal paper journal" },
    daily: { realizedPnl: realized, floatingPnl: null },
    activity: journalActivity(rows, now, trade.id),
  };
}

export interface JournalCheck {
  decision: "pass" | "block";
  reason: string;
  failedRules: Array<{ rule: string; severity: "critical" | "warning"; reason: string | null }>;
  requiredActions: string[];
  overrideAllowed: boolean;
  overridden: boolean;
  risk: EnforceResult;
}

function toCheck(r: EnforceResult): JournalCheck {
  const blocked = r.rules.filter((x) => x.outcome === "BLOCK");
  const disciplineOnly = r.decision === "BLOCK" && r.blockedBy.length === 1 && r.blockedBy[0] === "trading_discipline";
  return {
    decision: r.allowed ? "pass" : "block",
    reason: r.allowed
      ? r.override ? `Override applied: ${r.override.reason}` : "All risk checks passed."
      : r.primaryReason ?? "Blocked by the Risk Governor.",
    failedRules: blocked.map((x) => ({ rule: x.rule, severity: x.rule === "trading_discipline" ? "warning" : "critical", reason: x.reason })),
    requiredActions: blocked.map((x) => x.reason).filter((x): x is string => !!x),
    overrideAllowed: !r.allowed && disciplineOnly && !!r.limits?.discipline.allowOverrideInPaperMode,
    overridden: !!r.override,
    risk: r,
  };
}

/** Opening a planned journal trade at `entryPrice`. */
export async function enforceJournalOpen(userId: number, trade: PaperTrade, entryPrice: number, override?: { reason: string } | null): Promise<JournalCheck> {
  const now = new Date();
  const intent: TradeIntent = {
    userId, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol: trade.symbol, side: side(trade.side), lots: trade.lotSize,
    stopLoss: trade.stopLoss, takeProfit: trade.takeProfit,
    intentRef: `paper_trade:${trade.id}`,
    process: { playbookId: null, preTradeCheckDecision: null, preTradeCheckPassed: null, reasonForEntry: trade.reasonForEntry },
  };
  const r = await enforcePreTradeRisk(intent, {
    facts: await journalFacts(userId, trade, entryPrice, now),
    override: override ?? null,
    auditContext: { route: "POST /me/paper-trades/:id/open", paperTradeId: trade.id },
  });
  return toCheck(r);
}

/** Moving the stop or target of an open journal trade. */
export async function enforceJournalModify(userId: number, trade: PaperTrade, next: { stopLoss: number | null; takeProfit: number | null }): Promise<JournalCheck> {
  const now = new Date();
  const intent: TradeIntent = {
    userId, venue: "PAPER", origin: "manual", action: "MODIFY",
    symbol: trade.symbol, side: side(trade.side), lots: trade.lotSize,
    stopLoss: next.stopLoss, takeProfit: next.takeProfit,
    intentRef: `paper_trade:${trade.id}`,
    position: trade.entryPrice != null ? { entryPrice: trade.entryPrice, stopLoss: trade.stopLoss } : null,
  };
  const r = await enforcePreTradeRisk(intent, {
    facts: await journalFacts(userId, trade, trade.entryPrice, now),
    auditContext: { route: "PATCH /me/paper-trades/:id", paperTradeId: trade.id },
  });
  return toCheck(r);
}

/** Pre-flight for a ticket that is not in the journal yet. Writes no audit row. */
export async function previewJournalTicket(userId: number, t: {
  symbol: string; side: string | null; lots: number | null; entryPrice: number | null;
  stopLoss: number | null; takeProfit: number | null; mt5ConnectionId?: number | null;
  process: ProcessFacts;
}): Promise<JournalCheck> {
  const now = new Date();
  const symbol = t.symbol.trim().toUpperCase();
  const intent: TradeIntent = {
    userId, venue: "PAPER", origin: "manual", action: "OPEN",
    symbol, side: side(t.side), lots: t.lots, stopLoss: t.stopLoss, takeProfit: t.takeProfit, process: t.process,
  };
  const r = await enforcePreTradeRisk(intent, {
    preview: true,
    facts: await journalFacts(userId, { id: -1, symbol, mt5ConnectionId: t.mt5ConnectionId ?? null }, t.entryPrice, now),
  });
  return toCheck(r);
}
