// Synthetic-backtest honesty guards (audit ranks 41 + 42).
//
// What was wrong:
//   41. `isVerified` came from isVerificationEligible(metrics) alone, with no
//       reference to dataSource, so a run over fabricated candles was stamped a
//       green VERIFIED next to its own grey SYNTHETIC badge — and the generator
//       was biased: `(rng() - 0.48)` subtracts 0.48 from a U[0,1) draw, baking a
//       persistent upward drift in, so long-biased strategies trended profitable
//       on invented data by construction.
//   42. BASE_PRICES / VOLATILITIES were keyed by DISPLAY names ("Volatility 75
//       Index") while every caller passes the ARX canonicalSymbol ("V75"), and
//       ~22 of the 43 approved markets were absent entirely. `?? 1.0` then
//       produced a full results dashboard for Gold or V75 on a series starting
//       at 1.0000 with nothing saying so.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARX_FOCUS_MARKETS } from "@workspace/domain/market";
import {
  generateDeterministicCandles, resolveSyntheticPriceModel, modelledSyntheticSymbols,
  NoSyntheticPriceModelError, ENGINE_STRATEGY_NAMES,
} from "../backtestStrategyRegistry.js";

const ROUTE_SRC = readFileSync(
  fileURLToPath(new URL("../../routes/backtestRuns.ts", import.meta.url)),
  "utf8",
);
const REGISTRY_SRC = readFileSync(
  fileURLToPath(new URL("../backtestStrategyRegistry.ts", import.meta.url)),
  "utf8",
);

// ── Rank 42 — every approved market has a scale model, keyed canonically ─────

test("every ARX focus market has a synthetic price model", () => {
  const missing = ARX_FOCUS_MARKETS
    .filter((m) => !resolveSyntheticPriceModel(m.canonicalSymbol))
    .map((m) => m.canonicalSymbol);
  assert.deepEqual(missing, [], `markets with no synthetic price model: ${missing.join(", ")}`);
  assert.ok(ARX_FOCUS_MARKETS.length >= 40, "sanity: the focus registry should hold the full universe");
});

test("models are keyed by canonicalSymbol and resolve through display names and aliases", () => {
  // The exact symbols the audit named as falling through to 1.0000.
  for (const sym of ["XAUUSD", "XAGUSD", "DXY", "GER30", "BTCUSD", "ETHUSD", "V75", "BOOM1000", "CRASH500", "JUMP75", "EURAUD", "GBPAUD"]) {
    const m = resolveSyntheticPriceModel(sym);
    assert.ok(m, `${sym} must have a synthetic price model`);
    assert.notEqual(m.basePrice, 1.0, `${sym} must not fall back to a 1.0000 base price`);
  }
  // Display name and free-text alias land on the same canonical model.
  assert.equal(resolveSyntheticPriceModel("Volatility 75 Index")?.canonicalSymbol, "V75");
  assert.equal(resolveSyntheticPriceModel("gold")?.canonicalSymbol, "XAUUSD");
  assert.equal(resolveSyntheticPriceModel("Germany 40")?.canonicalSymbol, "GER30");
});

test("a Gold series starts at gold's scale, not at 1.0000", () => {
  const candles = generateDeterministicCandles({ symbol: "XAUUSD", count: 50, timeframe: "M5", seed: "t" });
  assert.equal(candles.length, 50);
  assert.ok(candles[0]!.open > 1000, `expected a gold-scale open, got ${candles[0]!.open}`);
  for (const c of candles) {
    assert.ok(c.close > 1000, "every bar must stay at the instrument's scale");
  }
});

test("an unmodelled symbol is refused, never fabricated at 1.0000", () => {
  assert.throws(
    () => generateDeterministicCandles({ symbol: "NOT_A_MARKET_XYZ", count: 10, timeframe: "M1", seed: "t" }),
    (err: unknown) => err instanceof NoSyntheticPriceModelError && /no synthetic price model/i.test((err as Error).message),
  );
  // Guard the silent default itself: the generator must not reintroduce one.
  assert.ok(
    !/BASE_PRICES\[[^\]]+\]\s*\?\?/.test(REGISTRY_SRC),
    "generator must not fall back to a default base price",
  );
  assert.ok(
    !/VOLATILITIES\[[^\]]+\]\s*\?\?/.test(REGISTRY_SRC),
    "generator must not fall back to a default volatility",
  );
});

