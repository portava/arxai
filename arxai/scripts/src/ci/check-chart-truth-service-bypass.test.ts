// Regression suite for the chart-truth-service-bypass CI guard.
//
// Exercises `analyzeChartTruthServiceBypass` against synthetic SERVICE-helper
// snippets: known leak shapes (a shared helper RETURNING raw candles, which a
// caller could forward unvalidated) must be flagged, while legitimate
// internal-only / transforming flows (ATR/volatility/diagnostics that
// map candles into other shapes, or return a count) must stay clean. Pure
// source analysis — no network, DB, or filesystem writes.

import { analyzeChartTruthServiceBypass } from "./check-chart-truth-service-bypass.js";

export {};

type Case = { name: string; src: string; shouldFlag: boolean };

const RC_IMPORT = `import { routeCandles } from "./marketDataRouter.js";`;
const RC_ALIAS = `import { routeCandles as rc } from "./marketDataRouter.js";`;
const GC_IMPORT = `import { getChartCandles } from "./chart/chartDataService.js";`;
const TRUTH_IMPORT = `import { runCandleTruth } from "./chart/candleTruthEngine.js";`;

const cases: Case[] = [
  // ── Must be flagged (leak: raw candles returned from a helper) ────────────
  {
    name: "helper returns raw routed.candles",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles;
      }`,
  },
  {
    name: "helper returns raw inline routeCandles().candles",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol) {
        return (await routeCandles(symbol, "1m", 250)).candles;
      }`,
  },
  {
    name: "concise arrow body returns raw candles",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export const getMarketData = async (symbol) =>
        (await routeCandles(symbol, "1m", 250)).candles;`,
  },
  {
    name: "helper returns whole raw result object",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getRouted(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r;
      }`,
  },
  {
    name: "helper returns destructured candles var",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        const { candles } = r;
        return candles;
      }`,
  },
  {
    name: "helper returns renamed destructured candles",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol) {
        const { candles: rows } = await routeCandles(symbol, "1m", 250);
        return rows;
      }`,
  },
  {
    name: "identity chain (.slice) is still raw",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getRecent(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles.slice(-50);
      }`,
  },
  {
    name: "identity chain (.filter) is still raw",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getValid(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles.filter((c) => c.close > 0);
      }`,
  },
  {
    name: "raw candles via candles: object field",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function buildSeries(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return { symbol, candles: r.candles };
      }`,
  },
  {
    name: "object-var indirection then returned",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function buildSeries(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        const out = { candles: r.candles };
        return out;
      }`,
  },
  {
    name: "?? [] fallback returned raw",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles ?? [];
      }`,
  },
  {
    name: "ternary returns raw on one branch",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getMarketData(symbol, ok) {
        const r = await routeCandles(symbol, "1m", 250);
        return ok ? r.candles : [];
      }`,
  },
  {
    name: "import alias evasion (routeCandles as rc)",
    shouldFlag: true,
    src: `${RC_ALIAS}
      export async function getMarketData(symbol) {
        const r = await rc(symbol, "1m", 250);
        return r.candles;
      }`,
  },
  {
    name: "mixed file: transforming helper does not excuse leaking helper",
    shouldFlag: true,
    src: `${RC_IMPORT}
      export async function getAtr(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles.map((c) => c.high - c.low);
      }
      export async function getMarketData(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles;
      }`,
  },

  // ── Must stay clean (legitimate internal consumers) ───────────────────────
  {
    name: "validated via getChartCandles",
    shouldFlag: false,
    src: `${GC_IMPORT}
      export async function getCandles(symbol) {
        const feed = await getChartCandles(symbol, "M5", 300);
        return feed.candles;
      }`,
  },
  {
    name: "passed through runCandleTruth before returning",
    shouldFlag: false,
    src: `${RC_IMPORT}
      ${TRUTH_IMPORT}
      export async function validated(symbol) {
        const r = await routeCandles(symbol, "M5", 300);
        const truth = runCandleTruth(r.candles, { symbol, timeframe: "M5" });
        return truth.verifiedCandles;
      }`,
  },
  {
    name: "OHLC-filter then map into fresh objects",
    shouldFlag: false,
    src: `${RC_IMPORT}
      import { isValidOhlc } from "./chart/candleNormalization.js";
      export async function getMarketData(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles
          .filter((c) => isValidOhlc(c))
          .map((c) => ({ time: c.time, open: c.open, high: c.high, low: c.low, close: c.close }));
      }`,
  },
  {
    name: "ATR computation maps candles into numbers",
    shouldFlag: false,
    src: `${RC_IMPORT}
      export async function getAtr(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        const ranges = (r.candles ?? []).map((c) => c.high - c.low);
        return ranges[ranges.length - 1];
      }`,
  },
  {
    name: "transforms via toSignalCandles helper (func-call result, not raw)",
    shouldFlag: false,
    src: `${RC_IMPORT}
      import { toSignalCandles } from "./signals.js";
      export async function fetchSeries(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return { candles: toSignalCandles(r.candles) };
      }`,
  },
  {
    name: "candles consumed as a function argument only",
    shouldFlag: false,
    src: `${RC_IMPORT}
      import { computeAtr } from "./indicators.js";
      export async function analyze(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        const atr = computeAtr(r.candles, 14);
        return { atr };
      }`,
  },
  {
    name: "diagnostic returns candles.length count only",
    shouldFlag: false,
    src: `${RC_IMPORT}
      export async function probe(symbol) {
        const r = await routeCandles(symbol, "M5", 5);
        return { candleCount: r.candles.length, ok: r.ok };
      }`,
  },
  {
    name: "single-element access is not a raw array",
    shouldFlag: false,
    src: `${RC_IMPORT}
      export async function latest(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        return r.candles[0];
      }`,
  },
  {
    name: "builds a new mapped array variable and returns it",
    shouldFlag: false,
    src: `${RC_IMPORT}
      export async function mapped(symbol) {
        const r = await routeCandles(symbol, "1m", 250);
        const mappedRows = r.candles.map((c) => ({ t: c.time, c: c.close }));
        return mappedRows;
      }`,
  },
];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nchart-truth-service-bypass guard — regression suite");
for (const c of cases) {
  const flags = analyzeChartTruthServiceBypass(c.src);
  const flagged = flags.length > 0;
  const ok = flagged === c.shouldFlag;
  record(
    c.name,
    ok,
    ok
      ? c.shouldFlag
        ? `flagged (${flags.length})`
        : "clean"
      : c.shouldFlag
        ? "expected a violation but got none"
        : `expected clean but got: ${flags[0]}`,
  );
}

const failed = results.filter((r) => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} chart-truth-service-bypass cases passed`);
process.exit(failed === 0 ? 0 : 1);
