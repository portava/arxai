// QA — R4 slice 3 prep: broker-confirmed live-ENTRY dispatch gate (pure predicate)
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §3.4;
//  replit-command-arx-R4-marketdata-provenance.md slice 3).
//
// Truth-table proofs of the ENFORCING predicate the wave-4 pipeline calls as a
// hard refusal before selecting a bridge. Locks:
//   1. `isBrokerConfirmedLive`: only a LIVE verdict from mt5_broker or a
//      existing Deriv-backed source confirms; deriv_public/assistant_real:* never do — fresh
//      third-party data is fresh, not broker-confirmed.
//   2. `evaluateLiveEntryFeedGate`: ENTRY-only; CLOSE/REDUCE/MODIFY exempt
//      (they manage existing exposure). Same-bridge binding: mismatch AND
//      missing attribution both refuse (fail-closed — unproven same-bridge is
//      not same-bridge).
//   3. Enforcement default-ON: only an explicit disable value of
//      ARX_ENFORCE_BROKER_CONFIRMED_FEED turns it off, and then violations are
//      still REPORTED (observe parity) while `allowed` stays true.
//   4. Purity: same inputs → same decision (no env/DB/feed reads inside).
//
// Offline: pure functions only; the dummy DATABASE_URL satisfies transitive
// @workspace/db module init (established pattern — see
// src/lib/live/__qa__/emergencyKillSwitchPreGate.test.ts). No query is issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/data/__qa__/brokerConfirmedGate.test.ts
process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSymbolFeedVerdict } from "../symbolFeedVerdict.js";
import { rawTrailingIntervalGap } from "../chart/candleNormalization.js";
import { decideUnifiedLiveReadiness, type UnifiedLiveReadinessInput } from "../../live/unifiedLiveReadinessDecision.js";

const {
  isBrokerConfirmedLive,
  evaluateLiveEntryFeedGate,
  brokerFeedGateEnforcementEnabled,
  BROKER_FEED_GATE_ENV,
} = await import("../brokerConfirmedFeed.js");

test("the override env var name is CI-pinned", () => {
  assert.equal(BROKER_FEED_GATE_ENV, "ARX_ENFORCE_BROKER_CONFIRMED_FEED");
});

test("isBrokerConfirmedLive truth table", () => {
  const cases: Array<{ verdict: "LIVE" | "LIVE_DELAYED" | "AWAITING"; source: string | null; derivBacked: boolean; expect: boolean }> = [
    { verdict: "LIVE", source: "mt5_broker", derivBacked: false, expect: true },
    { verdict: "LIVE", source: "deriv", derivBacked: true, expect: true },
    { verdict: "LIVE", source: "deriv_public", derivBacked: true, expect: false },
    { verdict: "LIVE", source: "deriv_public", derivBacked: false, expect: false },
    // Fresh third-party data is fresh — NOT broker-confirmed.
    { verdict: "LIVE", source: "assistant_real:twelve_data", derivBacked: false, expect: false },
    { verdict: "LIVE", source: "assistant_real:polygon", derivBacked: false, expect: false },
    { verdict: "LIVE", source: null, derivBacked: false, expect: false },
    // Non-LIVE verdicts never confirm, whatever the source.
    { verdict: "LIVE_DELAYED", source: "mt5_broker", derivBacked: false, expect: false },
    { verdict: "AWAITING", source: "mt5_broker", derivBacked: false, expect: false },
    { verdict: "LIVE_DELAYED", source: "deriv", derivBacked: true, expect: false },
    { verdict: "AWAITING", source: null, derivBacked: false, expect: false },
  ];
  for (const c of cases) {
    assert.equal(
      isBrokerConfirmedLive({ verdict: c.verdict, source: c.source, derivBacked: c.derivBacked }),
      c.expect,
      `verdict=${c.verdict} source=${String(c.source)} derivBacked=${c.derivBacked}`,
    );
  }
});

test("enforcement flag parse: default-ON, only explicit disable values turn it off", () => {
  for (const raw of [undefined, null, "", "1", "true", "on", "yes", "enforce", "typo-value"]) {
    assert.equal(brokerFeedGateEnforcementEnabled(raw), true, `raw=${String(raw)} must ENFORCE (fail-closed)`);
  }
  for (const raw of ["0", "false", "off", "disabled", "no", " FALSE ", "Off"]) {
    assert.equal(brokerFeedGateEnforcementEnabled(raw), false, `raw=${String(raw)} must disable`);
  }
});

