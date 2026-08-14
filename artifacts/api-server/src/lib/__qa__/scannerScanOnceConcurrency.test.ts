// End-to-end regression lock — the live scanner holds its single server-load
// cap across the REAL `scanOnce` call graph (Task: prove the scanner holds its
// server-load cap end-to-end).
// Run via:
//   node --import tsx --experimental-test-module-mocks --test \
//     src/lib/__qa__/scannerScanOnceConcurrency.test.ts
//   (wired as `pnpm --filter @workspace/api-server run test:scanner-scanonce-concurrency`)
//
// WHY THIS EXISTS (vs. scannerEnrichmentConcurrency.test.ts):
//   The sibling enrichment test reproduces the loop×sub-lookup nesting against
//   the real shared budget, but with FAKE leaf lookups — it never drives the
//   actual `scanOnce` → `scanSymbolTimeframe` → `analyzeViaRouter` code path. A
//   regression that added a NEW un-budgeted `routeCandles`/`routeQuote` call (or
//   dropped the `runWithScannerBudget` wrapper around the existing ones) would
//   slip past it: the structure would still *look* bounded in the source scan.
//
//   This test closes that gap behaviourally. It mocks the Market Data Router
//   seam (`routeCandles` / `routeQuote`) with instrumented stubs that record the
//   PEAK number of simultaneously in-flight router calls, then runs the genuine
//   `scanOnce` over a multi-symbol × multi-timeframe universe and asserts the
//   peak never exceeds `ENRICHMENT_CONCURRENCY` — the single shared cap.
//
//   The guarantee it locks: the scanner's nested fan-outs (the outer per-symbol
//   loop, itself capped at ENRICHMENT_CONCURRENCY, × each symbol's concurrent
//   candle+quote sub-lookups) all draw from ONE budget. If the candle+quote
//   lookups stopped acquiring the shared budget, the outer cap (8) would
//   multiply against the 2 concurrent sub-lookups and the peak would jump toward
//   ~16 — and this test would FAIL. It therefore catches a real, behavioural
//   regression against the actual call graph, not just the source shape.
//
// Requires Node's experimental module-mock flag (wired into the npm script).

import { test, mock } from "node:test";
import assert from "node:assert/strict";

// ── Instrument the router seam BEFORE importing the scanner ──────────────────
//
// Capture the REAL router module first so EVERY export other than the two
// instrumented leaf lookups stays genuine (classifySymbol, resolveDerivSymbol,
// and anything the scanner's transitive deps import from the router). We only
// swap `routeCandles` / `routeQuote` for concurrency-counting stubs.

const realRouter = await import("../data/marketDataRouter.js");

// Shared in-flight counters across BOTH leaf lookups — exactly how a real wide
// scan's total outbound router/DB load is what must stay capped, not each call
// site independently.
let inFlight = 0;
let peak = 0;
let candleCalls = 0;
let quoteCalls = 0;

// A leaf lookup that genuinely overlaps in time: it yields across several
// microtasks so concurrent callers actually coexist. An un-budgeted fan-out
// would let more than the cap enter this window at once, driving `peak` up.
async function leafBody(): Promise<void> {
  inFlight++;
  if (inFlight > peak) peak = inFlight;
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  inFlight--;
}

function fakeCandles(n: number) {
  const now = Date.now();
  const out = [];
  for (let i = n - 1; i >= 0; i--) {
    const base = 1.1 + (n - i) * 0.0001;
    out.push({
      time: new Date(now - i * 60_000).toISOString(),
      open: base,
      high: base + 0.0005,
      low: base - 0.0005,
      close: base + 0.0002,
      volume: 100,
    });
  }
  return out;
}

