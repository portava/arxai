// Phase 6 - close reconciliation.
//
// The worker that carries venue-confirmed settlements into the guided ledger.
// These tests pin the forbidden inferences at the exact seam where each would
// be cheapest to commit: a failed read is not a close, a mismatched reply is
// not evidence, an unstated P/L is not zero, and settlement is recorded at
// most once.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reconcileGuidedClosures,
  type CloseReconcilerDeps,
  type UnreconciledAttempt,
  type VenueContractRead,
} from "../guidedCloseReconciler.js";
import { buildLineageRecord, positionStateForEvent, reconstructAttempt } from "../guidedLineage.js";

const ATTEMPT = (over: Partial<UnreconciledAttempt> = {}): UnreconciledAttempt => ({
  intentId: "di_tkt_9baa4e49-391c-4a8e-8b34-274e7146a8ea",
  ticketId: "tkt_9baa4e49-391c-4a8e-8b34-274e7146a8ea",
  venueContractRef: "11161223559",
  constitutionVersion: 1,
  ...over,
});

type Appended = Parameters<CloseReconcilerDeps["appendReconciled"]>[0];

function deps(over: {
  attempts?: UnreconciledAttempt[];
  read?: (ref: string) => Promise<VenueContractRead>;
  appendResult?: "appended" | "already";
} = {}): { d: CloseReconcilerDeps; appended: Appended[] } {
  const appended: Appended[] = [];
  const d: CloseReconcilerDeps = {
    listUnreconciled: async () => over.attempts ?? [ATTEMPT()],
    readContract: over.read
      ?? (async (ref) => ({ kind: "SETTLED", contractId: ref, profit: 0.04 })),
    appendReconciled: async (r) => { appended.push(r); return over.appendResult ?? "appended"; },
  };
  return { d, appended };
}

test("a venue-confirmed settlement appends ONE reconciled event with the verbatim P/L", async () => {
  const { d, appended } = deps();
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 1);
  assert.equal(appended[0]!.venueContractRef, "11161223559");
  assert.equal(appended[0]!.venueProfitUsd, 0.04);
  assert.equal(appended[0]!.userId, 1);
  assert.deepEqual(report.reconciled, [
    { intentId: ATTEMPT().intentId, venueContractRef: "11161223559", venueProfitUsd: 0.04 },
  ]);
  assert.equal(report.stillOpen.length + report.unreadable.length + report.anomalies.length, 0);
});

test("a venue-open contract writes NOTHING — an attempt stays open until the venue closes it", async () => {
  const { d, appended } = deps({ read: async (ref) => ({ kind: "OPEN", contractId: ref }) });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 0, "wrote a settlement for a position the venue says is open");
  assert.deepEqual(report.stillOpen, [ATTEMPT().intentId]);
});

test("a FAILED venue read writes nothing and reports UNREADABLE — absence of an answer is not a close", async () => {
  const { d, appended } = deps({ read: async () => ({ kind: "UNREADABLE", detail: "socket dropped" }) });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 0, "a failed read produced a settlement record");
  assert.equal(report.unreadable.length, 1);
  assert.match(report.unreadable[0]!.detail, /socket dropped/);
});

test("a THROWING venue read is contained per-attempt, not fatal to the run", async () => {
  const a1 = ATTEMPT();
  const a2 = ATTEMPT({ intentId: "di_tkt_second", ticketId: "tkt_second", venueContractRef: "22222222222" });
  const { d, appended } = deps({
    attempts: [a1, a2],
    read: async (ref) => {
      if (ref === a1.venueContractRef) throw new Error("transport exploded");
      return { kind: "SETTLED", contractId: ref, profit: -0.5 };
    },
  });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(report.unreadable.length, 1, "the throwing read was not contained");
  assert.equal(appended.length, 1, "the healthy attempt was not reconciled");
  assert.equal(appended[0]!.venueProfitUsd, -0.5);
});

test("a reply about a DIFFERENT contract is an anomaly, never evidence", async () => {
  const { d, appended } = deps({
    read: async () => ({ kind: "SETTLED", contractId: "99999999999", profit: 5 }),
  });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 0, "someone else's settlement was recorded against this attempt");
  assert.equal(report.anomalies.length, 1);
  assert.match(report.anomalies[0]!.detail, /different contract/);
});

test("an EXECUTED attempt with no contract ref is an anomaly — the invariant broke upstream", async () => {
  const { d, appended } = deps({ attempts: [ATTEMPT({ venueContractRef: null })] });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 0);
  assert.equal(report.anomalies.length, 1);
  assert.match(report.anomalies[0]!.detail, /no venue contract reference/);
});

