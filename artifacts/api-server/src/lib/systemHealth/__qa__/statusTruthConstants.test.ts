// STATUS-TRUTH batch — dead gauges replaced with real reads.
//
// Four admin/user status surfaces asserted live-trading state as compile-time
// constants while the real arm switch lives in env +
// global_trading_settings.liveBrokerExecutionArmed and live dispatch really
// exists (lib/live/liveCommandPipeline.ts):
//
//   1. lib/systemHealth/health.ts    — liveTradingStatus:"DISABLED" /
//      mode:"PAPER_ONLY" / probeSafety canPlaceTrades:false constants.
//   2. routes/systemHealth.ts        — the same constants stamped on every
//      response envelope.
//   3. lib/release.ts                — realBrokerExecutionAvailable:false
//      behind the Release Status page's "Real broker locked: OK" pill.
//   4. routes/onboarding.ts + lib/onboarding/steps.ts — appMode:"PAPER_ONLY",
//      liveTradingStatus:"DISABLED", canPlaceLiveTrade:false on every
//      onboarding response, plus step copy claiming "this app cannot enable
//      live trading".
//
// Each now READS resolveLiveBrokerExecutionEnabledAsync() (or, per-user,
// readLiveReadiness) and degrades a failed read to UNKNOWN/null with a reason
// — never to a confident "disabled". These tests pin the source so the
// constants cannot quietly return.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../../../../../..");

function code(rel: string): string {
  // Strip comments so honesty notes describing the OLD lie don't false-positive.
  return readFileSync(resolve(ROOT, rel), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

const HEALTH = "artifacts/api-server/src/lib/systemHealth/health.ts";
const HEALTH_ROUTES = "artifacts/api-server/src/routes/systemHealth.ts";
const RELEASE = "artifacts/api-server/src/lib/release.ts";
const ONBOARDING_ROUTES = "artifacts/api-server/src/routes/onboarding.ts";
const ONBOARDING_STEPS = "artifacts/api-server/src/lib/onboarding/steps.ts";

describe("system health reports the real arm switch, not constants", () => {
  it("health.ts reads the Phase B arm switch", () => {
    const src = code(HEALTH);
    assert.match(src, /resolveLiveBrokerExecutionEnabledAsync\(\)/);
  });

  it("health.ts emits no hard-coded liveTradingStatus/mode/safety constants", () => {
    const src = code(HEALTH);
    assert.doesNotMatch(src, /liveTradingStatus: "DISABLED", mode: "PAPER_ONLY"/);
    assert.doesNotMatch(src, /canPlaceTrades: false, liveTradingAllowed: false/);
  });

  it("the route envelope no longer stamps fabricated status fields", () => {
    const src = code(HEALTH_ROUTES);
    assert.doesNotMatch(src, /liveTradingStatus: "DISABLED"/);
    assert.doesNotMatch(src, /mode: "PAPER_ONLY"/);
    assert.doesNotMatch(src, /canPlaceLiveTrade: false/);
  });
});

describe("release surfaces derive the broker-lock state", () => {
  it("release.ts reads the arm switch and never asserts a constant lock", () => {
    const src = code(RELEASE);
    assert.match(src, /resolveLiveBrokerExecutionEnabledAsync/);
    assert.doesNotMatch(src, /realBrokerExecutionAvailable: false/);
    assert.doesNotMatch(src, /canPlaceTrades: false/);
  });
});

describe("onboarding tells the per-user truth", () => {
  it("the envelope no longer hard-codes PAPER_ONLY/DISABLED", () => {
    const src = code(ONBOARDING_ROUTES);
    assert.doesNotMatch(src, /appMode: "PAPER_ONLY"/);
    assert.doesNotMatch(src, /liveTradingStatus: "DISABLED"/);
    assert.doesNotMatch(src, /canPlaceLiveTrade: false/);
  });

  it("status embeds the real per-user chain (readLiveReadiness)", () => {
    const src = code(ONBOARDING_ROUTES);
    assert.match(src, /readLiveReadiness\(uid\(req\)\)/);
  });

  it("step copy no longer claims live trading is impossible", () => {
    const src = code(ONBOARDING_STEPS);
    assert.doesNotMatch(src, /cannot enable live trading/i);
    assert.doesNotMatch(src, /Nothing here can place real trades/i);
    assert.doesNotMatch(src, /badge is always shown/i);
  });
});