const CONFIRMED = { verdict: "LIVE" as const, source: "mt5_broker", derivBacked: false };
const UNCONFIRMED = { verdict: "LIVE" as const, source: "assistant_real:twelve_data", derivBacked: false };

test("ENTRY + confirmed feed, no bridge binding requested → allowed", () => {
  const d = evaluateLiveEntryFeedGate({ intent: "ENTRY", ...CONFIRMED });
  assert.equal(d.allowed, true);
  assert.equal(d.violation, null);
  assert.equal(d.refusalCode, null);
  assert.equal(d.feedConfirmed, true);
  assert.equal(d.enforcing, true);
  assert.equal(d.intentExempt, false);
});

test("ENTRY + confirmed feed from the SAME bridge → allowed", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", ...CONFIRMED,
    feedBridgeConnectionId: 5, executionBridgeConnectionId: 5,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.violation, null);
});

test("ENTRY + confirmed feed from a DIFFERENT bridge → refused BROKER_FEED_BRIDGE_MISMATCH", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", ...CONFIRMED,
    feedBridgeConnectionId: 9, executionBridgeConnectionId: 5,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.refusalCode, "BROKER_FEED_BRIDGE_MISMATCH");
});

test("ENTRY + confirmed but UNATTRIBUTED feed with a named executing bridge → refused (fail-closed)", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", ...CONFIRMED,
    feedBridgeConnectionId: null, executionBridgeConnectionId: 5,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.refusalCode, "BROKER_FEED_BRIDGE_UNATTRIBUTED");
});

test("ENTRY + unconfirmed feed → refused BROKER_FEED_NOT_CONFIRMED even with matching bridges", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", ...UNCONFIRMED,
    feedBridgeConnectionId: 5, executionBridgeConnectionId: 5,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
  assert.equal(d.feedConfirmed, false);
});

test("feed-quality violation takes precedence over bridge-binding violations", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", verdict: "AWAITING", source: null, derivBacked: false,
    feedBridgeConnectionId: null, executionBridgeConnectionId: 5,
  });
  assert.equal(d.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
});

test("CLOSE / REDUCE / MODIFY are exempt — violations reported but never refused", () => {
  for (const intent of ["CLOSE", "REDUCE", "MODIFY"] as const) {
    const d = evaluateLiveEntryFeedGate({
      intent, ...UNCONFIRMED,
      feedBridgeConnectionId: null, executionBridgeConnectionId: 5,
    });
    assert.equal(d.allowed, true, `${intent} must never be blocked by the feed gate`);
    assert.equal(d.refusalCode, null);
    assert.equal(d.intentExempt, true);
    assert.equal(d.violation, "BROKER_FEED_NOT_CONFIRMED", "the violation stays visible for observability");
  }
});

test("disable override: ENTRY violation observed, not refused; violation still named", () => {
  const d = evaluateLiveEntryFeedGate({ intent: "ENTRY", ...UNCONFIRMED, enforceEnvValue: "0" });
  assert.equal(d.enforcing, false);
  assert.equal(d.allowed, true);
  assert.equal(d.refusalCode, null);
  assert.equal(d.violation, "BROKER_FEED_NOT_CONFIRMED");
});

test("purity: identical inputs yield identical decisions", () => {
  const input = {
    intent: "ENTRY" as const, ...CONFIRMED,
    feedBridgeConnectionId: 9, executionBridgeConnectionId: 5,
  };
  assert.deepEqual(evaluateLiveEntryFeedGate(input), evaluateLiveEntryFeedGate(input));
});

function recentPublicFeed() {
  const now = Date.parse("2026-10-26T12:00:30.000Z");
  const tickEpoch = (now - 1000) / 1000;
  const candles = [{ time: "2026-10-26T12:00:00.000Z", open: 100, high: 101, low: 99, close: 100.5, volume: 0 }];
  const source = "deriv_public";
  const trailingIntervals = rawTrailingIntervalGap(candles, source, "M1", now);
  const hasRecentTick = now - tickEpoch * 1000 >= 0 && now - tickEpoch * 1000 <= 30_000;
  return {
    connected: true,
    accountIdentity: null,
    candles,
    tickEpoch,
    source,
    derivBacked: true,
    verdict: resolveSymbolFeedVerdict({ hasRecentTick, trailingIntervals }),
  };
}

