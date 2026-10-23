// Restart recovery for the Deriv order path (Phase 5).
//
// Each test names a CRASH WINDOW: a point where the process can die, and what
// ARX must believe afterwards. The governing rule is unchanged —
//
//   ARX may be conservative, but it may never be falsely certain.
//
// so the tests that matter most are the ones asserting ARX does NOT conclude
// "no order" from its own ignorance.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  recoverDerivIntents, toUnknownCommandFacts, toUnknownCommandEvidence, checkDuplicateOrder,
  DERIV_VENUE_TIME_TOLERANCE_MS,
  type DerivOrderIntent, type DerivVenueEvidence, type WriteDisposition,
} from "../orderIntent.js";

const NOW = new Date("2026-08-26T12:00:00Z");
const T = (offsetMs: number) => NOW.getTime() + offsetMs;

const intent = (over: Partial<DerivOrderIntent> = {}): DerivOrderIntent => ({
  intentId: "i-1", accountId: "VRTC9001", symbol: "R_100",
  contractType: "MULTUP", stake: 1, multiplier: 100,
  createdAtMs: T(-60_000), frameWrittenAtMs: T(-59_000),
  writeDisposition: "WRITTEN", outcome: null, ...over,
});

const venue = (over: Partial<DerivVenueEvidence> = {}): DerivVenueEvidence => ({
  openContracts: [], portfolioReadAtMs: T(-1_000), closedInclusive: true, statementBuys: [],
  lateReplies: [], evidenceComplete: true, ...over,
});

const one = (i: DerivOrderIntent, v: DerivVenueEvidence) =>
  recoverDerivIntents([i], v, { now: NOW })[0]!;

// ── The central subtlety ───────────────────────────────────────────────────

test("UNRECORDED is IGNORANCE, not evidence — it never resolves to no-order", async () => {
  // The whole design turns on this. Recording the write is ITSELF subject to a
  // crash window: the process can die after the socket write and before the
  // record lands. Treating a missing write record as proof nothing was sent
  // would strand a live position on exactly the crash it is meant to survive.
  const r = one(intent({ writeDisposition: "UNRECORDED", frameWrittenAtMs: null }), venue());
  assert.notEqual(r.action, "NO_ORDER_PLACED", "ignorance was read as proof of absence");
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    // With no write timestamp the classifier cannot date the order against a
    // snapshot, so absence is unprovable and it must HOLD.
    assert.equal(r.verdict.action, "HOLD");
  }
});

test("the TWO dispositions that DO prove no order", async () => {
  for (const d of ["NOT_ATTEMPTED", "REFUSED_PRE_TRANSMISSION"] as WriteDisposition[]) {
    const r = one(intent({ writeDisposition: d, frameWrittenAtMs: null }), venue());
    assert.equal(r.action, "NO_ORDER_PLACED", `${d} did not prove absence`);
  }
});

test("a WRITTEN frame is never a clean no-order, however empty the venue looks", async () => {
  // An empty portfolio plus a written frame is not proof; it is the classifier's
  // job to decide whether the snapshot actually covers the order.
  const r = one(intent({ writeDisposition: "WRITTEN" }), venue({ openContracts: [] }));
  assert.notEqual(r.action, "NO_ORDER_PLACED");
});

// ── Crash windows ──────────────────────────────────────────────────────────

