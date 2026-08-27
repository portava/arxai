// Phase 6 — lineage honesty + autonomous sweeper.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  positionStateForEvent, positionStateLabel, buildLineageRecord, reconstructAttempt,
  GUIDED_AUDIT_EVENTS, TERMINAL_AUDIT_EVENTS,
  type GuidedLineageRecord,
} from "../guidedLineage.js";
import {
  startGuidedSweeperWorker, stopGuidedSweeperWorker, guidedSweeperIsRunning,
  GUIDED_SWEEP_INTERVAL_MS, GUIDED_SWEEP_BATCH,
} from "../guidedSweeperWorker.js";

const rec = (over: Partial<GuidedLineageRecord> = {}): GuidedLineageRecord => ({
  intentId: "di_1", ticketId: "tkt_1", userId: 7, liveCommandId: "gc_1",
  event: "PROPOSAL_CREATED", occurredAtIso: "2026-08-26T12:00:00.000Z",
  constitutionVersion: 4, venueContractRef: null, detail: "scanner setup",
  scannerSignalId: "sig_1", rubyExplanation: "trend continuation", ...over,
});

// ── the forbidden inferences are unreachable ──────────────────────────────
test("UNKNOWN maps to UNRESOLVED — never CLOSED, never no-position", () => {
  assert.equal(positionStateForEvent("EXECUTION_UNKNOWN"), "UNRESOLVED");
});

test("a CONTRADICTION needs a human, not another poll", () => {
  assert.equal(positionStateForEvent("CONTRADICTION"), "RECONCILIATION_REQUIRED");
});

test("a DRY RUN is closed with NO contract — nothing was ever sent", () => {
  assert.equal(positionStateForEvent("DRY_RUN_REFUSED"), "CLOSED");
  assert.throws(() => buildLineageRecord(rec({ event: "DRY_RUN_REFUSED", venueContractRef: "c1" })),
    /LINEAGE_REFUSED/, "a dry run produced a venue contract reference");
});

test("UNKNOWN and CONTRADICTION are NOT terminal", () => {
  assert.ok(!TERMINAL_AUDIT_EVENTS.includes("EXECUTION_UNKNOWN"));
  assert.ok(!TERMINAL_AUDIT_EVENTS.includes("CONTRADICTION"));
});

test("every audit event maps to a state, and none is left to a default", () => {
  for (const e of GUIDED_AUDIT_EVENTS) {
    const s = positionStateForEvent(e);
    assert.ok(s, `${e} has no position state`);
    // An unrecognised event must fall to RECONCILIATION_REQUIRED, never CLOSED.
    assert.notEqual(positionStateForEvent("__unknown__" as never), "CLOSED");
  }
});

test("the UNRESOLVED label never reads as no-trade, failed or closed", () => {
  const label = positionStateLabel("UNRESOLVED");
  assert.ok(/unknown/i.test(label), `label must say unknown: ${label}`);
  assert.ok(/may exist/i.test(label), `label must say an order may exist: ${label}`);
  assert.ok(!/no trade|failed|did not|closed/i.test(label), `label claims absence: ${label}`);
});

// ── lineage records refuse dishonesty rather than sanitising ──────────────
test("an UNKNOWN record cannot carry a contract reference", () => {
  assert.throws(() => buildLineageRecord(rec({ event: "EXECUTION_UNKNOWN", venueContractRef: "c1" })),
    /LINEAGE_REFUSED/);
});

test("EXECUTED REQUIRES the venue's own contract reference", () => {
  assert.throws(() => buildLineageRecord(rec({ event: "EXECUTED", venueContractRef: null })), /LINEAGE_REFUSED/);
  assert.throws(() => buildLineageRecord(rec({ event: "EXECUTED", venueContractRef: "  " })), /LINEAGE_REFUSED/);
  assert.doesNotThrow(() => buildLineageRecord(rec({ event: "EXECUTED", venueContractRef: "10548672559" })));
});

test("a record with no intent id is refused — the attempt could not be reconstructed", () => {
  assert.throws(() => buildLineageRecord(rec({ intentId: "" })), /LINEAGE_REFUSED/);
});

test("a lineage record carrying a secret is REFUSED, not silently redacted", () => {
  assert.throws(() => buildLineageRecord(rec({ detail: "Bearer sk_abcdefghijklmnopqrstuvwx" })),
    /SECRET_LEAK_REFUSED/, "a credential was written into the audit trail");
  assert.throws(() => buildLineageRecord({ ...rec(), derivApiToken: "x" } as never), /SECRET_LEAK_REFUSED/);
});

// ── reconstruction ────────────────────────────────────────────────────────
test("one intent id reconstructs the whole attempt", () => {
  const r = reconstructAttempt([
    rec({ event: "PROPOSAL_CREATED" }),
    rec({ event: "USER_APPROVED" }),
    rec({ event: "DISPATCH_CLAIMED" }),
    rec({ event: "EXECUTED", venueContractRef: "10548672559" }),
  ]);
  assert.equal(r.intentId, "di_1");
  assert.equal(r.state, "OPEN");
  assert.equal(r.venueContractRef, "10548672559");
  assert.equal(r.complete, true);
  assert.deepEqual(r.events, ["PROPOSAL_CREATED", "USER_APPROVED", "DISPATCH_CLAIMED", "EXECUTED"]);
});

