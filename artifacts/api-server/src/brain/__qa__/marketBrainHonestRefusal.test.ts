// QA — R7 step 1a: the market brain analyzes REAL candles or refuses honestly.
//
// Locks four contracts:
//   1. NO SYNTHETIC DEFAULT: with no feed available, analyzeMarket returns the
//      honest refusal { available:false, reason:"INSUFFICIENT_REAL_DATA" } —
//      never an analysis of invented bars, never entry/SL/TP numbers.
//   2. REFUSAL SHAPE: the refusal keeps consumer-safe envelope keys (symbol,
//      direction:"WAIT", confidence:0, riskApproved:false, blockedReason,
//      timestamp) and carries NO market numbers.
//   3. CALLER-SUPPLIED REAL BARS still analyze (back-compat), and the result
//      carries available:true + candleSource/candleCount provenance.
//   4. HONEST SUB-ENGINES: macroDetails is the not-connected pattern
//      (providerConnected:false, Neutral, safetyNote) and newsDetails comes
//      from the real calendar seam (providerConnected:false offline — never a
//      fabricated schedule, never blockTrading on unknown data).
//
// Offline by construction (established pattern — provenanceEnvelope.test.ts):
// dummy DATABASE_URL; provider/calendar env keys cleared BEFORE module load so
// the router serves honest-empty and the calendar reports not-connected.
//
// Run: node --import tsx --test --test-force-exit \
//   src/brain/__qa__/marketBrainHonestRefusal.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";
delete process.env.TWELVEDATA_API_KEY;
delete process.env.POLYGON_API_KEY;
delete process.env.FINNHUB_API_KEY;
delete process.env.ALPHA_VANTAGE_API_KEY;
delete process.env.NEWSAPI_API_KEY;
delete process.env.DERIV_APP_ID;
delete process.env.DERIV_API_TOKEN;
delete process.env.TRADING_ECONOMICS_KEY;
delete process.env.FRED_API_KEY;

import { test } from "node:test";
import assert from "node:assert/strict";
import type { Candle } from "../../lib/strategyEngine.js";

const { analyzeMarket, MIN_REAL_CANDLES_FOR_BRAIN } = await import("../marketBrain.js");

// Deterministic fixture bars (test fixtures may synthesize; __qa__ is excluded
// from the fabrication sweep).
function bars(count: number): Candle[] {
  const out: Candle[] = [];
  let price = 1.1;
  const t0 = Date.parse("2026-08-19T00:00:00.000Z");
  for (let i = 0; i < count; i++) {
    const open = price;
    const close = price + (i % 3 === 0 ? 0.0004 : -0.0002);
    out.push({
      time: new Date(t0 + i * 60_000).toISOString(),
      open, high: Math.max(open, close) + 0.0002, low: Math.min(open, close) - 0.0002,
      close, volume: 100,
    });
    price = close;
  }
  return out;
}

test("no feed → honest refusal, never an analysis of invented bars", async () => {
  const out = await analyzeMarket("EURUSD", undefined, undefined, undefined);
  assert.equal(out.available, false);
  if (out.available !== false) return; // type narrow
  assert.equal(out.reason, "INSUFFICIENT_REAL_DATA");
  assert.equal(out.direction, "WAIT");
  assert.equal(out.confidence, 0);
  assert.equal(out.riskApproved, false);
  assert.match(out.blockedReason, /INSUFFICIENT_REAL_DATA/);
  // Refusal carries NO market numbers.
  const json = JSON.stringify(out);
  assert.ok(!json.includes("entry"), "refusal must not carry entry/SL/TP fields");
  assert.ok(!json.includes("stopLoss"));
  assert.ok(!json.includes("takeProfit"));
});

test("caller-supplied bars below the floor → same honest refusal", async () => {
  const out = await analyzeMarket("EURUSD", bars(MIN_REAL_CANDLES_FOR_BRAIN - 1));
  assert.equal(out.available, false);
});

test("caller-supplied real bars analyze; sub-engines are honest, not fabricated", async () => {
  const out = await analyzeMarket("EURUSD", bars(250));
  assert.equal(out.available, true);
  if (out.available !== true) return; // type narrow
  assert.equal(out.symbol, "EURUSD");
  assert.equal(out.candleSource, "caller");
  assert.equal(out.candleCount, 250);

  // Macro: the honest not-connected pattern (no fabricated fundamentals).
  const macro = out.macroDetails as Record<string, unknown>;
  assert.equal(macro.type, "unavailable");
  assert.equal(macro.providerConnected, false);
  assert.equal(macro.macroBias, "Neutral");
  assert.equal(typeof macro.safetyNote, "string");
  assert.equal(out.macroBias, "Neutral", "unavailable macro must never push direction");

  // News: real calendar seam, honest not-connected offline — no invented
  // schedule, and never blockTrading on unknown data.
  assert.equal(out.newsDetails.providerConnected, false);
  assert.equal(out.newsDetails.blockTrading, false);
  assert.ok(!/simulated/i.test(out.newsDetails.reason), "no simulated events may appear");
});

test("synthetic-category symbol keeps its genuinely-known macro/news facts", async () => {
  const out = await analyzeMarket("Volatility 75 Index", bars(250));
  assert.equal(out.available, true);
  if (out.available !== true) return;
  const macro = out.macroDetails as Record<string, unknown>;
  assert.equal(macro.type, "synthetic");
  assert.equal(out.newsDetails.providerConnected, true, "synthetic news-immunity is a known fact, not a provider read");
  assert.equal(out.newsDetails.blockTrading, false);
});
