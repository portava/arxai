// Live Trade Health & Management — per-user service (Task #198).
//
// Reads the caller's REAL open positions (mode-scoped exactly like the unified
// positions feed: live for a LIVE_SHARED user, demo for a DEMO user, nothing for
// PAPER), pulls a best-effort original Ruby signal per distinct symbol, and the
// caller's real recent-command pace, then composes the pure TradeHealthReport.
//
// SAFETY:
//  - READ-ONLY. Never places, modifies, or closes a trade; never writes a row.
//  - Strictly per-user — every query is scoped by userId AND mode-scope, so no
//    other user's position can ever appear.
//  - HONEST. Every price is a real broker-derived number or null; a missing
//    input degrades to an honest "unknown" in the engine, never a fabricated
//    value, and never sim/mock/paper data treated as real.

import { and, desc, eq, gte, isNotNull, inArray, sql } from "drizzle-orm";
import {
  db,
  arxLiveCommandsTable,
  arxLivePositionsTable,
  mt5DemoCommandsTable,
  mt5StateTable,
  tradesTable,
} from "@workspace/db";
import {
  buildTradeHealthReport,
  type OpenPositionInput,
  type OriginalSignalInput,
  type OvertradingInput,
  type TradeHealthReport,
  type TradeSide,
} from "@workspace/domain/trade-health";
import { getUserModeScope } from "../modeScope/getUserModeScope.js";
import { buildRubyMarketEdgeForUser } from "../signalIntelligence/signalIntelligenceService.js";
import { getEconomicCalendar } from "../news/economicCalendarProvider.js";

export interface TradeHealthServiceArgs {
  userId: number;
  isAdmin: boolean;
  chartSymbol: string | null;
  nowMs: number;
}

export interface TradeHealthServiceResult {
  report: TradeHealthReport;
  chartSymbol: string | null;
}

const LIVE_STALE_MS = 90_000;
const OVERTRADING_WINDOW_MINUTES = 60;
const RECENT_CLOSED_TRADE_LOOKBACK = 10;
const NEWS_WINDOW_MS = 60 * 60_000;

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function toMs(v: unknown): number | null {
  if (v == null) return null;
  if (v instanceof Date) {
    const t = v.getTime();
    return Number.isFinite(t) ? t : null;
  }
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? t : null;
}

function normalizeSide(v: unknown): TradeSide | null {
  const s = String(v ?? "").trim().toUpperCase();
  return s === "BUY" || s === "SELL" ? s : null;
}

type DemoRaw = {
  ticket?: string | number | null;
  symbol?: string | null;
  side?: string | null;
  lot?: number | null;
  volume?: number | null;
  openPrice?: number | null;
  currentPrice?: number | null;
  stopLoss?: number | null;
  takeProfit?: number | null;
  profit?: number | null;
  openTime?: string | null;
};

