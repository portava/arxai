// Trade History Import Service
//
// Orchestrates parsing → validation → DB storage for MT5 trade history.
//
// SAFETY:
//   - Never places trades. Never touches MT5 bridge command pipeline.
//   - Never modifies canPlaceTrades or any live-trading gate.
//   - Imported trades are tagged with source and trust level.
//   - All writes are scoped to req.authUser.id — cross-user writes impossible.

import { randomUUID } from "node:crypto";
import { db } from "@workspace/db";
import {
  tradeHistoryImportsTable,
  importedTradesTable,
  type TradeHistoryImportRow,
  type ImportedTradeRow,
} from "@workspace/db/schema";
import { eq, desc, and, sql } from "drizzle-orm";
import {
  parseMT5CSV,
  parseMT5HTML,
  parseMT5ExcelRows,
  scoreDataQuality,
  trustLevelFromSource,
  type ParsedTrade,
} from "./parser.js";

export type ImportSource = "MT5_CSV" | "MT5_HTML" | "MT5_EXCEL" | "DERIV_API" | "BROKER_API" | "MANUAL";

export interface RunImportInput {
  userId:     number;
  source:     ImportSource;
  fileName?:  string;
  rawText?:   string;             // for CSV / HTML
  excelRows?: Array<Array<unknown>>; // pre-parsed Excel rows
  accountLabel?: string;
  brokerHint?:   string;
  isLive?:       boolean;
}

export interface ImportSummary {
  importId:       string;
  status:         string;
  tradesImported: number;
  tradesRejected: number;
  dataQuality:    object;
  warnings:       string[];
  errors:         string[];
  accountLabel:   string | null;
  brokerHint:     string | null;
  isLive:         boolean | null;
  dateRangeFrom:  Date | null;
  dateRangeTo:    Date | null;
}

// ── Detect session from open time ─────────────────────────────────────────────
function detectSession(openedAt: Date | null): string | null {
  if (!openedAt) return null;
  const h = openedAt.getUTCHours();
  if (h >= 0 && h < 7) return "asian";
  if (h >= 7 && h < 12) return "london";
  if (h >= 12 && h < 16) return "overlap";
  if (h >= 16 && h < 21) return "newyork";
  return "asian"; // late NY / early Asian
}

// ── Detect asset class from symbol ───────────────────────────────────────────
function detectAssetClass(symbol: string): string {
  const s = symbol.toUpperCase();
  if (/^(BTCUSD|ETHUSD|BTC|ETH|XRP|SOL|BNB|DOGE)/.test(s)) return "crypto";
  if (/^(XAUUSD|GOLD|SILVER|XAGUSD|OIL|USOIL|UKOIL|BRENT|NG|NATGAS)/.test(s)) return "commodities";
  if (/^(US30|US500|NAS|SPX|DAX|FTSE|NIKKEI|JP225|GER40|UK100|AUS200)/.test(s)) return "indices";
  if (/^(R_|1HZ|BOOM|CRASH|JUMP|STEP|RANGE|VOL)/.test(s)) return "synthetic";
  // Forex: 6-char pairs
  if (/^[A-Z]{6}$/.test(s) || /^[A-Z]{3}\/[A-Z]{3}$/.test(s)) return "forex";
  return "forex"; // default
}

