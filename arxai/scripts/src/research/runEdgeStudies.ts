// Runs the two edge studies (edgeStudies.ts) on stored MT5 history in the
// compact broker candle store and prints/writes the results.
//
//   DATABASE_URL=<disposable local copy> pnpm --filter @workspace/scripts exec \
//     tsx src/research/runEdgeStudies.ts [--part scanner|trend|both] [--timeframes M15,H1,H4,D1]
//     [--max-bars 20000] [--out results.json]
//
// Read-only. Never writes the database, never places, sizes or promotes
// anything. Costs are ASSUMED, stated in the output, and never zero unless
// the row says "gross".
//
// Pre-registered (fixed before looking at results, never tuned):
//   scanner: every non-overlapping scanner call, 60-bar first-touch horizon,
//            half-spread = MT5_BROKER_RUNNER_PARAMS per asset class.
//   trend:   D1 lookbacks 21/63/126/252 bars, H4 the same in days (x6);
//            vol window 63 days; 10% vol target; leverage cap 3; one bar of
//            delay; turnover cost = DEFAULT_RUNNER_PARAMS per class; 2%/yr
//            financing on |position|. 10 tests (2 timeframes x 4 lookbacks +
//            their equal blend), Bonferroni-corrected.
// Deriv synthetics (random by design) are the scanner study's NEGATIVE
// CONTROL and are excluded from the trend portfolio.

import { writeFileSync } from "node:fs";
import { isRandomByDesignSymbol } from "@workspace/domain/market";
import type { Candle } from "../../../artifacts/api-server/src/lib/strategyEngine.js";
import { DEFAULT_RUNNER_PARAMS, MT5_BROKER_RUNNER_PARAMS, type AssetClass } from "./realDataValidation.js";
import { inferAssetClass } from "./runRealDataValidation.js";
import {
  bonferroniZ, equalWeight, expectancyRow, meanStats, performance, scannerCalls, tsmomReturns,
  type ExpectancyRow, type ScannerCall, type TsmomParams,
} from "./edgeStudies.js";

const args = process.argv.slice(2);
const val = (k: string) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : undefined; };

/** One read-only session; every query runs on it. */
interface Q { query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }> }

const GOOD = "b.is_closed_bar AND a.quality_status IN ('accepted','finalized','idempotent')";

function classOf(symbol: string): AssetClass {
  return isRandomByDesignSymbol(symbol) ? "synthetic" : inferAssetClass(symbol);
}

async function symbols(pool: Q, tf: string): Promise<string[]> {
  const r = await pool.query<{ symbol: string }>("SELECT DISTINCT symbol FROM broker_candle_series WHERE timeframe = $1 ORDER BY 1", [tf]);
  return r.rows.map((x) => x.symbol);
}

/** Closed, accepted bars of one symbol/timeframe, newest `max`, oldest first.
 *  Legacy account-era series of the same market are merged on open time. */
async function load(pool: Q, symbol: string, tf: string, max: number): Promise<{ candles: Candle[]; dropped: number }> {
  const r = await pool.query<{ t: Date; open: number; high: number; low: number; close: number }>(
    `SELECT * FROM (
       SELECT DISTINCT ON (b.open_time_utc) b.open_time_utc AS t, b.open, b.high, b.low, b.close
       FROM broker_candle_bars b JOIN broker_candle_series s ON s.id = b.series_id JOIN broker_candle_attrs a ON a.id = b.attrs_id
       WHERE s.symbol = $1 AND s.timeframe = $2 AND ${GOOD}
       ORDER BY b.open_time_utc DESC, s.id DESC LIMIT $3) x ORDER BY t`, [symbol, tf, max]);
  const candles: Candle[] = [];
  let dropped = 0;
  for (const b of r.rows) {
    const ok = [b.open, b.high, b.low, b.close].every((x) => x > 0) && b.high >= Math.max(b.open, b.close) && b.low <= Math.min(b.open, b.close);
    if (!ok) { dropped++; continue; }
    candles.push({ time: b.t.toISOString(), open: b.open, high: b.high, low: b.low, close: b.close, volume: 0 });
  }
  return { candles, dropped };
}

// ── Scanner expectancy ──────────────────────────────────────────────────────

