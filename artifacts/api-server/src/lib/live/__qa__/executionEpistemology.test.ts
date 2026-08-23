// R2 S1+S2 — execution epistemology (UNKNOWN semantics + append-only events).
//
// Pins the two CRITICAL audit-execution.md findings closed by this slice:
//   G1a — a picked-up live command is never presumed dead: the TTL sweep may
//         terminalize (LIVE_EXPIRED, reservation released) ONLY rows the EA
//         provably never saw; any pickup evidence → LIVE_UNKNOWN (non-terminal,
//         reservation HELD).
//   G1b — an ambiguous success (no broker ticket) maps to LIVE_UNKNOWN, never
//         LIVE_FAILED, and never releases the master exposure reservation.
// Plus the S2 evidence-retention contracts: event-row shaping, and source pins
// that the duplicate/late-result branches retain payloads as execution events.
//
// Pure-unit + source-scan proofs only (established offline pattern):
// importing ../liveCommandPipeline.js transitively imports @workspace/db,
// whose module init throws when DATABASE_URL is unset. A dummy loopback URL
// satisfies the init; the pg Pool is lazy and NO query is ever issued.
//
// Run: node --import tsx --test --test-force-exit \
//   src/lib/live/__qa__/executionEpistemology.test.ts

process.env.DATABASE_URL ??= "postgres://qa:qa@127.0.0.1:1/qa_offline_never_connects";

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ARX_LIVE_COMMAND_STATUSES, type ArxLiveCommandStatus } from "@workspace/db/schema";

const {
  isTerminalLiveStatus,
  isAllowedLiveTransition,
  classifySweptLiveCommand,
  settleReservationForStatus,
  buildExecutionEventRow,
  mapBridgedLiveOutcome,
} = await import("../liveCommandPipeline.js");

const {
  isLiveBridgeMirrorPayload,
  LIVE_MIRROR_UNKNOWN_STATUS,
} = await import("../../mt5/stuckCommandWatchdog.js");

const pipelineSource = readFileSync(
  fileURLToPath(new URL("../liveCommandPipeline.ts", import.meta.url)),
  "utf8",
);

// ── S1a — pinned status vocabulary ──────────────────────────────────────────

test("the epistemic literals are in the schema vocabulary", () => {
  assert.ok((ARX_LIVE_COMMAND_STATUSES as readonly string[]).includes("LIVE_UNKNOWN"));
  assert.ok((ARX_LIVE_COMMAND_STATUSES as readonly string[]).includes("LIVE_RECONCILIATION_REQUIRED"));
  assert.equal(
    ARX_LIVE_COMMAND_STATUSES.length, 15,
    "11 legacy + 2 epistemic (S1) + 2 execution-stage (S5: ACKNOWLEDGED, PARTIALLY_FILLED)",
  );
});

test("LIVE_UNKNOWN and LIVE_RECONCILIATION_REQUIRED are NON-terminal; the prior terminal set is unchanged", () => {
  assert.equal(isTerminalLiveStatus("LIVE_UNKNOWN"), false);
  assert.equal(isTerminalLiveStatus("LIVE_RECONCILIATION_REQUIRED"), false);
  for (const s of [
    "LIVE_FILLED", "LIVE_REJECTED", "LIVE_FAILED",
    "LIVE_BLOCKED", "LIVE_CANCELLED", "LIVE_CLOSED", "LIVE_EXPIRED",
  ] as const) {
    assert.equal(isTerminalLiveStatus(s), true, `${s} stays terminal`);
  }
  for (const s of ["LIVE_DRAFT", "LIVE_CONFIRMATION_REQUIRED", "LIVE_APPROVED", "SENT_TO_MT5_LIVE"] as const) {
    assert.equal(isTerminalLiveStatus(s), false, `${s} stays non-terminal`);
  }
});