test("CRASH after the buy: a matching open contract BLOCKS absence, and cannot be claimed as ours", async () => {
  // Deriv's evidence is weaker than MT5's here, and the test says so rather
  // than pretending otherwise. MT5 positions carry sourceCommandId, so a
  // position can be POSITIVELY attributed to the command that opened it.
  // Deriv contracts carry no client reference at all — so a contract on our
  // symbol opened in our window is a candidate ARX can neither confirm nor
  // rule out. The honest verdict is AMBIGUOUS, not FILLED.
  const r = one(intent(), venue({
    openContracts: [{
      contractId: 777, underlyingSymbol: "R_100", contractType: "MULTUP",
      buyPrice: 1, purchaseTimeSec: Math.floor(T(-30_000) / 1000),
    }],
  }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    assert.equal(r.verdict.action, "HOLD", "claimed a contract it cannot attribute");
    if (r.verdict.action === "HOLD") assert.equal(r.verdict.reason, "AMBIGUOUS_POSITION_MATCH");
  }
});

test("an UNDATED open contract escalates — it can be neither attributed nor ruled out", async () => {
  // The classifier's ambiguity check needs a date. An undated candidate would
  // otherwise slip past it into a positive-absence verdict, resolving away a
  // position that is genuinely open.
  const r = one(intent(), venue({
    openContracts: [{
      contractId: 777, underlyingSymbol: "R_100", contractType: "MULTUP",
      buyPrice: 1, purchaseTimeSec: null,
    }],
  }));
  assert.equal(r.action, "ESCALATE");
  if (r.action === "ESCALATE") assert.match(r.reason, /neither attributed .* nor ruled out/);
});

test("CRASH after the buy: a LATE reply recovered from durable storage resolves it", async () => {
  // The in-process orphan ledger dies with the process. If a late reply was
  // durably stored before the crash, it is still authoritative afterwards.
  const r = one(intent(), venue({ lateReplies: [{ intentId: "i-1", contractId: 4242, derivCode: null }] }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    assert.equal(r.verdict.action, "RESOLVE_FILLED");
    if (r.verdict.action === "RESOLVE_FILLED") assert.equal(r.verdict.brokerTicket, "4242");
  }
});

test("CRASH with a STALE snapshot: absence is not concluded", async () => {
  // Must isolate STALENESS. My first fixture put the snapshot an hour before
  // an order written 59s ago, so SNAPSHOT_PREDATES_COMMAND fired first — the
  // invariant held, but the test was not exercising the rule it named.
  // Order 20 minutes ago, snapshot 10 minutes ago: comfortably after the
  // order plus the settle margin, and well past the 5-minute freshness bound.
  const r = one(
    intent({ createdAtMs: T(-21 * 60_000), frameWrittenAtMs: T(-20 * 60_000) }),
    venue({ portfolioReadAtMs: T(-10 * 60_000) }),
  );
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    assert.equal(r.verdict.action, "HOLD");
    if (r.verdict.action === "HOLD") assert.equal(r.verdict.reason, "SNAPSHOT_STALE");
  }
});

test("CRASH with a snapshot taken BEFORE the order: absence is not concluded", async () => {
  // The snapshot cannot show a contract that did not exist when it was taken.
  const r = one(intent({ frameWrittenAtMs: T(-5_000) }), venue({ portfolioReadAtMs: T(-30_000) }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    assert.equal(r.verdict.action, "HOLD");
    if (r.verdict.action === "HOLD") assert.equal(r.verdict.reason, "SNAPSHOT_PREDATES_COMMAND");
  }
});

test("CRASH with NO portfolio read at all: absence is not concluded", async () => {
  const r = one(intent(), venue({ portfolioReadAtMs: null }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") {
    assert.equal(r.verdict.action, "HOLD");
    if (r.verdict.action === "HOLD") assert.equal(r.verdict.reason, "NO_COMPLETE_SNAPSHOT");
  }
});

test("INCOMPLETE evidence can never prove a negative", async () => {
  // A partial sweep is exactly when a real position is most likely to be the
  // one that was missed.
  const r = one(intent(), venue({ evidenceComplete: false }));
  assert.equal(r.action, "RESOLVED");
  if (r.action === "RESOLVED") assert.equal(r.verdict.action, "HOLD");
});

test("an ALREADY resolved intent is not re-litigated", async () => {
  const filled = one(intent({ outcome: { kind: "CONTRACT", contractId: 9 } }), venue());
  assert.equal(filled.action, "ALREADY_RESOLVED");
  const refused = one(intent({ outcome: { kind: "VENUE_REFUSED", derivCode: "InsufficientBalance" } }), venue());
  assert.equal(refused.action, "ALREADY_RESOLVED");
});

// ── The mapping onto the shared classifier ─────────────────────────────────

test("the write timestamp — not the intent timestamp — dates the order", async () => {
  // Dating from createdAtMs would let a snapshot taken before the frame ever
  // left be treated as covering the order, which is how a live position gets
  // resolved away as absent.
  // Asserted as an OFFSET FROM THE WRITE, not as a literal. The window start is
  // deliberately widened backwards by DERIV_VENUE_TIME_TOLERANCE_MS to absorb
  // second-granularity venue timestamps and clock skew; pinning the exact value
  // would test that constant rather than the invariant.
  const f = toUnknownCommandFacts(intent({ createdAtMs: T(-90_000), frameWrittenAtMs: T(-10_000) }));
  assert.equal(f.sentToMt5At?.getTime(), T(-10_000) - DERIV_VENUE_TIME_TOLERANCE_MS);
  // The invariant: derived from the WRITE, never from the intent timestamp.
  assert.ok((f.sentToMt5At?.getTime() ?? 0) > T(-90_000),
    "the window start was derived from createdAtMs, not from the write");
  // And with no confirmed write there is no reference point at all.
  assert.equal(toUnknownCommandFacts(intent({ frameWrittenAtMs: null })).sentToMt5At, null);
});

test("a contract on a DIFFERENT symbol is a non-match, not ambiguity", async () => {
  const ev = toUnknownCommandEvidence(intent(), venue({
    openContracts: [
      { contractId: 1, underlyingSymbol: "R_50", contractType: "MULTUP", buyPrice: 1, purchaseTimeSec: Math.floor(T(-30_000) / 1000) },
      { contractId: 2, underlyingSymbol: "R_100", contractType: "MULTUP", buyPrice: 1, purchaseTimeSec: Math.floor(T(-30_000) / 1000) },
    ],
  }));
  assert.equal(ev.positions.length, 1);
  assert.equal(ev.positions[0]!.brokerTicket, "2");
});

test("Deriv contracts are never LINKED to an intent — only ticket-matched", async () => {
  // Deriv has no client-reference field on a contract, so sourceCommandId must
  // be null. Claiming a link the venue cannot express would manufacture
  // certainty out of a field ARX filled in itself.
  const ev = toUnknownCommandEvidence(intent(), venue({
    openContracts: [{ contractId: 3, underlyingSymbol: "R_100", contractType: "MULTUP", buyPrice: 1, purchaseTimeSec: Math.floor(T(-30_000) / 1000) }],
  }));
  assert.equal(ev.positions[0]!.sourceCommandId, null);
});

// ── Composition, not duplication ───────────────────────────────────────────

test("recovery DELEGATES to the shared classifier rather than reimplementing it", () => {
  // Two classifiers would drift apart on exactly the judgements that matter
  // most, and only one of them has years of CI behind it.
  const code = readFileSync(new URL("../orderIntent.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  assert.match(code, /classifyUnknownCommand/, "does not use the shared classifier");
  // A local re-implementation would need its own verdict construction.
  assert.ok(!/RESOLVE_ABSENT["']?\s*[,}]/.test(code.replace(/import[\s\S]*?;/g, "")),
    "appears to construct verdicts itself instead of delegating");
});

test("this module reaches no database, network, or clock — TEXTUALLY", () => {
  // Necessary but NOT sufficient. This grep passed while the module could not
  // actually load without a database, because it imported the reconciler,
  // which imports drizzle and the db handle at module scope. A source grep
  // cannot see a transitive import.
  const code = readFileSync(new URL("../orderIntent.ts", import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["db.", "drizzle", "fetch(", "NewDerivTransport", "Date.now()"]) {
    assert.ok(!code.includes(forbidden), `orderIntent reaches ${forbidden}`);
  }
});

test("this module reaches no database — ACTUALLY, by import graph", () => {
  // The claim that matters, and the one the grep could not make. Every import
  // in the transitive graph must itself be free of a runtime database
  // dependency; the pure classifier was extracted from unknownReconciler
  // precisely so this holds.
  const seen = new Set<string>();
  const forbidden: string[] = [];
  const walk = (fileUrl: URL): void => {
    const key = fileUrl.pathname;
    if (seen.has(key)) return;
    seen.add(key);
    let src: string;
    try { src = readFileSync(fileUrl, "utf8"); } catch { return; }
    // Comments first. The extraction header for unknownClassifier EXPLAINS the
    // db dependency it exists to avoid, and matching that prose flagged the
    // very file that fixes the problem. Seventh time a source scan in this
    // workstream has matched its own documentation.
    src = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (/@workspace\/db|from "drizzle-orm"/.test(src)) forbidden.push(key.split("/src/")[1] ?? key);
    for (const m of src.matchAll(/from\s+"(\.[^"]+)\.js"/g)) {
      walk(new URL(`${m[1]}.ts`, fileUrl));
    }
  };
  walk(new URL("../orderIntent.ts", import.meta.url));
  assert.ok(seen.size > 1, "the walk did not follow any import");
  assert.deepEqual(forbidden, [],
    `orderIntent transitively imports a database module: ${forbidden.join(", ")}`);
});
