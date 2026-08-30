// Trader Coach — the "auto-checked" prep items must carry a real answer.
//
// BEFORE
//   The page rendered `<input type="checkbox" disabled={item.auto} />` — no
//   checked, no onChange, no state. The five items labelled "(auto-checked)"
//   ("Risk Governor status checked and not LOCKED", "Live trading is DISABLED",
//   …) therefore showed visibly UNCHECKED and could not be clicked, and nothing
//   anywhere evaluated them. `auto: true` meant only "disable the box".
//
// AFTER
//   `evaluateAutoChecklist` answers each auto item from the Risk Governor read
//   and the page renders that answer. It fails CLOSED: with no governor read
//   every auto item is NOT_CHECKED — never a pass.
//
// Run: node --import tsx --test src/lib/__qa__/coachAutoChecklist.test.ts

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateAutoChecklist,
  type AutoCheckGovernorView,
  type PreSessionChecklistItem,
} from "../traderCoach/autoChecklist.js";

const ITEMS: PreSessionChecklistItem[] = [
  { id: "governor_ok", label: "Risk Governor status checked and not LOCKED", required: true, auto: true },
  { id: "daily_loss_ok", label: "Daily paper loss limit not yet hit", required: true, auto: true },
  { id: "no_cooldown", label: "No active per-symbol revenge cooldown", required: true, auto: true },
  { id: "data_quality", label: "Market data quality is GOOD", required: true, auto: true },
  { id: "spread_ok", label: "Spread is acceptable", required: true, auto: false },
  { id: "live_disabled", label: "Live trading is DISABLED", required: true, auto: true },
  { id: "paper_only", label: "Mode is PAPER_ONLY", required: true, auto: true },
];

const HEALTHY: AutoCheckGovernorView = {
  overallStatus: "PAPER_ALLOWED",
  hardBlocks: [],
  softWarnings: [],
  riskFlags: [],
  cooldowns: [],
  metrics: { marketDataQuality: "GOOD" },
};

function byId(items: PreSessionChecklistItem[], id: string): PreSessionChecklistItem {
  const found = items.find((i) => i.id === id);
  assert.ok(found, `item ${id} missing`);
  return found;
}

test("with no governor read every auto item is NOT_CHECKED, never a pass", () => {
  const out = evaluateAutoChecklist(ITEMS, null);
  for (const item of out) {
    if (!item.auto) continue;
    assert.equal(
      item.autoResult,
      "NOT_CHECKED",
      `${item.id} must be unverified when the governor cannot be read`,
    );
    assert.notEqual(item.autoResult, "PASS");
  }
});

test("manual items are left alone — no autoResult is invented for them", () => {
  const out = evaluateAutoChecklist(ITEMS, HEALTHY);
  assert.equal(byId(out, "spread_ok").autoResult, undefined);
});

test("a healthy governor passes every auto item", () => {
  const out = evaluateAutoChecklist(ITEMS, HEALTHY);
  for (const item of out) {
    if (!item.auto) continue;
    assert.equal(item.autoResult, "PASS", `${item.id} should pass on a healthy governor`);
  }
});

test("a LOCKED governor FAILS the governor item", () => {
  const out = evaluateAutoChecklist(ITEMS, { ...HEALTHY, overallStatus: "LOCKED" });
  assert.equal(byId(out, "governor_ok").autoResult, "FAIL");
});

test("an exceeded daily loss limit FAILS that item and only that item", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    hardBlocks: [{ code: "DAILY_LOSS_LIMIT_EXCEEDED", message: "over" }],
  });
  assert.equal(byId(out, "daily_loss_ok").autoResult, "FAIL");
  assert.equal(byId(out, "governor_ok").autoResult, "PASS");
});

test("active cooldowns FAIL the cooldown item and name the symbols", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    cooldowns: [{ symbol: "XAUUSD", reason: "REVENGE", until: "2026-08-29T12:00:00.000Z" }],
  });
  const item = byId(out, "no_cooldown");
  assert.equal(item.autoResult, "FAIL");
  assert.match(item.autoDetail ?? "", /XAUUSD/);
});

test("a live-trading flag FAILS the live-disabled item", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    hardBlocks: [{ code: "LIVE_TRADING_FLAG_DETECTED", message: "flag set" }],
  });
  assert.equal(byId(out, "live_disabled").autoResult, "FAIL");
});

test("fallback-only market data FAILS the data-quality item", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    riskFlags: [{ code: "MARKET_DATA_FALLBACK_ONLY", message: "fallback" }],
  });
  assert.equal(byId(out, "data_quality").autoResult, "FAIL");
});

// DEGRADED market data reaches the coach as a governor SOFT WARNING
// (governor.ts pushes { code: "MARKET_DATA_DEGRADED" } into softWarnings), and
// UNKNOWN quality raises no signal at all. The first cut of this evaluator
// answered data_quality from hardBlocks + riskFlags only, so both states fell
// through to PASS — a green tick under the label "Market data quality is GOOD
// (not DEGRADED/FALLBACK)". These four tests pin the fail-closed behaviour.
test("DEGRADED market data (a soft warning) FAILS the data-quality item", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    softWarnings: [{ code: "MARKET_DATA_DEGRADED", message: "Build DD market data is degraded." }],
    metrics: { marketDataQuality: "DEGRADED" },
  });
  const item = byId(out, "data_quality");
  assert.equal(item.autoResult, "FAIL");
  assert.match(item.autoDetail ?? "", /DEGRADED/);
  assert.equal(byId(out, "governor_ok").autoResult, "PASS");
});

test("a reported DEGRADED quality FAILS even if the soft warning is absent", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    metrics: { marketDataQuality: "DEGRADED" },
  });
  assert.equal(byId(out, "data_quality").autoResult, "FAIL");
});

test("UNKNOWN market data quality is NOT_CHECKED — never a pass", () => {
  const out = evaluateAutoChecklist(ITEMS, {
    ...HEALTHY,
    metrics: { marketDataQuality: "UNKNOWN" },
  });
  const item = byId(out, "data_quality");
  assert.equal(item.autoResult, "NOT_CHECKED");
  assert.notEqual(item.autoResult, "PASS");
});

test("an unreported market data quality is NOT_CHECKED — never a pass", () => {
  const out = evaluateAutoChecklist(ITEMS, { ...HEALTHY, metrics: undefined });
  const item = byId(out, "data_quality");
  assert.equal(item.autoResult, "NOT_CHECKED");
  assert.match(item.autoDetail ?? "", /not reported/);
});

test("an auto item with no evaluator is NOT_CHECKED, not passed by default", () => {
  const out = evaluateAutoChecklist(
    [{ id: "some_future_item", label: "Unimplemented", required: true, auto: true }],
    HEALTHY,
  );
  assert.equal(out[0]?.autoResult, "NOT_CHECKED");
});
