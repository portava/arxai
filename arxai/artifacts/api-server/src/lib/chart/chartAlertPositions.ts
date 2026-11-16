// Open positions for the chart AI-alert scan (POST /me/chart/ai-alerts/scan).
//
// The position near-stop / near-target alerts must see every position the
// trader can hold on the chart's symbol: paper trades AND their MT5 DEMO / LIVE
// positions. MT5 rows come from the canonical open-position read model
// (readOpenPositions) with the same mode scope the unified positions feed
// (/me/positions/all) uses — LIVE only in LIVE_SHARED, DEMO only in DEMO — and
// the alert-eligible predicates (LIVE EXPOSURE; DEMO broker-confirmed OPEN with
// a ticket and no closed_at).
//
// Symbols are compared through the canonical normalizer, so a broker-suffixed
// MT5 symbol ("EURUSDm", "XAUUSD.r") matches the chart's canonical symbol.
//
// Read-only. Never places, modifies or closes a trade. Every source fails open
// to "no positions from that source".

import { normalizeSymbol } from "../instruments/index.js";
import type { ChartAlertOpenPosition } from "./aiAlerts.js";

/** The MT5 bridge reports a full snapshot every ~5s; same window as the unified feed. */
export const CHART_ALERT_QUOTE_FRESH_MS = 30_000;

export interface PaperPositionLike {
  id: number | string;
  symbol: unknown;
  side: unknown;
  entryPrice: unknown;
  stopLoss: unknown;
  takeProfit: unknown;
}

export interface Mt5PositionLike {
  venue: "LIVE" | "DEMO";
  id: number;
  ticket: string | null;
  symbol: string;
  side: string;
  entryPrice: unknown;
  stopLoss: unknown;
  takeProfit: unknown;
  currentPrice: unknown;
  observedAt: Date | null;
  closedAt?: Date | null;
}

function num(v: unknown): number | null {
  if (v == null) return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

function sideOf(v: unknown): "BUY" | "SELL" {
  return String(v).toUpperCase() === "SELL" ? "SELL" : "BUY";
}

/** True when two symbols name the same instrument (broker suffixes ignored). */
export function sameChartSymbol(a: unknown, b: unknown): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const na = normalizeSymbol(a);
  const nb = normalizeSymbol(b);
  return na !== "" && na === nb;
}

/** Map paper + MT5 rows on the chart symbol into the alert engine's shape. */
export function toChartAlertPositions(
  chartSymbol: string,
  paper: readonly PaperPositionLike[],
  mt5: readonly Mt5PositionLike[],
  nowMs: number = Date.now(),
): ChartAlertOpenPosition[] {
  const out: ChartAlertOpenPosition[] = [];
  for (const p of paper) {
    if (!sameChartSymbol(p.symbol, chartSymbol)) continue;
    const entry = num(p.entryPrice);
    if (entry == null) continue;
    // Paper ids keep their historic alert key (no venue prefix) so existing
    // deduped alerts still match.
    out.push({ id: p.id, side: sideOf(p.side), entry, sl: num(p.stopLoss), tp: num(p.takeProfit) });
  }
  for (const p of mt5) {
    if (!sameChartSymbol(p.symbol, chartSymbol)) continue;
    if (p.closedAt) continue;
    if (p.ticket == null || p.ticket === "") continue;
    const entry = num(p.entryPrice);
    if (entry == null) continue;
    const observedMs = p.observedAt ? new Date(p.observedAt).getTime() : NaN;
    const fresh = Number.isFinite(observedMs) && nowMs - observedMs <= CHART_ALERT_QUOTE_FRESH_MS;
    const quote = num(p.currentPrice);
    out.push({
      // Row ids are not comparable across venues; the ticket + venue is unique.
      id: `${p.venue.toLowerCase()}-${p.ticket}`,
      side: sideOf(p.side),
      entry,
      sl: num(p.stopLoss),
      tp: num(p.takeProfit),
      freshQuote: fresh && quote != null ? quote : null,
    });
  }
  return out;
}

export interface GatherChartAlertPositionsDeps {
  readPaper: (userId: number) => Promise<readonly PaperPositionLike[]>;
  readMt5: (userId: number) => Promise<readonly Mt5PositionLike[]>;
  nowMs?: () => number;
}

/** Read paper + MT5 positions (each failing open) and keep those on the chart symbol. */
export async function gatherChartAlertPositions(
  userId: number,
  chartSymbol: string,
  deps: GatherChartAlertPositionsDeps,
): Promise<ChartAlertOpenPosition[]> {
  const [paper, mt5] = await Promise.all([
    deps.readPaper(userId).catch(() => [] as PaperPositionLike[]),
    deps.readMt5(userId).catch(() => [] as Mt5PositionLike[]),
  ]);
  return toChartAlertPositions(chartSymbol, paper, mt5, deps.nowMs ? deps.nowMs() : Date.now());
}
