// #59 Minimum-Intelligence Baseline — pure engine + worker helper tests
// (OFFLINE) + no-execution pin.
//
// Locks:
//   * DETERMINISM: identical inputs produce identical decisions (the control
//     group must be reproducible or it proves nothing).
//   * TRUSTWORTHY DATA OR NOTHING: an untrusted source, a short series, a
//     malformed bar, or out-of-order bars are TYPED refusals — never a
//     decision.
//   * THE ONE EDGE: close above the prior-N high → BUY with stop at the
//     prior-N low; below the prior-N low → SELL; inside the channel → the
//     honest NO_BREAKOUT wait.
//   * HARD RISK: a zero stop distance or a stop wider than maxStopFraction
//     refuses the trade.
//   * DETERMINISTIC, COST-ADJUSTED RESOLUTION: win = +1R − costs, loss =
//     −1R − costs, both-touched bar settles as loss (no benefit of the
//     doubt), unresolved stays OPEN with pnlR null.
//   * NO EXECUTION (pin): neither the engine nor the worker source touches
//     executeInstant, dispatch, the live pipeline, or an adapter deliver.
//   * Env opt-out parsing + deterministic shadow ids.
//
// Run: pnpm --filter @workspace/api-server run test:minimum-baseline

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const {
  decideBaseline,
  resolveBaselineOutcome,
  DEFAULT_BASELINE_CONFIG,
  isTrustedBaselineSource,
} = await import("../minimumIntelligenceBaseline.js");
type BaselineCandle = import("../minimumIntelligenceBaseline.js").BaselineCandle;
type BaselineDecisionTrade = import("../minimumIntelligenceBaseline.js").BaselineDecisionTrade;

const {
  baselineComparatorEnabled,
  baselineShadowId,
  baselineConfigForPrice,
  DECLARED_ROUND_TRIP_SPREAD_FRAC,
  MIN_INTEL_BASELINE_STRATEGY,
} = await import("../baselineComparatorWorker.js");

const BAR_MS = 15 * 60 * 1000;
const T0 = Date.UTC(2026, 0, 5, 0, 0, 0);

/** Flat channel at [99, 101], then a decision bar closing at `lastClose`. */
function series(lastClose: number, n = DEFAULT_BASELINE_CONFIG.lookback): BaselineCandle[] {
  const out: BaselineCandle[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ openTimeMs: T0 + i * BAR_MS, open: 100, high: 101, low: 99, close: 100 });
  }
  out.push({
    openTimeMs: T0 + n * BAR_MS,
    open: 100,
    high: Math.max(101, lastClose),
    low: Math.min(99, lastClose),
    close: lastClose,
  });
  return out;
}

test("determinism: identical inputs, identical decision", () => {
  const a = decideBaseline(series(102), "mt5_broker");
  const b = decideBaseline(series(102), "mt5_broker");
  assert.deepEqual(a, b);
});

test("BUY breakout: close above prior-N high, stop at prior-N low, 1R target", () => {
  const d = decideBaseline(series(102), "mt5_broker");
  assert.equal(d.kind, "TRADE");
  const t = d as BaselineDecisionTrade;
  assert.equal(t.action, "BUY");
  assert.equal(t.entry, 102);
  assert.equal(t.stop, 99);
  assert.equal(t.riskPerUnit, 3);
  assert.equal(t.target, 105);
});

test("SELL breakout: close below prior-N low, stop at prior-N high", () => {
  const d = decideBaseline(series(98), "deriv");
  assert.equal(d.kind, "TRADE");
  const t = d as BaselineDecisionTrade;
  assert.equal(t.action, "SELL");
  assert.equal(t.stop, 101);
  assert.equal(t.target, 98 - 3);
});

test("inside the channel is the honest NO_BREAKOUT wait", () => {
  const d = decideBaseline(series(100.5), "mt5_broker");
  assert.equal(d.kind, "REFUSAL");
  assert.equal((d as { reason: string }).reason, "NO_BREAKOUT");
});

test("untrusted source refuses — trustworthy data is the first pillar", () => {
  for (const src of ["SYNTHETIC_SIMULATOR", "assistant_real:foo", "", "scanner"]) {
    const d = decideBaseline(series(102), src);
    assert.equal(d.kind, "REFUSAL");
    assert.equal((d as { reason: string }).reason, "DATA_SOURCE_UNTRUSTED");
    assert.equal(isTrustedBaselineSource(src), false);
  }
});

test("insufficient bars refuse (typed), never a guessed decision", () => {
  const d = decideBaseline(series(102).slice(0, 10), "mt5_broker");
  assert.equal(d.kind, "REFUSAL");
  assert.equal((d as { reason: string }).reason, "DATA_INSUFFICIENT");
});

