// Task #785 (option 2) — Live dispatch PREFLIGHT consumes the unified readiness
// resolver as ADDITIVE/OBSERVATIONAL metadata only.
//
// This locks the safety contract of the observation layer the live dispatch
// preflight wires in (buildLivePreflightReadinessObservation):
//   1. The preflight can READ the unified resolver and attach its verdict to a
//      diagnostic record (metadata is present + shaped).
//   2. The observation can NEVER create a bypass — even a fully-eligible unified
//      verdict does not flip a blocked preflight to a pass.
//   3. The observation can NEVER weaken/replace a real gate — a blocked
//      preflight stays blocked regardless of what the resolver reports.
//   4. Additive resolver blockers (resolver sees a block the preflight let pass)
//      are surfaced in diagnostics, but only as observation — not as a decision.
//   5. A fail-soft (null) resolver leaves the preflight outcome untouched.
//
// It also statically asserts the live command pipeline actually CONSUMES the
// resolver + observation builder at the preflight (so the wiring is real, not
// just defined).
//
// Offline / pure: no DB, no network, no providers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decideUnifiedLiveReadiness,
  type UnifiedLiveReadinessInput,
} from "../../artifacts/api-server/src/lib/live/unifiedLiveReadinessDecision.js";
import { buildLivePreflightReadinessObservation } from "../../artifacts/api-server/src/lib/live/livePreflightReadinessObservation.js";

let passed = 0;
function ok(label: string, cond: boolean) {
  assert.ok(cond, label);
  passed += 1;
  // eslint-disable-next-line no-console
  console.log(`  PASS  ${label}`);
}

// A fully live-ready input (zero blockers) for a human trader with a symbol in
// context. Toggling any single field below introduces exactly one blocker.
function readyInput(): UnifiedLiveReadinessInput {
  return {
    userId: 1,
    email: "trader@example.com",
    role: "USER",
    isInvestor: false,
    isBotAgentSystem: false,
    isHumanTrader: true,
    accountMode: "LIVE",
    liveApproved: true,
    sharedBridgeApproved: true,
    fullLiveActivation: true,
    armed: true,
    serverLiveExecutionOn: true,
    killSwitchEngaged: false,
    emergencyKillSwitch: false,
    riskProfileReady: true,
    bridgeMode: "MASTER_LIVE_SHARED",
    bridgeHeartbeatFresh: true,
    brokerAccountId: 123,
    allocationSource: "SHARED_MASTER_POOL",
    allocatedAmount: 1000,
    availableLiveAllocation: 1000,
    hasAllocation: true,
    symbol: "EURUSD",
    brokerSymbol: "EURUSD",
    normalizedSymbol: "EURUSD",
    selectedTimeframe: "M1",
    lastTickAt: new Date().toISOString(),
    lastCandleAt: new Date().toISOString(),
    feedSource: "mt5_broker",
    feedConfirmed: true,
    missingIntervals: 0,
    symbolLiveEligible: true,
  };
}

test("preflight observation — metadata is read and shaped", () => {
  const unified = decideUnifiedLiveReadiness(readyInput());
  ok("ready input ⇒ unified liveEntryEligible true", unified.liveEntryEligible === true);

  const obs = buildLivePreflightReadinessObservation({
    preflightBlocked: false,
    preflightReason: null,
    unified,
  });
  ok("observation is marked observationOnly", obs.observationOnly === true);
  ok("observation carries the unified eligibility hint", obs.unifiedLiveEntryEligible === true);
  ok("observation records resolver was resolved", obs.unifiedResolved === true);
  ok("observation exposes blocker codes array", Array.isArray(obs.unifiedBlockerCodes));
});

