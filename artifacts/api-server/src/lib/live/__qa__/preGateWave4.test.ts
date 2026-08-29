// Wave-4 dispatch pre-gates — R3 slices 4 (price collar), 5 (signal age),
// 7 (failure-streak breaker), the correlation-cluster guard (R3 slice 6 pure
// core wired), and the R4 slice 3 broker-confirmed-feed gate (now ENFORCING).
//
// These are pure-unit proofs of the extracted decision helpers (no DB, no
// network — extracted exactly so these contracts run offline), plus
// source-order proofs that dispatchLiveCommand consults every new pre-gate
// AFTER the risk-lock pre-gate and BEFORE the 23-gate evaluator, and that
// recordLiveCommandResult owns the failure-streak breaker. Structure mirrors
// riskPreGates.test.ts / emergencyKillSwitchPreGate.test.ts.
//
// Importing ../liveCommandPipeline.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; the pg Pool is lazy and NO query is ever issued by
// these tests.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/preGateWave4.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const {
  PRICE_DEVIATION_BLOCK_REASON,
  priceCollarBlocksDispatch,
  SIGNAL_TOO_OLD_BLOCK_REASON,
  signalAgeBlocksDispatch,
  CLUSTER_BLOCK_REASON_PREFIX,
  clusterExposureBlockReason,
  BROKER_FEED_BLOCK_REASON,
  FAILURE_STREAK_LOCK_TYPE,
  FAILURE_STREAK_THRESHOLD,
  FAILURE_STREAK_LOCK_MINUTES,
  countConsecutiveTerminalFailures,
  failureStreakShouldLock,
  REQUIRED_MARGIN_PROXY_PER_LOT_USD,
} = await import("../liveCommandPipeline.js");

const {
  evaluateLiveEntryFeedGate,
  brokerFeedGateEnforcementEnabled,
  BROKER_FEED_GATE_ENV,
} = await import("../../data/brokerConfirmedFeed.js");

// ── Reason literals (CI-pinned) ─────────────────────────────────────────────

test("wave-4 block-reason literals are CI-pinned", () => {
  assert.equal(PRICE_DEVIATION_BLOCK_REASON, "LIVE_BLOCKED:PRICE_DEVIATION_TOO_LARGE");
  assert.equal(SIGNAL_TOO_OLD_BLOCK_REASON, "LIVE_BLOCKED:SIGNAL_TOO_OLD");
  assert.equal(CLUSTER_BLOCK_REASON_PREFIX, "LIVE_BLOCKED:CLUSTER_");
  assert.equal(BROKER_FEED_BLOCK_REASON, "LIVE_BLOCKED:BROKER_FEED_NOT_CONFIRMED");
  assert.equal(BROKER_FEED_GATE_ENV, "ARX_ENFORCE_BROKER_CONFIRMED_FEED");
});

test("failure-streak breaker constants are CI-pinned", () => {
  assert.equal(FAILURE_STREAK_LOCK_TYPE, "FAILURE_STREAK");
  assert.equal(FAILURE_STREAK_THRESHOLD, 3);
  assert.equal(FAILURE_STREAK_LOCK_MINUTES, 30);
  assert.equal(REQUIRED_MARGIN_PROXY_PER_LOT_USD, 1000);
});

// ── R3 slice 4 — price collar ───────────────────────────────────────────────

test("collar: deviation over the cap refuses an entry", () => {
  // requested 1.1000 vs reference 1.1200 → |Δ|/ref ≈ 178.6 bps > 100 bps cap.
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 100,
      requestedPrice: 1.1,
      referencePrice: 1.12,
      side: "BUY",
      isEntryCommand: true,
    }),
    true,
  );
});

test("collar: deviation inside the cap passes", () => {
  // requested 1.1000 vs reference 1.1005 → ≈ 4.5 bps < 100 bps cap.
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 100,
      requestedPrice: 1.1,
      referencePrice: 1.1005,
      side: "BUY",
      isEntryCommand: true,
    }),
    false,
  );
  // SELL side uses the same |requested-vs-reference| distance.
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 100,
      requestedPrice: 1.1,
      referencePrice: 1.1005,
      side: "SELL",
      isEntryCommand: true,
    }),
    false,
  );
});

