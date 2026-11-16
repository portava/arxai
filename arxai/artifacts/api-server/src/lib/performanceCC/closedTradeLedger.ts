// Mode-aware closed-trade ledger shared by the Performance Calendar routes
// (routes/mePerformanceCalendar.ts) and Eleanor's performance tools
// (lib/assistant/tools.ts), so both answer "what's my P&L" from the SAME book.
//
//  - LIVE_SHARED mode scope → withheld (no per-user book here; mixing stale
//    paper rows into a live view would leak across modes).
//  - safety envelope tradingMode LIVE → closed live trades
//    (shared_trade_attribution).
//  - otherwise → closed demo paper trades (paper_trades).
import { db, paperTradesTable } from "@workspace/db";
import { sharedTradeAttributionTable } from "@workspace/db/schema";
import { and, eq, isNotNull, gte, lte } from "drizzle-orm";
import { getEnvelope } from "../adminTrading/safetyEnvelope.js";
import { getUserModeScope, type CurrentAccountMode } from "../modeScope/getUserModeScope.js";

// Normalized closed-trade row. Both the live (shared_trade_attribution) and
// paper (paper_trades) sources map into this.
export type ClosedRow = {
  id: number;
  symbol: string;
  side: string;
  pnl: number | null;
  lotSize: number | null;
  entryPrice: number | null;
  exitPrice: number | null;
  strategyTag: string | null;
  riskAmount: number | null;
  closedAt: Date | null;
};

/**
 * Which book a response read, so a caller never labels one book as another:
 *  - paper_trades: closed demo paper trades (the same rows /me/paper-trades lists);
 *  - live_trades: closed live trades (shared_trade_attribution), read because
 *    the safety envelope's tradingMode is LIVE;
 *  - withheld_live_shared: the LIVE_SHARED mode scope returns no book here.
 */
export type CalendarSource = "paper_trades" | "live_trades" | "withheld_live_shared";

// The ledger a loaded response was computed from, and a note naming it. The
// demo ledger is the trades a trader logs by hand (paper_trades) — not the
// simulated orders (paper_orders) the Trading Calendar reads — so the two
// pages' figures differ for a date.
export type LedgerSource = Exclude<CalendarSource, "withheld_live_shared">;
export const SOURCE_NOTE: Record<LedgerSource, string> = {
  live_trades: "From your closed live trades recorded against your account.",
  paper_trades:
    "From the demo trades you log by hand on My Demo Trades. Simulated orders (Paper Autopilot and simulated trade tickets) are on the Trading Calendar and are not included; their P&L is computed differently, so the two pages will not match.",
};
export const WITHHELD_LIVE_SHARED_NOTE =
  "Your account is on the shared live master. Per-user closed-trade history is not kept in this ledger, so no win rate or daily P&L is computed here — your live P&L is on My Account (balance / today's P&L) and your open live trades.";

export function sourceFields(source: LedgerSource) {
  return { source, sourceNote: SOURCE_NOTE[source] };
}

// Mode-aware loader. In LIVE mode the calendar reflects ONLY closed live trades
// (shared_trade_attribution). In demo/paper/simulated it reflects paper_trades.
// No mixing — a live calendar never shows paper P&L and vice-versa.
export async function loadClosedRows(
  userId: number, fromIso?: string, toIso?: string,
): Promise<{ rows: ClosedRow[]; source: LedgerSource }> {
  const source = await ledgerSourceFor(userId);
  return { source, rows: await loadRowsFor(source, userId, fromIso, toIso) };
}

async function ledgerSourceFor(userId: number): Promise<LedgerSource> {
  const env = await getEnvelope(userId);
  return env.tradingMode === "LIVE" ? "live_trades" : "paper_trades";
}

async function loadRowsFor(
  source: LedgerSource, userId: number, fromIso?: string, toIso?: string,
): Promise<ClosedRow[]> {
  if (source === "live_trades") {
    const conds = [
      eq(sharedTradeAttributionTable.userId, userId),
      eq(sharedTradeAttributionTable.status, "closed"),
      isNotNull(sharedTradeAttributionTable.closedAt),
    ];
    if (fromIso) conds.push(gte(sharedTradeAttributionTable.closedAt, new Date(fromIso)));
    if (toIso) conds.push(lte(sharedTradeAttributionTable.closedAt, new Date(toIso)));
    const rows = await db.select().from(sharedTradeAttributionTable).where(and(...conds));
    return rows.map((r) => ({
      id: r.id,
      symbol: r.symbol,
      side: r.side,
      pnl: r.pnl ?? null,
      lotSize: r.lotSize ?? null,
      entryPrice: r.entryPrice ?? null,
      exitPrice: r.closePrice ?? null,
      strategyTag: null,
      riskAmount: null,
      closedAt: r.closedAt ?? null,
    }));
  }

  const conds = [
    eq(paperTradesTable.userId, userId),
    eq(paperTradesTable.status, "closed"),
    isNotNull(paperTradesTable.closedAt),
  ];
  if (fromIso) conds.push(gte(paperTradesTable.closedAt, new Date(fromIso)));
  if (toIso) conds.push(lte(paperTradesTable.closedAt, new Date(toIso)));
  const rows = await db.select().from(paperTradesTable).where(and(...conds));
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    side: r.side,
    pnl: r.pnl ?? null,
    lotSize: r.lotSize ?? null,
    entryPrice: r.entryPrice ?? null,
    exitPrice: r.exitPrice ?? null,
    strategyTag: r.strategyTag ?? null,
    riskAmount: r.riskAmount ?? null,
    closedAt: r.closedAt ?? null,
  }));
}

export type LedgerBasis = {
  source: CalendarSource;
  sourceNote: string;
  currentAccountMode: CurrentAccountMode;
};

export type ClosedTradeLedger = LedgerBasis & { rows: ClosedRow[] };

// Which book the Performance Calendar would show this user right now (mode
// scope first, then the envelope's trading mode) — same order as the route.
export async function resolveLedgerBasis(
  userId: number, opts: { isAdmin?: boolean } = {},
): Promise<LedgerBasis> {
  const scope = await getUserModeScope(userId, { isAdmin: opts.isAdmin === true });
  if (scope.currentAccountMode === "LIVE_SHARED") {
    return { source: "withheld_live_shared", sourceNote: WITHHELD_LIVE_SHARED_NOTE, currentAccountMode: scope.currentAccountMode };
  }
  const source = await ledgerSourceFor(userId);
  return { source, sourceNote: SOURCE_NOTE[source], currentAccountMode: scope.currentAccountMode };
}

// Full Performance-Calendar resolution for callers outside the HTTP route
// (Eleanor's tools): the basis plus its closed rows (none when withheld).
export async function resolveClosedTradeLedger(
  userId: number,
  opts: { isAdmin?: boolean; fromIso?: string; toIso?: string } = {},
): Promise<ClosedTradeLedger> {
  const basis = await resolveLedgerBasis(userId, opts);
  if (basis.source === "withheld_live_shared") return { ...basis, rows: [] };
  return { ...basis, rows: await loadRowsFor(basis.source, userId, opts.fromIso, opts.toIso) };
}