/** Read the caller's mode-scoped open positions as engine inputs. */
async function readOpenPositions(
  userId: number,
  includeLive: boolean,
  includeDemo: boolean,
  nowMs: number,
): Promise<OpenPositionInput[]> {
  const out: OpenPositionInput[] = [];

  // LIVE — arx_live_positions, scoped by userId, with the same ghost-reconcile
  // window the unified positions feed uses (hide rows the broker no longer
  // reports as open). fillRecorded comes from the source command's real fill
  // price — never fabricated.
  if (includeLive) {
    const liveRowsAll = await db
      .select()
      .from(arxLivePositionsTable)
      .where(eq(arxLivePositionsTable.userId, userId));
    const newestSync = liveRowsAll.reduce((max, r) => {
      const t = r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : 0;
      return t > max ? t : max;
    }, 0);
    const floor = newestSync > 0 ? newestSync - LIVE_STALE_MS : 0;
    const liveRows = liveRowsAll.filter((r) => {
      if (r.closedAt) return false;
      const t = r.lastSyncedAt ? new Date(r.lastSyncedAt).getTime() : 0;
      return t >= floor;
    });

    // Resolve which source commands recorded a real broker fill price (honest
    // "fill + slippage stored" handshake signal). Scoped by userId.
    const sourceIds = liveRows
      .map((r) => r.sourceCommandId)
      .filter((x): x is string => !!x);
    const fillByCommandId = new Map<string, boolean>();
    if (sourceIds.length > 0) {
      const cmdRows = await db
        .select({
          commandId: arxLiveCommandsTable.commandId,
          fillPrice: arxLiveCommandsTable.fillPrice,
        })
        .from(arxLiveCommandsTable)
        .where(eq(arxLiveCommandsTable.userId, userId));
      for (const c of cmdRows) {
        if (c.commandId) fillByCommandId.set(c.commandId, c.fillPrice != null);
      }
    }

    for (const r of liveRows) {
      const side = normalizeSide(r.side);
      if (!side || !r.brokerTicket || !r.symbol) continue;
      const syncedMs = toMs(r.lastSyncedAt);
      out.push({
        ticket: String(r.brokerTicket),
        symbol: r.symbol,
        side,
        lotSize: num(r.volume) ?? 0,
        entryPrice: num(r.entryPrice),
        currentPrice: num(r.currentPrice),
        stopLoss: num(r.stopLoss),
        takeProfit: num(r.takeProfit),
        floatingPnl: num(r.floatingPl),
        openedAtMs: toMs(r.openedAt),
        priceAgeMs: syncedMs != null ? Math.max(0, nowMs - syncedMs) : null,
        accountMode: "LIVE",
        fillRecorded: r.sourceCommandId
          ? fillByCommandId.get(r.sourceCommandId) ?? false
          : undefined,
      });
    }
  }

  // DEMO — latest mt5_state row for the user, then map its positions JSON.
  if (includeDemo) {
    const stateRows = await db
      .select()
      .from(mt5StateTable)
      .where(eq(mt5StateTable.userId, userId))
      .orderBy(sql`${mt5StateTable.lastSyncAt} DESC NULLS LAST`)
      .limit(1);
    const stateRow = stateRows[0];
    const syncedMs = toMs(stateRow?.lastSyncAt);
    const positionsRaw: DemoRaw[] = Array.isArray(stateRow?.positions)
      ? (stateRow!.positions as DemoRaw[])
      : [];
    for (const p of positionsRaw) {
      const side = normalizeSide(p.side);
      if (!side || p.ticket == null || !p.symbol) continue;
      out.push({
        ticket: String(p.ticket),
        symbol: p.symbol,
        side,
        lotSize: num(p.lot ?? p.volume) ?? 0,
        entryPrice: num(p.openPrice),
        currentPrice: num(p.currentPrice),
        stopLoss: num(p.stopLoss),
        takeProfit: num(p.takeProfit),
        floatingPnl: num(p.profit),
        openedAtMs: toMs(p.openTime),
        priceAgeMs: syncedMs != null ? Math.max(0, nowMs - syncedMs) : null,
        accountMode: "DEMO",
        // Demo fill slippage isn't tracked → honest NOT_AVAILABLE downstream.
        fillRecorded: undefined,
      });
    }
  }

  return out;
}

/**
 * Newest open lot the caller is currently carrying (used for revenge-sizing).
 * Null when no open position has a usable lot.
 */
function newestOpenLot(positions: readonly OpenPositionInput[]): number | null {
  let best: { lot: number; at: number } | null = null;
  for (const p of positions) {
    const lot = num(p.lotSize);
    if (lot == null || !(lot > 0)) continue;
    const at = p.openedAtMs ?? 0;
    if (!best || at >= best.at) best = { lot, at };
  }
  return best?.lot ?? null;
}

/**
 * Read the caller's recent CLOSED trades (real, per-user) to derive whether the
 * latest close was a loss and the user's usual recent lot baseline. Honest:
 * returns nulls when there is no closed history, so the engine emits no
 * revenge-sizing warning rather than fabricating one.
 */
async function readRecentClosedSummary(
  userId: number,
): Promise<{ lastWasLoss: boolean | null; baselineLot: number | null }> {
  const rows = await db
    .select({
      status: tradesTable.status,
      lot: tradesTable.lot,
      closedAt: tradesTable.closedAt,
    })
    .from(tradesTable)
    .where(
      and(
        eq(tradesTable.userId, userId),
        inArray(tradesTable.status, ["CLOSED_WIN", "CLOSED_LOSS"]),
        isNotNull(tradesTable.closedAt),
      ),
    )
    .orderBy(desc(tradesTable.closedAt))
    .limit(RECENT_CLOSED_TRADE_LOOKBACK);

  if (rows.length === 0) return { lastWasLoss: null, baselineLot: null };

  const lastWasLoss = rows[0]!.status === "CLOSED_LOSS";
  const lots = rows.map((r) => num(r.lot)).filter((n): n is number => n != null && n > 0);
  const baselineLot =
    lots.length > 0 ? lots.reduce((a, b) => a + b, 0) / lots.length : null;
  return { lastWasLoss, baselineLot };
}

/**
 * Honest read of whether the user is trading through a high-impact news window
 * on any open symbol. Sourced from the real economic-calendar provider seam:
 * when NO open symbol's provider is connected we return null (we cannot read it,
 * so the engine emits no warning); when at least one is connected we return
 * whether a high-impact event falls within the window — never fabricated.
 */