test("collar: cap NULL = gate skipped (fail-open — slippage stays delegated to the EA)", () => {
  for (const unset of [null, undefined]) {
    assert.equal(
      priceCollarBlocksDispatch({
        maxEntryDeviationBps: unset,
        requestedPrice: 1.0,
        referencePrice: 2.0, // wild deviation — still skipped, no cap demanded
        side: "BUY",
        isEntryCommand: true,
      }),
      false,
      `cap ${String(unset)} must skip the server collar`,
    );
    assert.equal(
      priceCollarBlocksDispatch({
        maxEntryDeviationBps: unset,
        requestedPrice: null,
        referencePrice: null, // even unresolvable prices: no cap, no gate
        side: "BUY",
        isEntryCommand: true,
      }),
      false,
    );
  }
});

test("collar: cap SET + missing/unresolvable reference price is FAIL-CLOSED", () => {
  for (const badRef of [null, undefined, 0, -1, Number.NaN]) {
    assert.equal(
      priceCollarBlocksDispatch({
        maxEntryDeviationBps: 100,
        requestedPrice: 1.1,
        referencePrice: badRef,
        side: "BUY",
        isEntryCommand: true,
      }),
      true,
      `reference ${String(badRef)} with a cap set must refuse, never guess`,
    );
  }
});

test("collar: cap SET + missing draft requested price is FAIL-CLOSED", () => {
  for (const badReq of [null, undefined, 0, -3, Number.NaN]) {
    assert.equal(
      priceCollarBlocksDispatch({
        maxEntryDeviationBps: 100,
        requestedPrice: badReq,
        referencePrice: 1.1,
        side: "SELL",
        isEntryCommand: true,
      }),
      true,
      `requested ${String(badReq)} with a cap set must refuse (no approved-price provenance)`,
    );
  }
});

test("collar: corrupt cap (non-finite / negative) is FAIL-CLOSED, never 'unset'", () => {
  for (const corrupt of [Number.NaN, -10, Number.POSITIVE_INFINITY]) {
    assert.equal(
      priceCollarBlocksDispatch({
        maxEntryDeviationBps: corrupt,
        requestedPrice: 1.1,
        referencePrice: 1.1,
        side: "BUY",
        isEntryCommand: true,
      }),
      true,
      `corrupt cap ${String(corrupt)} must refuse`,
    );
  }
});

test("collar: a cap of 0 bps is a REAL zero-tolerance collar, never 'unlimited'", () => {
  // Zero deviation passes (strictly greater-than, mirroring the shared guard).
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 0,
      requestedPrice: 1.1,
      referencePrice: 1.1,
      side: "BUY",
      isEntryCommand: true,
    }),
    false,
  );
  // Any measurable deviation refuses.
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 0,
      requestedPrice: 1.1,
      referencePrice: 1.1001,
      side: "BUY",
      isEntryCommand: true,
    }),
    true,
  );
});

test("collar: ENTRY-ONLY — close/modify pass even with a breached collar", () => {
  assert.equal(
    priceCollarBlocksDispatch({
      maxEntryDeviationBps: 1,
      requestedPrice: 1.0,
      referencePrice: 2.0,
      side: "BUY",
      isEntryCommand: false,
    }),
    false,
  );
});

// ── R3 slice 5 — signal age ─────────────────────────────────────────────────

const NOW = new Date("2026-08-20T12:00:00.000Z");

test("signal: older than the bound refuses an entry", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 60_000,
      signalTimestamp: new Date(NOW.getTime() - 60_001),
      isEntryCommand: true,
      now: NOW,
    }),
    true,
  );
});

test("signal: at/under the bound passes (strictly age > bound)", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 60_000,
      signalTimestamp: new Date(NOW.getTime() - 60_000),
      isEntryCommand: true,
      now: NOW,
    }),
    false,
    "age exactly at the bound must pass",
  );
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 60_000,
      signalTimestamp: new Date(NOW.getTime() - 1_000),
      isEntryCommand: true,
      now: NOW,
    }),
    false,
  );
});

