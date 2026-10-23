// MT5 candle provider — symbol+timeframe keying, freshness, OHLC validation.
//
// Phase 4 foundation test. Proves the in-memory broker candle store:
//   • keys candles by symbol+timeframe (M5 never served under H1),
//   • returns [] for stale/absent series (router falls through),
//   • reports isConnected only while the feed is fresh,
//   • and that the OHLC validation rule rejects malformed bars.
//
// PURE: exercises the provider directly + replicates the route's isValidOhlc
// rule. No HTTP, no DB, no broker. Run:
//   pnpm --filter @workspace/scripts run test:mt5-candle-provider

import {
  mt5Provider,
  updateCandlesFromMT5,
  updateQuoteFromMT5,
  getMt5SeriesFreshness,
  __resetMt5ProviderStore,
} from "../../artifacts/api-server/src/lib/data/providers/mt5Provider.js";
import type { Candle } from "../../artifacts/api-server/src/lib/data/types.js";

let failures = 0;
function check(name: string, cond: boolean, detail = "") {
  if (cond) { console.log(`PASS  ${name}  ${detail}`); } // eslint-disable-line no-console
  else { failures += 1; console.log(`FAIL  ${name}  ${detail}`); } // eslint-disable-line no-console
}

function bars(closes: number[]): Candle[] {
  return closes.map((c, i) => ({
    time: new Date(Date.UTC(2026, 5, 7, 8, i)).toISOString(),
    open: c, high: c + 0.5, low: c - 0.5, close: c, volume: 100 + i,
  }));
}

// Mirror of the route's isValidOhlc (kept in sync with mt5.ts).
// Must be updated whenever the route's version changes.
function isValidOhlc(b: { open: number; high: number; low: number; close: number }): boolean {
  const { open, high, low, close } = b;
  if (![open, high, low, close].every((n) => Number.isFinite(n))) return false;
  if (open <= 0 || high <= 0 || low <= 0 || close <= 0) return false;
  if (high < low) return false;
  if (high < Math.max(open, close)) return false;
  if (low > Math.min(open, close)) return false;
  return true;
}

