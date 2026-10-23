// QA — Kill the simulator fallback: a NO-feed market must scan to an honest
// AWAITING_FEED row, never a simulator-backed one (command:
// kill-simulator-fallback-unify-scalp, PART 1).
//
// This is an INTEGRATION-lane test: it exercises the REAL scanner read path
//   scanSymbolTimeframe → analyzeViaRouter → routeCandles → (all providers)
// with the broker seam EMPTY and all external HTTP providers hard-blocked
// (globalThis.fetch rejects), so the router genuinely has NO candles for the
// symbol. Before this task, marketScanner fell back to the simulator
// (`analyzeMarket(sym, tf)`) for non-synthetic no-feed symbols and produced a
// SIMULATOR row with fabricated OHLC-derived scores. The honesty contract now:
//   dataSource === "AWAITING_FEED", dataStatus === "no_data",
//   selectable === false, tradeable === false — for EVERY asset class.
//
// A static source-scan locks the code shape too: marketScanner.ts must contain
// NO call to the simulator's `analyzeMarket(` (the candle-truth
// `analyzeMarketFromCandles(` is the only allowed analyzer).
//
// `export {}` scopes this file as a module (avoids the scripts/__qa__ global
// duplicate-identifier collision documented in memory).
export {};

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { __resetMt5ProviderStore } from "../data/providers/mt5Provider.js";
import { scanSymbolTimeframe } from "../marketScanner.js";

const realFetch = globalThis.fetch;
let blockedAttempts = 0;

before(() => {
  // Hard-block every external HTTP provider (TwelveData / Polygon / etc.).
  // Env keys may be configured in this workspace, so without this block a
  // "no feed" test could silently receive REAL live data and go vacuous.
  globalThis.fetch = ((..._args: Parameters<typeof fetch>) => {
    blockedAttempts += 1;
    return Promise.reject(new Error("network blocked by scannerNoFeedHonesty test"));
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
});

test("non-synthetic symbol with NO feed scans to honest AWAITING_FEED (no simulator fallback)", async () => {
  __resetMt5ProviderStore(); // broker seam empty — nothing pushed.

  const op = await scanSymbolTimeframe("EURUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  // The row must be honestly feed-less — NEVER simulator-backed.
  assert.notEqual(op.dataSource, "SIMULATOR", "simulator fallback must be dead");
  assert.equal(op.dataSource, "AWAITING_FEED");
  assert.equal(op.dataStatus, "no_data");
  assert.equal(op.selectable, false);
  assert.equal(op.tradeable, false);
});

test("second asset class (metal) with NO feed is also AWAITING_FEED — unified across classes", async () => {
  __resetMt5ProviderStore();

  const op = await scanSymbolTimeframe("XAUUSD", "M5");
  assert.ok(op != null, "scanner must return a row for an approved symbol");
  assert.notEqual(op.dataSource, "SIMULATOR", "simulator fallback must be dead");
  assert.equal(op.dataSource, "AWAITING_FEED");
  assert.equal(op.dataStatus, "no_data");
  assert.equal(op.selectable, false);
  assert.equal(op.tradeable, false);
});

test("network guard actually engaged (proof the no-feed condition was real)", () => {
  // If no provider ever attempted an external fetch, the block could be
  // vacuous — but the mt5 seam was empty, so at least one HTTP provider in the
  // composite chain must have tried (and been refused).
  assert.ok(
    blockedAttempts > 0,
    "expected at least one blocked external fetch attempt during the no-feed scans",
  );
});

test("static lock: marketScanner.ts contains no simulator analyzeMarket( call", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const src = readFileSync(path.join(here, "..", "marketScanner.ts"), "utf8");
  // `analyzeMarket(` requires "(" immediately after the name, so the allowed
  // candle-truth analyzer `analyzeMarketFromCandles(` can never match.
  const simCalls = src.match(/\banalyzeMarket\(/g) ?? [];
  assert.equal(
    simCalls.length,
    0,
    "marketScanner.ts must not call the simulator analyzeMarket( — only analyzeMarketFromCandles(",
  );
});
