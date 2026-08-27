// Phase 6 — the guided read surfaces: position centre, journal, debrief.
//
// These are the surfaces a trader actually looks at, so a dishonest state here
// is a dishonest state to a human about their own money. Source-scanned on
// STRIPPED source, because these files describe the forbidden inferences in
// prose and a raw match would pass on the comment.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { reconstructAttempt, positionStateLabel, type GuidedLineageRecord }
  from "../guidedLineage.js";

const strip = (p: string): string =>
  readFileSync(new URL(p, import.meta.url), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

const POSITIONS = strip("../../../routes/meGuidedPositions.ts");
const INBOX = strip("../../../routes/meApprovalInbox.ts");
const ENTRY = strip("../guidedDispatchEntry.ts");

const rec = (over: Partial<GuidedLineageRecord> = {}): GuidedLineageRecord => ({
  intentId: "di_1", ticketId: "tkt_1", userId: 7, liveCommandId: null,
  event: "PROPOSAL_CREATED", occurredAtIso: "2026-08-26T12:00:00.000Z",
  constitutionVersion: 4, venueContractRef: null, detail: "",
  scannerSignalId: null, rubyExplanation: null, ...over,
});

// ── the three forbidden inferences are structurally unreachable ───────────
test("the position surface never reads a venue portfolio at all", () => {
  // "Portfolio absence = no position" cannot be made if no portfolio is read.
  // The surface derives state from the recorded ledger only.
  for (const forbidden of ["portfolio", "openContracts", "proposal_open_contract"]) {
    assert.ok(!new RegExp(forbidden, "i").test(POSITIONS),
      `the position surface reads ${forbidden}, which invites inferring absence`);
  }
});

test("the position surface derives state from the ledger, not from a guess", () => {
  assert.match(POSITIONS, /reconstructAttempt/, "state is not derived from the recorded events");
  assert.match(POSITIONS, /positionStateLabel/, "the honest label is not used");
});

test("UNRESOLVED is surfaced as needing reconciliation, and counted at the top level", () => {
  assert.match(POSITIONS, /needsReconciliation/, "unresolved attempts are not flagged");
  assert.match(POSITIONS, /unresolvedCount/,
    "the unresolved count is not surfaced where a UI cannot bury it");
});

test("every guided read surface is owner-scoped in the QUERY", () => {
  assert.match(POSITIONS, /listUserAttemptEvents\(\s*\n?\s*userId/,
    "an attempt is read without scoping to the authenticated user");
  assert.ok(!/listAttemptEvents\(/.test(POSITIONS),
    "the surface uses the UNSCOPED reader, which can return another user's attempt");
  // 404 not 403 — "forbidden" confirms the id is real.
  assert.match(POSITIONS, /ATTEMPT_NOT_FOUND/);
  assert.ok(!/403/.test(POSITIONS), "a 403 confirms the attempt exists");
});

test("no read surface can emit a credential-shaped value", () => {
  for (const src of [POSITIONS, INBOX]) {
    assert.match(src, /assertNoSecretLeak/, "a response is emitted without the secret check");
  }
});

// ── the debrief refuses to invent an outcome ──────────────────────────────
test("a debrief on an UNRESOLVED attempt withholds analysis AND says why", () => {
  assert.match(POSITIONS, /analysisAvailable/, "the debrief does not gate its analysis");
  assert.match(POSITIONS, /analysisWithheldReason/,
    "the debrief withholds analysis silently, which reads as 'nothing to say'");
});

test("an unresolved attempt is not complete, so its debrief is withheld", () => {
  const a = reconstructAttempt([
    rec({ event: "DISPATCH_CLAIMED" }),
    rec({ event: "EXECUTION_UNKNOWN" }),
  ]);
  assert.equal(a.complete, false, "an unknown outcome would have produced a confident debrief");
  assert.match(positionStateLabel(a.state), /may exist/);
});

// ── the lineage writer is honest by construction ──────────────────────────
test("audit kinds map EXPLICITLY to ledger events — no cast, no default", () => {
  // A new audit kind must be invisible to the ledger until someone decides what
  // it means. Coercing an unmapped kind would write an event nobody chose.
  assert.match(ENTRY, /AUDIT_KIND_TO_EVENT/, "the mapping was replaced by a cast");
  assert.match(ENTRY, /if \(!eventType\) return;/,
    "an unmapped audit kind is written to the ledger anyway");
  assert.ok(!/as GuidedAuditEvent/.test(ENTRY),
    "an audit kind is cast to a ledger event, bypassing the explicit mapping");
});

test("the ledger write goes through buildLineageRecord, which refuses dishonesty", () => {
  assert.match(ENTRY, /buildLineageRecord/,
    "the ledger is written directly, bypassing the honesty checks");
  const at = ENTRY.indexOf("buildLineageRecord");
  const append = ENTRY.indexOf("appendGuidedEvent");
  assert.ok(at > 0 && append > at,
    "the row is appended before it is validated, so a dishonest row can land");
});

test("an INDETERMINATE dispatch maps to EXECUTION_UNKNOWN, never to a refusal", () => {
  const m = ENTRY.match(/GUIDED_DISPATCH_INDETERMINATE:\s*"([A-Z_]+)"/);
  assert.ok(m, "the indeterminate audit kind is not mapped");
  assert.equal(m![1], "EXECUTION_UNKNOWN",
    "an indeterminate delivery is recorded as something other than UNKNOWN");
});

test("a DRY RUN maps to its own event, distinct from a venue rejection", () => {
  const dry = ENTRY.match(/GUIDED_DISPATCH_DRY_RUN:\s*"([A-Z_]+)"/);
  assert.equal(dry?.[1], "DRY_RUN_REFUSED",
    "a dry run is recorded as something else — nothing was sent, and the ledger must say so");
});

// ── the ledger table is append-only and guarded ───────────────────────────
test("the guided ledger is registered with the append-only guard", () => {
  const guard = strip("../../../../../../scripts/src/ci/check-vault-mutations.ts");
  assert.match(guard, /guidedAttemptEventsTable/,
    "the forensic ledger can be mutated without failing CI");
});

test("the ledger repository contains no UPDATE or DELETE", () => {
  const repo = strip("../../../../../../lib/db/src/repositories/guidedAttemptEventsRepo.ts");
  assert.ok(!/\.update\s*\(/.test(repo), "the append-only ledger has an UPDATE path");
  assert.ok(!/\.delete\s*\(/.test(repo), "the append-only ledger has a DELETE path");
});

test("the sequence number is derived in SQL, so concurrent writers cannot collide silently", () => {
  const repo = strip("../../../../../../lib/db/src/repositories/guidedAttemptEventsRepo.ts");
  assert.match(repo, /max\(sequence_no\)/,
    "the sequence is computed in application code, where two writers can pick the same slot");
});
