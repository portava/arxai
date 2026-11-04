// Regression for the chart-signals sweep (CS2, CS3, CS4).
//
//  CS2 — the setup-preview scanner score must come from the chart's own
//        timeframe; a different-timeframe candidate is never substituted and
//        never feeds the agent-team verdict as if it described the chart.
//  CS3 — chart AI position alerts see MT5 DEMO/LIVE positions, matched on the
//        canonical symbol (broker suffixes ignored), plus paper trades.
//  CS4 — momentum and position alerts are paused (no fire, no clear) while the
//        feed is stale/unusable; a position with a fresh broker quote may still
//        alert from that quote.
import { test, mock, describe } from "node:test";
import assert from "node:assert/strict";

process.env.DATABASE_URL = "postgres://qa:qa@127.0.0.1:1/offline_never_connects";

// ── Fake storage for scanChartAlerts ────────────────────────────────────────
let storedSnapshot: Record<string, unknown> | null = null;
const upserts: string[] = [];
const dismissals: string[] = [];

const database = await import("@workspace/db");
mock.method(database.pool, "query", () => { throw new Error("Unexpected database access"); });
mock.method(database.pool, "connect", () => { throw new Error("Unexpected database access"); });
const fakeDb = {
  select: () => ({
    from: () => ({
      where: () => ({
        limit: async () => (storedSnapshot ? [{ lastSnapshot: storedSnapshot }] : []),
      }),
    }),
  }),
  insert: () => ({
    values: (v: { lastSnapshot: Record<string, unknown> }) => ({
      onConflictDoUpdate: async () => { storedSnapshot = v.lastSnapshot; },
    }),
  }),
};
mock.module("@workspace/db", { namedExports: { ...database, db: fakeDb } });

const alertsMod = await import("../../../routes/meAlerts.js");
mock.module("../../../routes/meAlerts.js", {
  namedExports: {
    ...alertsMod,
    upsertAlertOnce: async (_u: number, a: { alertType: string }) => { upserts.push(a.alertType); },
    dismissAlertsByType: async (_u: number, keys: string[]) => { dismissals.push(...keys); return keys.length; },
  },
});
const annMod = await import("../chartAnnotations.js");
mock.module("../chartAnnotations.js", {
  namedExports: { ...annMod, listActivePriceAlerts: async () => [], markAnnotationTriggered: async () => {}, dismissAnnotation: async () => {} },
});

const { scanChartAlerts } = await import("../aiAlerts.js");
const { toChartAlertPositions, gatherChartAlertPositions, sameChartSymbol } = await import("../chartAlertPositions.js");
const {
  selectScannerCandidate,
  deriveScannerSignals,
  assembleSetupSignals,
} = await import("../../assistant/setupSignals.js");

function reset() { storedSnapshot = null; upserts.length = 0; dismissals.length = 0; }

function state(over: Record<string, unknown> = {}) {
  return {
    symbol: "EURUSD",
    displaySymbol: "EURUSD",
    timeframe: "M5",
    stale: false,
    aiUsable: true,
    setupState: null,
    decisionState: null,
    agentConsensus: null,
    candleStats: { lastClose: 1.0905 },
    ...over,
  } as never;
}

const BUY = { id: 7, side: "BUY" as const, entry: 1.1, sl: 1.09, tp: 1.12 };

// ── CS2 ─────────────────────────────────────────────────────────────────────
describe("CS2 scanner score timeframe", () => {
  const res = {
    connected: true,
    candidates: [
      { symbol: "EURUSD", timeframe: "H1", score: 72, riskScore: 30 },
      { symbol: "EURUSD", timeframe: "M15", score: 55, riskScore: 40 },
    ],
  } as never;

  test("uses only the candidate on the chart's own timeframe", () => {
    assert.equal(selectScannerCandidate(res, "EURUSD", "M15")?.timeframe, "M15");
    assert.deepEqual(deriveScannerSignals(res, "EURUSD", "H1"), { scannerScore: 72, riskScore: 30, scannerTimeframe: "H1" });
  });

  test("an M5 chart gets no scanner score instead of the top M15/H1 one", () => {
    assert.equal(selectScannerCandidate(res, "EURUSD", "M5"), null);
    assert.deepEqual(deriveScannerSignals(res, "EURUSD", "M5"), { scannerScore: null, riskScore: null, scannerTimeframe: null });
  });

  test("governance gets the structure estimate, not a mismatched-timeframe score", async () => {
    let seen: { confNum: number; riskNum: number } | null = null;
    const out = await assembleSetupSignals(
      { symbol: "EURUSD", timeframe: "M5", requestedSide: "BUY", bias: "Bullish", confidence: "Medium" } as never,
      {
        scoreLiveCandidates: async () => res,
        evaluateScalpForSymbol: async () => { throw new Error("no scalp"); },
        runGovernance: async (a) => { seen = { confNum: a.confNum, riskNum: a.riskNum }; return null; },
      },
    );
    assert.equal(out.scannerScore, null);
    assert.equal(out.scannerTimeframe, null);
    assert.deepEqual(seen, { confNum: 60, riskNum: 40 });
  });
});