async function scannerStudy(pool: Q, tfs: string[], maxBars: number) {
  const cells = new Map<string, ScannerCall[]>();
  const perSymbol: { symbol: string; tf: string; cls: AssetClass; bars: number; calls: number; meanNetR: number }[] = [];
  for (const tf of tfs) {
    for (const symbol of await symbols(pool, tf)) {
      const cls = classOf(symbol);
      const { candles } = await load(pool, symbol, tf, maxBars);
      if (candles.length < 500) continue;
      const half = MT5_BROKER_RUNNER_PARAMS.costPerTurnover[cls];
      if (half == null) throw new Error(`no assumed cost for ${symbol} (${cls})`);
      const calls = scannerCalls(candles, symbol, tf, half);
      const key = `${cls}/${tf}`;
      cells.set(key, [...(cells.get(key) ?? []), ...calls]);
      perSymbol.push({ symbol, tf, cls, bars: candles.length, calls: calls.length, meanNetR: meanStats(calls.map((c) => c.rNet)).mean });
      process.stderr.write(`scanner ${symbol}@${tf}: ${candles.length} bars, ${calls.length} calls\n`);
    }
  }
  const realCells = [...cells.keys()].filter((k) => !k.startsWith("synthetic/"));
  const z = bonferroniZ(realCells.length);
  const rows: ExpectancyRow[] = [...cells.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([k, calls]) => expectancyRow(k, calls, z));
  return { tests: realCells.length, z, rows, perSymbol };
}

// ── Trend following ─────────────────────────────────────────────────────────

const FINANCING_ANNUAL = 0.02;
const TREND_TFS = [
  { tf: "D1", barsPerDay: 1, minBars: 1000 },
  { tf: "H4", barsPerDay: 6, minBars: 6000 },
] as const;
const LOOKBACK_DAYS = [21, 63, 126, 252] as const;

/** Bars per year observed in a dated series (handles weekends, crypto, gaps). */
function observedBarsPerYear(times: readonly string[]): number {
  if (times.length < 2) return 252;
  const years = (Date.parse(times.at(-1)!) - Date.parse(times[0]!)) / (365.25 * 86_400_000);
  return years > 0 ? times.length / years : 252;
}

function summarize(series: { time: string; ret: number }[]) {
  const bpy = observedBarsPerYear(series.map((x) => x.time));
  const all = performance(series.map((x) => x.ret), bpy);
  const mid = Math.floor(series.length / 2);
  const firstHalf = performance(series.slice(0, mid).map((x) => x.ret), bpy);
  const secondHalf = performance(series.slice(mid).map((x) => x.ret), bpy);
  const decades: Record<string, number> = {};
  const by = new Map<string, number[]>();
  for (const x of series) { const d = `${x.time.slice(0, 3)}0s`; by.set(d, [...(by.get(d) ?? []), x.ret]); }
  for (const [d, rs] of by) if (rs.length > bpy) decades[d] = Number(performance(rs, bpy).sharpe.toFixed(2));
  return { from: series[0]?.time.slice(0, 10), to: series.at(-1)?.time.slice(0, 10), barsPerYear: Math.round(bpy), all, firstHalf, secondHalf, decadeSharpe: decades };
}

async function trendStudy(pool: Q) {
  const z = bonferroniZ(TREND_TFS.length * (LOOKBACK_DAYS.length + 1));
  const results: Record<string, unknown>[] = [];
  const universe: Record<string, string[]> = {};
  for (const { tf, barsPerDay, minBars } of TREND_TFS) {
    const perLookback = new Map<number, { time: string; ret: number }[][]>();
    const perLookbackGross = new Map<number, { time: string; ret: number }[][]>();
    const blend: { time: string; ret: number }[][] = [];
    const blendGross: { time: string; ret: number }[][] = [];
    universe[tf] = [];
    for (const symbol of await symbols(pool, tf)) {
      const cls = classOf(symbol);
      if (cls === "synthetic") continue;
      const { candles } = await load(pool, symbol, tf, 1_000_000);
      if (candles.length < minBars) continue;
      universe[tf]!.push(`${symbol}(${candles[0]!.time.slice(0, 4)})`);
      const cost = DEFAULT_RUNNER_PARAMS.costPerTurnover[cls];
      if (cost == null) throw new Error(`no assumed cost for ${symbol} (${cls})`);
      const bpy = observedBarsPerYear(candles.map((c) => c.time));
      const base: Omit<TsmomParams, "lookback"> = { volLookback: 63 * barsPerDay, barsPerYear: bpy, targetVolAnnual: 0.1, maxLeverage: 3, costPerTurnover: cost, financingAnnual: FINANCING_ANNUAL };
      const symNet: Map<string, number>[] = [];
      const symGross: Map<string, number>[] = [];
      for (const days of LOOKBACK_DAYS) {
        const net = tsmomReturns(candles, { ...base, lookback: days * barsPerDay });
        const gross = tsmomReturns(candles, { ...base, lookback: days * barsPerDay, costPerTurnover: 0, financingAnnual: 0 });
        perLookback.set(days, [...(perLookback.get(days) ?? []), net]);
        perLookbackGross.set(days, [...(perLookbackGross.get(days) ?? []), gross]);
        symNet.push(new Map(net.map((x) => [x.time, x.ret])));
        symGross.push(new Map(gross.map((x) => [x.time, x.ret])));
      }
      // Blend: equal weight of the four lookbacks, on dates all four trade.
      const longest = symNet.at(-1)!;
      const mk = (ms: Map<string, number>[]) => [...longest.keys()].map((t) => ({ time: t, ret: ms.reduce((a, m) => a + (m.get(t) ?? 0), 0) / ms.length }));
      blend.push(mk(symNet)); blendGross.push(mk(symGross));
      process.stderr.write(`trend ${symbol}@${tf}: ${candles.length} bars from ${candles[0]!.time.slice(0, 10)}\n`);
    }
    const tests: [string, { time: string; ret: number }[][], { time: string; ret: number }[][]][] = [
      ...LOOKBACK_DAYS.map((d) => [`${tf} ${d}d`, perLookback.get(d) ?? [], perLookbackGross.get(d) ?? []] as [string, typeof blend, typeof blend]),
      [`${tf} blend`, blend, blendGross],
    ];
    for (const [name, net, gross] of tests) {
      const s = summarize(equalWeight(net));
      const g = summarize(equalWeight(gross));
      results.push({
        test: name, symbols: net.length, ...s, grossSharpe: g.all.sharpe,
        edge: s.all.t > z && s.secondHalf.sharpe > 0,
      });
    }
  }
  return { tests: results.length, z, financingAnnual: FINANCING_ANNUAL, costs: DEFAULT_RUNNER_PARAMS.costPerTurnover, universe, results };
}

