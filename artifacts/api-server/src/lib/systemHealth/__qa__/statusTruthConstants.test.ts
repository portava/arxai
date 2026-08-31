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

describe("health probes fail closed instead of defaulting to healthy zeros", () => {
  it("a failed safety_core read becomes a SAFETY_STATE_UNKNOWN hard block, not an empty list", () => {
    const src = code(HEALTH);
    // The old shape: db.select().from(safetyCoreTable).limit(1).catch(() => [])
    // swallowed a failed read and the page rendered "Hard blocks: none" while
    // the kill switch might be engaged and unreadable.
    assert.doesNotMatch(src, /safetyCoreTable\)\.limit\(1\)\.catch/);
    assert.match(src, /SAFETY_STATE_UNKNOWN/);
  });

  it("secret-redaction probes degrade to null (unknown), never to 0 leaks / working:true", () => {
    const src = code(HEALTH);
    // No catch handler may fabricate a zero count for the secret scans.
    assert.doesNotMatch(src, /catch\(\(\) => \(\{ rows: \[\{ c: 0 \}\]/);
    // redactionWorking must be tri-state: null when either probe failed.
    assert.match(src, /redactionWorking: ff === null \|\| lf === null \? null : ff === 0 && lf === 0/);
  });

  it("critical-unread and row-count probes report null on failure, not 0", () => {
    const src = code(HEALTH);
    assert.doesNotMatch(src, /\.catch\(\(\) => \[\{ c: 0 \}\]\)/);
    assert.match(src, /latestNotificationCriticalCount: number \| null/);
  });

  it("a null redactionWorking is surfaced as a warning, and false stays an error", () => {
    const src = code(HEALTH);
    assert.match(src, /redactionWorking === false\) errors\.push/);
    assert.match(src, /redactionWorking === null/);
  });
});

const ADMIN_RUNTIME = "artifacts/api-server/src/routes/adminRuntimeHealth.ts";

describe("admin runtime-health distinguishes a failed bridge aggregate from zero bridges", () => {
  it("the bridge envelope carries an ok flag set only after the query succeeds", () => {
    const src = code(ADMIN_RUNTIME);
    assert.match(src, /ok: false/);
    assert.match(src, /bridge\.ok = true/);
  });
});

describe("release gates are probed, never hard-coded green", () => {
  it("no gate is pushed with a literal pass:true", () => {
    const src = code(RELEASE);
    // push("key", "Label", true, ...) — a dead gauge rendered as a PASS pill.
    assert.doesNotMatch(src, /push\("[a-z0-9_]+", "[^"]*", true[,)]/);
  });

  it("the arm-switch gate probes readability instead of asserting honesty", () => {
    const src = code(RELEASE);
    assert.match(src, /arm_switch_readable/);
    assert.doesNotMatch(src, /mt5_deferred_honesty_pass/);
  });
});

const RELEASE_ROUTES = "artifacts/api-server/src/routes/release.ts";

describe("release notes known issues come from the real tracker", () => {
  it("the route no longer serves a hard-coded empty knownIssues array", () => {
    const src = code(RELEASE_ROUTES);
    assert.doesNotMatch(src, /knownIssues: \[\]/);
    assert.match(src, /listOpenKnownIssues/);
  });

  it("lib/release exposes the open-P0/P1 query with a null (unavailable) failure state", () => {
    const src = code(RELEASE);
    assert.match(src, /export async function listOpenKnownIssues/);
    assert.match(src, /"P0", "P1"/);
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

  it("step routes no longer point at removed pages or admin-only surfaces", () => {
    // STALE_UNLABELED: the catalogue routed REQUIRED steps at
    // /trading-cockpit and /paper-testing-launch (routes deleted in Phase 3)
    // and at admin surfaces on no trader allowlist, so RouteAccessGuard
    // silently bounced every such "Open …" click home. The trading-dashboard
    // side (lib/inAppHrefAllowlist.test.ts) proves each surviving route is
    // declared and trader-allowlisted; this pins the dead targets out of the
    // server catalogue itself.
    const src = code(ONBOARDING_STEPS);
    for (const dead of [
      "/trading-cockpit", "/paper-testing-launch", "/readiness-checklist",
      "/risk-settings", "/session-report", "/replay-simulator",
      "/data-import", "/system-health", "/trader-coach",
    ]) {
      assert.doesNotMatch(src, new RegExp(`page_route: "${dead.replaceAll("/", "\\/")}"`), `steps must not route to ${dead}`);
    }
    // The completion copy named the removed page as the user's home base.
    assert.doesNotMatch(src, /Trading Cockpit/);
  });
});