test("preflight observation — CANNOT create a bypass", () => {
  // Resolver says fully eligible, but the canonical preflight BLOCKED. The
  // observation must keep the preflight's blocked truth — it never grants entry.
  const unified = decideUnifiedLiveReadiness(readyInput());
  const obs = buildLivePreflightReadinessObservation({
    preflightBlocked: true,
    preflightReason: "MISSING_STOP_LOSS",
    unified,
  });
  ok("blocked preflight stays blocked even when resolver is eligible", obs.preflightBlocked === true);
  ok("blocked preflight preserves its canonical reason", obs.preflightReason === "MISSING_STOP_LOSS");
  ok(
    "a blocked preflight reports no 'additional' blockers (it is already refusing)",
    obs.additionalBlockersNotInPreflight.length === 0,
  );
  ok(
    "no observation field can express 'allow' — only observationOnly + descriptive data",
    obs.observationOnly === true && !("ok" in obs) && !("allow" in obs) && !("pass" in obs),
  );
});

test("preflight observation — additive resolver blockers are visible in diagnostics", () => {
  // Preflight PASSED, but the resolver sees a feed-not-confirmed block. This is
  // exactly the drift case: surface it as observation, never block on it here.
  const input = readyInput();
  input.feedConfirmed = false; // resolver now reports BROKER_FEED_NOT_CONFIRMED
  const unified = decideUnifiedLiveReadiness(input);
  ok("resolver now reports at least one blocker", unified.blockers.length >= 1);

  const obs = buildLivePreflightReadinessObservation({
    preflightBlocked: false,
    preflightReason: null,
    unified,
  });
  ok("observation flags an additional block while preflight passed", obs.unifiedReportsAdditionalBlock === true);
  ok(
    "the additional blocker is surfaced for diagnostics",
    obs.additionalBlockersNotInPreflight.some((b) => b.code === "BROKER_FEED_NOT_CONFIRMED"),
  );
  ok("but the unified eligibility hint is honestly false", obs.unifiedLiveEntryEligible === false);
});

test("preflight observation — fail-soft (null resolver) is inert", () => {
  const obs = buildLivePreflightReadinessObservation({
    preflightBlocked: false,
    preflightReason: null,
    unified: null,
  });
  ok("null resolver ⇒ unifiedResolved false", obs.unifiedResolved === false);
  ok("null resolver ⇒ eligibility hint false (fail-closed)", obs.unifiedLiveEntryEligible === false);
  ok("null resolver ⇒ no additional-block claim", obs.unifiedReportsAdditionalBlock === false);
  ok("null resolver ⇒ empty blocker codes", obs.unifiedBlockerCodes.length === 0);
});

test("preflight wiring — the live command pipeline consumes the resolver", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const pipelinePath = join(
    here,
    "../../artifacts/api-server/src/lib/live/liveCommandPipeline.ts",
  );
  const raw = readFileSync(pipelinePath, "utf8");
  // Strip block + line comments and string/template literals so the scan can
  // never false-pass off documentation or quoted text.
  const code = raw
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/\/\/[^\n]*/g, " ")
    .replace(/`(?:\\.|[^`\\])*`/g, " ")
    .replace(/"(?:\\.|[^"\\])*"/g, " ")
    .replace(/'(?:\\.|[^'\\])*'/g, " ");

  ok(
    "pipeline imports buildUnifiedLiveReadiness",
    /import\s*\{[^}]*\bbuildUnifiedLiveReadiness\b[^}]*\}\s*from/.test(code),
  );
  ok(
    "pipeline imports buildLivePreflightReadinessObservation",
    /import\s*\{[^}]*\bbuildLivePreflightReadinessObservation\b[^}]*\}\s*from/.test(code),
  );
  ok(
    "pipeline actually CALLS buildUnifiedLiveReadiness",
    /\bbuildUnifiedLiveReadiness\s*\(/.test(code),
  );
  ok(
    "pipeline actually CALLS the observation builder",
    /\bbuildLivePreflightReadinessObservation\s*\(/.test(code),
  );
});

process.on("exit", () => {
  // eslint-disable-next-line no-console
  console.log(`\nlive-preflight-readiness-observation: ${passed}/${passed} passed`);
});