test("signal: bound NULL = no bound — even an ancient or missing stamp passes", () => {
  for (const unset of [null, undefined]) {
    assert.equal(
      signalAgeBlocksDispatch({
        maxSignalAgeMs: unset,
        signalTimestamp: new Date("2020-01-01T00:00:00Z"),
        isEntryCommand: true,
        now: NOW,
      }),
      false,
    );
    assert.equal(
      signalAgeBlocksDispatch({
        maxSignalAgeMs: unset,
        signalTimestamp: null,
        isEntryCommand: true,
        now: NOW,
      }),
      false,
    );
  }
});

test("signal: bound SET + missing stamp is FAIL-CLOSED (a bound demands provenance)", () => {
  for (const missing of [null, undefined]) {
    assert.equal(
      signalAgeBlocksDispatch({
        maxSignalAgeMs: 60_000,
        signalTimestamp: missing,
        isEntryCommand: true,
        now: NOW,
      }),
      true,
      `signalTimestamp ${String(missing)} with a bound set must refuse`,
    );
  }
});

test("signal: bound SET + unparseable stamp is FAIL-CLOSED", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 60_000,
      signalTimestamp: "not-a-timestamp",
      isEntryCommand: true,
      now: NOW,
    }),
    true,
  );
});

test("signal: corrupt bound (non-finite / negative) is FAIL-CLOSED, never 'no bound'", () => {
  for (const corrupt of [Number.NaN, -1, Number.POSITIVE_INFINITY]) {
    assert.equal(
      signalAgeBlocksDispatch({
        maxSignalAgeMs: corrupt,
        signalTimestamp: NOW,
        isEntryCommand: true,
        now: NOW,
      }),
      true,
      `corrupt bound ${String(corrupt)} must refuse`,
    );
  }
});

test("signal: a bound of 0 ms is a REAL bound — any positive age refuses, zero age passes", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 0,
      signalTimestamp: NOW,
      isEntryCommand: true,
      now: NOW,
    }),
    false,
  );
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 0,
      signalTimestamp: new Date(NOW.getTime() - 1),
      isEntryCommand: true,
      now: NOW,
    }),
    true,
  );
});

test("signal: a FUTURE stamp passes (clock skew must not spuriously refuse)", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 60_000,
      signalTimestamp: new Date(NOW.getTime() + 5_000),
      isEntryCommand: true,
      now: NOW,
    }),
    false,
  );
});

test("signal: ENTRY-ONLY — close/modify pass even with an ancient stamp + bound", () => {
  assert.equal(
    signalAgeBlocksDispatch({
      maxSignalAgeMs: 1,
      signalTimestamp: new Date("2020-01-01T00:00:00Z"),
      isEntryCommand: false,
      now: NOW,
    }),
    false,
  );
});

// ── Correlation-cluster guard ───────────────────────────────────────────────
// Same-symbol rows always share a cluster (even unknown families cluster
// per-symbol), so EURUSD-vs-EURUSD keeps these matrices independent of the
// family map's contents.

test("cluster: clustered risk over the USD cap refuses with LIVE_BLOCKED:CLUSTER_RISK_EXCEEDED", () => {
  const block = clusterExposureBlockReason({
    candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 600 },
    openPositions: [{ symbol: "EURUSD", side: "BUY", riskAmount: 500 }],
    maxClusterRiskUsd: 1_000,
    maxClusterPositions: null,
    isEntryCommand: true,
  });
  assert.ok(block, "1100 > 1000 must refuse");
  assert.equal(block.reason, "LIVE_BLOCKED:CLUSTER_RISK_EXCEEDED");
  assert.equal(block.evaluation.clusterRisk, 1_100);
  assert.equal(block.evaluation.clusterCount, 2);
});

test("cluster: clustered position count over the cap refuses with LIVE_BLOCKED:CLUSTER_POSITIONS_EXCEEDED", () => {
  const block = clusterExposureBlockReason({
    candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 10 },
    openPositions: [{ symbol: "EURUSD", side: "BUY", riskAmount: 10 }],
    maxClusterRiskUsd: null,
    maxClusterPositions: 1,
    isEntryCommand: true,
  });
  assert.ok(block, "count 2 > cap 1 must refuse");
  assert.equal(block.reason, "LIVE_BLOCKED:CLUSTER_POSITIONS_EXCEEDED");
});

