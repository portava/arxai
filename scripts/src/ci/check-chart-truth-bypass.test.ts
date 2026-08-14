// Regression suite for the chart-truth-bypass CI guard.
//
// Exercises `analyzeChartTruthBypass` against synthetic route snippets that
// represent known OHLC-gate bypass shapes (must be flagged) and legitimate
// internal-only / validated flows (must stay clean). Pure source analysis —
// no network, DB, or filesystem writes.

import { analyzeChartTruthBypass } from "./check-chart-truth-bypass.js";

export {};

type Case = { name: string; src: string; shouldFlag: boolean };

const RC_IMPORT = `import { routeCandles } from "../lib/data/marketDataRouter.js";`;
const RC_ALIAS = `import { routeCandles as rc } from "../lib/data/marketDataRouter.js";`;
const GC_IMPORT = `import { getChartCandles } from "../lib/data/chart/chartDataService.js";`;

const cases: Case[] = [
  // ── Must be flagged (bypass) ──────────────────────────────────────────────
  {
    name: "direct .candles in res.json",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.json({ candles: routed.candles });
      });`,
  },
  {
    name: "inline routeCandles().candles in res.json",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        res.json((await routeCandles("EURUSD", "M5", 300)).candles);
      });`,
  },
  {
    name: "chained res.status().json()",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.status(200).json({ candles: routed.candles });
      });`,
  },
  {
    name: "object-var indirection then res.json(out)",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const out = { candles: routed.candles };
        res.json(out);
      });`,
  },
  {
    name: "mapped array via local then shorthand",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const candles = (routed.candles ?? []).map((c) => c);
        res.json({ candles });
      });`,
  },
  {
    name: "object destructuring of result then shorthand",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const { candles } = routed;
        res.json({ candles });
      });`,
  },
  {
    name: "renamed destructuring of result returned directly",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const { candles: rows } = routed;
        res.json(rows);
      });`,
  },
  {
    name: "destructuring directly from routeCandles call",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const { candles } = await routeCandles("EURUSD", "M5", 300);
        res.json({ candles });
      });`,
  },
  {
    name: "import alias evasion (routeCandles as rc)",
    shouldFlag: true,
    src: `${RC_ALIAS}
      r.get("/x", async (req, res) => {
        const routed = await rc("EURUSD", "M5", 300);
        res.json({ candles: routed.candles });
      });`,
  },
  {
    name: "whole result object via res.json(routed)",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.json(routed);
      });`,
  },
  {
    name: "whole result object via chained res.status().json(routed)",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.status(200).json(routed);
      });`,
  },
  {
    name: "whole result object nested in response payload",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.json({ payload: routed });
      });`,
  },
  {
    name: "inline whole result object res.json(await routeCandles(...))",
    shouldFlag: true,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        res.json(await routeCandles("EURUSD", "M5", 300));
      });`,
  },
  {
    name: "mixed file: safe endpoint does not excuse leaking endpoint",
    shouldFlag: true,
    src: `${RC_IMPORT}
      ${GC_IMPORT}
      r.get("/safe", async (req, res) => {
        const out = await getChartCandles("EURUSD", "M5", 300);
        res.json(out);
      });
      r.get("/leak", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        res.json({ candles: routed.candles });
      });`,
  },

  // ── Must stay clean (legitimate) ──────────────────────────────────────────
  {
    name: "validated via getChartCandles",
    shouldFlag: false,
    src: `${GC_IMPORT}
      r.get("/x", async (req, res) => {
        const out = await getChartCandles("EURUSD", "M5", 300);
        res.json(out);
      });`,
  },
  {
    name: "internal-only ATR computation, candles never returned",
    shouldFlag: false,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const candles = (routed.candles ?? []).map((c) => c.close);
        const last = candles[candles.length - 1];
        res.json({ suggestion: last });
      });`,
  },
  {
    name: "admin probe returns candles.length count only",
    shouldFlag: false,
    src: `${RC_IMPORT}
      r.get("/x", async (req, res) => {
        const probe = await routeCandles("EURUSD", "M5", 5);
        res.json({ candleCount: probe.candles.length, ok: probe.ok });
      });`,
  },
  {
    name: "candles passed through runCandleTruth before returning",
    shouldFlag: false,
    src: `${RC_IMPORT}
      import { runCandleTruth } from "../lib/data/chart/candleTruthEngine.js";
      r.get("/x", async (req, res) => {
        const routed = await routeCandles("EURUSD", "M5", 300);
        const truth = runCandleTruth(routed.candles, "EURUSD", "M5");
        res.json({ candles: truth.normalizedCandles });
      });`,
  },
];

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
function record(name: string, ok: boolean, detail?: string) {
  results.push({ name, ok, detail });
  const label = ok ? "PASS" : "FAIL";
  // eslint-disable-next-line no-console
  console.log(`  ${label}  ${name}${detail ? ` — ${detail}` : ""}`);
}

console.log("\nchart-truth-bypass guard — regression suite");
for (const c of cases) {
  const flags = analyzeChartTruthBypass(c.src);
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
console.log(`\n${results.length - failed}/${results.length} chart-truth-bypass cases passed`);
process.exit(failed === 0 ? 0 : 1);
