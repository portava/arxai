// QA — R4 slice 3 prep: broker-confirmed live-ENTRY dispatch gate (pure predicate)
// (docs/prodready-20260819/audit-reports/audit-marketdata.md §3.4;
//  replit-command-arx-R4-marketdata-provenance.md slice 3).
//
// Truth-table proofs of the ENFORCING predicate the wave-4 pipeline integrator
// wires as a hard refusal (the pipeline itself is NOT touched here — today it
// consumes the feed verdict observe-only). Locks:
//   1. `isBrokerConfirmedLive`: only a LIVE verdict from mt5_broker or a
//      Deriv-backed source confirms; assistant_real:* NEVER does — fresh
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