test("UNCERTAINTY IS STICKY — a later record cannot quietly make it certain", () => {
  // Without stickiness, any subsequent non-evidence record would overwrite
  // UNRESOLVED and the attempt would silently read as settled.
  const r = reconstructAttempt([
    rec({ event: "DISPATCH_CLAIMED" }),
    rec({ event: "EXECUTION_UNKNOWN" }),
    rec({ event: "TICKET_EXPIRED" }),          // a timer, not evidence
  ]);
  assert.equal(r.state, "UNRESOLVED", "an expiry made an unknown outcome look closed");
  assert.equal(r.complete, false, "an uncertain attempt was reported complete");
});

test("only venue evidence lifts uncertainty", () => {
  const resolved = reconstructAttempt([
    rec({ event: "EXECUTION_UNKNOWN" }),
    rec({ event: "RECONCILED" }),
  ]);
  assert.equal(resolved.state, "CLOSED");
  assert.equal(resolved.complete, true);

  const stillOpen = reconstructAttempt([
    rec({ event: "EXECUTION_UNKNOWN" }),
    rec({ event: "EXECUTED", venueContractRef: "c9" }),
  ]);
  assert.equal(stillOpen.state, "OPEN");
  assert.equal(stillOpen.venueContractRef, "c9");
});

test("an empty lineage is RECONCILIATION_REQUIRED, not a clean slate", () => {
  const r = reconstructAttempt([]);
  assert.equal(r.state, "RECONCILIATION_REQUIRED");
  assert.equal(r.complete, false);
});

// ── the sweeper is autonomous and leaks no timer ──────────────────────────
test("the sweeper starts, is idempotent, and stops cleanly — TIMERS COUNTED", () => {
  // Counting timers, not reading a boolean. A non-idempotent start creates a
  // SECOND interval and overwrites the handle, so the first leaks and fires
  // forever — while `guidedSweeperIsRunning()` still reports true. The boolean
  // cannot see that; only the create/clear ledger can.
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  let created = 0, cleared = 0;
  globalThis.setInterval = (() => { created++; return { unref: () => ({}) }; }) as never;
  globalThis.clearInterval = (() => { cleared++; }) as never;
  try {
    stopGuidedSweeperWorker();
    created = 0; cleared = 0;

    startGuidedSweeperWorker();
    assert.equal(created, 1, "the sweeper did not start");
    assert.equal(guidedSweeperIsRunning(), true);

    startGuidedSweeperWorker();
    assert.equal(created, 1,
      `a second start created another timer (${created} total) — the first leaks and fires forever`);

    stopGuidedSweeperWorker();
    assert.equal(cleared, 1, "stop did not clear the interval");
    assert.equal(guidedSweeperIsRunning(), false);
    assert.equal(created, cleared, `${created} timer(s) created but ${cleared} cleared — a timer leaked`);
  } finally {
    globalThis.setInterval = realSet;
    globalThis.clearInterval = realClear;
    stopGuidedSweeperWorker();
  }
});

test("the sweeper WAKES AUTONOMOUSLY — a real timer fires without being driven", async () => {
  // Proves the worker is scheduled, not merely callable. The interval is
  // monkeypatched down for the test; the module's own timer plumbing runs.
  const realSetInterval = globalThis.setInterval;
  let fired = 0;
  // @ts-expect-error test double
  globalThis.setInterval = (fn: () => void) => {
    const t = realSetInterval(() => { fired++; fn(); }, 5);
    return { unref: () => t } as never;
  };
  try {
    stopGuidedSweeperWorker();
    startGuidedSweeperWorker();
    await new Promise((r) => realSetInterval(r, 40));
    assert.ok(fired > 0, "the sweeper never woke on its own");
  } finally {
    globalThis.setInterval = realSetInterval;
    stopGuidedSweeperWorker();
  }
});

test("the sweeper is registered in the application lifecycle, not manual-only", () => {
  const index = readFileSync(new URL("../../../index.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(index, /startGuidedSweeperWorker\s*\(\s*\)/,
    "the sweeper is not started by the app lifecycle — it would require a manual command");
});

test("the sweeper NEVER expires DISPATCHING or UNRESOLVED", () => {
  // The exclusion lives in the repository query. Asserted on stripped source so
  // the comment explaining it cannot satisfy the assertion.
  const repo = readFileSync(
    new URL("../../../../../../lib/db/src/repositories/approvalTicketsRepo.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  const fn = repo.slice(repo.indexOf("export async function expireStaleTickets"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.ok(body.includes("'PENDING','APPROVED'"), "the expiry query no longer names its allowed states");
  assert.ok(!body.includes("DISPATCHING"), "the expiry query can reach DISPATCHING tickets");
  assert.ok(!body.includes("UNRESOLVED"), "the expiry query can reach UNRESOLVED tickets");
});

test("sweep bounds are set so one backlog cannot monopolise a tick", () => {
  assert.ok(GUIDED_SWEEP_BATCH > 0 && GUIDED_SWEEP_BATCH <= 1000);
  assert.ok(GUIDED_SWEEP_INTERVAL_MS >= 1000);
});