async function main() {
  // 1. M5 and H1 stored separately for the same symbol — no contamination.
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars([1.10, 1.11, 1.12]), "M5");
  updateCandlesFromMT5("EURUSD", bars([1.20, 1.21]), "H1");
  const m5 = await mt5Provider.getCandles("EURUSD", "M5", 100);
  const h1 = await mt5Provider.getCandles("EURUSD", "H1", 100);
  check("M5 series isolated", m5.length === 3 && m5[m5.length - 1]!.close === 1.12, `m5=${m5.length}`);
  check("H1 series isolated", h1.length === 2 && h1[h1.length - 1]!.close === 1.21, `h1=${h1.length}`);
  check("M5 bars do NOT appear under H1", h1.every((c) => c.close >= 1.20), JSON.stringify(h1.map((c) => c.close)));

  // 2. Timeframe normalization — "5m" maps to the same series as "M5".
  __resetMt5ProviderStore();
  updateCandlesFromMT5("XAUUSD", bars([2300, 2301]), "M5");
  const viaLower = await mt5Provider.getCandles("XAUUSD", "5m", 100);
  check("timeframe normalized (5m == M5)", viaLower.length === 2, `n=${viaLower.length}`);

  // 3. Absent series returns [] (router falls through, no fabrication).
  __resetMt5ProviderStore();
  const absent = await mt5Provider.getCandles("GBPUSD", "M15", 100);
  check("absent series → []", absent.length === 0);

  // 4. limit is respected (last N).
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars([1, 2, 3, 4, 5]), "M5");
  const limited = await mt5Provider.getCandles("EURUSD", "M5", 2);
  check("limit returns last N", limited.length === 2 && limited[1]!.close === 5, `n=${limited.length}`);

  // 5. Freshness probe reports a fresh series.
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars([1.1]), "M5");
  const fresh = getMt5SeriesFreshness("EURUSD", "M5");
  check("freshness: fresh series detected", fresh.hasSeries && fresh.fresh && fresh.barCount === 1, JSON.stringify(fresh));

  // 6. isConnected true right after a push, false after reset.
  __resetMt5ProviderStore();
  check("isConnected false with no data", (await mt5Provider.isConnected()) === false);
  updateCandlesFromMT5("EURUSD", bars([1.1]), "M5");
  check("isConnected true after fresh push", (await mt5Provider.isConnected()) === true);

  // 7. Quote store works and is symbol-scoped.
  __resetMt5ProviderStore();
  updateQuoteFromMT5("EURUSD", { symbol: "EURUSD", bid: 1.10, ask: 1.101, timestamp: new Date().toISOString() });
  const q = await mt5Provider.getQuote("EURUSD");
  check("quote stored + returned", q.bid === 1.10 && q.ask === 1.101, JSON.stringify(q));
  const qMissing = await mt5Provider.getQuote("NZDUSD");
  check("missing quote → safe empty (no bid/ask)", qMissing.bid === undefined && qMissing.ask === undefined);

  // 8. OHLC validation rule — valid passes, malformed rejected.
  check("valid OHLC passes", isValidOhlc({ open: 1.1, high: 1.2, low: 1.0, close: 1.15 }));
  check("high<low rejected", !isValidOhlc({ open: 1.1, high: 1.0, low: 1.2, close: 1.1 }));
  check("high below body rejected", !isValidOhlc({ open: 1.1, high: 1.1, low: 1.0, close: 1.5 }));
  check("low above body rejected", !isValidOhlc({ open: 1.1, high: 1.6, low: 1.3, close: 1.2 }));
  check("NaN rejected", !isValidOhlc({ open: NaN, high: 1.2, low: 1.0, close: 1.1 }));
  check("Infinity rejected", !isValidOhlc({ open: 1.1, high: Infinity, low: 1.0, close: 1.1 }));
  // Negative and zero prices are impossible for real instruments — must reject.
  check("negative open rejected", !isValidOhlc({ open: -1.1, high: 1.2, low: -1.1, close: 1.1 }));
  check("negative low rejected", !isValidOhlc({ open: 1.1, high: 1.2, low: -0.5, close: 1.1 }));
  check("zero price rejected", !isValidOhlc({ open: 0, high: 0.1, low: 0, close: 0.05 }));
  check("initialised-to-zero bar rejected", !isValidOhlc({ open: 0, high: 0, low: 0, close: 0 }));

  // 9. Re-push replaces the series (EA sends latest window each push).
  __resetMt5ProviderStore();
  updateCandlesFromMT5("EURUSD", bars([1, 2, 3]), "M5");
  updateCandlesFromMT5("EURUSD", bars([9, 9]), "M5");
  const replaced = await mt5Provider.getCandles("EURUSD", "M5", 100);
  check("re-push replaces series", replaced.length === 2 && replaced[0]!.close === 9, `n=${replaced.length}`);

  // 10. getMt5AllSeriesStatus — returns all pushed series with correct status.
  __resetMt5ProviderStore();
  const { getMt5AllSeriesStatus } = await import("../../artifacts/api-server/src/lib/data/providers/mt5Provider.js");
  check("all-series empty before any push", getMt5AllSeriesStatus().length === 0);
  updateCandlesFromMT5("EURUSD", bars([1.1, 1.2]), "M5");
  updateCandlesFromMT5("XAUUSD", bars([2300, 2301, 2302]), "H1");
  const allSeries = getMt5AllSeriesStatus();
  check("all-series length after 2 pushes", allSeries.length === 2, `n=${allSeries.length}`);
  const eurM5 = allSeries.find((s) => s.symbol === "EURUSD" && s.timeframe === "M5");
  const xauH1 = allSeries.find((s) => s.symbol === "XAUUSD" && s.timeframe === "H1");
  check("EURUSD M5 contributing", eurM5?.status === "contributing" && eurM5.barCount === 2, JSON.stringify(eurM5));
  check("XAUUSD H1 contributing", xauH1?.status === "contributing" && xauH1.barCount === 3, JSON.stringify(xauH1));
  check("all-series feedActive", allSeries.some((s) => s.status === "contributing"));

  console.log(`\n${failures === 0 ? "ALL PASS" : failures + " FAILED"}`);
  if (failures > 0) process.exit(1);
}

void main();