const f = (x: number, d = 3) => (Number.isFinite(x) ? x.toFixed(d) : "—");

async function main() {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL (a disposable local copy) is required");
  const { pool: dbPool } = await import("@workspace/db");
  const client = await dbPool.connect();
  await client.query("SET default_transaction_read_only = on");
  const pool = client as unknown as Q;
  const part = val("--part") ?? "both";
  const out: Record<string, unknown> = { generatedAt: new Date().toISOString(), costsAreAssumed: true };
  try {
    if (part === "scanner" || part === "both") {
      const s = await scannerStudy(pool, (val("--timeframes") ?? "M15,H1,H4,D1").split(","), Number(val("--max-bars") ?? 20000));
      out.scanner = s;
      console.log(`\nSCANNER EXPECTANCY AFTER COSTS (R per call; ${s.tests} real-market cells, Bonferroni z=${f(s.z, 2)}; synthetic = negative control)`);
      console.log("cell                 n     hit    avgRR  costR  grossR   netR    netLo     net2ndHalf  edge");
      for (const r of s.rows) console.log(`${r.cell.padEnd(18)} ${String(r.n).padStart(6)}  ${f(r.hitRate)}  ${f(r.avgRewardR, 2).padStart(5)}  ${f(r.avgCostR).padStart(5)}  ${f(r.gross.mean).padStart(6)}  ${f(r.net.mean).padStart(6)}  ${f(r.net.mean - s.z * r.net.se).padStart(7)}  ${f(r.netSecondHalf.mean).padStart(9)}   ${r.edge ? "YES" : "no"}`);
    }
    if (part === "trend" || part === "both") {
      const t = await trendStudy(pool);
      out.trend = t;
      console.log(`\nTIME-SERIES MOMENTUM, vol-targeted, net of assumed costs + ${t.financingAnnual * 100}%/yr financing (${t.tests} tests, Bonferroni z=${f(t.z, 2)})`);
      for (const [tf, u] of Object.entries(t.universe)) console.log(`${tf} universe (${u.length}): ${u.join(" ")}`);
      console.log("test        syms  from        Sharpe  t      grossSh  1stHalf 2ndHalf  edge   decades");
      for (const r of t.results as any[]) console.log(`${String(r.test).padEnd(11)} ${String(r.symbols).padStart(4)}  ${r.from}  ${f(r.all.sharpe, 2).padStart(5)}  ${f(r.all.t, 2).padStart(5)}  ${f(r.grossSharpe, 2).padStart(6)}   ${f(r.firstHalf.sharpe, 2).padStart(5)}  ${f(r.secondHalf.sharpe, 2).padStart(5)}   ${r.edge ? "YES" : "no "}   ${JSON.stringify(r.decadeSharpe)}`);
    }
  } finally { client.release(); await dbPool.end(); }
  const file = val("--out");
  if (file) writeFileSync(file, `${JSON.stringify(out, null, 1)}\n`);
  process.exit(0);
}

main().catch((e) => { console.error(e instanceof Error ? e.stack : e); process.exit(1); });