test("the epistemic transitions are exactly the S1 plan — nothing wider", () => {
  // Entry into LIVE_UNKNOWN: from a dispatched command, and (R2 S5) from the
  // two unsettled execution stages — an acked order whose broker then goes
  // quiet, or a partial whose remainder stops being reported, is genuinely
  // unknown. Every OTHER origin stays illegal.
  const unknownEntryPoints = new Set<ArxLiveCommandStatus>([
    "SENT_TO_MT5_LIVE", "LIVE_ACKNOWLEDGED", "LIVE_PARTIALLY_FILLED",
  ]);
  for (const from of ARX_LIVE_COMMAND_STATUSES) {
    assert.equal(
      isAllowedLiveTransition(from, "LIVE_UNKNOWN"),
      unknownEntryPoints.has(from),
      `${from} → LIVE_UNKNOWN`,
    );
  }
  // LIVE_UNKNOWN escalates ONLY to LIVE_RECONCILIATION_REQUIRED. In
  // particular it may NOT be cancelled (cancel releases the held
  // reservation) and may NOT jump straight to a terminal.
  for (const to of ARX_LIVE_COMMAND_STATUSES) {
    assert.equal(
      isAllowedLiveTransition("LIVE_UNKNOWN", to),
      to === "LIVE_RECONCILIATION_REQUIRED",
      `LIVE_UNKNOWN → ${to}`,
    );
  }
  // LIVE_RECONCILIATION_REQUIRED resolves only to a broker-truth terminal.
  // R2 S5 adds LIVE_PARTIALLY_FILLED: reconciliation may discover the broker
  // filled only part of the order, which is a truthful resolution.
  const allowedResolutions = new Set<ArxLiveCommandStatus>([
    "LIVE_FILLED", "LIVE_PARTIALLY_FILLED", "LIVE_REJECTED", "LIVE_FAILED", "LIVE_CANCELLED", "LIVE_EXPIRED",
  ]);
  for (const to of ARX_LIVE_COMMAND_STATUSES) {
    assert.equal(
      isAllowedLiveTransition("LIVE_RECONCILIATION_REQUIRED", to),
      allowedResolutions.has(to),
      `LIVE_RECONCILIATION_REQUIRED → ${to}`,
    );
  }
});

// ── S1b — sweep classification (audit G1a) ──────────────────────────────────

test("sweep: any arx-side pickup stamp → LIVE_UNKNOWN, regardless of mirror", () => {
  for (const mirrorStatus of [null, "PENDING", "cancelled", "DELIVERED", "sent", "completed", "failed"]) {
    assert.equal(
      classifySweptLiveCommand({ pickedByEaAt: new Date(), mirrorStatus }),
      "LIVE_UNKNOWN",
      `picked-up + mirror=${mirrorStatus ?? "none"} must never be presumed dead`,
    );
  }
});

test("sweep: LIVE_EXPIRED only when the EA provably never saw the command", () => {
  // No arx pickup stamp AND the transport mirror was never claimed.
  for (const mirrorStatus of [null, "PENDING", "cancelled"]) {
    assert.equal(
      classifySweptLiveCommand({ pickedByEaAt: null, mirrorStatus }),
      "LIVE_EXPIRED",
      `never-served (mirror=${mirrorStatus ?? "none"}) may terminalize`,
    );
  }
});

test("sweep: mirror pickup evidence alone forces LIVE_UNKNOWN (bridged transport — arx pickedByEaAt stays null)", () => {
  // The v1.50 EA polls only the mt5_commands mailbox, so the arx-side pickup
  // stamp is never written for bridged commands. Mirror status is the pickup
  // evidence; anything outside the never-served set — including unrecognized
  // or unreadable statuses — must fail toward UNKNOWN, never toward EXPIRED.
  for (const mirrorStatus of ["DELIVERED", "claimed", "sent", "completed", "failed", "unknown", "MIRROR_LOOKUP_FAILED", "garbage-status"]) {
    assert.equal(
      classifySweptLiveCommand({ pickedByEaAt: null, mirrorStatus }),
      "LIVE_UNKNOWN",
      `mirror=${mirrorStatus} is pickup evidence (or unreadable) → UNKNOWN`,
    );
  }
});

// ── S1c — ambiguous-result mapping + reservation matrix (audit G1b) ─────────

test("mapBridgedLiveOutcome: success-without-ticket → LIVE_UNKNOWN, never LIVE_FAILED/LIVE_FILLED", () => {
  for (const status of ["FILLED", "DONE", "OK", ""]) {
    assert.equal(mapBridgedLiveOutcome({ status, hasBrokerTicket: false }), "LIVE_UNKNOWN");
  }
  // Confirmed refusals stay confirmed.
  assert.equal(mapBridgedLiveOutcome({ status: "REJECTED", hasBrokerTicket: false }), "LIVE_REJECTED");
  assert.equal(mapBridgedLiveOutcome({ status: "FAILED", hasBrokerTicket: false }), "LIVE_FAILED");
  // A fill still requires a ticket.
  assert.equal(mapBridgedLiveOutcome({ status: "FILLED", hasBrokerTicket: true }), "LIVE_FILLED");
});

