import type { Trade } from "../trade/trade.types";
import type { Session } from "../market/session.engine";
import { currentSession } from "../market/session.engine";
import type { SessionPerformance } from "./traderProfile.types";

export interface SessionPerformanceReport {
  bySession: SessionPerformance[];
  preferred: Session[];                 // sessions where this trader is profitable + statistically meaningful
  avoided: Session[];                   // sessions to discourage
  totalTrades: number;
}

const MIN_TRADES_FOR_VERDICT = 5;
const PREFERRED_WIN_RATE = 0.55;
const PREFERRED_PROFIT_FACTOR = 1.3;
const AVOIDED_WIN_RATE = 0.40;
const AVOIDED_PROFIT_FACTOR = 0.9;

export function analyzeSessionPerformance(trades: Trade[]): SessionPerformanceReport {
  const closed = trades.filter(isClosed);
  const groups = new Map<Session, Trade[]>();
  for (const t of closed) {
    const s = currentSession(new Date(t.openedAt));
    if (!groups.has(s)) groups.set(s, []);
    groups.get(s)!.push(t);
  }

  const bySession: SessionPerformance[] = [];
  for (const [session, ts] of groups) {
    bySession.push(buildPerf(session, ts));
  }
  bySession.sort((a, b) => b.netPnL - a.netPnL);

  const preferred: Session[] = [];
  const avoided: Session[] = [];
  for (const p of bySession) {
    if (p.tradeCount < MIN_TRADES_FOR_VERDICT) continue;
    if (p.winRate >= PREFERRED_WIN_RATE && p.profitFactor >= PREFERRED_PROFIT_FACTOR) {
      preferred.push(p.session);
    } else if (p.winRate <= AVOIDED_WIN_RATE || p.profitFactor <= AVOIDED_PROFIT_FACTOR) {
      avoided.push(p.session);
    }
  }

  return { bySession, preferred, avoided, totalTrades: closed.length };
}

function buildPerf(session: Session, trades: Trade[]): SessionPerformance {
  const wins = trades.filter((t) => (t.pnl ?? 0) > 0);
  const losses = trades.filter((t) => (t.pnl ?? 0) < 0);
  const grossWin = wins.reduce((s, t) => s + (t.pnl ?? 0), 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + (t.pnl ?? 0), 0));
  const netPnL = grossWin - grossLoss;
  const avgRMultiple = trades.length
    ? trades.reduce((s, t) => s + (t.rMultiple ?? 0), 0) / trades.length
    : 0;
  return {
    session,
    tradeCount: trades.length,
    winRate: trades.length ? wins.length / trades.length : 0,
    avgRMultiple,
    netPnL,
    profitFactor: grossLoss > 0 ? grossWin / grossLoss : (grossWin > 0 ? Infinity : 0),
  };
}

function isClosed(t: Trade): boolean {
  return t.status === "CLOSED_WIN" || t.status === "CLOSED_LOSS" || t.status === "CLOSED_BREAKEVEN";
}
