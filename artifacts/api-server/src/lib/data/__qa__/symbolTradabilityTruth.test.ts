// QA — the tradability badge says only what was checked.
//
// "Tradable via MT5" + "This market can be traded through the connected MT5
// bridge if all live safety gates pass" came from one allow-list lookup:
// nothing about a connected bridge, the broker's symbols, ARX Focus approval
// or governance was checked. A symbol on the default list but outside ARX
// Focus (NAS100 / WTI / UKOIL) — which the live pipeline refuses outright
// (SYMBOL_NOT_IN_ARX_FOCUS) — still read "Tradable via MT5", and when the
// user's own list could not be read the default list was used silently and
// presented as theirs.
//
// Run: node --import tsx --experimental-test-module-mocks --test --test-force-exit \
//   src/lib/data/__qa__/symbolTradabilityTruth.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test, mock, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { isApprovedArxMarket } from "@workspace/domain/market";

let settings: () => Promise<{ allowedSymbols: string[] | null }> = async () => ({ allowedSymbols: null });
mock.module("../../live/liveCommandPipeline.js", { namedExports: {
  getOrCreateUserSettings: async () => settings(),
} });

const { getSymbolTradability } = await import("../symbolTradability.js");

beforeEach(() => { settings = async () => ({ allowedSymbols: null }); });

test("a default-list symbol outside ARX Focus is not shown as tradable (the pipeline refuses it)", async () => {
  assert.equal(isApprovedArxMarket("NAS100"), false, "fixture: NAS100 is outside ARX Focus");
  const t = await getSymbolTradability("NAS100", 1);
  assert.notEqual(t.badgeLabel, "Tradable via MT5");
  assert.equal(t.mt5Tradable, "no");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /ARX Focus/);
  assert.match(t.userMessage, /refused/);
});

test("the user's live list could not be read → not verified, never the default list presented as theirs", async () => {
  settings = async () => { throw new Error("db offline"); };
  const t = await getSymbolTradability("EURUSD", 1);
  assert.notEqual(t.badgeLabel, "Tradable via MT5");
  assert.equal(t.mt5Tradable, "unknown");
  assert.equal(t.badgeLabel, "Tradability not verified");
  assert.equal(t.liveExecutionAllowed, false);
  assert.match(t.userMessage, /could not be loaded/);
});

test("allowed symbol: the label says it is allowed, and the copy names what was not checked", async () => {
  settings = async () => ({ allowedSymbols: ["EURUSD"] });
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "yes");
  assert.equal(t.liveExecutionAllowed, true);
  assert.equal(t.badgeLabel, "Allowed for MT5 live");
  // No claim about a bridge connection it never looked at.
  assert.doesNotMatch(t.userMessage, /connected/i);
  assert.match(t.userMessage, /your live market list/);
  assert.match(t.userMessage, /bridge/);
  assert.match(t.userMessage, /only when an order is submitted/);
});

test("no list of their own → the copy says the default list was used", async () => {
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "yes");
  assert.match(t.userMessage, /default live market list/);
});

test("not on the list → analysis only, naming the list", async () => {
  settings = async () => ({ allowedSymbols: ["GBPUSD"] });
  const t = await getSymbolTradability("EURUSD", 1);
  assert.equal(t.mt5Tradable, "no");
  assert.equal(t.badgeLabel, "Analysis only");
  assert.match(t.userMessage, /not on your live market list/);
});

test("the live pipeline's synthetic-floor inputs are unchanged", async () => {
  const v = await getSymbolTradability("V75", 1);
  assert.equal(v.assetClass, "synthetic");
  assert.equal(v.dataProvider, "deriv");
  const e = await getSymbolTradability("EURUSD", 1);
  assert.equal(e.dataProvider, "external");
});

// ── The label never names a data provider it did not observe ───────────────

test("synthetic not on the list: the label/copy do not name Deriv (the router may serve it from the MT5 broker)", async () => {
  settings = async () => ({ allowedSymbols: ["EURUSD"] });
  const t = await getSymbolTradability("V75", 1);
  assert.equal(t.mt5Tradable, "no");
  assert.notEqual(t.badgeLabel, "Data-only via Deriv");
  assert.equal(t.badgeLabel, "Analysis only");
  assert.doesNotMatch(t.userMessage, /deriv/i);
  assert.doesNotMatch(t.userMessage, /current MT5 bridge/i);
  assert.match(t.userMessage, /not on your live market list/);
  // The class-derived route label the live pipeline's synthetic floor reads stays.
  assert.equal(t.dataProvider, "deriv");
});
