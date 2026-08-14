import type { Trade } from "../trade/trade.types";

export interface ExposureBucket {
  key: string;            // e.g. "USD" base or "EUR" quote
  netLots: number;        // net signed lot size (BUY positive)
  trades: number;
}

export interface ExposureReport {
  totalOpenTrades: number;
  totalLots: number;
  // Lot-based proxy for currency exposure — base counts +lots, quote counts
  // -lots. This is intentionally a heuristic for cross-currency concentration
  // checks, not a precise notional-USD calculation (which would require live
  // mid prices and contract-size lookups per symbol).
  byCurrency: ExposureBucket[];
  bySymbol: ExposureBucket[];
  warnings: string[];
}

// Decompose FX symbol into base + quote. Tolerates broker suffixes used by
// MT5 feeds such as "EURUSD.m", "GBPUSD_i", "USDJPY-cent", "AUDUSDpro".
// Non-FX symbols (indices, stocks) return null and bucket under their
// full symbol name only.
function splitFx(symbol: string): [string, string] | null {
  const m = /^([A-Z]{3})([A-Z]{3})(?:[._\-].*)?$/.exec(symbol);
  if (!m) return null;
  return [m[1], m[2]];
}

export function computeExposure(openTrades: Trade[], opts: { maxLotsPerSymbol?: number; maxLotsPerCurrency?: number } = {}): ExposureReport {
  const warnings: string[] = [];
  const byCcy = new Map<string, ExposureBucket>();
  const bySym = new Map<string, ExposureBucket>();
  let totalLots = 0;

  for (const t of openTrades) {
    const sign = t.direction === "BUY" ? 1 : -1;
    totalLots += t.lotSize;

    const symBucket = bySym.get(t.symbol) ?? { key: t.symbol, netLots: 0, trades: 0 };
    symBucket.netLots += sign * t.lotSize;
    symBucket.trades += 1;
    bySym.set(t.symbol, symBucket);

    const fx = splitFx(t.symbol);
    if (fx) {
      const [base, quote] = fx;
      const baseBucket = byCcy.get(base) ?? { key: base, netLots: 0, trades: 0 };
      baseBucket.netLots += sign * t.lotSize; baseBucket.trades += 1; byCcy.set(base, baseBucket);
      const quoteBucket = byCcy.get(quote) ?? { key: quote, netLots: 0, trades: 0 };
      quoteBucket.netLots += -sign * t.lotSize; quoteBucket.trades += 1; byCcy.set(quote, quoteBucket);
    }
  }

  if (opts.maxLotsPerSymbol != null) {
    for (const b of bySym.values()) {
      if (Math.abs(b.netLots) > opts.maxLotsPerSymbol) {
        warnings.push(`${b.key} net exposure ${b.netLots.toFixed(2)} exceeds cap ${opts.maxLotsPerSymbol}`);
      }
    }
  }
  if (opts.maxLotsPerCurrency != null) {
    for (const b of byCcy.values()) {
      if (Math.abs(b.netLots) > opts.maxLotsPerCurrency) {
        warnings.push(`${b.key} currency exposure ${b.netLots.toFixed(2)} exceeds cap ${opts.maxLotsPerCurrency}`);
      }
    }
  }

  return {
    totalOpenTrades: openTrades.length,
    totalLots,
    byCurrency: [...byCcy.values()].sort((a, b) => Math.abs(b.netLots) - Math.abs(a.netLots)),
    bySymbol:   [...bySym.values()].sort((a, b) => Math.abs(b.netLots) - Math.abs(a.netLots)),
    warnings,
  };
}