test("reservation settlement matrix: FULFILL on confirmed fill, RELEASE on confirmed non-execution, HOLD on unknown", () => {
  assert.equal(settleReservationForStatus("LIVE_FILLED"), "FULFILL");
  for (const s of ["LIVE_REJECTED", "LIVE_FAILED", "LIVE_EXPIRED", "LIVE_BLOCKED", "LIVE_CANCELLED"] as const) {
    assert.equal(settleReservationForStatus(s), "RELEASE", `${s} is confirmed non-execution`);
  }
  assert.equal(settleReservationForStatus("LIVE_UNKNOWN"), "HOLD");
  assert.equal(settleReservationForStatus("LIVE_RECONCILIATION_REQUIRED"), "HOLD");
  // Fail-closed epistemically: anything unrecognized holds, never releases.
  assert.equal(settleReservationForStatus("SOMETHING_NEW" as ArxLiveCommandStatus), "HOLD");
  // Pre-dispatch states hold too (no reservation exists to release there; the
  // dispatch path settles its own failures explicitly).
  assert.equal(settleReservationForStatus("SENT_TO_MT5_LIVE"), "HOLD");
});

test("recordLiveCommandResult settles reservations ONLY through the pure matrix (source pin)", () => {
  const fnStart = pipelineSource.indexOf("export async function recordLiveCommandResult");
  assert.ok(fnStart > 0);
  const fnBody = pipelineSource.slice(fnStart);
  assert.ok(
    fnBody.includes("settleReservationForStatus(finalStatus)"),
    "settlement must consult settleReservationForStatus",
  );
  assert.ok(
    fnBody.includes("RESERVATION_HELD_UNKNOWN_OUTCOME"),
    "the HOLD branch must exist (reservation held on unknown outcome)",
  );
});

test("sweepExpiredLiveCommands classifies through the pure helper and holds reservations on UNKNOWN (source pin)", () => {
  const fnStart = pipelineSource.indexOf("export async function sweepExpiredLiveCommands");
  assert.ok(fnStart > 0);
  // Scan only this function's body (up to the next exported function).
  const fnEnd = pipelineSource.indexOf("export async function", fnStart + 1);
  const fnBody = pipelineSource.slice(fnStart, fnEnd > fnStart ? fnEnd : undefined);
  assert.ok(fnBody.includes("classifySweptLiveCommand({"), "sweep must classify via the pure helper");
  // Reservation release must be CALLED exactly once — in the LIVE_EXPIRED
  // loop. (Counting call sites, not the dynamic-import destructure.)
  const releases = fnBody.split("releaseReservationByCommandId(").length - 1;
  assert.equal(releases, 1, "exactly one release call site (the provably-never-delivered branch)");
  assert.ok(
    fnBody.indexOf("releaseReservationByCommandId(") > fnBody.indexOf("const expired ="),
    "the single release call belongs to the expired branch",
  );
  assert.ok(fnBody.includes("UNKNOWN_ENTERED_TTL_NO_RESULT"), "UNKNOWN entry writes an execution event");
});

// ── S2 — event-row shaping + retention pins ─────────────────────────────────

test("buildExecutionEventRow shapes a valid row and defaults honestly", () => {
  const now = new Date("2026-08-19T00:00:00Z");
  const r = buildExecutionEventRow({
    commandRowId: 42, source: " ea ", eventType: " RESULT_LIVE_FILLED ",
    payload: { brokerTicket: "123" }, occurredAt: null, now,
  });
  if (!r.ok) assert.fail("expected a shaped row");
  assert.equal(r.row.commandRowId, 42);
  assert.equal(r.row.source, "ea");
  assert.equal(r.row.eventType, "RESULT_LIVE_FILLED");
  assert.deepEqual(r.row.payload, { brokerTicket: "123" });
  assert.equal(r.row.occurredAt.getTime(), now.getTime(), "missing occurredAt falls back to the caller clock");

  const withTime = buildExecutionEventRow({
    commandRowId: 1, source: "arx", eventType: "TTL_EXPIRED",
    occurredAt: new Date("2026-08-19T01:00:00Z"), now,
  });
  if (!withTime.ok) assert.fail("expected a shaped row");
  assert.equal(withTime.row.occurredAt.toISOString(), "2026-08-19T01:00:00.000Z");
  assert.deepEqual(withTime.row.payload, {}, "missing payload defaults to {}");
});