test("an UNSTATED venue P/L is recorded as NULL — never zero", async () => {
  const { d, appended } = deps({
    read: async (ref) => ({ kind: "SETTLED", contractId: ref, profit: null }),
  });
  await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 1);
  assert.strictEqual(appended[0]!.venueProfitUsd, null,
    "an unstated P/L was converted into a number");
  assert.match(appended[0]!.detail, /unstated, not zero/);
});

test("an already-recorded settlement reports 'already' and is not double-counted", async () => {
  const { d, appended } = deps({ appendResult: "already" });
  const report = await reconcileGuidedClosures(1, d);
  assert.equal(appended.length, 1, "the append was still attempted (the DB decides idempotency)");
  assert.deepEqual(report.alreadyReconciled, [ATTEMPT().intentId]);
  assert.equal(report.reconciled.length, 0, "an 'already' outcome was reported as a fresh reconciliation");
});

// ── lineage integration: RECONCILED is honest and closes the attempt ────────

test("RECONCILED maps to CLOSED and completes the attempt", () => {
  assert.equal(positionStateForEvent("RECONCILED"), "CLOSED");
  const a = reconstructAttempt([
    { intentId: "i", ticketId: "t", userId: 1, liveCommandId: null, event: "EXECUTED",
      occurredAtIso: "2026-08-30T22:00:00.000Z", constitutionVersion: 1,
      venueContractRef: "11161223559", detail: "", scannerSignalId: null, rubyExplanation: null },
    { intentId: "i", ticketId: "t", userId: 1, liveCommandId: null, event: "RECONCILED",
      occurredAtIso: "2026-08-30T22:13:00.000Z", constitutionVersion: 1,
      venueContractRef: "11161223559", detail: "", scannerSignalId: null, rubyExplanation: null },
  ]);
  assert.equal(a.state, "CLOSED");
  assert.equal(a.complete, true);
  assert.equal(a.venueContractRef, "11161223559");
});

test("LINEAGE: RECONCILED without a venue contract reference is refused", () => {
  assert.throws(() => buildLineageRecord({
    intentId: "i", ticketId: "t", userId: 1, liveCommandId: null, event: "RECONCILED",
    occurredAtIso: "2026-08-30T22:13:00.000Z", constitutionVersion: 1,
    venueContractRef: null, detail: "", scannerSignalId: null, rubyExplanation: null,
  }), /venue's contract reference/);
});

test("SOURCE PIN: the observed-state ratchet releases ONLY on RECONCILED ledger evidence", async () => {
  // The DB-backed loader cannot run here, so its release valve is pinned on
  // stripped source, the same way the certificate pins the kill-switch wiring:
  // the open-position and exposure queries must exclude attempts with a
  // RECONCILED event, and the loss gates must consume reconciledLossStateForUser
  // rather than the old hard-coded zero.
  const { readFileSync } = await import("node:fs");
  const entry = readFileSync(new URL("../guidedDispatchEntry.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(entry, /event_type = 'RECONCILED'/,
    "the observed-state queries never mention RECONCILED — the ratchet has no release valve");
  assert.match(entry, /reconciledLossStateForUser/,
    "the loss gates do not consume venue-settled results");
  assert.ok(!/consecutiveLosses:\s*0\s*,/.test(entry),
    "consecutiveLosses is still the hard-coded zero — the cooldown gate is inert");
});

test("LINEAGE: a P/L riding on any event other than RECONCILED is refused", () => {
  assert.throws(() => buildLineageRecord({
    intentId: "i", ticketId: "t", userId: 1, liveCommandId: null, event: "EXECUTED",
    occurredAtIso: "2026-08-30T22:00:00.000Z", constitutionVersion: 1,
    venueContractRef: "11161223559", detail: "", scannerSignalId: null, rubyExplanation: null,
    venueProfitUsd: 0.04,
  }), /claim without a settlement/);
  // And on RECONCILED it is welcome.
  const ok = buildLineageRecord({
    intentId: "i", ticketId: "t", userId: 1, liveCommandId: null, event: "RECONCILED",
    occurredAtIso: "2026-08-30T22:13:00.000Z", constitutionVersion: 1,
    venueContractRef: "11161223559", detail: "", scannerSignalId: null, rubyExplanation: null,
    venueProfitUsd: 0.04,
  });
  assert.equal(ok.venueProfitUsd, 0.04);
});