// ── Rank 41 — the generator is driftless, and VERIFIED needs real bars ───────

test("the fabricated random walk is zero-mean, not rigged upward", () => {
  // The old `(rng() - 0.48)` step compounded to roughly +6% over this window.
  const candles = generateDeterministicCandles({ symbol: "EURUSD", count: 5000, timeframe: "M1", seed: "drift" });
  const totalDriftPct = (candles.at(-1)!.close / candles[0]!.open - 1) * 100;
  assert.ok(
    Math.abs(totalDriftPct) < 2,
    `expected a driftless walk over 5000 bars, got ${totalDriftPct.toFixed(3)}%`,
  );
  // Inspect the step expression itself, not the comments explaining the history.
  const stepLines = REGISTRY_SRC.split("\n")
    .filter((l) => /const change\s*=/.test(l) && !l.trimStart().startsWith("//"));
  assert.equal(stepLines.length, 1, "expected exactly one step expression");
  assert.ok(!/0\.48/.test(stepLines[0]!), "the 0.48 upward-drift bias must not return");
  assert.ok(/rng\(\)\s*-\s*0\.5\b/.test(stepLines[0]!), "the step must be centred on zero");
});

test("VERIFIED is gated on real broker bars", () => {
  assert.ok(
    /const isVerified = dataSource !== "broker"/.test(ROUTE_SRC),
    "the verification verdict must branch on dataSource before anything else",
  );
  assert.ok(
    /SYNTHETIC_NOT_VERIFIABLE/.test(ROUTE_SRC),
    "synthetic runs must carry their own non-verifiable verdict",
  );
  // isVerificationEligible must never be the sole gate any more.
  const verdictLine = ROUTE_SRC.split("\n").find((l) => l.includes("const isVerified ="));
  assert.ok(verdictLine && !/^\s*const isVerified = sim\.metrics/.test(verdictLine),
    "the metrics threshold alone must not grant VERIFIED");
});

test("a synthetic run's stored summary opens by saying it is synthetic", () => {
  assert.ok(
    /export function syntheticSummaryPrefix/.test(ROUTE_SRC),
    "the summary prefix helper must exist",
  );
  assert.ok(
    /SYNTHETIC DATA —/.test(ROUTE_SRC) && /can never be marked VERIFIED/.test(ROUTE_SRC),
    "the prefix must name the data as fabricated and rule out verification",
  );
  // Both the create path and the review-refresh path must stamp it.
  const stamped = ROUTE_SRC.match(/syntheticSummaryPrefix\(/g) ?? [];
  assert.ok(stamped.length >= 3, `expected the prefix on every summary write, saw ${stamped.length} uses`);
});

test("an unmodelled symbol with no broker history yields a refusal, not a run", () => {
  assert.ok(
    /NO_SYNTHETIC_PRICE_MODEL/.test(ROUTE_SRC) && /422/.test(ROUTE_SRC),
    "the route must refuse rather than simulate on a fabricated scale",
  );
});

// ── Engine-derived strategy universe (used by the tournament, rank 70) ───────

test("engine strategy names are derived from the registry, not hand-written", () => {
  assert.equal(ENGINE_STRATEGY_NAMES.length, 7);
  for (const name of ENGINE_STRATEGY_NAMES) {
    assert.ok(name && name !== "None" && name !== "No Trade Filter", `bad derived name: ${name}`);
  }
  assert.ok(ENGINE_STRATEGY_NAMES.includes("Trend Continuation"));
  assert.ok(ENGINE_STRATEGY_NAMES.includes("Session Breakout"));
});

test("modelledSyntheticSymbols covers the focus universe", () => {
  const modelled = new Set(modelledSyntheticSymbols());
  for (const m of ARX_FOCUS_MARKETS) {
    assert.ok(modelled.has(m.canonicalSymbol), `${m.canonicalSymbol} missing from the model table`);
  }
});