test("cluster: under both caps passes; opposite-direction rows give no cluster (and no credit)", () => {
  assert.equal(
    clusterExposureBlockReason({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 600 },
      openPositions: [
        { symbol: "EURUSD", side: "BUY", riskAmount: 300 },
        // Opposite direction: belongs to the SELL cluster, never offsets BUY.
        { symbol: "EURUSD", side: "SELL", riskAmount: 10_000 },
      ],
      maxClusterRiskUsd: 1_000,
      maxClusterPositions: 5,
      isEntryCommand: true,
    }),
    null,
  );
});

test("cluster: BOTH caps NULL = no cap configured — gate skipped entirely", () => {
  assert.equal(
    clusterExposureBlockReason({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 1e9 },
      openPositions: [{ symbol: "EURUSD", side: "BUY", riskAmount: 1e9 }],
      maxClusterRiskUsd: null,
      maxClusterPositions: undefined,
      isEntryCommand: true,
    }),
    null,
  );
});

test("cluster: with a cap set, evaluator validation refusals block FAIL-CLOSED", () => {
  // Corrupt open-position row must never silently create capacity.
  const badRow = clusterExposureBlockReason({
    candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 100 },
    openPositions: [{ symbol: "EURUSD", side: "???", riskAmount: 100 }],
    maxClusterRiskUsd: 1_000,
    maxClusterPositions: null,
    isEntryCommand: true,
  });
  assert.ok(badRow);
  assert.equal(badRow.reason, "LIVE_BLOCKED:CLUSTER_OPEN_POSITION_INVALID");
  // Corrupt candidate.
  const badCandidate = clusterExposureBlockReason({
    candidate: { symbol: "", side: "BUY", riskAmount: 100 },
    openPositions: [],
    maxClusterRiskUsd: 1_000,
    maxClusterPositions: null,
    isEntryCommand: true,
  });
  assert.ok(badCandidate);
  assert.equal(badCandidate.reason, "LIVE_BLOCKED:CLUSTER_CANDIDATE_INVALID");
  // Corrupt cap (negative) refuses rather than degrading to "no cap".
  const badCap = clusterExposureBlockReason({
    candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 100 },
    openPositions: [],
    maxClusterRiskUsd: -1,
    maxClusterPositions: null,
    isEntryCommand: true,
  });
  assert.ok(badCap);
  assert.equal(badCap.reason, "LIVE_BLOCKED:CLUSTER_CAP_INVALID");
});

test("cluster: a cap of 0 is a REAL cap of zero capacity, never 'unlimited'", () => {
  const block = clusterExposureBlockReason({
    candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 1 },
    openPositions: [],
    maxClusterRiskUsd: 0,
    maxClusterPositions: null,
    isEntryCommand: true,
  });
  assert.ok(block, "any candidate risk must exceed a zero cap");
  assert.equal(block.reason, "LIVE_BLOCKED:CLUSTER_RISK_EXCEEDED");
});

test("cluster: ENTRY-ONLY — close/modify pass even over every cap", () => {
  assert.equal(
    clusterExposureBlockReason({
      candidate: { symbol: "EURUSD", side: "BUY", riskAmount: 1e9 },
      openPositions: [{ symbol: "EURUSD", side: "BUY", riskAmount: 1e9 }],
      maxClusterRiskUsd: 1,
      maxClusterPositions: 0,
      isEntryCommand: false,
    }),
    null,
  );
});

// ── R4 slice 3 — broker-confirmed-feed gate (pure predicate matrix) ────────

test("feed: enforcement is DEFAULT-ON — env absent/empty/typo all enforce; only explicit disable values turn it off", () => {
  for (const enforcing of [null, undefined, "", "1", "true", "flase" /* typo stays ON */]) {
    assert.equal(brokerFeedGateEnforcementEnabled(enforcing), true,
      `env ${String(enforcing)} must ENFORCE`);
  }
  for (const disabled of ["false", "0", "off", "disabled", "no", " FALSE "]) {
    assert.equal(brokerFeedGateEnforcementEnabled(disabled), false,
      `env ${JSON.stringify(disabled)} must disable`);
  }
});