test("connected public ticks and candles stay LIVE for analysis but cannot satisfy the unbound ENTRY feed gate", () => {
  const feed = recentPublicFeed();
  assert.equal(feed.connected, true);
  assert.equal(feed.accountIdentity, null);
  assert.equal(feed.verdict, "LIVE", "fresh public market data must not be falsified into stale/unavailable data");
  const before = structuredClone(feed);
  const decision = evaluateLiveEntryFeedGate({ intent: "ENTRY", ...feed });
  assert.equal(decision.feedConfirmed, false);
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
  assert.deepEqual(feed, before, "execution refusal never mutates chart/analysis facts");
});

test("a claimed matching bridge cannot promote public-only provenance into execution evidence", () => {
  const decision = evaluateLiveEntryFeedGate({ intent: "ENTRY", ...recentPublicFeed(), feedBridgeConnectionId: 7, executionBridgeConnectionId: 7 });
  assert.equal(decision.allowed, false);
  assert.equal(decision.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
});

test("public-only provenance does not trap existing exposure or hide an explicit enforcement override", () => {
  for (const intent of ["CLOSE", "REDUCE", "MODIFY"] as const) {
    const decision = evaluateLiveEntryFeedGate({ intent, ...recentPublicFeed() });
    assert.equal(decision.allowed, true);
    assert.equal(decision.intentExempt, true);
    assert.equal(decision.feedConfirmed, false);
    assert.equal(decision.violation, "BROKER_FEED_NOT_CONFIRMED");
  }
  const overridden = evaluateLiveEntryFeedGate({ intent: "ENTRY", ...recentPublicFeed(), enforceEnvValue: "0" });
  assert.equal(overridden.allowed, true, "existing owner override semantics remain unchanged");
  assert.equal(overridden.feedConfirmed, false, "an override cannot manufacture feed evidence");
  assert.equal(overridden.violation, "BROKER_FEED_NOT_CONFIRMED");
});

function readyAccountWithPublicFeed(): UnifiedLiveReadinessInput {
  const feed = recentPublicFeed();
  return {
    userId: 7, email: "offline@example.invalid", role: "USER", isInvestor: false, isBotAgentSystem: false, isHumanTrader: true,
    accountMode: "LIVE", liveApproved: true, sharedBridgeApproved: true, fullLiveActivation: true, armed: true,
    serverLiveExecutionOn: true, killSwitchEngaged: false, platformStopSources: [], riskProfileReady: true,
    bridgeMode: "MASTER_LIVE_SHARED", bridgeHeartbeatFresh: true, brokerAccountId: 42,
    allocationSource: "SHARED_MASTER_POOL", allocatedAmount: 1000, availableLiveAllocation: 800, hasAllocation: true,
    symbol: "V75", brokerSymbol: "V75", normalizedSymbol: "V75", selectedTimeframe: "M1",
    lastTickAt: new Date(feed.tickEpoch * 1000).toISOString(), lastCandleAt: feed.candles[0].time,
    feedSource: feed.source, feedConfirmed: isBrokerConfirmedLive(feed), missingIntervals: 0, symbolLiveEligible: true,
  };
}

test("unified readiness remains entry-blocked even when other account and bridge checks pass", () => {
  const state = decideUnifiedLiveReadiness(readyAccountWithPublicFeed());
  assert.equal(state.liveEntryEligible, false);
  assert.deepEqual(state.blockers.map((blocker) => blocker.code), ["BROKER_FEED_NOT_CONFIRMED"]);
  assert.equal(state.feedSource, "deriv_public");
});

test("public data cannot clear absent-account, arming, stop, or symbol-mapping blockers", () => {
  const state = decideUnifiedLiveReadiness({
    ...readyAccountWithPublicFeed(), brokerAccountId: null, sharedBridgeApproved: false,
    fullLiveActivation: false, armed: false, killSwitchEngaged: true,
    platformStopSources: ["platform_emergency_stop", "safety_core_kill_switch"], symbolLiveEligible: false,
  });
  assert.equal(state.liveEntryEligible, false);
  assert.equal(state.liveExecutionActive, false);
  for (const code of ["LIVE_BRIDGE_ASSIGNMENT_PENDING", "LIVE_CONFIRMATION_REQUIRED", "LIVE_ARMING_PENDING", "KILL_SWITCH_ENGAGED", "EMERGENCY_STOP_ACTIVE", "SAFETY_CORE_KILL_SWITCH_ENGAGED", "SYMBOL_NOT_LIVE_ELIGIBLE", "BROKER_FEED_NOT_CONFIRMED"]) {
    assert.ok(state.blockers.some((blocker) => blocker.code === code), `${code} remains authoritative`);
  }
});