mock.module("../data/marketDataRouter.js", {
  namedExports: {
    ...realRouter,
    // Instrumented candle leaf — returns a valid, non-empty LIVE_FEED result so
    // `analyzeViaRouter` proceeds (never falls back to the simulator) and every
    // scanned pair actually drives both leaf lookups.
    routeCandles: async (symbol: string, _timeframe: string, limit: number) => {
      candleCalls++;
      await leafBody();
      return {
        ok: true,
        symbol,
        assetClass: "forex" as const,
        candles: fakeCandles(Math.max(1, Math.min(limit, 30))),
        primaryProvider: "mt5_broker",
        attempts: [],
        userMessage: "",
        adminDetail: "",
      };
    },
    routeQuote: async (symbol: string) => {
      quoteCalls++;
      await leafBody();
      return {
        ok: true,
        symbol,
        assetClass: "forex" as const,
        quote: {
          symbol,
          bid: 1.1,
          ask: 1.1002,
          last: 1.1001,
          spread: 0.0002,
          timestamp: new Date().toISOString(),
        },
        primaryProvider: "mt5_broker",
        attempts: [],
        userMessage: "",
        adminDetail: "",
      };
    },
  },
});

// Neutralize the per-symbol advisory read so this test is deterministic and
// side-effect-free: returning null skips the governance + durable-trace branch
// inside `scanSymbolTimeframe` (no real DB writes during the scan). The advisory
// /governance path's OWN budget discipline is locked by the source-scan tests in
// scannerEnrichmentConcurrency.test.ts; here we isolate the router data seam.
const realAdvisory = await import("../agentEcosystem/advisoryInfluence.js");
mock.module("../agentEcosystem/advisoryInfluence.js", {
  namedExports: {
    ...realAdvisory,
    computeScannerAdvisory: async () => null,
  },
});

// Import the scanner AFTER the mocks are registered so its bound imports of
// routeCandles/routeQuote/computeScannerAdvisory resolve to the instrumented
// versions.
const scanner = await import("../marketScanner.js");

// ── The behavioural cap, driven by the REAL scanOnce ────────────────────────

test("scanOnce holds the single shared server-load cap across the real router seam", async () => {
  // A genuinely wide universe so the outer per-symbol loop is saturated and the
  // inner candle+quote sub-lookups overlap heavily — the exact condition that
  // would expose two multiplying caps.
  const symbols = scanner.symbolsForUniverse("forex").slice(0, 40);
  assert.ok(
    symbols.length >= 12,
    `need a multi-symbol universe to force overlap (got ${symbols.length})`,
  );

  const out = await scanner.scanOnce({ symbols, timeframes: ["M1", "M5", "M15"] });

  // The instrumented seam must have actually been driven by the real scan —
  // proves we exercised the production call graph, not a short-circuit.
  assert.ok(
    candleCalls > 0 && quoteCalls > 0,
    `scanOnce must drive both router leaf lookups (candles=${candleCalls}, quotes=${quoteCalls})`,
  );
  assert.ok(out.length > 0, "scanOnce must return rows fed by the instrumented seam");

  // The core guarantee: total simultaneous router/DB leaf calls across the
  // nested fan-outs never exceed the ONE shared cap.
  assert.ok(peak > 1, `leaf lookups must genuinely overlap (peak was ${peak})`);
  assert.ok(
    peak <= scanner.ENRICHMENT_CONCURRENCY,
    `peak simultaneous router/DB calls ${peak} must stay <= the single shared cap ` +
      `${scanner.ENRICHMENT_CONCURRENCY}. If this jumped toward ~2× the cap, a leaf ` +
      `lookup stopped acquiring runWithScannerBudget and the nested caps now multiply.`,
  );

  // The budget fully drains — no permit leaked across a complete scan.
  assert.equal(inFlight, 0, "all router leaf lookups must have completed (no leaked permits)");
});

test("a second back-to-back scan still respects the same shared cap", async () => {
  // Re-running must not accumulate permits or drift the peak — the budget is a
  // long-lived process-wide semaphore, so a leak would surface on the 2nd pass.
  peak = 0;
  inFlight = 0;
  const before = candleCalls + quoteCalls;

  const symbols = scanner.symbolsForUniverse("forex").slice(0, 30);
  await scanner.scanOnce({ symbols, timeframes: ["M5", "M15"] });

  assert.ok(candleCalls + quoteCalls > before, "the second scan must drive the seam again");
  assert.ok(peak > 1, `second scan leaf lookups must overlap (peak was ${peak})`);
  assert.ok(
    peak <= scanner.ENRICHMENT_CONCURRENCY,
    `second-scan peak ${peak} must stay <= shared cap ${scanner.ENRICHMENT_CONCURRENCY}`,
  );
  assert.equal(inFlight, 0, "no permit leaked after the second scan");
});