// ── Main import orchestrator ──────────────────────────────────────────────────
export async function runTradeHistoryImport(input: RunImportInput): Promise<ImportSummary> {
  const importId = `thi_${randomUUID()}`;
  const trustLevel = trustLevelFromSource(input.source);

  // 1. Parse
  let parseResult;
  try {
    if (input.source === "MT5_HTML" && input.rawText) {
      parseResult = parseMT5HTML(input.rawText);
    } else if (input.source === "MT5_EXCEL" && input.excelRows) {
      parseResult = parseMT5ExcelRows(input.excelRows);
    } else if (input.rawText) {
      parseResult = parseMT5CSV(input.rawText);
    } else {
      parseResult = {
        ok: false, trades: [], rejected: [],
        warnings: [], errors: ["No data provided to parse."],
        isLiveHint: null, accountLabel: null, brokerHint: null,
      };
    }
  } catch (e) {
    parseResult = {
      ok: false, trades: [], rejected: [],
      warnings: [], errors: [`Parse error: ${(e as Error).message}`],
      isLiveHint: null, accountLabel: null, brokerHint: null,
    };
  }

  // 2. Score data quality
  const dataQuality = scoreDataQuality(parseResult, trustLevel);

  const accountLabel = input.accountLabel ?? parseResult.accountLabel ?? null;
  const brokerHint   = input.brokerHint   ?? parseResult.brokerHint   ?? null;
  const isLive       = input.isLive       ?? parseResult.isLiveHint   ?? null;

  const status = !parseResult.ok
    ? "FAILED"
    : parseResult.trades.length === 0
    ? "FAILED"
    : parseResult.rejected.length > 0
    ? "PARTIAL"
    : "COMPLETE";

  // 3. Write import batch record
  await db.insert(tradeHistoryImportsTable).values({
    userId:         input.userId,
    importId,
    source:         input.source,
    trustLevel,
    accountLabel,
    brokerHint,
    isLive,
    fileName:       input.fileName ?? null,
    status,
    tradesFound:    parseResult.trades.length + parseResult.rejected.length,
    tradesImported: parseResult.trades.length,
    tradesRejected: parseResult.rejected.length,
    dataQuality:    dataQuality as unknown as Record<string, unknown>,
    warnings:       dataQuality.warnings as unknown as string[],
    errors:         dataQuality.errors as unknown as string[],
    dateRangeFrom:  getDateRange(parseResult.trades).from,
    dateRangeTo:    getDateRange(parseResult.trades).to,
  });

  // 4. Write individual trades (batch insert, dedup via unique index)
  if (parseResult.trades.length > 0) {
    const rows = parseResult.trades.map((t: ParsedTrade) => ({
      userId:          input.userId,
      importId,
      trustLevel,
      brokerDealId:    t.brokerDealId,
      brokerOrderId:   t.brokerOrderId,
      magicNumber:     t.magicNumber,
      comment:         t.comment,
      symbol:          t.symbol,
      assetClass:      detectAssetClass(t.symbol),
      side:            t.side,
      orderType:       t.orderType,
      lotSize:         t.lotSize,
      entryPrice:      t.entryPrice,
      exitPrice:       t.exitPrice,
      stopLoss:        t.stopLoss,
      takeProfit:      t.takeProfit,
      openedAt:        t.openedAt,
      closedAt:        t.closedAt,
      durationSeconds: t.durationSeconds,
      grossPnl:        t.grossPnl,
      commission:      t.commission,
      swap:            t.swap,
      netPnl:          t.netPnl,
      balanceAfter:    t.balanceAfter,
      closeType:       t.closeType,
      isLive,
      accountLabel,
      isFlagged:       t.flagReasons.length > 0,
      flagReasons:     t.flagReasons as unknown as string[],
      sessionLabel:    detectSession(t.openedAt),
    }));

    // Insert in chunks to avoid parameter limits
    const CHUNK = 100;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      try {
        await db.insert(importedTradesTable)
          .values(chunk)
          .onConflictDoNothing(); // skip duplicates silently
      } catch {
        // If chunk fails, try row by row to maximise imported count
        for (const row of chunk) {
          try {
            await db.insert(importedTradesTable).values(row).onConflictDoNothing();
          } catch { /* skip */ }
        }
      }
    }
  }

  return {
    importId,
    status,
    tradesImported: parseResult.trades.length,
    tradesRejected: parseResult.rejected.length,
    dataQuality,
    warnings: dataQuality.warnings,
    errors:   dataQuality.errors,
    accountLabel,
    brokerHint,
    isLive,
    dateRangeFrom: getDateRange(parseResult.trades).from,
    dateRangeTo:   getDateRange(parseResult.trades).to,
  };
}

// ── List imports for a user ───────────────────────────────────────────────────
export async function listTradeHistoryImports(userId: number): Promise<TradeHistoryImportRow[]> {
  return db.select()
    .from(tradeHistoryImportsTable)
    .where(eq(tradeHistoryImportsTable.userId, userId))
    .orderBy(desc(tradeHistoryImportsTable.createdAt))
    .limit(50);
}

// ── List imported trades for a user ──────────────────────────────────────────
export interface ListImportedTradesOptions {
  userId:   number;
  importId?: string;
  symbol?:   string;
  side?:     string;
  limit?:    number;
  offset?:   number;
}