test("feed: ENTRY on an unconfirmed feed refuses with the pinned literal (default-ON)", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY",
    verdict: "AWAITING",
    source: null,
    derivBacked: false,
    enforceEnvValue: null, // absence enforces
  });
  assert.equal(d.allowed, false);
  assert.equal(d.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
  assert.equal(`LIVE_BLOCKED:${d.refusalCode}`, BROKER_FEED_BLOCK_REASON);
});

test("feed: a fresh third-party REST fallback is NOT broker-confirmed — ENTRY refuses", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY",
    verdict: "LIVE",
    source: "assistant_real:twelvedata",
    derivBacked: false,
    enforceEnvValue: null,
  });
  assert.equal(d.allowed, false);
  assert.equal(d.refusalCode, "BROKER_FEED_NOT_CONFIRMED");
});

test("feed: broker-grade LIVE feeds allow the entry (mt5 bars / deriv tick-confirmed)", () => {
  assert.equal(
    evaluateLiveEntryFeedGate({
      intent: "ENTRY", verdict: "LIVE", source: "mt5_broker",
      derivBacked: false, enforceEnvValue: null,
    }).allowed,
    true,
  );
  assert.equal(
    evaluateLiveEntryFeedGate({
      intent: "ENTRY", verdict: "LIVE", source: "deriv",
      derivBacked: true, enforceEnvValue: null,
    }).allowed,
    true,
  );
});

test("feed: CLOSE/REDUCE/MODIFY are exempt even on a dead feed (never trap exposure)", () => {
  for (const intent of ["CLOSE", "REDUCE", "MODIFY"] as const) {
    const d = evaluateLiveEntryFeedGate({
      intent, verdict: "AWAITING", source: null,
      derivBacked: false, enforceEnvValue: null,
    });
    assert.equal(d.allowed, true, `${intent} must be exempt`);
    assert.equal(d.intentExempt, true);
  }
});

test("feed: explicit 'false' disables enforcement — allowed, but the violation is still reported", () => {
  const d = evaluateLiveEntryFeedGate({
    intent: "ENTRY", verdict: "AWAITING", source: null,
    derivBacked: false, enforceEnvValue: "false",
  });
  assert.equal(d.allowed, true);
  assert.equal(d.refusalCode, null);
  assert.equal(d.violation, "BROKER_FEED_NOT_CONFIRMED", "observe-only parity: the violation must stay visible");
});

// ── R3 slice 7 — failure streak ─────────────────────────────────────────────

test("streak: consecutive terminal failures count from newest", () => {
  assert.equal(countConsecutiveTerminalFailures([]), 0);
  assert.equal(countConsecutiveTerminalFailures(["LIVE_FAILED"]), 1);
  assert.equal(
    countConsecutiveTerminalFailures(["LIVE_FAILED", "LIVE_REJECTED", "LIVE_FAILED"]),
    3,
  );
});

test("streak: a broker-confirmed success (FILLED/CLOSED) RESETS the streak", () => {
  assert.equal(
    countConsecutiveTerminalFailures(["LIVE_FAILED", "LIVE_FILLED", "LIVE_FAILED", "LIVE_FAILED"]),
    1,
  );
  assert.equal(
    countConsecutiveTerminalFailures(["LIVE_REJECTED", "LIVE_CLOSED", "LIVE_REJECTED"]),
    1,
  );
  assert.equal(countConsecutiveTerminalFailures(["LIVE_FILLED", "LIVE_FAILED", "LIVE_FAILED"]), 0);
});

test("streak: neutral statuses neither extend nor reset (a gate refusal is not broker success)", () => {
  assert.equal(
    countConsecutiveTerminalFailures([
      "LIVE_FAILED", "LIVE_BLOCKED", "LIVE_FAILED", "LIVE_CANCELLED",
      "LIVE_EXPIRED", "LIVE_UNKNOWN", "LIVE_REJECTED",
    ]),
    3,
    "BLOCKED/CANCELLED/EXPIRED/UNKNOWN must not launder a streak back to zero",
  );
});

