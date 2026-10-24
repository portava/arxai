// Limits in force, layer by layer (Tier 1 finalization, item 7).
//
// The trader's page must show exactly what the Risk Governor enforces:
// every row's effective value is resolveEffectiveLimits' value, the layer
// that set it is named, and the strictest layer wins in every direction.
//
// Run: pnpm --filter @workspace/api-server run test:limit-layers

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { explainLimitLayers, layerOf } from "../limitLayers.js";
import { PLATFORM_RISK_CEILINGS, resolveEffectiveLimits, type StoredLimitRows } from "../preTrade.js";

const user = {
  maxRiskPerTradePercent: 0.5, maxRiskPerTradeAmount: 40, maxDailyLossPercent: 2, maxDailyLossAmount: 300,
  maxOpenTrades: 2, maxPositionSize: 1, blockAfterDailyLossHit: true, requireStopLoss: true,
  maxLeverage: 50, maxPositionsPerSymbol: 1, maxTradesPerDay: 4,
};
const admin = { maxLotSize: 0.5, maxDailyLossUsd: 500, allowedAccountType: "live", maxTradesPerDay: 3, maxLeverage: 10 };
const row = (rows: StoredLimitRows, key: string) => explainLimitLayers(rows).rows.find((r) => r.key === key)!;

test("each row's effective value is the Risk Governor's value", () => {
  for (const rows of [{}, { userSettings: user }, { userSettings: user, adminLimits: admin }] as StoredLimitRows[]) {
    const L = resolveEffectiveLimits(rows);
    const { rows: out } = explainLimitLayers(rows);
    const expect: Record<string, number | null> = {
      maxLotSize: L.maxLotSize, maxRiskPerTradePercent: L.maxRiskPerTradePercent, maxRiskPerTradeAmount: L.maxRiskPerTradeAmount,
      maxDailyLossPercent: L.maxDailyLossPercent, maxDailyLossAmount: L.maxDailyLossAmount,
      maxPortfolioRiskPercent: L.maxPortfolioRiskPercent, maxLeverage: L.maxLeverage, maxSymbolLeverage: L.maxSymbolLeverage,
      maxPositionsPerSymbol: L.maxPositionsPerSymbol, maxDrawdownPercent: L.maxDrawdownPercent,
      maxOpenTrades: L.discipline.maxOpenTrades, maxTradesPerDay: L.discipline.maxTradesPerDay,
    };
    assert.deepEqual(Object.fromEntries(out.map((r) => [r.key, r.effective])), expect);
    for (const r of out) assert.equal(r.source, L.sources[r.key] ?? "none");
  }
});

test("strictest wins, and the winning layer is named", () => {
  const rows: StoredLimitRows = { userSettings: user, adminLimits: admin };
  const lot = row(rows, "maxLotSize");
  assert.deepEqual([lot.platform, lot.account, lot.user, lot.effective, lot.winner], [PLATFORM_RISK_CEILINGS.maxLotSize, 0.5, 1, 0.5, "account"]);
  const lev = row(rows, "maxLeverage");
  assert.deepEqual([lev.platform, lev.account, lev.user, lev.effective, lev.winner], [PLATFORM_RISK_CEILINGS.maxLeverage, 10, 50, 10, "account"]);
  const pps = row(rows, "maxPositionsPerSymbol");
  assert.deepEqual([pps.effective, pps.winner], [1, "user"]);
  const day = row(rows, "maxTradesPerDay");
  assert.deepEqual([day.account, day.user, day.effective, day.winner], [3, 4, 3, "account"]);
  const loss = row(rows, "maxDailyLossAmount");
  assert.deepEqual([loss.account, loss.user, loss.effective, loss.winner], [500, 300, 300, "user"]);
});

test("a trader cannot loosen a platform ceiling", () => {
  const rows: StoredLimitRows = { userSettings: { ...user, maxPositionSize: 50, maxLeverage: 500, maxPositionsPerSymbol: 9 } };
  for (const k of ["maxLotSize", "maxLeverage", "maxPositionsPerSymbol"]) {
    const r = row(rows, k);
    assert.equal(r.winner, "platform", k);
    assert.equal(r.effective, r.platform, k);
  }
});

test("a trader switching their daily-loss block off leaves the account cap in force", () => {
  const rows: StoredLimitRows = { userSettings: { ...user, blockAfterDailyLossHit: false }, adminLimits: admin };
  const pct = row(rows, "maxDailyLossPercent");
  assert.deepEqual([pct.user, pct.effective, pct.winner], [null, null, "disabled"]);
  const amt = row(rows, "maxDailyLossAmount");
  assert.deepEqual([amt.user, amt.effective, amt.winner], [null, 500, "account"]);
});

test("source → layer", () => {
  assert.equal(layerOf("platform"), "platform");
  assert.equal(layerOf("user_risk_limits.max_lot_size"), "account");
  assert.equal(layerOf("user_risk_settings.max_position_size"), "user");
  assert.equal(layerOf("risk_settings.max_lot_size"), "user");
  assert.equal(layerOf("default:user_risk_settings.max_open_trades"), "default");
  assert.equal(layerOf("per_trade_percent x max_open_trades"), "derived");
});

test("the route serves only the signed-in trader's rows", () => {
  const src = readFileSync(fileURLToPath(new URL("../../../routes/meRiskGovernor.ts", import.meta.url)), "utf8");
  const route = src.slice(src.indexOf('"/me/risk-limits/layers"'), src.indexOf("router.post(\"/me/risk-settings/reset-defaults\""));
  assert.match(route, /requireUser/);
  assert.match(route, /loadStoredLimitRows\(req\.authUser!\.id\)/);
  assert.doesNotMatch(route, /req\.(query|params|body)/);
});