// ── CS3 ─────────────────────────────────────────────────────────────────────
describe("CS3 MT5 positions reach chart alerts", () => {
  const NOW = Date.parse("2026-11-04T12:00:00Z");
  const mt5 = [
    { venue: "DEMO" as const, id: 1, ticket: "555", symbol: "EURUSDm", side: "SELL", entryPrice: "1.1", stopLoss: "1.11", takeProfit: null, currentPrice: "1.105", observedAt: new Date(NOW - 5_000), closedAt: null },
    { venue: "LIVE" as const, id: 1, ticket: "777", symbol: "EURUSD.r", side: "BUY", entryPrice: 1.1, stopLoss: 1.09, takeProfit: 1.12, currentPrice: 1.095, observedAt: new Date(NOW - 120_000), closedAt: null },
    { venue: "DEMO" as const, id: 2, ticket: "888", symbol: "GBPUSD", side: "BUY", entryPrice: 1.3, stopLoss: null, takeProfit: null, currentPrice: null, observedAt: null, closedAt: null },
    { venue: "DEMO" as const, id: 3, ticket: "999", symbol: "EURUSD", side: "BUY", entryPrice: 1.1, stopLoss: null, takeProfit: null, currentPrice: null, observedAt: null, closedAt: new Date(NOW) },
    { venue: "DEMO" as const, id: 4, ticket: null, symbol: "EURUSD", side: "BUY", entryPrice: 1.1, stopLoss: null, takeProfit: null, currentPrice: null, observedAt: null, closedAt: null },
  ];
  const paper = [
    { id: 11, symbol: "eurusd", side: "buy", entryPrice: "1.1", stopLoss: "1.09", takeProfit: null },
    { id: 12, symbol: "USDJPY", side: "buy", entryPrice: "150", stopLoss: null, takeProfit: null },
  ];

  test("normalized symbol comparison ignores broker suffixes", () => {
    assert.equal(sameChartSymbol("EURUSDm", "EURUSD"), true);
    assert.equal(sameChartSymbol("XAUUSD.r", "XAUUSD"), true);
    assert.equal(sameChartSymbol("GBPUSD", "EURUSD"), false);
  });

  test("keeps paper + open MT5 rows on the chart symbol, venue-keyed, with fresh quotes only", () => {
    const out = toChartAlertPositions("EURUSD", paper, mt5, NOW);
    assert.deepEqual(out.map((p) => p.id), [11, "demo-555", "live-777"]);
    const demo = out.find((p) => p.id === "demo-555")!;
    assert.equal(demo.side, "SELL");
    assert.equal(demo.freshQuote, 1.105);
    assert.equal(out.find((p) => p.id === "live-777")!.freshQuote, null, "a 2-minute-old bridge row is not a fresh quote");
    assert.equal(out.find((p) => p.id === 11)!.freshQuote, undefined);
  });

  test("one failing source still returns the other", async () => {
    const out = await gatherChartAlertPositions(1, "EURUSD", {
      readPaper: async () => { throw new Error("db down"); },
      readMt5: async () => mt5,
      nowMs: () => NOW,
    });
    assert.deepEqual(out.map((p) => p.id), ["demo-555", "live-777"]);
  });
});

// ── CS4 ─────────────────────────────────────────────────────────────────────
describe("CS4 stale feed pauses momentum and position alerts", () => {
  test("healthy feed: igniting flame + near-stop fire as before", async () => {
    reset();
    const r = await scanChartAlerts(1, "USER", state(), {
      flame: { stage: "IGNITING", entryTiming: "CLEAN", blind: false } as never,
      openPositions: [BUY],
    });
    assert.ok(upserts.includes("chart_scalp_flame:EURUSD"));
    assert.ok(upserts.includes("chart_trade_danger:EURUSD:7"));
    assert.equal(r.suppressed, undefined);
  });

  test("stale feed: no momentum or position fire, a reason instead, held state kept", async () => {
    reset();
    storedSnapshot = { stage: null, actionability: null, vetoed: false, conflict: false, feedBad: false, lastClose: 1.1, flameStage: "ACTIVE", entryTiming: "CLEAN" };
    const r = await scanChartAlerts(1, "USER", state({ stale: true }), {
      flame: { stage: "STRETCH", entryTiming: "CHASING", blind: false } as never,
      openPositions: [BUY],
    });
    assert.ok(upserts.includes("chart_feed_stale:EURUSD"));
    assert.ok(!upserts.some((k) => k.startsWith("chart_scalp") || k.startsWith("chart_trade_danger")));
    assert.ok(!dismissals.some((k) => k.startsWith("chart_scalp") || k.startsWith("chart_trade_danger") || k.startsWith("chart_partial_tp")));
    assert.equal(r.suppressed?.length, 2);
    assert.match(r.suppressed![0]!, /Momentum alerts paused/);
    assert.match(r.suppressed![1]!, /held for 1 open position/);
    assert.equal(storedSnapshot!.flameStage, "ACTIVE", "the stale scan does not overwrite the held flame read");
  });

  test("stale feed: a position with a fresh broker quote still alerts from that quote", async () => {
    reset();
    await scanChartAlerts(1, "USER", state({ stale: true, candleStats: { lastClose: 1.2 } }), {
      flame: null,
      openPositions: [{ ...BUY, freshQuote: 1.0905 }],
    });
    assert.ok(upserts.includes("chart_trade_danger:EURUSD:7"));
  });
});