export async function listImportedTrades(opts: ListImportedTradesOptions): Promise<{
  trades: ImportedTradeRow[];
  total: number;
}> {
  const limit  = Math.min(opts.limit  ?? 100, 500);
  const offset = opts.offset ?? 0;

  const conditions = [eq(importedTradesTable.userId, opts.userId)];
  if (opts.importId) conditions.push(eq(importedTradesTable.importId, opts.importId));
  if (opts.symbol)   conditions.push(eq(importedTradesTable.symbol, opts.symbol.toUpperCase()));
  if (opts.side)     conditions.push(eq(importedTradesTable.side, opts.side.toUpperCase() as "BUY" | "SELL"));

  const where = and(...conditions);

  const [trades, countResult] = await Promise.all([
    db.select().from(importedTradesTable)
      .where(where)
      .orderBy(desc(importedTradesTable.openedAt))
      .limit(limit)
      .offset(offset),
    db.select({ count: sql<number>`count(*)::int` })
      .from(importedTradesTable)
      .where(where),
  ]);

  return { trades, total: countResult[0]?.count ?? 0 };
}

// ── Summary stats for Ruby ────────────────────────────────────────────────────
export async function getTradeHistorySummary(userId: number) {
  const trades = await db.select().from(importedTradesTable)
    .where(eq(importedTradesTable.userId, userId))
    .orderBy(desc(importedTradesTable.openedAt));

  if (trades.length === 0) {
    return { hasTrades: false, count: 0 };
  }

  const closed = trades.filter((t) => t.closedAt && t.netPnl !== null);
  const wins   = closed.filter((t) => (t.netPnl ?? 0) > 0);
  const losses = closed.filter((t) => (t.netPnl ?? 0) < 0);

  const totalNetPnl = closed.reduce((s, t) => s + (t.netPnl ?? 0), 0);
  const avgWin  = wins.length   ? wins.reduce((s, t) => s + (t.netPnl ?? 0), 0) / wins.length   : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + (t.netPnl ?? 0), 0) / losses.length : 0;
  const winRate = closed.length ? (wins.length / closed.length) * 100 : 0;

  // Symbol breakdown
  const bySymbol: Record<string, { count: number; netPnl: number; wins: number }> = {};
  for (const t of closed) {
    const s = bySymbol[t.symbol] = bySymbol[t.symbol] ?? { count: 0, netPnl: 0, wins: 0 };
    s.count++;
    s.netPnl += t.netPnl ?? 0;
    if ((t.netPnl ?? 0) > 0) s.wins++;
  }

  const symbols = Object.entries(bySymbol)
    .map(([sym, d]) => ({ symbol: sym, ...d, winRate: (d.wins / d.count) * 100 }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  // Session breakdown
  const bySession: Record<string, { count: number; netPnl: number }> = {};
  for (const t of closed) {
    if (!t.sessionLabel) continue;
    const s = bySession[t.sessionLabel] = bySession[t.sessionLabel] ?? { count: 0, netPnl: 0 };
    s.count++;
    s.netPnl += t.netPnl ?? 0;
  }

  const imports = await listTradeHistoryImports(userId);
  const sources = [...new Set(imports.map((i) => i.source))];

  return {
    hasTrades: true,
    count: trades.length,
    closedCount: closed.length,
    winRate: Math.round(winRate * 10) / 10,
    totalNetPnl: Math.round(totalNetPnl * 100) / 100,
    avgWin:  Math.round(avgWin  * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
    topSymbols: symbols,
    sessions: bySession,
    sources,
    dateFrom: trades[trades.length - 1]?.openedAt ?? null,
    dateTo:   trades[0]?.openedAt ?? null,
  };
}

// ── Helper ────────────────────────────────────────────────────────────────────
function getDateRange(trades: ParsedTrade[]): { from: Date | null; to: Date | null } {
  const dates = trades.map((t) => t.openedAt).filter(Boolean) as Date[];
  if (!dates.length) return { from: null, to: null };
  return {
    from: new Date(Math.min(...dates.map((d) => d.getTime()))),
    to:   new Date(Math.max(...dates.map((d) => d.getTime()))),
  };
}