test("malformed and out-of-order bars refuse", () => {
  const bad = series(102);
  bad[3] = { ...bad[3]!, high: Number.NaN };
  assert.equal((decideBaseline(bad, "mt5_broker") as { reason: string }).reason, "DATA_MALFORMED");

  const shuffled = series(102);
  const tmp = shuffled[2]!;
  shuffled[2] = shuffled[3]!;
  shuffled[3] = tmp;
  assert.equal((decideBaseline(shuffled, "mt5_broker") as { reason: string }).reason, "DATA_NOT_ASCENDING");
});

test("hard risk: stop wider than maxStopFraction refuses the trade", () => {
  // Channel low 99, entry pushed far above → huge stop distance.
  const d = decideBaseline(series(120), "mt5_broker", { ...DEFAULT_BASELINE_CONFIG, maxStopFraction: 0.05 });
  assert.equal(d.kind, "REFUSAL");
  assert.equal((d as { reason: string }).reason, "STOP_TOO_WIDE");
});

function trade(): BaselineDecisionTrade {
  return decideBaseline(series(102), "mt5_broker") as BaselineDecisionTrade;
}

function bar(offset: number, over: Partial<BaselineCandle>): BaselineCandle {
  return {
    openTimeMs: T0 + (DEFAULT_BASELINE_CONFIG.lookback + 1 + offset) * BAR_MS,
    open: 102, high: 102, low: 102, close: 102,
    ...over,
  };
}

test("resolution: target hit = +1R minus declared costs", () => {
  const cfg = { ...DEFAULT_BASELINE_CONFIG, spread: 0.3 }; // 0.3 price units on 3R risk = 0.1R
  const o = resolveBaselineOutcome(trade(), [bar(0, { high: 105.5, low: 101 })], cfg);
  assert.equal(o.status, "WIN");
  assert.ok(Math.abs((o.pnlR ?? 0) - 0.9) < 1e-9);
});

test("resolution: stop hit = -1R minus costs (costs never flatter a loss)", () => {
  const cfg = { ...DEFAULT_BASELINE_CONFIG, spread: 0.3 };
  const o = resolveBaselineOutcome(trade(), [bar(0, { low: 98.9, high: 103 })], cfg);
  assert.equal(o.status, "LOSS");
  assert.ok(Math.abs((o.pnlR ?? 0) - -1.1) < 1e-9);
});

test("a bar touching BOTH stop and target settles as loss — no benefit of the doubt", () => {
  const o = resolveBaselineOutcome(trade(), [bar(0, { low: 98, high: 106 })]);
  assert.equal(o.status, "AMBIGUOUS_BAR");
  assert.equal(o.pnlR, -1);
});

test("unresolved stays OPEN with pnlR null — unresolved evidence is never scored", () => {
  const o = resolveBaselineOutcome(trade(), [bar(0, { low: 101, high: 103 })]);
  assert.equal(o.status, "OPEN");
  assert.equal(o.pnlR, null);
});

test("bars at or before the decision bar resolve nothing (no lookahead)", () => {
  const t = trade();
  const before: BaselineCandle = { openTimeMs: t.decisionBarOpenTimeMs, open: 100, high: 200, low: 1, close: 100 };
  const o = resolveBaselineOutcome(t, [before]);
  assert.equal(o.status, "OPEN");
});

test("worker helpers: deterministic shadow id + declared-cost config + env opt-out", () => {
  assert.equal(baselineShadowId("R_75", 123), "minb:R_75:M15:123");
  assert.equal(baselineShadowId("R_75", 123), baselineShadowId("R_75", 123));
  const cfg = baselineConfigForPrice(100);
  assert.ok(Math.abs(cfg.spread - 100 * DECLARED_ROUND_TRIP_SPREAD_FRAC) < 1e-12);
  assert.equal(baselineConfigForPrice(-5).spread, 0);

  assert.equal(baselineComparatorEnabled(undefined), true);
  assert.equal(baselineComparatorEnabled("1"), true);
  for (const v of ["0", "false", "off", "no", " FALSE "]) {
    assert.equal(baselineComparatorEnabled(v), false);
  }
  assert.equal(MIN_INTEL_BASELINE_STRATEGY, "MIN_INTEL_BASELINE");
});

test("NO EXECUTION pin: baseline sources never touch dispatch or adapters", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const f of ["../minimumIntelligenceBaseline.ts", "../baselineComparatorWorker.ts"]) {
    const src = readFileSync(path.join(here, f), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "executeInstant",
      "liveCommandPipeline",
      "dispatchApprovedDraft",
      "dispatchGuidedTicket",
      ".deliver(",
      "guidedDispatchEntry",
      "ARX_EXECUTION_TIER",
    ]) {
      assert.ok(
        !src.includes(forbidden),
        `${f} must never reference ${forbidden} — the baseline is evidence only`,
      );
    }
  }
});