test("buildExecutionEventRow refuses malformed rows with a reason, never a guess", () => {
  for (const bad of [null, undefined, 0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const r = buildExecutionEventRow({ commandRowId: bad as number, source: "arx", eventType: "X" });
    if (r.ok) assert.fail(`commandRowId=${String(bad)} must refuse`);
    assert.equal(r.reason, "EVENT_COMMAND_ROW_ID_INVALID");
  }
  const noSource = buildExecutionEventRow({ commandRowId: 1, source: "  ", eventType: "X" });
  if (noSource.ok) assert.fail("empty source must refuse");
  assert.equal(noSource.reason, "EVENT_SOURCE_EMPTY");
  const noType = buildExecutionEventRow({ commandRowId: 1, source: "arx", eventType: null });
  if (noType.ok) assert.fail("empty eventType must refuse");
  assert.equal(noType.reason, "EVENT_TYPE_EMPTY");
});

test("late/duplicate/conflicting broker results are RETAINED as events, not destroyed (source pin, audit G3)", () => {
  const fnStart = pipelineSource.indexOf("export async function recordLiveCommandResult");
  const fnBody = pipelineSource.slice(fnStart);
  // Three retention sites: pre-CAS terminal duplicate, epistemic-state late
  // result, and the lost-CAS-race branch (x2 — terminal and epistemic).
  const retained = fnBody.split("\"LATE_RESULT_RETAINED\"").length - 1;
  assert.ok(retained >= 3, `expected >=3 LATE_RESULT_RETAINED sites, found ${retained}`);
  // The duplicate counter still exists (in-flight behavior unchanged) but the
  // payload now also lands in execution_events.
  assert.ok(fnBody.includes("duplicateResultCount"), "duplicate counter behavior unchanged");
  assert.ok(fnBody.includes("...reportedEvidence"), "the full reported payload is retained");
});

test("every touched transition writes an execution event (source pin)", () => {
  for (const marker of [
    "eventType: \"DISPATCH_SENT\"",
    "eventType: \"EA_PICKED_UP\"",
    "eventType: \"TTL_EXPIRED\"",
    "eventType: \"UNKNOWN_ENTERED_TTL_NO_RESULT\"",
    "eventType: `RESULT_${finalStatus}`",
  ]) {
    assert.ok(pipelineSource.includes(marker), `missing event write: ${marker}`);
  }
});

test("the idempotency partial index covers the epistemic states (audit G1e, schema source pin)", () => {
  const schemaSource = readFileSync(
    fileURLToPath(new URL("../../../../../../lib/db/src/schema/arxLiveExecution.ts", import.meta.url)),
    "utf8",
  );
  assert.ok(
    schemaSource.includes("status in ('SENT_TO_MT5_LIVE','LIVE_FILLED','LIVE_UNKNOWN','LIVE_RECONCILIATION_REQUIRED')"),
    "arx_live_commands_idem_active_uq must block duplicates while an outcome is unknown",
  );
});

// ── S1d — watchdog: live mirrors are never stamped 'failed' ─────────────────

test("isLiveBridgeMirrorPayload recognizes exactly the bridge stamp", () => {
  assert.equal(isLiveBridgeMirrorPayload({ bridged: "LIVE_PHASE_B", liveCommandId: "abc" }), true);
  for (const notMirror of [
    null, undefined, "LIVE_PHASE_B", 42, [],
    {}, { bridged: "LIVE_PHASE_B" },                       // no liveCommandId
    { bridged: "LIVE_PHASE_B", liveCommandId: 7 },          // wrong type
    { bridged: "OTHER", liveCommandId: "abc" },
    { liveCommandId: "abc" },
  ]) {
    assert.equal(isLiveBridgeMirrorPayload(notMirror), false, `${JSON.stringify(notMirror)} is not a live mirror`);
  }
});

test("watchdog routes live mirrors to 'unknown', never 'failed' (source pin, audit G1c)", () => {
  assert.equal(LIVE_MIRROR_UNKNOWN_STATUS, "unknown");
  const watchdogSource = readFileSync(
    fileURLToPath(new URL("../../mt5/stuckCommandWatchdog.ts", import.meta.url)),
    "utf8",
  );
  const fnStart = watchdogSource.indexOf("export async function sweepStuckCommands");
  assert.ok(fnStart > 0);
  const fnBody = watchdogSource.slice(fnStart);
  const mirrorBranchAt = fnBody.indexOf("isLiveBridgeMirrorPayload(command.payload)");
  const failedStampAt = fnBody.indexOf("status: \"failed\"");
  assert.ok(mirrorBranchAt > 0, "the sweep must consult the live-mirror predicate");
  assert.ok(failedStampAt > 0, "legacy rows keep the failed stamp");
  assert.ok(
    mirrorBranchAt < failedStampAt,
    "the live-mirror branch must divert BEFORE the failed stamp",
  );
  // The unknown branch must not fabricate failure evidence.
  const unknownBranch = fnBody.slice(mirrorBranchAt, failedStampAt);
  assert.ok(!unknownBranch.includes("failedAt"), "no failedAt on an unverified outcome");
  assert.ok(!unknownBranch.includes("WATCHDOG_STALE"), "no fabricated error code on an unverified outcome");
});