async function readTradingThroughNews(
  symbols: readonly string[],
  nowMs: number,
): Promise<boolean | null> {
  const distinct = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
  if (distinct.length === 0) return null;
  const snapshots = await Promise.all(
    distinct.map(async (symbol) => {
      try {
        return await getEconomicCalendar(symbol, nowMs);
      } catch {
        return null;
      }
    }),
  );
  const connected = snapshots.filter((s): s is NonNullable<typeof s> => !!s?.connected);
  if (connected.length === 0) return null;
  for (const snap of connected) {
    for (const ev of snap.events) {
      if (ev.impact !== "high") continue;
      const t = Date.parse(ev.eventTimeIso);
      if (!Number.isFinite(t)) continue;
      if (Math.abs(t - nowMs) <= NEWS_WINDOW_MS) return true;
    }
  }
  return false;
}

/**
 * Build the caller's REAL behavioral inputs for the overtrading guidance: recent
 * command pace, whether the last close was a loss, the current size vs the recent
 * baseline, and whether a high-impact news window is open. Every dimension is
 * read from real per-user data; any unreadable dimension stays null so the engine
 * never fabricates a warning.
 */
async function readOvertradingInput(
  userId: number,
  includeLive: boolean,
  includeDemo: boolean,
  positions: readonly OpenPositionInput[],
  nowMs: number,
): Promise<OvertradingInput> {
  const since = new Date(nowMs - OVERTRADING_WINDOW_MINUTES * 60_000);
  let recentTradeCount: number | null = null;

  if (includeLive) {
    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(arxLiveCommandsTable)
      .where(
        and(
          eq(arxLiveCommandsTable.userId, userId),
          gte(arxLiveCommandsTable.createdAt, since),
        ),
      );
    recentTradeCount = (recentTradeCount ?? 0) + (rows[0]?.c ?? 0);
  }
  if (includeDemo) {
    const rows = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(mt5DemoCommandsTable)
      .where(
        and(
          eq(mt5DemoCommandsTable.userId, userId),
          gte(mt5DemoCommandsTable.createdAt, since),
        ),
      );
    recentTradeCount = (recentTradeCount ?? 0) + (rows[0]?.c ?? 0);
  }

  const [{ lastWasLoss, baselineLot }, tradingThroughNews] = await Promise.all([
    readRecentClosedSummary(userId),
    readTradingThroughNews(
      positions.map((p) => p.symbol),
      nowMs,
    ),
  ]);

  const currentLot = newestOpenLot(positions);
  const lotVsBaseline =
    baselineLot != null && baselineLot > 0 && currentLot != null
      ? currentLot / baselineLot
      : null;

  return {
    recentTradeCount,
    windowMinutes: recentTradeCount == null ? null : OVERTRADING_WINDOW_MINUTES,
    recentLosses: lastWasLoss,
    lotVsBaseline,
    tradingThroughNews,
  };
}

/** Best-effort original Ruby signal per distinct symbol (null on any failure). */
async function readSignalsBySymbol(
  userId: number,
  symbols: readonly string[],
): Promise<Record<string, OriginalSignalInput | null>> {
  const distinct = [...new Set(symbols.map((s) => s.trim().toUpperCase()))];
  const entries = await Promise.all(
    distinct.map(async (symbol): Promise<[string, OriginalSignalInput | null]> => {
      try {
        const signal = await buildRubyMarketEdgeForUser(userId, { symbol });
        if (!signal) return [symbol, null];
        return [
          symbol,
          {
            symbol: signal.symbol,
            direction: normalizeSide(signal.direction),
            hasSufficientData: signal.hasSufficientData,
            invalidationPrice: num(signal.invalidationPrice),
            entryZone: signal.entryZone ?? null,
            retestZone: signal.retestZone ?? null,
            watchZone: signal.watchZone ?? null,
          },
        ];
      } catch {
        return [symbol, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Compose the per-user Live Trade Health report. READ-ONLY and per-user.
 */
export async function buildTradeHealthForUser(
  args: TradeHealthServiceArgs,
): Promise<TradeHealthServiceResult> {
  const { userId, isAdmin, nowMs } = args;
  const chartSymbol = args.chartSymbol?.trim() || null;

  const scope = await getUserModeScope(userId, { isAdmin });
  const includeLive = scope.currentAccountMode === "LIVE_SHARED";
  const includeDemo = scope.currentAccountMode === "DEMO";

  const positions = await readOpenPositions(userId, includeLive, includeDemo, nowMs);

  const [signalsBySymbol, overtrading] = await Promise.all([
    positions.length > 0
      ? readSignalsBySymbol(
          userId,
          positions.map((p) => p.symbol),
        )
      : Promise.resolve<Record<string, OriginalSignalInput | null>>({}),
    readOvertradingInput(userId, includeLive, includeDemo, positions, nowMs),
  ]);

  const report = buildTradeHealthReport({
    positions,
    signalsBySymbol,
    overtrading,
    chartSymbol,
    nowMs,
    evaluatedAtIso: new Date(nowMs).toISOString(),
  });

  return { report, chartSymbol };
}