test("streak: threshold rule engages at >= 3 and never on non-finite input", () => {
  assert.equal(failureStreakShouldLock(2), false);
  assert.equal(failureStreakShouldLock(3), true);
  assert.equal(failureStreakShouldLock(7), true);
  assert.equal(failureStreakShouldLock(Number.NaN), false);
});

// ── Source-order proofs ─────────────────────────────────────────────────────

const pipelineSource = readFileSync(
  fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
  "utf8",
);

test("dispatchLiveCommand consults all four wave-4 pre-gates AFTER the risk-lock gate and BEFORE the 23-gate evaluator", () => {
  const dispatchStart = pipelineSource.indexOf("export async function dispatchLiveCommand");
  assert.ok(dispatchStart > 0, "dispatchLiveCommand must exist");
  const riskLockAt = pipelineSource.indexOf("activeRiskLockBlockReason({", dispatchStart);
  const collarAt = pipelineSource.indexOf("priceCollarBlocksDispatch({", dispatchStart);
  const signalAt = pipelineSource.indexOf("signalAgeBlocksDispatch({", dispatchStart);
  const clusterAt = pipelineSource.indexOf("clusterExposureBlockReason({", dispatchStart);
  const feedAt = pipelineSource.indexOf("evaluateLiveEntryFeedGate({", dispatchStart);
  const evaluatorAt = pipelineSource.indexOf("evaluateLivePhaseBDispatchGate({", dispatchStart);
  assert.ok(riskLockAt > 0, "risk-lock pre-gate must still run");
  assert.ok(evaluatorAt > 0, "the 23-gate evaluator must still run");
  for (const [name, at] of [
    ["price collar", collarAt],
    ["signal age", signalAt],
    ["cluster guard", clusterAt],
    ["broker feed", feedAt],
  ] as const) {
    assert.ok(at > 0, `dispatchLiveCommand must consult the ${name} pre-gate`);
    assert.ok(at > riskLockAt, `the ${name} pre-gate must run AFTER the risk-lock pre-gate`);
    assert.ok(at < evaluatorAt, `the ${name} pre-gate must run BEFORE the 23-gate evaluator`);
  }
});

test("recordLiveCommandResult owns the failure-streak breaker (count + risk_locks insert, try/caught)", () => {
  const resultStart = pipelineSource.indexOf("export async function recordLiveCommandResult");
  assert.ok(resultStart > 0, "recordLiveCommandResult must exist");
  const countAt = pipelineSource.indexOf("countConsecutiveTerminalFailures(", resultStart);
  const lockInsertAt = pipelineSource.indexOf("db.insert(riskLocksTable)", resultStart);
  assert.ok(countAt > 0, "recordLiveCommandResult must count the failure streak");
  assert.ok(lockInsertAt > countAt, "the risk_locks insert must follow the streak count");
  // Best-effort contract: the breaker must sit inside a try/catch so streak
  // accounting can never break result recording.
  const tryAt = pipelineSource.lastIndexOf("try {", countAt);
  assert.ok(tryAt > resultStart, "the streak breaker must be try/caught");
});

test("the preflight broker-rule guard still delegates slippage to the EA (requestedPrice: null)", () => {
  // R3 slice 4 changes DISPATCH only; the draft-time guard keeps its
  // documented fail-open slippage delegation.
  assert.ok(
    pipelineSource.includes("requestedPrice: null, // server does not enforce slippage"),
    "preflight must keep requestedPrice:null in the broker-rule guard",
  );
});

test("schema carries the wave-4 columns (signal_timestamp + the four nullable caps)", () => {
  const schemaSource = readFileSync(
    fileURLToPath(new URL(
      "../../../../../../lib/db/src/schema/arxLiveExecution.ts",
      import.meta.url,
    )),
    "utf8",
  );
  for (const col of [
    "signal_timestamp",
    "max_entry_deviation_bps",
    "max_signal_age_ms",
    "max_cluster_risk_usd",
    "max_cluster_positions",
  ]) {
    assert.ok(schemaSource.includes(`"${col}"`), `schema must define ${col}`);
  }
});
